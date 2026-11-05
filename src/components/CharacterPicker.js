import '../styles/engine.css';
import '../styles/characters.css';
import { engine } from '../lib/engine.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => esc(String(n || '?').trim().charAt(0).toUpperCase());

let cache = { at: 0, list: [] };
/** Characters from the engine (cached a few seconds so several pickers share one request). */
export async function loadCharacters(fresh) {
    if (!engine.online) return [];
    if (!fresh && Date.now() - cache.at < 5000) return cache.list;
    cache = { at: Date.now(), list: await engine.get('/characters').catch(() => cache.list) };
    return cache.list;
}

/**
 * Multi-select of saved characters for a studio prompt bar. Selected ids go into the generation request as
 * `characters: [...]`; the engine routes each character's best references to whatever the model accepts.
 * Returns { el, ids(), set(ids) }. Renders nothing when the engine is offline.
 */
export function CharacterPicker({ onChange, label = 'Character' } = {}) {
    const el = document.createElement('div');
    el.className = 'chpk';
    let selected = [];
    let open = false;
    if (!engine.online) { el.style.display = 'none'; return { el, ids: () => [], set() {} }; }

    function avatars(list) {
        const sel = list.filter((c) => selected.includes(c.id));
        if (!sel.length) return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>${label}`;
        return `<span class="st">${sel.slice(0, 3).map((c) => `<span style="${c.coverUrl ? `background-image:url('${esc(c.coverUrl)}')` : ''}">${c.coverUrl ? '' : initial(c.name)}</span>`).join('')}</span>${esc(sel.length === 1 ? sel[0].name : `${sel.length} characters`)}`;
    }

    async function render() {
        const list = await loadCharacters();
        selected = selected.filter((id) => list.some((c) => c.id === id));
        el.innerHTML = `<button type="button" class="chpk-btn ${selected.length ? 'on' : ''}" title="Keep a saved character's likeness in this generation">${avatars(list)}</button>
          ${open ? `<div class="chpk-pop">${list.length ? list.map((c) => `
            <div class="opt ${selected.includes(c.id) ? 'on' : ''}" data-id="${esc(c.id)}">
              <div class="av" style="${c.coverUrl ? `background-image:url('${esc(c.coverUrl)}')` : ''}">${c.coverUrl ? '' : initial(c.name)}</div>
              <div><b>${esc(c.name)}</b><small>${c.refs.length} refs · ${c.coverage?.percent ?? 0}% coverage${c.approvedSheet ? ' · sheet ✓' : ''}</small></div>
              <div class="ck">✓</div></div>`).join('') : '<div class="none">No characters yet. Create one from your photos to keep a person consistent across every model.</div>'}
            <div class="ft"><span>${selected.length ? `${selected.length} selected` : 'Engine models only'}</span><a data-manage>Manage characters →</a></div></div>` : ''}`;
    }

    el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (e.target.closest('[data-manage]')) {
            open = false;
            window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'characters' } }));
            return;
        }
        const opt = e.target.closest('.opt');
        if (opt) {
            const id = opt.dataset.id;
            selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
            onChange?.(selected.slice());
            return render();
        }
        if (e.target.closest('.chpk-btn')) {
            open = !open;
            if (open) await loadCharacters(true);
            return render();
        }
    });
    document.addEventListener('click', () => { if (open) { open = false; render(); } });
    render();
    return {
        el,
        ids: () => selected.slice(),
        set(ids) { selected = [...(ids || [])]; render(); },
    };
}
