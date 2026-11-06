import { engine } from '../lib/engine.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeFolderURL = (value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password
            && (!url.port || url.port === '443') && url.pathname.startsWith('/drive/folders/') ? url.href : null;
    } catch { return null; }
};
const size = (bytes) => {
    const n = Number(bytes) || 0;
    return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
};

/** Separate settings save: provider keys and backup policy never overwrite one another. */
export function mountDriveArchiveSettings(container) {
    let status = null;
    let draft = null;
    let busy = false;
    let error = null;
    let notice = null;
    const changed = () => status && JSON.stringify(draft) !== JSON.stringify(status.policy);
    const policyOf = (p) => ({ enabled: p.enabled === true, uploadDelayHours: Number(p.uploadDelayHours), removeLocalAfterHours: p.removeLocalAfterHours == null ? null : Number(p.removeLocalAfterHours) });

    function render() {
        if (!container.isConnected) return;
        const folderURL = safeFolderURL(status?.folderUrl);
        const stats = status?.stats;
        container.innerHTML = `
            <h4>Google Drive backup ${status ? `<span class="chip ${status.connected ? 'ok' : ''}"><i></i>${status.connected ? 'connected' : 'not connected'}</span>` : ''}</h4>
            <p>Finished projects get their own folder with videos and project files. Backups run on the server, even when you close the app.</p>
            ${status ? `
                <p><b>Folder:</b> ${esc(status.rootFolder)} ${folderURL ? `<a href="${esc(folderURL)}" target="_blank" rel="noopener">Open Google Drive folder ↗</a>` : ''}</p>
                <label class="toggle"><input type="checkbox" data-drive-field="enabled" ${draft.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}/> Automatically back up</label>
                <div class="grid2">
                    <label class="f"><span>Upload finished projects</span><select data-drive-field="uploadDelayHours" ${busy || !draft.enabled ? 'disabled' : ''}>
                        ${[[0, 'Immediately'], [24, 'After 1 day'], [48, 'After 2 days']].map(([n, label]) => `<option value="${n}" ${draft.uploadDelayHours === n ? 'selected' : ''}>${label}</option>`).join('')}
                    </select></label>
                    <label class="f"><span>Keep finished videos on server</span><select data-drive-field="removeLocalAfterHours" ${busy || !draft.enabled ? 'disabled' : ''}>
                        ${[['', 'Always'], [24, '1 day'], [48, '2 days']].map(([n, label]) => `<option value="${n}" ${(draft.removeLocalAfterHours ?? '') === n ? 'selected' : ''}>${label}</option>`).join('')}
                    </select></label>
                </div>
                <p class="muted">Only backed-up finished videos are removed after verification and the retention period. Source clips and references stay on the server. Archived videos are restored when opened again.</p>
                ${status.busy ? '<p><span class="spin"></span> Backup in progress on the server</p>' : ''}
                ${stats ? `<p class="muted">${Number(stats.projects) || 0} projects · ${Number(stats.videos) || 0} videos · ${esc(size(stats.verifiedBytes))} verified · ${esc(size(stats.localBytesFreed))} freed${stats.pending ? ` · ${Number(stats.pending)} pending` : ''}</p>` : ''}
                ${status.lastRunAt ? `<p class="muted">Last backup check: ${esc(new Date(status.lastRunAt).toLocaleString())}</p>` : ''}
                ${status.lastError ? `<p style="color:var(--eg-bad)">${esc(status.lastError)}</p>` : ''}
                ${changed() ? '<p class="muted">Save your settings before starting a backup.</p>' : ''}
                <div class="row">
                    <button type="button" class="btn sm primary" data-drive-action="save" ${busy || !changed() ? 'disabled' : ''}>Save backup settings</button>
                    <button type="button" class="btn sm" data-drive-action="run" ${busy || !status.connected || changed() ? 'disabled' : ''}>Back up finished projects now</button>
                    <button type="button" class="btn sm" data-drive-action="refresh" ${busy ? 'disabled' : ''}>Refresh status</button>
                </div>
            ` : busy ? '<p><span class="spin"></span> Checking Google Drive…</p>' : '<button type="button" class="btn sm" data-drive-action="refresh">Refresh status</button>'}
            ${error ? `<p role="alert" style="color:var(--eg-bad)">${esc(error)}</p>` : ''}
            ${notice ? `<p role="status" class="muted">${esc(notice)}</p>` : ''}`;
    }

    async function load() {
        if (busy) return;
        busy = true; error = null; render();
        try {
            const fresh = await engine.get('/archive/status');
            fresh.policy = policyOf(fresh.policy);
            if (!changed()) draft = { ...fresh.policy };
            status = fresh;
        } catch (e) {
            status = null;
            error = e.status === 404 ? 'Google Drive backup is not available on this studio yet.' : e.message;
        } finally { busy = false; render(); }
    }

    container.addEventListener('change', (event) => {
        const field = event.target.dataset.driveField;
        if (!draft || !field) return;
        draft[field] = field === 'enabled' ? event.target.checked : field === 'removeLocalAfterHours' && event.target.value === '' ? null : Number(event.target.value);
        notice = null;
        render();
    });
    container.addEventListener('click', async (event) => {
        const action = event.target.closest('[data-drive-action]')?.dataset.driveAction;
        if (!action || busy) return;
        if (action === 'refresh') { await load(); return; }
        busy = true; error = null; notice = null; render();
        try {
            if (action === 'save') {
                status = await engine.patch('/archive/settings', draft);
                status.policy = policyOf(status.policy);
                draft = { ...status.policy };
                notice = 'Backup settings saved.';
            } else if (action === 'run') {
                status = await engine.post('/archive/run');
                status.policy = policyOf(status.policy);
                notice = 'Backup requested. The server will process eligible finished projects; refresh to check progress.';
            }
        } catch (e) { error = e.message; }
        finally { busy = false; render(); }
    });
    load();
}
