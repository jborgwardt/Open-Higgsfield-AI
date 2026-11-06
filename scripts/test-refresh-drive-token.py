import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('broker', Path(__file__).with_name('refresh-drive-token.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

class BrokerTests(unittest.TestCase):
    def payload(self):
        return {'access_token': 'synthetic-scoped-token', 'client_id': 'fixture.apps.googleusercontent.com',
                'scope': broker.SCOPE, 'account': broker.ACCOUNT, 'token_type': 'Bearer',
                'expiry': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)).isoformat()}

    def test_config_contains_access_token_only(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'rclone.conf'
            file.write_text(broker.config_text(self.payload()))
            broker.verify_access_only(file)
            self.assertNotIn('refresh_token', file.read_text())
            self.assertNotIn('client_secret', file.read_text())

    def test_extra_scope_wrong_owner_or_expiry_rejected(self):
        for change in [{'scope': broker.SCOPE + ' https://mail.google.com/'}, {'account': 'someone@example.com'},
                       {'refresh_token': 'must-not-leave-source'}, {'expiry': '2020-01-01T00:00:00Z'}]:
            with self.assertRaises(Exception):
                broker.config_text({**self.payload(), **change})

    def test_failed_probe_keeps_old_config(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target' / 'rclone.conf'
            target.parent.mkdir(); target.write_text('old-working-config')
            replies = [subprocess.CompletedProcess([], 0, json.dumps(self.payload()), ''),
                       subprocess.CompletedProcess([], 1, b'', b'synthetic provider failure')]
            with patch.object(broker, 'TARGET', target), patch.object(broker, 'BACKUP', Path(directory) / 'backup' / 'old.conf'), \
                 patch.object(broker.os, 'geteuid', return_value=0), patch.object(broker.subprocess, 'run', side_effect=replies):
                with self.assertRaises(Exception): broker.refresh()
            self.assertEqual(target.read_text(), 'old-working-config')
            self.assertEqual(list(target.parent.glob('.rclone-scoped-*')), [])

    def test_success_is_atomic_private_and_backed_up_once(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target' / 'rclone.conf'; backup = Path(directory) / 'backup' / 'old.conf'
            target.parent.mkdir(); target.write_text('old-working-config')
            def run(*args, **kwargs):
                if args[0][0] == '/usr/bin/incus': return subprocess.CompletedProcess([], 0, json.dumps(self.payload()), '')
                return subprocess.CompletedProcess([], 0, b'{"free":123}', b'')
            with patch.object(broker, 'TARGET', target), patch.object(broker, 'BACKUP', backup), \
                 patch.object(broker.os, 'geteuid', return_value=0), patch.object(broker.subprocess, 'run', side_effect=run):
                broker.refresh(); broker.refresh()
            broker.verify_access_only(target)
            self.assertEqual(backup.read_text(), 'old-working-config')
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

if __name__ == '__main__': unittest.main()
