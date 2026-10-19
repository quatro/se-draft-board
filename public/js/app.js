/* 2027 SE Major Draft Board — browser client.
   The server owns the draft: it computes the slot order, validates every pick
   and pushes a change event over SSE; this file only renders /api/state and
   sends admin actions back. */
'use strict';

const STATUSES = ['Registered', 'Not registered', 'Verbal commit', 'Need to contact', 'Not returning'];
const S = { st: null, me: null, tab: 'board', live: false, skew: 0, regs: null, log: null, pendingRender: false };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const dotCls = (s) => ({ Registered: 'Registered', 'Verbal commit': 'Verbal', 'Not returning': 'Not-returning', 'Need to contact': 'Need' }[s] || '');
const isAdmin = () => !!S.st?.canWrite;
const now = () => Date.now() + S.skew;

function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), err ? 4000 : 2200); }

async function call(method, url, body) {
  // Every mutation goes out as JSON (even a bodiless DELETE) — the server's CSRF guard requires it.
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && data?.error === 'login_required') { location.href = '/admin'; }
    throw new Error(data?.error || `Request failed (${r.status})`);
  }
  return data;
}
async function act(method, url, body, okMsg) {
  try { const d = await call(method, url, body); if (okMsg || d?.message) toast(d?.message || okMsg); return d; }
  catch (e) { toast(e.message, true); return null; }
}

/* ---------- lookups ---------- */
const team = (id) => S.st.teams.find((t) => t.id === id);
const player = (id) => S.st.players.find((p) => p.id === id);
const pickMap = () => Object.fromEntries(S.st.picks.map((p) => [p.key, p]));
const takenIds = () => new Set(S.st.picks.map((p) => p.player));
const teamColor = (t) => (t.color.toUpperCase() === '#FFFFFF' ? 'var(--ink)' : esc(t.color));
const hdrStyle = (t) => `background:${esc(t.color)};color:${esc(t.fg)}`;
const keepers = (tid) => S.st.players.filter((p) => p.kind === 'returning' && p.teamId === tid);

/* ---------- render ---------- */
function render() {
  if (!S.st) return;
  const st = S.st;
  document.title = `${st.settings.season || ''} SE Major Draft Board`.trim();
  $('season').textContent = `SE Baseball · ${st.settings.season || ''} Majors`;
  document.querySelectorAll('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
  renderWho();
  renderClock();
  renderOrphans();
  if (S.tab === 'board') { renderBoard(); renderPool(); }
  if (S.tab === 'teams') renderTeams();
  // Admin tabs hold inputs; don't rebuild under someone's cursor. Re-render on blur instead.
  const ae = document.activeElement;
  const typing = ae && ae.closest && ae.closest('section') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox' && ae.type !== 'file';
  if (typing && ['players', 'setup', 'regs'].includes(S.tab)) { S.pendingRender = true; return; }
  if (S.tab === 'players') renderPlayers();
  if (S.tab === 'setup') renderSetup();
  if (S.tab === 'regs') renderRegs();
  if (S.tab === 'log') renderLog();
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !document.activeElement?.closest?.('section')) { S.pendingRender = false; render(); } }, 0));

function renderWho() {
  $('whoami').innerHTML = S.me?.admin
    ? `Signed in as <b>${esc(S.me.admin)}</b> · <button id="logout">Log out</button>`
    : `<a href="/admin">Admin login</a>`;
  const lo = $('logout');
  if (lo) lo.onclick = async () => { await act('POST', '/api/logout', {}); location.href = '/'; };
  const reg = S.st?.links?.registration;
  $('tools').hidden = !reg;
  if (reg) $('tools').innerHTML = `<a href="${esc(reg)}"><b>Registration seats ↗</b></a>`;
}

function renderClock() {
  const st = S.st, pm = pickMap(), cur = st.current;
  const total = st.slots.length, made = st.picks.length;
  const live = `<span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'Live' : 'Reconnecting'}</span>`;
  if (!st.teams.length) { $('clock').innerHTML = `<div><div class="who">No league set up yet</div><div class="meta">${isAdmin() ? 'Add teams in Setup, or seed from the original artifact (see README).' : 'Check back once the league is set up.'}</div></div><span class="spacer"></span>${live}`; return; }
  if (!cur) { $('clock').innerHTML = `<div><div class="who">Draft complete</div><div class="meta">${made} of ${total} picks made · every roster is at ${st.settings.rosterSize}</div></div><span class="spacer"></span>${live}`; return; }
  const t = team(cur.team);
  const upNext = st.slots.filter((s) => !pm[s.key]).slice(1, 4).map((s) => team(s.team).name).join(', ');
  const cs = st.clock.clockStart;
  $('clock').innerHTML = `<div><div class="meta">On the clock</div><div class="who" style="color:${teamColor(t)}">${esc(t.name)}</div></div>
    <div class="meta">Round ${cur.round} · Pick #${cur.n} of ${total}${cur.comp ? ' <span class="chip comp">Comp round</span>' : ''}<br>Up next: ${esc(upNext || '—')}</div>
    <span class="spacer"></span>${live}${isAdmin() ? `<button class="btn" id="undoTop" ${made ? '' : 'disabled'}>Undo</button>` : ''}
    ${cs ? `<div class="timer" id="timer"><span class="lbl">On the clock for</span><span class="t" id="timerT">${fmt(now() - cs)}</span></div>`
      : isAdmin() ? `<button class="btn primary" id="startClock">Start draft clock</button>` : `<div class="timer"><span class="lbl">Clock starts when the draft begins</span></div>`}`;
  const u = $('undoTop'); if (u) u.onclick = () => act('POST', '/api/admin/undo', {}, 'Last pick undone');
  const sc = $('startClock'); if (sc) sc.onclick = () => act('POST', '/api/admin/clock/start', {}, 'Clock started');
  tick();
}
function tick() {
  const el = $('timerT'), cs = S.st?.clock.clockStart;
  if (!el || !cs) return;
  const ms = now() - cs; el.textContent = fmt(ms);
  const w = $('timer'); w.classList.toggle('warn', ms >= 120000 && ms < 300000); w.classList.toggle('long', ms >= 300000);
}
setInterval(tick, 1000);

function renderOrphans() {
  const o = S.st.orphans, box = $('orphanWarn');
  box.hidden = !(isAdmin() && o.length);
  if (box.hidden) return;
  const pm = pickMap();
  box.innerHTML = `<b>${o.length} pick${o.length > 1 ? 's' : ''} no longer fit the board</b> — a team now owes fewer picks than it has made (usually a “Not returning” player was switched back). Remove or keep: `
    + o.map((k) => { const p = pm[k]; return `<span class="chip">${esc(team(p.team)?.name)} · ${esc(player(p.player)?.name)} <button class="mini" data-orph="${esc(k)}">Remove</button></span>`; }).join(' ');
  box.querySelectorAll('[data-orph]').forEach((b) => (b.onclick = () => act('DELETE', `/api/admin/picks/${encodeURIComponent(b.dataset.orph)}`, undefined, 'Pick removed')));
}

function renderBoard() {
  const st = S.st, teams = st.teams, pm = pickMap(), cur = st.current;
  const rounds = Math.max(st.maxRound, 1);
  const byKey = Object.fromEntries(st.slots.map((s) => [s.key, s]));
  let h = `<thead><tr><th class="rd">Round</th>${teams.map((t) => `<th style="${hdrStyle(t)}">${esc(t.name)}</th>`).join('')}</tr></thead><tbody>`;
  for (let r = 1; r <= rounds; r++) {
    const comp = r > st.minRound;
    h += `<tr><th class="rd">Rd ${r}${comp ? '<br><span class="chip comp">Comp</span>' : ''}</th>`;
    for (const t of teams) {
      const s = byKey[`${r}-${t.id}`];
      if (!s) { h += `<td class="full" title="${esc(t.name)} roster is full">—</td>`; continue; }
      const p = pm[s.key];
      if (p) {
        const pl = player(p.player);
        h += `<td class="picked${isAdmin() ? ' editable' : ''}" ${isAdmin() ? `data-slot="${esc(s.key)}" title="Edit this pick"` : ''}><span class="nm">${esc(pl?.name || '(removed)')}</span>${pl?.age ? ` <span class="ag">(${esc(pl.age)})</span>` : ''}<span class="pk">#${s.n}</span>${p.took != null ? `<span class="tk" title="Time on the clock">${fmt(p.took)}</span>` : ''}</td>`;
      } else if (cur && cur.key === s.key) h += `<td class="onclock">On the clock<span class="pk" style="color:inherit">#${s.n}</span></td>`;
      else h += `<td class="next">#${s.n}</td>`;
    }
    h += '</tr>';
  }
  h += '</tbody><tbody class="sum">';
  const kc = (t) => keepers(t.id).filter((p) => p.status !== 'Not returning').length;
  const made = (t) => st.picks.filter((p) => p.team === t.id).length;
  for (const [lab, f] of [['Keepers', kc], ['Picks owed', (t) => st.open[t.id] ?? 0], ['Picks left', (t) => (st.open[t.id] ?? 0) - made(t)]])
    h += `<tr><th class="rd">${lab}</th>${teams.map((t) => `<td>${f(t)}</td>`).join('')}</tr>`;
  h += `</tbody><tbody class="keep"><tr><th class="rd">Returning</th>${teams.map((t) => `<td>${keepers(t.id).sort((a, b) => (b.age ?? 0) - (a.age ?? 0) || a.name.localeCompare(b.name))
    .map((p) => `<div class="kp ${p.status === 'Not returning' ? 'gone' : ''}" title="${esc(p.status)}"><i class="dot ${dotCls(p.status)}"></i>${esc(p.name)}${p.age ? ` (${esc(p.age)})` : ''}</div>`).join('')}</td>`).join('')}</tr></tbody>`;
  $('board').innerHTML = h;
}
$('board').onclick = (e) => { const td = e.target.closest('[data-slot]'); if (td && isAdmin()) editPick(td.dataset.slot); };

function poolPlayers() { return S.st.players.filter((p) => p.kind === 'pool'); }
function renderPool() {
  const st = S.st, cur = st.current;
  const q = $('poolSearch').value.trim().toLowerCase(), age = $('poolAge').value, showT = $('showTaken').checked;
  const taken = takenIds(), pool = poolPlayers();
  const ages = [...new Set(pool.map((p) => p.age).filter(Boolean))].sort((a, b) => a - b);
  const sel = $('poolAge'), prev = sel.value;
  sel.innerHTML = '<option value="">All ages</option>' + ages.map((a) => `<option value="${a}">Age ${a}</option>`).join('');
  sel.value = prev;
  const avail = pool.filter((p) => !taken.has(p.id) && p.status !== 'Not returning');
  $('poolCount').textContent = `${avail.length} left · ${avail.filter((p) => p.status === 'Registered').length} registered`;
  if (!pool.length) { $('pool').innerHTML = `<li class="empty">No players in the pool yet.${isAdmin() ? ' Add the kids eligible to move up in <b>Setup → Add to draft pool</b>, or let SportsEngine registrations create them.' : ''}</li>`; return; }
  const list = pool.filter((p) => (showT || !taken.has(p.id)) && (!q || p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q)) && (!age || String(p.age) === age))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  if (!list.length) { $('pool').innerHTML = '<li class="empty">No players match.</li>'; return; }
  const t = cur && team(cur.team);
  $('pool').innerHTML = list.map((p) => {
    const tk = taken.has(p.id), by = tk ? team(st.picks.find((x) => x.player === p.id).team)?.name : '';
    const out = p.status === 'Not returning';
    return `<li class="${tk || out ? 'taken' : ''}"><div><div class="nm kp ${out ? 'gone' : ''}" title="${esc(p.status)}"><i class="dot ${dotCls(p.status)}"></i>${p.rank != null ? `<span class="sub">${esc(p.rank)}.</span> ` : ''}${esc(p.name)}</div>
      <div class="sub">${esc(p.status)}${p.age ? ` · Age ${esc(p.age)}` : ''}${p.notes ? ` · ${esc(p.notes)}` : ''}${tk ? ` · ${esc(by)}` : ''}</div></div>
      ${!tk && !out && isAdmin() && t ? `<button class="btn primary" data-draft="${esc(p.id)}" title="Draft to ${esc(t.name)}">Draft</button>` : ''}</li>`;
  }).join('');
}
$('poolSearch').oninput = $('poolAge').onchange = $('showTaken').onchange = () => S.st && renderPool();
$('pool').onclick = async (e) => {
  const b = e.target.closest('[data-draft]'); if (!b) return;
  b.disabled = true;
  await act('POST', '/api/admin/pick', { playerId: b.dataset.draft });
};

function renderTeams() {
  const st = S.st;
  $('teams').innerHTML = st.teams.map((t) => {
    const ks = keepers(t.id).filter((p) => p.status !== 'Not returning');
    const ps = st.picks.filter((p) => p.team === t.id).sort((a, b) => a.n - b.n);
    return `<div class="team"><div class="bar" style="${hdrStyle(t)};${t.color.toUpperCase() === '#FFFFFF' ? 'border-bottom:1px solid var(--line)' : ''}"><span>${esc(t.name)}</span><span>${ks.length + ps.length}/${st.settings.rosterSize}</span></div><ol>
      ${ks.map((p) => `<li><i class="dot ${dotCls(p.status)}" title="${esc(p.status)}"></i> ${esc(p.name)}${p.age ? ` (${esc(p.age)})` : ''}<span class="tag">returning</span></li>`).join('')}
      ${ps.map((p) => { const pl = player(p.player); return `<li><i class="dot ${dotCls(pl?.status)}" title="${esc(pl?.status)}"></i> ${esc(pl?.name || '(removed)')}${pl?.age ? ` (${esc(pl.age)})` : ''}<span class="tag">Rd ${p.round} · #${p.n}</span></li>`; }).join('')}</ol></div>`;
  }).join('');
}

/* ---------- dialogs ---------- */
function openDialog(html, bind) {
  const d = $('dlg'); d.innerHTML = html; bind?.(d); d.showModal();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); d.close(); }));
}
function editPick(key) {
  const p = pickMap()[key]; if (!p) return;
  const pl = player(p.player), t = team(p.team), taken = takenIds();
  const options = poolPlayers().filter((x) => !taken.has(x.id) && x.status !== 'Not returning').sort((a, b) => a.name.localeCompare(b.name));
  openDialog(`<div class="dlg"><h2>Pick #${p.n} · ${esc(t?.name)}</h2>
    <p>Currently <b>${esc(pl?.name || '(removed)')}</b>, round ${p.round}.</p>
    <label class="note" for="swapSel">Replace with another available player</label>
    <select id="swapSel"><option value="">—</option>${options.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.age ? ` (${x.age})` : ''}</option>`).join('')}</select>
    <div class="row"><button class="btn primary" id="doSwap">Replace</button><button class="btn danger" id="doRemove">Remove this pick</button><span class="spacer"></span><button class="btn" data-close>Close</button></div>
    <p class="note">Removing a pick reopens its slot; the clock goes back to the earliest open pick.</p></div>`, (d) => {
    d.querySelector('#doSwap').onclick = async () => { const v = d.querySelector('#swapSel').value; if (!v) return; if (await act('PUT', `/api/admin/picks/${encodeURIComponent(key)}`, { playerId: v }, 'Pick replaced')) d.close(); };
    d.querySelector('#doRemove').onclick = async () => { if (await act('DELETE', `/api/admin/picks/${encodeURIComponent(key)}`, undefined, 'Pick removed')) d.close(); };
  });
}

function playerForm(p) {
  const st = S.st;
  openDialog(`<form id="pf"><h2>${p ? 'Edit player' : 'Add player'}</h2>
    <div class="row"><label for="fName">Name</label><input type="text" id="fName" required value="${esc(p?.name)}" style="flex:1"></div>
    <div class="row"><label for="fType">Type</label><select id="fType" style="width:auto"><option value="pool">Draft pool</option><option value="returning">Returning</option></select>
      <select id="fTeam" style="width:auto" aria-label="Team">${st.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>
    <div class="row"><label for="fAge">Age</label><input type="number" id="fAge" style="width:80px" value="${esc(p?.age)}" ${p ? '' : 'required'}>${p ? `<input type="date" id="fDob" style="width:auto" value="${esc(p.birthdate)}" aria-label="Birthdate">` : ''}</div>
    ${p ? `<div class="row"><label for="fStatus">Status</label><select id="fStatus" style="width:auto">${STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label style="min-width:0;font-weight:500"><input type="checkbox" id="fLock" ${p.locked ? 'checked' : ''}> Lock status</label></div>
    <div class="row"><label for="fRank">Eval rank</label><input type="number" id="fRank" style="width:80px" value="${esc(p.rank)}"></div>
    <div class="row"><label for="fSe">SportsEngine id</label><input type="text" id="fSe" style="flex:1" value="${esc(p.seProfileId)}"></div>
    <label for="fNotes" class="note">Eval notes (admins only)</label><textarea id="fNotes" rows="3">${esc(p.notes)}</textarea>` : ''}
    <p class="err-text" id="fErr"></p>
    <div class="row"><button class="btn primary" type="submit">Save</button>${p ? '<button class="btn danger" type="button" id="fDel">Delete player</button>' : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (d) => {
    const type = d.querySelector('#fType'), teamSel = d.querySelector('#fTeam');
    type.value = p?.kind || 'pool'; teamSel.value = p?.teamId || st.teams[0]?.id || '';
    const sync = () => (teamSel.hidden = type.value !== 'returning'); sync(); type.onchange = sync;
    const num = (id) => { const v = d.querySelector(id).value; return v === '' ? null : parseInt(v, 10); };
    d.querySelector('#pf').onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: d.querySelector('#fName').value, kind: type.value, teamId: type.value === 'returning' ? teamSel.value : null, age: num('#fAge') };
      if (p) Object.assign(body, { birthdate: d.querySelector('#fDob').value || null, status: d.querySelector('#fStatus').value, locked: d.querySelector('#fLock').checked,
        rank: num('#fRank'), seProfileId: d.querySelector('#fSe').value.trim() || null, notes: d.querySelector('#fNotes').value });
      try { await call(p ? 'PATCH' : 'POST', p ? `/api/admin/players/${p.id}` : '/api/admin/players', body); toast(p ? 'Saved' : 'Player added'); d.close(); }
      catch (err) { d.querySelector('#fErr').textContent = err.message; }
    };
    const del = d.querySelector('#fDel');
    if (del) del.onclick = async () => {
      if (del.dataset.armed) { if (await act('DELETE', `/api/admin/players/${p.id}`, undefined, 'Player deleted')) d.close(); }
      else { del.dataset.armed = '1'; del.textContent = 'Click again to delete'; }
    };
  });
}

async function showHistory(id) {
  const p = player(id);
  const h = await act('GET', `/api/admin/players/${id}/history`); if (!h) return;
  openDialog(`<div class="dlg"><h2>${esc(p?.name)}</h2>
    <p class="sub">Status <b>${esc(p?.status)}</b>${p?.locked ? ' (locked)' : ''} · set by ${esc(p?.statusSource)}${p?.registeredAt ? ` · registered ${esc(p.registeredAt)} UTC` : ''}${p?.seProfileId ? ` · SE id <code>${esc(p.seProfileId)}</code>` : ''}</p>
    <h3>Registrations</h3>${h.registrations.length ? `<table class="kt">${h.registrations.map((r) => `<tr><td>${esc(r.received_at)}</td><td>${esc(r.source)}</td><td>${esc(r.outcome)}</td><td>${esc(r.note)}</td></tr>`).join('')}</table>` : '<p class="note">None yet.</p>'}
    <h3>History</h3>${h.audit.length ? `<table class="kt">${h.audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="mono">${esc(a.detail)}</td></tr>`).join('')}</table>` : '<p class="note">No changes recorded.</p>'}
    <div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`);
}

/* ---------- players tab ---------- */
function renderPlayers() {
  const st = S.st;
  const tSel = $('plTeam'), sSel = $('plStatus'), tv = tSel.value, sv = sSel.value;
  tSel.innerHTML = '<option value="">All teams</option><option value="-">Undrafted</option>' + st.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  sSel.innerHTML = '<option value="">All statuses</option>' + STATUSES.map((s) => `<option>${s}</option>`).join('');
  tSel.value = tv; sSel.value = sv;
  const pm = Object.fromEntries(st.picks.map((p) => [p.player, p]));
  const teamOf = (p) => (p.kind === 'returning' ? p.teamId : pm[p.id]?.team) || '';
  const q = $('plSearch').value.trim().toLowerCase(), kind = $('plKind').value;
  const list = st.players.filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q))
    && (!kind || p.kind === kind) && (!tv || (tv === '-' ? !teamOf(p) : teamOf(p) === tv)) && (!sv || p.status === sv))
    .sort((a, b) => a.kind.localeCompare(b.kind) || st.teams.findIndex((t) => t.id === teamOf(a)) - st.teams.findIndex((t) => t.id === teamOf(b)) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  const teamOpts = (v) => st.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('plTable').innerHTML = `<tr><th>Player</th><th>Age</th><th>Type</th><th>Team</th><th>Status</th><th title="Lock status against SportsEngine updates">Lock</th><th>Source</th><th>Rank</th><th></th></tr>`
    + (list.length ? list.map((p) => {
      const drafted = pm[p.id];
      return `<tr data-p="${esc(p.id)}" class="${p.status === 'Not returning' ? 'dim' : ''}">
        <td><input type="text" data-f="name" value="${esc(p.name)}" style="min-width:150px" aria-label="Name"></td>
        <td><input type="number" data-f="age" value="${esc(p.age)}" style="width:56px" aria-label="Age"></td>
        <td><select data-f="kind" aria-label="Type"><option value="pool" ${p.kind === 'pool' ? 'selected' : ''}>Pool</option><option value="returning" ${p.kind === 'returning' ? 'selected' : ''}>Returning</option></select></td>
        <td>${p.kind === 'returning' ? `<select data-f="teamId" aria-label="Team">${teamOpts(p.teamId)}</select>` : drafted ? `${esc(team(drafted.team)?.name)} <span class="tag">#${drafted.n}</span>` : '<span class="sub">—</span>'}</td>
        <td><span class="kp"><i class="dot ${dotCls(p.status)}"></i><select data-f="status" aria-label="Status">${STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></span></td>
        <td><input type="checkbox" data-f="locked" ${p.locked ? 'checked' : ''} aria-label="Lock status"></td>
        <td class="sub">${esc(p.statusSource)}</td>
        <td>${p.kind === 'pool' ? `<input type="number" data-f="rank" value="${esc(p.rank)}" style="width:56px" aria-label="Rank">` : ''}</td>
        <td style="white-space:nowrap"><button class="mini" data-edit="${esc(p.id)}">Edit</button> <button class="mini" data-hist="${esc(p.id)}">History</button> <button class="mini" data-del="${esc(p.id)}">Delete</button></td></tr>`;
    }).join('') : '<tr><td colspan="9" class="note">No players match.</td></tr>');
}
['plSearch', 'plKind', 'plTeam', 'plStatus'].forEach((id) => ($(id)[id === 'plSearch' ? 'oninput' : 'onchange'] = () => renderPlayers()));
$('addPlayer').onclick = () => playerForm(null);
$('plTable').onchange = async (e) => {
  const tr = e.target.closest('[data-p]'), f = e.target.dataset.f; if (!tr || !f) return;
  const p = player(tr.dataset.p);
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f === 'age' || f === 'rank') v = v === '' ? null : parseInt(v, 10);
  const body = { [f]: v };
  if (f === 'kind' && v === 'returning') body.teamId = p.teamId || S.st.teams[0]?.id;
  const ok = await act('PATCH', `/api/admin/players/${p.id}`, body, 'Saved');
  if (!ok) render();
};
$('plTable').onclick = (e) => {
  const ed = e.target.closest('[data-edit]'); if (ed) return playerForm(player(ed.dataset.edit));
  const hi = e.target.closest('[data-hist]'); if (hi) return showHistory(hi.dataset.hist);
  const dl = e.target.closest('[data-del]');
  if (dl) { if (dl.dataset.armed) act('DELETE', `/api/admin/players/${dl.dataset.del}`, undefined, 'Player deleted'); else { dl.dataset.armed = '1'; dl.textContent = 'Delete?'; } }
};

/* ---------- registrations tab ---------- */
const OUTCOME_CHIP = { matched: 'good', locked: 'meh', unmatched: 'bad', ambiguous: 'bad', error: 'bad', pending: 'meh', wrong_year: '', ignored: '' };
async function loadRegs() {
  const d = await call('GET', `/api/admin/registrations?filter=${encodeURIComponent($('regFilter').value)}`).catch((e) => { toast(e.message, true); return null; });
  if (!d) return;
  S.regs = d;
  const open = (d.counts.unmatched || 0) + (d.counts.ambiguous || 0) + (d.counts.error || 0) + (d.counts.pending || 0);
  $('regBadge').hidden = !open; $('regBadge').textContent = open;
  if (S.tab === 'regs') renderRegs();
}
function renderRegs() {
  const d = S.regs; if (!d) return;
  const w = d.webhook;
  $('whInfo').innerHTML = w.configured
    ? `<p>Give SportsEngine this endpoint (POST, JSON):</p><code>${esc(w.url)}</code>
       <p class="note">${w.signed ? `Signatures are <b>required</b> (HMAC-SHA256 in <code>${esc(w.signatureHeader)}</code>).` : 'No signing secret set yet: deliveries are accepted on the URL token alone and marked unverified. Set <code>SPORTSENGINE_WEBHOOK_SECRET</code> once SportsEngine issues one.'}</p>
       <p class="note">Only registrations for <b>${esc(S.st.settings.registrationYear)}</b> update statuses. Every delivery is kept, so if SportsEngine's format needs a mapping fix, deliveries can be re-run.</p>`
    : `<p>Not switched on yet. Set <code>SPORTSENGINE_WEBHOOK_TOKEN</code> in <code>.env</code> and restart; the URL to give SportsEngine will appear here.</p><p class="note">Meanwhile, import the registration report CSV below.</p>`;
  const labels = { matched: 'Matched', locked: 'Locked', unmatched: 'Unmatched', ambiguous: 'Ambiguous', error: 'Error', pending: 'Pending', wrong_year: 'Other years', ignored: 'Ignored' };
  $('regCounts').innerHTML = Object.entries(labels).filter(([k]) => d.counts[k]).map(([k, l]) => `<span class="chip ${OUTCOME_CHIP[k]}">${l} ${d.counts[k]}</span>`).join('') || '<span class="note">No registrations received yet.</span>';
  const opts = S.st.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.age ? ` (${p.age})` : ''} · ${p.kind === 'returning' ? esc(team(p.teamId)?.name) : 'pool'}</option>`).join('');
  $('regTable').innerHTML = `<tr><th>Received (UTC)</th><th>Source</th><th>Participant</th><th>DOB</th><th>Year</th><th>Outcome</th><th>Player</th><th>Note</th><th></th></tr>`
    + (d.rows.length ? d.rows.map((r) => {
      const needs = ['unmatched', 'ambiguous', 'error', 'pending'].includes(r.outcome);
      return `<tr data-r="${r.id}"><td class="sub">${esc(r.received_at)}</td><td>${esc(r.source)}${r.source === 'webhook' && !r.verified ? ' <span class="tag">unverified</span>' : ''}</td>
        <td><b>${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '—')}</b>${r.event_type ? `<div class="sub">${esc(r.event_type)}</div>` : ''}</td>
        <td>${esc(r.birthdate || '')}</td><td>${esc(r.reg_year || '')}</td>
        <td><span class="chip ${OUTCOME_CHIP[r.outcome] ?? ''}">${esc(labels[r.outcome] || r.outcome)}</span></td>
        <td>${esc(r.player_name || '')}</td><td class="sub">${esc(r.note)}</td>
        <td style="white-space:nowrap">${needs ? `<select data-link aria-label="Link to player" style="width:170px"><option value="">Link to…</option><option value="__new">+ New pool player</option>${opts}</select> <button class="mini" data-ignore>Ignore</button> ` : ''}<button class="mini" data-rerun>Re-run</button> <button class="mini" data-raw>Raw</button></td></tr>`;
    }).join('') : '<tr><td colspan="9" class="note">Nothing here.</td></tr>');
}
$('regFilter').onchange = loadRegs;
$('regReprocess').onclick = async () => { const t = await act('POST', '/api/admin/registrations/reprocess-open', {}); if (t) { toast(Object.entries(t).map(([k, v]) => `${v} ${k}`).join(', ') || 'Nothing to re-run'); loadRegs(); } };
$('regTable').onchange = async (e) => {
  if (!e.target.matches('[data-link]') || !e.target.value) return;
  const id = e.target.closest('[data-r]').dataset.r, v = e.target.value;
  const r = await act('POST', `/api/admin/registrations/${id}/link`, { playerId: v === '__new' ? null : v });
  if (r) { toast(`Linked: ${r.note}`); loadRegs(); }
};
$('regTable').onclick = async (e) => {
  const tr = e.target.closest('[data-r]'); if (!tr) return;
  const id = tr.dataset.r;
  if (e.target.matches('[data-ignore]')) { if (await act('POST', `/api/admin/registrations/${id}/ignore`, {}, 'Ignored')) loadRegs(); }
  if (e.target.matches('[data-rerun]')) { const r = await act('POST', `/api/admin/registrations/${id}/reprocess`, {}); if (r) { toast(`${r.outcome}: ${r.note}`); loadRegs(); } }
  if (e.target.matches('[data-raw]')) {
    const r = await act('GET', `/api/admin/registrations/${id}`); if (!r) return;
    let pretty = r.raw; try { pretty = JSON.stringify(JSON.parse(r.raw), null, 2); } catch { /* keep */ }
    openDialog(`<div class="dlg"><h2>Registration #${r.id}</h2><pre>${esc(pretty)}</pre><div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`);
  }
};
$('regFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('regCsv').value = await f.text(); };
$('regImport').onclick = async () => {
  const text = $('regCsv').value.trim(); if (!text) return toast('Choose or paste a CSV first', true);
  const t = await act('POST', '/api/admin/registrations/import', { text });
  if (t) { toast(Object.entries(t).map(([k, v]) => `${v} ${k}`).join(', ')); $('regCsv').value = ''; $('regFile').value = ''; loadRegs(); }
};
$('mSave').onclick = async () => {
  const body = { firstName: $('mFirst').value.trim(), lastName: $('mLast').value.trim(), birthdate: $('mDob').value || undefined, season: $('mSeason').value.trim() || undefined };
  if (!body.firstName || !body.lastName) return toast('First and last name are required', true);
  const r = await act('POST', '/api/admin/registrations/manual', body);
  if (r) { toast(`${r.outcome}: ${r.note}`); ['mFirst', 'mLast', 'mDob', 'mSeason'].forEach((i) => ($(i).value = '')); loadRegs(); }
};

/* ---------- setup tab ---------- */
function renderSetup() {
  const st = S.st, s = st.settings;
  $('seasonIn').value = s.season || ''; $('regYear').value = s.registrationYear; $('ageCutoff').value = s.ageCutoff;
  $('rosterSize').value = s.rosterSize; $('mode').value = s.mode;
  const opts = (v) => '<option value="">—</option>' + st.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('swapA').innerHTML = opts(s.swap?.[0]); $('swapB').innerHTML = opts(s.swap?.[1]);
  $('order').innerHTML = st.teams.map((t, i) => `<li data-t="${esc(t.id)}"><input type="color" data-c="color" value="${esc(t.color)}" aria-label="${esc(t.name)} color" title="Header color">
    <input type="color" data-c="fg" value="${esc(t.fg)}" aria-label="${esc(t.name)} text color" title="Header text color">
    <input type="text" data-c="name" value="${esc(t.name)}" class="nm" aria-label="Team name">
    <button class="mini" data-mv="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} up">↑</button><button class="mini" data-mv="${i}" data-d="1" ${i === st.teams.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} down">↓</button>
    <button class="mini" data-rmt="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">✕</button></li>`).join('');
}
const patchSettings = (b, msg = 'Saved') => act('PATCH', '/api/admin/settings', b, msg);
$('seasonIn').onchange = (e) => patchSettings({ season: e.target.value.trim() });
$('regYear').onchange = (e) => patchSettings({ registrationYear: parseInt(e.target.value, 10) });
$('ageCutoff').onchange = (e) => patchSettings({ ageCutoff: e.target.value.trim() });
$('rosterSize').onchange = (e) => patchSettings({ rosterSize: parseInt(e.target.value, 10) || 12 });
$('mode').onchange = (e) => patchSettings({ mode: e.target.value });
$('swapA').onchange = $('swapB').onchange = () => patchSettings({ swap: [$('swapA').value, $('swapB').value] });
$('order').onchange = (e) => {
  const li = e.target.closest('[data-t]'); if (!li) return;
  const t = team(li.dataset.t);
  const body = { name: t.name, color: t.color, fg: t.fg, [e.target.dataset.c]: e.target.value };
  act('PATCH', `/api/admin/teams/${t.id}`, body, 'Team saved');
};
$('order').onclick = (e) => {
  const mv = e.target.closest('[data-mv]');
  if (mv) { const o = S.st.teams.map((t) => t.id), i = +mv.dataset.mv, j = i + +mv.dataset.d;[o[i], o[j]] = [o[j], o[i]]; return act('PUT', '/api/admin/order', { order: o }); }
  const rm = e.target.closest('[data-rmt]');
  if (rm) { if (rm.dataset.armed) act('DELETE', `/api/admin/teams/${rm.dataset.rmt}`, undefined, 'Team removed'); else { rm.dataset.armed = '1'; rm.textContent = 'Remove?'; } }
};
$('addTeam').onclick = () => act('POST', '/api/admin/teams', { name: 'New team', color: '#14213D', fg: '#FFFFFF' }, 'Team added');
$('importBtn').onclick = async () => { const d = await act('POST', '/api/admin/pool/import', { text: $('importBox').value }); if (d) { toast(d.added ? `Added ${d.added} player${d.added > 1 ? 's' : ''} to the pool` : 'No new names found'); if (d.added) $('importBox').value = ''; } };
$('undo').onclick = () => act('POST', '/api/admin/undo', {}, 'Last pick undone');
$('restartClock').onclick = () => act('POST', '/api/admin/clock/start', {}, 'Clock restarted');
$('reset').onclick = async () => {
  if ($('clearConfirm').value.trim() !== 'CLEAR') return toast('Type CLEAR in the box to confirm', true);
  if (await act('POST', '/api/admin/picks/clear', { confirm: 'CLEAR' }, 'All picks cleared')) $('clearConfirm').value = '';
};

/* ---------- activity tab ---------- */
async function loadLog() { S.log = await call('GET', '/api/admin/audit').catch(() => null); if (S.tab === 'log') renderLog(); }
function renderLog() {
  if (!S.log) { $('logTable').innerHTML = '<tr><td class="note">Loading…</td></tr>'; return; }
  $('logTable').innerHTML = '<tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Player</th><th>Detail</th></tr>'
    + S.log.map((a) => `<tr><td class="sub">${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td>${esc(a.player_name || '')}</td><td class="mono">${esc(a.detail)}</td></tr>`).join('');
}
$('logRefresh').onclick = loadLog;

/* ---------- tabs ---------- */
function setTab(t) {
  if (!document.querySelector(`[data-tab="${t}"]`) || (document.querySelector(`[data-tab="${t}"]`).hasAttribute('data-admin') && !isAdmin())) t = 'board';
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  ['board', 'teams', 'players', 'regs', 'setup', 'log'].forEach((v) => ($('view-' + v).hidden = v !== t));
  try { localStorage.setItem('tab', t); } catch { /* private mode */ }
  if (t === 'regs') loadRegs();
  if (t === 'log') loadLog();
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

/* ---------- gates ---------- */
function gate(html, bind) { $('app').hidden = true; const g = $('gate'); g.innerHTML = html; g.hidden = false; bind(g); }
function loginGate() {
  gate(`<form class="gate" id="lf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">SE Major Draft Board</small>Admin login</h1>
    <input type="text" id="lu" placeholder="Username" autocomplete="username" required aria-label="Username">
    <input type="password" id="lp" placeholder="Password" autocomplete="current-password" required aria-label="Password">
    <p class="err-text" id="le"></p><button class="btn primary" type="submit">Log in</button><a href="/" class="note">← Back to the board</a></form>`, (g) => {
    g.querySelector('#lu').focus();
    g.querySelector('#lf').onsubmit = async (e) => {
      e.preventDefault();
      try { await call('POST', '/api/login', { username: g.querySelector('#lu').value, password: g.querySelector('#lp').value }); location.reload(); }
      catch (err) { g.querySelector('#le').textContent = err.message; }
    };
  });
}
function viewerGate() {
  gate(`<form class="gate" id="vf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">SE Baseball Majors</small>Draft Board</h1>
    <p class="note">Enter the league's board code to watch the draft.</p>
    <input type="password" id="vc" placeholder="Board code" required aria-label="Board code">
    <p class="err-text" id="ve"></p><button class="btn primary" type="submit">Watch the draft</button><a href="/admin" class="note">Admin login</a></form>`, (g) => {
    g.querySelector('#vc').focus();
    g.querySelector('#vf').onsubmit = async (e) => {
      e.preventDefault();
      try { await call('POST', '/api/viewer', { code: g.querySelector('#vc').value }); location.reload(); }
      catch (err) { g.querySelector('#ve').textContent = err.message; }
    };
  });
}

/* ---------- boot ---------- */
async function refresh() {
  try {
    const st = await call('GET', '/api/state');
    S.skew = st.serverNow - Date.now();
    S.st = st;
    render();
    if (isAdmin() && S.tab !== 'regs') loadRegs(); // keep the inbox badge current
    if (isAdmin() && S.tab === 'log') loadLog();
  } catch (e) { toast(e.message, true); }
}
let refreshTimer;
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('change', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); });
  es.onopen = () => { S.live = true; refresh(); };
  es.onerror = () => { S.live = false; if (S.st) renderClock(); };
}

(async () => {
  S.me = await call('GET', '/api/me');
  const wantsAdmin = location.pathname.startsWith('/admin');
  if (wantsAdmin && !S.me.admin) return loginGate();
  if (!S.me.viewer) return viewerGate();
  $('app').hidden = false;
  await refresh();
  let t = 'board';
  try { t = localStorage.getItem('tab') || 'board'; } catch { /* private mode */ }
  setTab(t);
  connect();
})();
