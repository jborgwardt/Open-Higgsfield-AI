#!/usr/bin/env python3
"""Renew Film Studio's Drive-only access token without exporting broad refresh credentials.

Run on the VPS as root. OAuth refresh credentials remain inside Incus `god`.
Stdout/stderr and journald contain status only, never credential values.
"""
from __future__ import annotations

import configparser
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

TARGET = Path('/var/lib/docker/volumes/studio-data/_data/rclone/rclone.conf')
BACKUP = Path('/opt/studio/drive-broker-backups/rclone.conf.before-scoped-broker')
SCOPE = 'https://www.googleapis.com/auth/drive'
ACCOUNT = 'jborgwardtis@gmail.com'

# Executed within god. Only the downscoped access token and public client ID leave it.
INNER = r'''
import datetime as dt
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request

SCOPE = 'https://www.googleapis.com/auth/drive'
ACCOUNT = 'jborgwardtis@gmail.com'
TOKEN_FILE = Path('/root/grok-exec/secrets/gdrive/google_token.json')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Unexpected Google redirect')

opener = urllib.request.build_opener(NoRedirect())
def request_json(req):
    with opener.open(req, timeout=30) as response:
        return json.loads(response.read(1024 * 1024))

try:
    source = json.loads(TOKEN_FILE.read_text())
    if source.get('token_uri', 'https://oauth2.googleapis.com/token') != 'https://oauth2.googleapis.com/token':
        raise RuntimeError('Unexpected token endpoint')
    if not all(source.get(k) for k in ('client_id', 'client_secret', 'refresh_token')):
        raise RuntimeError('Missing source credentials')
    body = urllib.parse.urlencode({
        'client_id': source['client_id'], 'client_secret': source['client_secret'],
        'refresh_token': source['refresh_token'], 'grant_type': 'refresh_token', 'scope': SCOPE,
    }).encode()
    result = request_json(urllib.request.Request('https://oauth2.googleapis.com/token', data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST'))
    if set(str(result.get('scope', '')).split()) != {SCOPE}:
        raise RuntimeError('Google did not return exactly Drive scope')
    if str(result.get('token_type', '')).lower() != 'bearer' or not result.get('access_token'):
        raise RuntimeError('Invalid Google access token response')
    lifetime = int(result.get('expires_in', 0))
    if not 1200 <= lifetime <= 86400:
        raise RuntimeError('Unexpected Google token lifetime')
    about = request_json(urllib.request.Request(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
        headers={'Authorization': 'Bearer ' + result['access_token']}))
    email = str(about.get('user', {}).get('emailAddress', '')).lower()
    if email != ACCOUNT:
        raise RuntimeError('Google account did not match the studio owner')
    expiry = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=lifetime)).isoformat(timespec='seconds').replace('+00:00', 'Z')
    print(json.dumps({'access_token': result['access_token'], 'client_id': source['client_id'],
        'scope': SCOPE, 'account': email, 'expiry': expiry, 'token_type': 'Bearer'}))
except Exception:
    # Provider bodies and exception details can contain credentials: never emit them.
    print('Drive-only token refresh or account validation failed.', file=sys.stderr)
    sys.exit(1)
'''


def private_directory(path: Path) -> None:
    if path.is_symlink():
        raise RuntimeError('Unsafe directory')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def validate_payload(payload: dict) -> None:
    if not isinstance(payload, dict) or set(payload) != {'access_token', 'client_id', 'scope', 'account', 'expiry', 'token_type'}:
        raise RuntimeError('Invalid broker payload')
    if payload['scope'] != SCOPE or payload['account'] != ACCOUNT or payload['token_type'] != 'Bearer':
        raise RuntimeError('Unexpected token scope or owner')
    if not isinstance(payload['access_token'], str) or not payload['access_token'] or '\n' in payload['access_token']:
        raise RuntimeError('Invalid access token')
    client = payload['client_id']
    if not isinstance(client, str) or not client.endswith('.apps.googleusercontent.com') or any(c in client for c in '\r\n[]'):
        raise RuntimeError('Invalid client identifier')
    expiry = dt.datetime.fromisoformat(payload['expiry'].replace('Z', '+00:00'))
    if expiry.tzinfo is None or expiry <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=15):
        raise RuntimeError('Token expires too soon')


def config_text(payload: dict) -> str:
    validate_payload(payload)
    token = {k: payload[k] for k in ('access_token', 'token_type', 'expiry')}
    return '[gdrive]\ntype = drive\nclient_id = ' + payload['client_id'] + '\nscope = drive\ntoken = ' + json.dumps(token, separators=(',', ':')) + '\n'


def verify_access_only(file: Path) -> None:
    config = configparser.ConfigParser(interpolation=None)
    config.read(file)
    if config.sections() != ['gdrive'] or set(config['gdrive']) != {'type', 'client_id', 'scope', 'token'}:
        raise RuntimeError('Unexpected rclone configuration')
    if set(json.loads(config['gdrive']['token'])) != {'access_token', 'token_type', 'expiry'}:
        raise RuntimeError('Unexpected token fields')


def backup_once() -> None:
    if not TARGET.exists():
        return
    private_directory(BACKUP.parent)
    if BACKUP.is_symlink() or TARGET.is_symlink():
        raise RuntimeError('Unsafe backup path')
    try:
        fd = os.open(BACKUP, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    with os.fdopen(fd, 'wb') as output:
        output.write(TARGET.read_bytes())
        output.flush()
        os.fsync(output.fileno())


def refresh() -> None:
    if os.geteuid() != 0:
        raise RuntimeError('Root required')
    # Captured pipe: token JSON is never sent to the tool output or journal.
    result = subprocess.run(['/usr/bin/incus', 'exec', 'god', '--', 'python3', '-'], input=INNER,
        capture_output=True, text=True, timeout=100, check=False)
    if result.returncode != 0:
        raise RuntimeError('Scoped refresh failed')
    payload = json.loads(result.stdout)
    rendered = config_text(payload)
    private_directory(TARGET.parent)
    if TARGET.is_symlink():
        raise RuntimeError('Unsafe target path')
    temporary = None
    try:
        fd, name = tempfile.mkstemp(prefix='.rclone-scoped-', dir=TARGET.parent)
        temporary = Path(name)
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(rendered)
            output.flush()
            os.fsync(output.fileno())
        verify_access_only(temporary)
        # Verify the exact candidate config before replacing the working one.
        probe = subprocess.run(['/usr/local/bin/rclone', '--config', str(temporary), 'about', 'gdrive:', '--json',
            '--contimeout', '15s', '--timeout', '30s', '--retries', '1', '--low-level-retries', '1'],
            capture_output=True, timeout=55, check=False)
        if probe.returncode != 0 or not isinstance(json.loads(probe.stdout), dict):
            raise RuntimeError('Drive verification failed')
        verify_access_only(temporary)
        backup_once()
        os.replace(temporary, TARGET)
        temporary = None
        directory_fd = os.open(TARGET.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print('Film Studio Drive-only access token renewed; account and scope verified.')


def main() -> int:
    try:
        refresh()
        return 0
    except Exception:
        print('Film Studio Drive token renewal failed; existing configuration was kept. Check Google availability and the broker source account.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
