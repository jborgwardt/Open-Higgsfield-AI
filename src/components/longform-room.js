// Long-form studio panels for the writers' room director and the Gemini screening loop.
// Pure HTML builders; LongFormStudio.js wires the data-a actions.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(1).replace(/\.0$/, '') : '?');
const small = 'font-size:11.5px';

export const GENRES = [['', 'Director decides'], ['comedy', 'Comedy'], ['drama', 'Drama'], ['horror', 'Horror'], ['thriller', 'Thriller'], ['ad', 'Ad / commercial'], ['music-video', 'Music video'], ['documentary', 'Documentary']];

/** Director picker: every chat model across connected keys, grouped by provider. Value = "provider|model". */
export function directorPicker(dir, brief) {
    if (!dir) return '<label class="f"><span>Director</span><select disabled><option>Loading directors…</option></select></label>';
    const own = brief.directorProvider ? { id: brief.directorProvider, model: brief.directorModel || '' } : null;
    const cur = own || { id: dir.selected, model: dir.model || '' };
    const groups = dir.providers.map((p) => {
        const models = p.models.length ? p.models : [{ id: '', label: p.id === 'split' ? 'Split the script into shots' : p.defaultModel || 'default model' }];
        const opts = models.map((m) => {
            const sel = cur.id === p.id && (cur.model === m.id || (!cur.model && (m.id === p.defaultModel || !m.id)));
            return `<option value="${esc(`${p.id}|${m.id}`)}" ${sel ? 'selected' : ''} ${p.available ? '' : 'disabled'}>${esc(m.label)}</option>`;
        }).join('');
        return `<optgroup label="${esc(p.label)}${p.available ? '' : ` — ${p.detail || 'not connected'}`}">${opts}</optgroup>`;
    }).join('');
    const p = dir.providers.find((x) => x.id === cur.id);
    return `<label class="f"><span>Director <em>${own ? 'this film only · <a href="#" data-a="director-studio">use studio choice</a>' : 'saved for every film until you change it'}</em></span>
      <select data-director>${cur.id ? '' : '<option value="" selected disabled>Choose a director…</option>'}${groups}</select></label>
      ${p && !p.available ? `<p class="dim" style="${small};color:var(--eg-bad)">${esc(p.label)}: ${esc(p.detail)}</p>` : ''}`;
}

export function genreSelect(b) {
    return `<label class="f"><span>Genre <em>steers the writers' room</em></span><select data-b="genre">${GENRES.map(([v, l]) => `<option value="${v}" ${(b.genre || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
}

/** Concept, beat sheet and the room's own critique for the current plan. */
export function roomCard(p) {
    const r = p.plan?.room;
    if (!r) return '';
    const c = r.concepts?.[r.pick] || {};
    const warn = (r.warnings || []).map((w) => `<div class="msg err" style="${small}">⚠ ${esc(w)}</div>`).join('');
    const alts = (r.concepts || []).map((x, i) => `<div style="margin:6px 0;${i === r.pick ? '' : 'opacity:.7'}"><b>${i === r.pick ? '★ ' : ''}${esc(x.name)}</b> <span class="dim">${esc(x.score)}/10</span><br>${esc(x.logline)}<br><span class="dim">Engine: ${esc(x.engine)} · Hook: ${esc(x.hook)} · Button: ${esc(x.button)}</span></div>`).join('');
    const beats = (r.beats || []).map((b) => `<div style="display:flex;gap:8px"><span class="mono dim" style="min-width:64px">${n1(b.t)}s +${n1(b.len)}</span><span class="chip" style="height:18px">${esc(b.purpose)}</span><span>${esc(b.beat)}${b.audience ? ` <span class="dim">— ${esc(b.audience)}</span>` : ''}</span></div>`).join('');
    const cr = r.critique;
    const crit = cr ? `<div><b>Room critique ${esc(cr.score)}/10</b> — ${esc(cr.rhythm || '')}</div>${(cr.flat || []).map((f) => `<div class="dim">• ${esc(f)}</div>`).join('')}${(r.changes || []).length ? `<div style="margin-top:6px"><b>Rewrite</b></div>${r.changes.map((x) => `<div class="dim">• ${esc(x)}</div>`).join('')}` : ''}` : '';
    return `<div class="card col" style="gap:6px;${small}">
      <div class="row"><h3 style="margin:0">Writers' room</h3><span class="dim">${esc(r.genre)} · ${esc(p.plan.director)}${p.plan.directorModel ? ` · ${esc(p.plan.directorModel)}` : ''} · cut ${n1(r.cutSeconds)}s from ${n1(r.renderSeconds)}s of renders${r.seconds ? ` · ${r.seconds}s` : ''}</span></div>
      <div><b>${esc(c.name || '')}</b> — ${esc(c.logline || '')}</div>
      <div class="dim">${esc(c.engine || '')}</div>
      <div class="dim">Escalation: ${(c.escalation || []).map(esc).join(' → ')} · Turn: ${esc(c.turn || '')} · Button: ${esc(c.button || '')}</div>
      ${r.music ? `<div class="dim">♪ ${esc(r.music)}</div>` : ''}
      ${warn}
      <details><summary class="muted" style="cursor:pointer">Three concepts · why this one</summary>${alts}<div class="dim">${esc(r.why || '')}</div></details>
      <details><summary class="muted" style="cursor:pointer">Beat sheet (${(r.beats || []).length} beats)</summary><div class="col" style="gap:3px;margin-top:6px">${beats}</div></details>
      ${crit ? `<details><summary class="muted" style="cursor:pointer">Critique and rewrite</summary><div style="margin-top:6px">${crit}</div></details>` : ''}
    </div>`;
}

/** Coverage, cut length, dialogue and the hit, under each shot's prompt. */
export function shotExtras(s) {
    const cut = s.editLength ? `✂ ${n1(s.editLength)}s from ${n1(s.editIn ?? 0)}s of ${n1(s.duration || s.clipDuration)}s` : '';
    const lines = (s.dialogue || []).map((l) => `<div class="msg" style="color:#ffe3b0">🗣 <b>${esc(l.speaker)}</b>${l.delivery ? ` <span class="dim">(${esc(l.delivery)})</span>` : ''}: “${esc(l.line)}”</div>`).join('');
    const tags = [s.coverage && `<span class="chip" style="height:18px">${esc(s.coverage)}</span>`, cut && `<span class="dim mono" style="${small}">${cut}</span>`, s.score === true && '<span class="dim">♪ score</span>', s.omit && '<span class="chip warn" style="height:18px">cut from master</span>'].filter(Boolean).join(' ');
    return `${tags ? `<div class="row" style="gap:6px;margin-top:4px">${tags}</div>` : ''}${lines}${s.hit ? `<div class="msg dim">⤷ lands: ${esc(s.hit)}</div>` : ''}${s.screenNote ? `<div class="msg" style="color:#cfe3ff">🎬 ${esc(s.screenNote)}</div>` : ''}`;
}

/** Edit-mode fields for the cut. */
export function editFields(s) {
    return `<div class="row" style="gap:6px;margin-top:6px;${small}">
      <label class="f" style="width:110px"><span>Cut starts at (s)</span><input type="number" step="0.1" min="0" data-edit-in="${s.id}" value="${s.editIn ?? ''}" placeholder="0"/></label>
      <label class="f" style="width:110px"><span>Cut length (s)</span><input type="number" step="0.1" min="0.5" data-edit-len="${s.id}" value="${s.editLength ?? ''}" placeholder="whole clip"/></label>
      <label class="toggle" style="margin-top:14px"><input type="checkbox" data-edit-omit="${s.id}" ${s.omit ? 'checked' : ''}/> Leave out of the master</label></div>`;
}

/** Gemini's screening notes for the latest master. */
export function screeningCard(p, available) {
    if (!p.master?.url) return '';
    const sc = p.screening;
    const btn = `<button class="btn sm" data-a="screen" ${available && sc?.status !== 'running' ? '' : 'disabled'} title="${available ? 'Gemini watches the master and writes notes' : 'Add a Gemini API key to screen'}">${sc?.status === 'running' ? '<span class="spin"></span> Screening…' : sc?.status === 'done' ? '↻ Screen again' : '🎬 Screen with Gemini'}</button>`;
    if (!sc || sc.status !== 'done') {
        return `<div class="card col" style="gap:6px"><div class="row"><h3 style="margin:0">Screening</h3><span class="grow"></span>${btn}</div>${sc?.status === 'error' ? `<div class="msg err">${esc(sc.error)}</div>` : `<p class="dim" style="${small}">Gemini watches the cut with sound and gives notes: hook, pacing, every joke, likeness, audio, music — plus re-cuts you can apply for free.</p>`}</div>`;
    }
    const stale = sc.masterAssetId && sc.masterAssetId !== p.master.assetId;
    const recuts = (sc.shots || []).filter((n) => (n.verdict === 'recut' && n.editLength) || n.verdict === 'cut');
    const pending = recuts.filter((n) => !(sc.applied || []).includes(n.shot));
    const row = (label, v) => (v ? `<div><b>${label}</b> ${v}</div>` : '');
    const list = (arr, f) => (arr || []).map(f).join('');
    const shotNotes = list(sc.shots.filter((n) => n.verdict !== 'keep'), (n) => `<div class="row" style="gap:6px;align-items:flex-start;padding:4px 0;border-top:1px solid var(--eg-line)">
        <span class="mono" style="min-width:26px">#${n.shot}</span><span class="chip ${n.verdict === 'reshoot' ? 'warn' : n.verdict === 'cut' ? 'bad' : ''}" style="height:18px">${esc(n.verdict)}</span>
        <span class="grow">${esc(n.note)}${n.verdict === 'recut' && n.editLength ? ` <span class="dim mono">→ ${n1(n.editLength)}s from ${n1(n.editIn ?? 0)}s</span>` : ''}${n.newPrompt ? `<div class="dim" style="margin-top:2px">New prompt: ${esc(n.newPrompt)}</div>` : ''}</span>
        ${n.shotId && ((n.verdict === 'recut' && n.editLength) || n.verdict === 'cut') ? `<button class="btn sm ghost" data-a="screen-apply" data-n="${n.shot}" ${(sc.applied || []).includes(n.shot) ? 'disabled' : ''}>${(sc.applied || []).includes(n.shot) ? 'Applied' : n.verdict === 'cut' ? 'Cut it' : 'Re-cut'}</button>` : ''}
        ${n.shotId && n.newPrompt ? `<button class="btn sm ghost" data-a="screen-prompt" data-id="${n.shotId}" data-n="${n.shot}" title="Replace the prompt and queue a re-render">Use prompt</button>` : ''}</div>`);
    return `<div class="card col" style="gap:6px;${small}">
      <div class="row"><h3 style="margin:0">Screening</h3><b style="font-size:18px">${esc(sc.score ?? '?')}/10</b><span class="dim">keep watching: ${esc(sc.wouldKeepWatching || '?')} · ${esc(sc.model)}${stale ? ' · notes are for an older cut' : ''}</span><span class="grow"></span>
        ${pending.length ? `<button class="btn sm primary" data-a="screen-apply">Apply ${pending.length} re-cut${pending.length > 1 ? 's' : ''} & re-assemble</button>` : ''}${btn}</div>
      <div>${esc(sc.verdict)}</div>
      ${(sc.topFixes || []).length ? `<ol style="margin:0;padding-left:18px">${sc.topFixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ol>` : ''}
      <details><summary class="muted" style="cursor:pointer">Hook, pacing, jokes, likeness, audio, music</summary><div class="col" style="gap:4px;margin-top:6px">
        ${row(`Hook ${esc(sc.hook?.score ?? '')}/10:`, esc(sc.hook?.note))}
        ${row(`Pacing ${esc(sc.pacing?.score ?? '')}/10:`, esc(sc.pacing?.note))}
        ${list(sc.pacing?.flat, (f) => `<div class="dim">• flat ${esc(f.at)}: ${esc(f.why)}</div>`)}
        ${list(sc.jokes, (j) => `<div>${j.landed === 'yes' ? '✅' : j.landed === 'partly' ? '〰️' : '❌'} <b>${esc(j.joke)}</b> <span class="dim">(#${esc(j.shot ?? '?')} ${esc(j.at || '')}) ${esc(j.why)}</span></div>`)}
        ${list(sc.likeness, (l) => `<div>${l.consistent ? '👤' : '⚠️'} <b>${esc(l.character)}</b> <span class="dim">${esc(l.note)}${l.shots?.length ? ` · shots ${l.shots.join(', ')}` : ''}</span></div>`)}
        ${list(sc.audio, (a) => `<div>🔊 <span class="dim">#${esc(a.shot ?? '?')} ${esc(a.at || '')}</span> ${esc(a.issue)}</div>`)}
        ${sc.music ? `<div>♪ <b>${esc(sc.music.verdict)}</b> <span class="dim">${esc(sc.music.note)}</span></div>` : ''}
      </div></details>
      ${shotNotes ? `<details open><summary class="muted" style="cursor:pointer">Per-shot fixes</summary>${shotNotes}</details>` : ''}
    </div>`;
}

/** Seconds of finished film (cut lengths) for the stats strip. */
export const cutSeconds = (shots) => shots.reduce((t, s) => {
    if (s.omit) return t;
    const clip = Number(s.clipDuration) || 0;
    const cut = Number(s.editLength) || 0;
    return t + (cut && clip ? Math.min(cut, clip) : cut || clip);
}, 0);
