/* Draft room — one per division per season (Majors, Minors, Rookie, T-Ball...).
   The server owns the draft: it computes the slot order, validates every pick
   and pushes a change event over SSE; this file renders /api/drafts/:id/state
   and sends admin actions back. A blind draft (T-Ball) shows numbered tiles
   instead of names until a number is picked. */
'use strict';

const S = { st: null, me: null, home: null, id: null, tab: 'board', live: false, skew: 0 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const dotCls = (s) => ({ Registered: 'Registered', Expected: 'Expected', 'Need to contact': 'Need', 'Not returning': 'Not-returning', Withdrawn: 'Withdrawn', Waitlist: 'Waitlist' }[s] || '');
const isAdmin = () => !!S.st?.canWrite;
const canSee = () => !!S.st?.canSee; // admins and the Board see notes and the player sheet
const now = () => Date.now() + S.skew;
const OUT = ['Not returning', 'Withdrawn'];
// Green on the name: light = the family said they're coming back, bold = registered. Not returning keeps the strike-through.
const cmCls = (p) => (p?.commit ? ` cm-${p.commit}` : '');
const cmTip = (p) => (p?.commit === 'reg' ? 'Registered' : p?.commit === 'yes' ? 'Family says coming back' : '');
const A = (path) => `/api/admin/drafts/${encodeURIComponent(S.id)}${path}`;

function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), err ? 4500 : 2600); }
async function call(method, url, body) {
  // Every mutation goes out as JSON (even a bodiless DELETE) — the server's CSRF guard requires it.
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
}
async function act(method, url, body, okMsg) {
  try { const d = await call(method, url, body); if (okMsg || d?.message) toast(d?.message || okMsg); return d || {}; }
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
const blind = () => S.st.draft.format === 'blind';
const label = (p) => (p ? (p.name ?? `#${p.number}`) : '(removed)');

/* ---------- render ---------- */
function render() {
  if (!S.st) return;
  const st = S.st, d = st.draft;
  document.title = `${st.season.year} ${d.name} Draft`;
  $('season').textContent = `${S.home?.league || 'SE Baseball'} · ${st.season.year}`;
  $('title').textContent = `${d.name} Draft`;
  document.querySelectorAll('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
  $('rostersCsv').href = `/api/drafts/${encodeURIComponent(S.id)}/rosters.csv`;
  renderWho();
  renderBlocked();
  renderClock();
  renderOrphans();
  $('reviewBtn').hidden = !canSee() || blind();
  if (S.tab === 'board') { renderBoard(); renderPool(); renderCoachKids(); }
  if (S.tab === 'teams') renderTeams();
  const ae = document.activeElement;
  const typing = ae?.closest?.('section') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox';
  if (S.tab === 'setup' && !typing) renderSetup();
}

function renderWho() {
  $('whoami').innerHTML = `Signed in as <b>${esc(S.me.user.email)}</b>${S.me.admin ? ' (admin)' : ''} · <button id="logout">Log out</button>`;
  $('logout').onclick = async () => { await act('POST', '/api/logout', {}); location.href = '/signin'; };
  const base = S.home?.leagueUrl || '';
  $('tools').innerHTML = `<span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'Live' : 'Reconnecting'}</span> <a href="${esc(base)}/">League home</a>`;
}

function renderBlocked() {
  const d = S.st.draft, b = $('blocked');
  const msg = d.status === 'closed'
    ? `This draft is closed.${d.next ? ` Undrafted players moved on to the ${esc(d.next)} draft.` : ''}`
    : d.blocked ? `${esc(d.blocked)} — the available players below are who will be eligible.` : '';
  b.hidden = !msg; b.innerHTML = msg;
}

function renderClock() {
  const st = S.st, pm = pickMap(), cur = st.current;
  const total = st.slots.length, made = st.picks.length;
  const live = `<span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'Live' : 'Reconnecting'}</span>`;
  if (!st.teams.length) { $('clock').innerHTML = `<div><div class="who">No teams yet</div><div class="meta">${isAdmin() ? 'Add teams in Setup.' : 'Check back once the teams are set up.'}</div></div><span class="spacer"></span>${live}`; return; }
  if (!cur) { $('clock').innerHTML = `<div><div class="who">Draft complete</div><div class="meta">${made} of ${total} picks made · every roster is at ${st.draft.rosterSize}</div></div><span class="spacer"></span>${live}`; return; }
  const t = team(cur.team);
  const upNext = st.slots.filter((s) => !pm[s.key]).slice(1, 4).map((s) => team(s.team).name).join(', ');
  const cs = st.clock.clockStart;
  const canPick = !st.draft.blocked;
  $('clock').innerHTML = `<div><div class="meta">On the clock</div><div class="who" style="color:${teamColor(t)}">${esc(t.name)}</div></div>
    <div class="meta">Round ${cur.round} · Pick #${cur.n} of ${total}${cur.comp ? ' <span class="chip comp">Comp round</span>' : ''}<br>Up next: ${esc(upNext || '—')}</div>
    <span class="spacer"></span>${live}${isAdmin() && canPick ? `<button class="btn" id="undoTop" ${made ? '' : 'disabled'}>Undo</button>` : ''}
    ${cs ? `<div class="timer" id="timer"><span class="lbl">On the clock for</span><span class="t" id="timerT">${fmt(now() - cs)}</span></div>`
      : isAdmin() && canPick ? `<button class="btn primary" id="startClock">Start draft clock</button>` : `<div class="timer"><span class="lbl">Clock starts when the draft begins</span></div>`}`;
  const u = $('undoTop'); if (u) u.onclick = () => act('POST', A('/undo'), {}, 'Last pick undone');
  const sc = $('startClock'); if (sc) sc.onclick = () => act('POST', A('/clock/start'), {}, 'Clock started');
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
  box.innerHTML = `<b>${o.length} pick${o.length > 1 ? 's' : ''} no longer fit the board</b> — a team now owes fewer picks than it has made (usually a returner was switched back). Remove or keep: `
    + o.map((k) => { const p = pm[k]; return `<span class="chip">${esc(team(p.team)?.name)} · ${esc(label(player(p.player)))} <button class="mini" data-orph="${esc(k)}">Remove</button></span>`; }).join(' ');
  box.querySelectorAll('[data-orph]').forEach((b) => (b.onclick = () => act('DELETE', A(`/picks/${encodeURIComponent(b.dataset.orph)}`), undefined, 'Pick removed')));
}

function renderBoard() {
  const st = S.st, teams = st.teams, pm = pickMap(), cur = st.current;
  const rounds = Math.max(st.maxRound, 1);
  const byKey = Object.fromEntries(st.slots.map((s) => [s.key, s]));
  let h = `<thead><tr><th class="rd">Round</th>${teams.map((t) => `<th style="${hdrStyle(t)}">${esc(t.name)}<div class="thcoach" title="Head coach">${t.coach ? esc(t.coach) : '<i>No coach yet</i>'}</div>${t.record ? `<div style="font-size:.7rem;font-weight:600;opacity:.85">${esc(t.record)}</div>` : ''}</th>`).join('')}</tr></thead><tbody>`;
  for (let r = 1; r <= rounds; r++) {
    const comp = r > st.minRound;
    h += `<tr><th class="rd">Rd ${r}${comp ? '<br><span class="chip comp">Comp</span>' : ''}</th>`;
    for (const t of teams) {
      const s = byKey[`${r}-${t.id}`];
      if (!s) { h += `<td class="full" title="${esc(t.name)} roster is full">—</td>`; continue; }
      const p = pm[s.key];
      if (p) {
        const pl = player(p.player);
        const ckc = pl?.coachOf ? ckCheck(pl) : null;
        h += `<td class="picked${isAdmin() ? ' editable' : ''}${ckc ? ` ck ck-${ckc.cls}` : ''}" ${isAdmin() ? `data-slot="${esc(s.key)}" title="${ckc ? `${esc(ckc.text)} — ` : ''}Edit this pick"` : ckc ? `title="${esc(ckc.text)}"` : ''}>${ckc ? ckBadge(pl) : ''}<span class="nm${cmCls(pl)}"${cmTip(pl) ? ` title="${cmTip(pl)}"` : ''}>${esc(label(pl))}</span>${pl?.age ? ` <span class="ag">(${esc(pl.age)})</span>` : ''}<span class="pk">#${s.n}${pl?.number ? ` · no. ${pl.number}` : ''}${p.sibling ? ' · sibling pick' : ''}</span>${p.took != null ? `<span class="tk" title="Time on the clock">${fmt(p.took)}</span>` : ''}</td>`;
      } else if (cur && cur.key === s.key) h += `<td class="onclock">On the clock<span class="pk" style="color:inherit">#${s.n}</span></td>`;
      else h += `<td class="next">#${s.n}</td>`;
    }
    h += '</tr>';
  }
  h += '</tbody><tbody class="sum">';
  const kc = (t) => keepers(t.id).filter((p) => !OUT.includes(p.status)).length;
  const made = (t) => st.picks.filter((p) => p.team === t.id).length;
  for (const [lab, f] of [['Returning', kc], ['Picks owed', (t) => st.open[t.id] ?? 0], ['Picks left', (t) => (st.open[t.id] ?? 0) - made(t)]])
    h += `<tr><th class="rd">${lab}</th>${teams.map((t) => `<td>${f(t)}</td>`).join('')}</tr>`;
  h += '</tbody>';
  if (teams.some((t) => keepers(t.id).length)) {
    h += `<tbody class="keep"><tr><th class="rd">Returning</th>${teams.map((t) => `<td>${keepers(t.id).sort((a, b) => (b.age ?? 0) - (a.age ?? 0) || a.name.localeCompare(b.name))
      .map((p) => `<div class="kp ${OUT.includes(p.status) ? 'gone' : ''}${p.coachOf ? ` ck ck-${ckCheck(p).cls}` : ''}" title="${p.coachOf ? `${esc(ckCheck(p).text)} · ` : ''}"${esc(p.status)}${p.lastNote ? ` — “${esc(p.lastNote.text)}”` : ''}"><i class="dot ${dotCls(p.status)}"></i><span class="kn"><span class="${cmCls(p).trim()}">${canSee() ? `<button class="plink" data-psheet="${esc(p.id)}">${esc(p.name)}</button>` : esc(p.name)}</span>${p.age ? ` <span class="ag">(${esc(p.age)})</span>` : ''}${p.coachOf ? ` ${ckBadge(p)}` : ''}${p.lastNote ? ' <span class="pn" aria-label="has notes">✎</span>' : ''}</span></div>`).join('')}</td>`).join('')}</tr></tbody>`;
  }
  $('board').innerHTML = h;
}
$('board').onclick = (e) => {
  const ps = e.target.closest('[data-psheet]'); if (ps) return openSheet(ps.dataset.psheet);
  const td = e.target.closest('[data-slot]'); if (td && isAdmin()) editPick(td.dataset.slot);
};

/* ---------- coaches' kids: badge them everywhere, and check each is where they belong ---------- */
const ckBadge = (p) => `<span class="ckb${p.coachOf.sure ? '' : ' maybe'}" title="${esc(p.coachOf.sure ? `Coach ${p.coachOf.coach}'s kid (${p.coachOf.team})` : `Possibly Coach ${p.coachOf.coach}'s kid — same last name`)}" aria-label="Coach's kid">C</span>`;
function ckCheck(p) {
  const c = p.coachOf, pick = S.st.picks.find((x) => x.player === p.id);
  const on = p.kind === 'returning' ? p.teamId : pick?.team;
  const parent = `${c.sure ? '' : 'Possibly '}Coach ${c.coach}'s kid`;
  if (OUT.includes(p.status)) return { cls: 'info', text: `${parent} · ${p.status}` };
  if (!c.here) return { cls: 'info', text: `${parent} · coaches ${c.team} (${c.division})` };
  if (on === c.teamId) return { cls: 'ok', text: `${parent} · on ${c.team} — ${p.kind === 'returning' ? 'returning' : `round ${pick.round}, pick #${pick.n}${pick.sibling ? ' (sibling pick)' : ''}`}` };
  if (on) return { cls: 'bad', text: `${parent} · on ${team(on)?.name} — parent coaches ${c.team}` };
  return { cls: c.sure ? 'warn' : 'info', text: `${parent} · not on ${c.team} yet${c.sure ? ' — add a sibling pick' : ''}` };
}
function renderCoachKids() {
  const box = $('ckBar'), list = S.st.players.filter((p) => p.coachOf && !p.hidden && p.coachOf.here)
    .sort((a, b) => a.coachOf.team.localeCompare(b.coachOf.team) || a.name.localeCompare(b.name));
  box.hidden = !list.length;
  if (!list.length) return;
  const rows = list.map((p) => ({ p, c: ckCheck(p) }));
  const need = rows.filter((r) => r.c.cls === 'warn' || r.c.cls === 'bad').length;
  const open = box.querySelector('details')?.open ?? need > 0;
  box.innerHTML = `<details ${open ? 'open' : ''}><summary><span class="ckb">C</span> <b>Coaches’ kids</b> <span class="sub">${list.length} in this draft</span>
      ${need ? `<span class="ckneed">${need} to check</span>` : '<span class="ckok">all on their parent’s team</span>'}</summary>
    <ul>${rows.map(({ p, c }) => `<li class="ck-${c.cls}"><i aria-hidden="true">${c.cls === 'ok' ? '✓' : c.cls === 'bad' ? '✕' : c.cls === 'warn' ? '!' : '·'}</i>
      ${canSee() ? `<button class="plink" data-psheet="${esc(p.id)}">${esc(p.name)}</button>` : esc(p.name)}${p.age ? ` <span class="sub">(${esc(p.age)})</span>` : ''}
      <span class="sub">${esc(c.text.replace(/^(Possibly )?Coach [^·]*· /, '').replace(/^on /, ''))}${p.coachOf.sure ? '' : ' · possible — same last name as the coach'}</span></li>`).join('')}</ul></details>`;
}
$('ckBar').onclick = (e) => { const ps = e.target.closest('[data-psheet]'); if (ps) openSheet(ps.dataset.psheet); };

function poolPlayers() { return S.st.players.filter((p) => p.kind === 'pool'); }
function renderPool() {
  const st = S.st, cur = st.current, taken = takenIds(), pool = poolPlayers();
  const isBlind = blind();
  $('pool').hidden = $('poolTools').hidden = isBlind; $('numbers').hidden = !isBlind;
  $('poolTitle').textContent = isBlind ? 'Numbers' : 'Available';
  const avail = pool.filter((p) => !taken.has(p.id) && !OUT.includes(p.status));
  const t = cur && team(cur.team);
  const canPick = isAdmin() && t && !st.draft.blocked;
  if (isBlind) {
    const nums = pool.filter((p) => p.number).sort((a, b) => a.number - b.number);
    $('poolCount').textContent = `${avail.filter((p) => p.number).length} left`;
    if (!nums.length) { $('numbers').innerHTML = `<p class="empty" style="grid-column:1/-1">${avail.length ? `${avail.length} kids are waiting for numbers.${isAdmin() ? ' Hand them out in <b>Setup</b>.' : ''}` : 'No kids in this draft yet.'}</p>`; return; }
    $('numbers').innerHTML = nums.map((p) => taken.has(p.id)
      ? `<button class="revealed" disabled title="${esc(p.name)}"><b>${p.number}</b>${esc(p.name)}<br>${esc(team(st.picks.find((x) => x.player === p.id).team)?.name)}</button>`
      : `<button data-number="${p.number}" ${canPick ? `title="Pick number ${p.number} for ${esc(t.name)}"` : 'disabled'}>${p.number}</button>`).join('')
      + (st.unnumbered && isAdmin() ? `<p class="note" style="grid-column:1/-1">${st.unnumbered} more ${st.unnumbered === 1 ? 'kid needs a number' : 'kids need numbers'} — hand them out in Setup.</p>` : '');
    return;
  }
  const q = $('poolSearch').value.trim().toLowerCase(), age = $('poolAge').value, showT = $('showTaken').checked;
  // Kids still on a later division's team (Minors returners) can be filtered apart from the rest of the pool.
  const fromDivs = [...new Set(pool.map((p) => p.from?.division).filter(Boolean))];
  const fs = $('poolFrom'), fprev = fs.value;
  fs.hidden = !fromDivs.length;
  fs.innerHTML = '<option value="">Everyone</option><option value="-">Trying out / new</option>' + fromDivs.map((d) => `<option value="${esc(d)}">${esc(d)} returners</option>`).join('');
  fs.value = [...fs.options].some((o) => o.value === fprev) ? fprev : '';
  const from = fs.value;
  const ages = [...new Set(pool.map((p) => p.age).filter(Boolean))].sort((a, b) => a - b);
  const sel = $('poolAge'), prev = sel.value;
  sel.innerHTML = '<option value="">All ages</option>' + ages.map((a) => `<option value="${a}">Age ${a}</option>`).join('');
  sel.value = prev;
  $('poolCount').textContent = `${avail.length} left · ${avail.filter((p) => p.status === 'Registered').length} registered`;
  if (!pool.length) { $('pool').innerHTML = `<li class="empty">No players in this draft yet.${isAdmin() ? ' Kids join as they register, or from the league site\'s Kids tab.' : ''}</li>`; return; }
  const list = pool.filter((p) => (showT || !taken.has(p.id)) && (!q || p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q)) && (!age || String(p.age) === age)
      && (!from || (from === '-' ? !p.from : p.from?.division === from)))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  if (!list.length) { $('pool').innerHTML = '<li class="empty">No players match.</li>'; return; }
  $('pool').innerHTML = list.map((p) => {
    const tk = taken.has(p.id), by = tk ? team(st.picks.find((x) => x.player === p.id).team)?.name : '';
    const out = OUT.includes(p.status);
    return `<li class="${tk || out ? 'taken' : ''}${p.coachOf ? ` ckrow${p.coachOf.sure ? '' : ' maybe'}` : ''}"><div><div class="nm kp ${out ? 'gone' : ''}" title="${esc(cmTip(p) || p.status)}"><i class="dot ${dotCls(p.status)}"></i>${p.rank != null ? `<span class="sub">${esc(p.rank)}.</span> ` : ''}${p.coachOf ? ckBadge(p) : ''}<span class="${cmCls(p).trim()}">${canSee() ? `<button class="plink" data-psheet="${esc(p.id)}">${esc(p.name)}</button>` : esc(p.name)}</span></div>
      <div class="sub">${esc(p.status)}${p.age ? ` · Age ${esc(p.age)}` : ''}${p.prior ? ` · ${esc(p.prior)}` : ''}${p.playingUp && !tk ? ` · <b>playing up from the ${esc(p.playingUp)}</b>` : ''}${p.from && !tk ? ` · <b>trying out${p.from.assumed ? ' (assumed — hasn’t registered yet)' : ''}</b>` : ''}${p.notes ? ` · ${esc(p.notes)}` : ''}${tk ? ` · ${esc(by)}` : ''}</div>${p.coachOf ? `<div class="cknote ck-${ckCheck(p).cls}">${esc(ckCheck(p).text)}</div>` : ''}${p.lastNote ? `<div class="pnote">“${esc(p.lastNote.text)}” <span>— ${esc(who(p.lastNote.by))}, ${esc(when(p.lastNote.at))}</span></div>` : ''}</div>
      ${!tk && !out && canPick ? `<button class="btn primary" data-draft="${esc(p.id)}" title="Draft to ${esc(t.name)}">Draft</button>` : ''}</li>`;
  }).join('');
}
$('poolSearch').oninput = $('poolAge').onchange = $('poolFrom').onchange = $('showTaken').onchange = () => S.st && renderPool();
$('pool').onclick = async (e) => {
  const ps = e.target.closest('[data-psheet]'); if (ps) return openSheet(ps.dataset.psheet);
  const b = e.target.closest('[data-draft]'); if (!b) return;
  b.disabled = true;
  await act('POST', A('/pick'), { playerId: b.dataset.draft });
};
$('numbers').onclick = async (e) => {
  const b = e.target.closest('[data-number]'); if (!b || b.disabled) return;
  const t = team(S.st.current?.team);
  if (!confirm(`Pick number ${b.dataset.number} for ${t?.name}?`)) return;
  b.disabled = true;
  await act('POST', A('/pick'), { number: +b.dataset.number });
};

function renderTeams() {
  const st = S.st;
  $('teams').innerHTML = st.teams.map((t) => {
    const ks = keepers(t.id).filter((p) => !OUT.includes(p.status));
    const ps = st.picks.filter((p) => p.team === t.id).sort((a, b) => a.n - b.n);
    return `<div class="team"><div class="bar" style="${hdrStyle(t)};${t.color.toUpperCase() === '#FFFFFF' ? 'border-bottom:1px solid var(--line)' : ''}"><span>${esc(t.name)}${t.coach ? `<small class="tcoach">Coach ${esc(t.coach)}</small>` : ''}</span><span>${ks.length + ps.length}/${st.draft.rosterSize}</span></div><ol>
      ${ks.map((p) => `<li><i class="dot ${dotCls(p.status)}" title="${esc(p.status)}"></i> <span class="${cmCls(p).trim()}">${esc(p.name)}</span>${p.age ? ` (${esc(p.age)})` : ''}<span class="tag">returning</span></li>`).join('')}
      ${ps.map((p) => { const pl = player(p.player); return `<li><i class="dot ${dotCls(pl?.status)}" title="${esc(pl?.status)}"></i> <span class="${cmCls(pl).trim()}">${esc(label(pl))}</span>${pl?.age ? ` (${esc(pl.age)})` : ''}<span class="tag">Rd ${p.round} · #${p.n}</span></li>`; }).join('')}</ol></div>`;
  }).join('') || '<p class="note">No teams yet.</p>';
}

/* ---------- dialogs ---------- */
function openDialog(html, bind) {
  const d = $('dlg'); d.innerHTML = html; bind?.(d); if (!d.open) d.showModal();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); d.close(); }));
}
function editPick(key) {
  const p = pickMap()[key]; if (!p) return;
  const pl = player(p.player), t = team(p.team), taken = takenIds();
  const options = blind() ? [] : poolPlayers().filter((x) => !taken.has(x.id) && !OUT.includes(x.status)).sort((a, b) => a.name.localeCompare(b.name));
  openDialog(`<div class="dlg"><h2>Pick #${p.n} · ${esc(t?.name)}</h2>
    <p>Currently <b>${esc(label(pl))}</b>, round ${p.round}.</p>
    ${blind() ? '' : `<label class="note" for="swapSel">Replace with another available player</label>
    <select id="swapSel"><option value="">—</option>${options.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.age ? ` (${x.age})` : ''}</option>`).join('')}</select>`}
    <div class="row">${blind() ? '' : '<button class="btn primary" id="doSwap">Replace</button>'}<button class="btn danger" id="doRemove">Remove this pick</button><span class="spacer"></span><button class="btn" data-close>Close</button></div>
    <p class="note">Removing a pick reopens its slot; the clock goes back to the earliest open pick.</p></div>`, (d) => {
    const sw = d.querySelector('#doSwap');
    if (sw) sw.onclick = async () => { const v = d.querySelector('#swapSel').value; if (!v) return; if (await act('PUT', A(`/picks/${encodeURIComponent(key)}`), { playerId: v }, 'Pick replaced')) d.close(); };
    d.querySelector('#doRemove').onclick = async () => { if (await act('DELETE', A(`/picks/${encodeURIComponent(key)}`), undefined, 'Pick removed')) d.close(); };
  });
}

/* ---------- player sheet: what's happening with one kid, and who said so ----------
   Opens from any name on the board or in the pool. Previous / Next walk the whole
   list (returners team by team, then the pool), so the room can go player by player. */
const DECIDE = [['yes', 'Coming back', 'Expected'], ['unsure', 'Needs a call', 'Need to contact'], ['no', 'Not returning', 'Not returning']];
const INTENT_WORD = { yes: 'Coming back', no: 'Not returning', unsure: 'Not sure yet' };
const when = (at) => { const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`); return isNaN(d) ? at : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const who = (a) => (a?.startsWith('family:') ? 'Family' : a?.startsWith('coach:') ? `Coach ${a.slice(6)}` : a === 'system' ? 'System' : a || '?');
function sheetOrder() {
  const st = S.st, pm = new Set(st.picks.map((x) => x.player));
  const ret = st.teams.flatMap((t) => keepers(t.id).sort((a, b) => a.name.localeCompare(b.name)));
  const pool = poolPlayers().filter((p) => !p.hidden && !pm.has(p.id)).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  const drafted = st.picks.slice().sort((a, b) => a.n - b.n).map((x) => player(x.player)).filter((p) => p && !p.hidden);
  return [...ret, ...pool, ...drafted].map((p) => p.id);
}
// A decision also writes a status change at the same moment; show it once.
const tidyHistory = (hs) => hs.filter((h) => !(h.action === 'enrollment_edited' && h.detail && Object.keys(h.detail).join() === 'status'
  && hs.some((o) => o.action === 'interest_answered' && o.by === h.by && o.at === h.at)));
function historyLine(h) {
  const d = h.detail && typeof h.detail === 'object' ? h.detail : {};
  switch (h.action) {
    case 'player_note': return `<q>${esc(d.text)}</q>`;
    case 'interest_answered': return h.by?.startsWith('family:') ? `Family answered <b>${esc(INTENT_WORD[d.answer] || d.answer)}</b>` : `Decision: <b>${esc(DECIDE.find((x) => x[0] === d.answer)?.[1] || d.answer)}</b>`;
    case 'enrollment_edited': return Object.entries(d).map(([k, v]) => `${esc(k.replace(/_/g, ' '))}: ${esc(v?.from ?? '—')} → <b>${esc(v?.to ?? '—')}</b>`).join('<br>') || 'Edited';
    default: {
      const extra = Object.entries(d).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ');
      return `${esc(h.action.replace(/_/g, ' '))}${extra ? ` <span class="sub">${extra}</span>` : typeof h.detail === 'string' && h.detail ? ` <span class="sub">${esc(h.detail)}</span>` : ''}`;
    }
  }
}
async function openSheet(id, data) {
  const pl = player(id);
  let x = data;
  if (!x) { try { x = await call('GET', A(`/players/${encodeURIComponent(id)}`)); } catch (e) { return toast(e.message, true); } }
  const order = sheetOrder(), i = order.indexOf(id), prev = order[i - 1], next = order[i + 1];
  const pick = S.st.picks.find((p) => p.player === id);
  const where = pick ? `Drafted by ${team(pick.team)?.name} · round ${pick.round}` : pl?.kind === 'returning' ? `Returning to ${team(pl.teamId)?.name ?? x.team ?? 'their team'}` : pl?.from ? `Trying out · goes back to ${pl.from.team} (${pl.from.division}) if not drafted` : 'In the draft pool';
  const cur = DECIDE.find((d) => d[2] === x.status)?.[0];
  const fam = x.intentBy === 'family' && x.intent;
  const can = isAdmin(), reg = x.status === 'Registered';
  const ago = x.intentAt ? when(x.intentAt) : '';
  openDialog(`<form class="dlg psheet" method="dialog">
    <div class="pshd"><div><h2>${esc(x.name)}</h2><div class="sub">${pl?.age ? `Age ${esc(pl.age)} · ` : ''}${esc(where)}${x.prior ? ` · ${esc(x.prior)}` : ''}</div></div>
      <span class="chip ${reg ? 'good' : x.status === 'Not returning' || x.status === 'Withdrawn' ? 'bad' : x.status === 'Need to contact' ? 'meh' : ''}"><i class="dot ${dotCls(x.status)}"></i> ${esc(x.status)}</span></div>
    ${reg ? '<p class="psans good"><b>Registered</b> — they’re in. Notes below still help the room.</p>'
      : fam ? `<p class="psans fam"><b>The family answered: ${esc(INTENT_WORD[x.intent])}</b> <span class="sub">${esc(ago)} · only the family can change this</span></p>`
      : x.intent ? `<p class="psans"><b>${esc(DECIDE.find((d) => d[0] === x.intent)?.[1])}</b> <span class="sub">— set by ${x.intentBy === 'coach' ? 'a coach' : 'the league'}${ago ? `, ${esc(ago)}` : ''}; no word from the family directly</span></p>`
      : x.returner ? '<p class="psans muted">No answer from the family yet — “Expected” is the default for every returner.</p>' : ''}
    ${can && !reg ? `<fieldset class="psdec"><legend>Decision</legend>${DECIDE.map(([v, l]) => `<label class="${v}"><input type="radio" name="decision" value="${v}" ${cur === v ? 'checked' : ''} ${fam && v !== x.intent ? 'disabled' : ''}><span>${l}</span></label>`).join('')}</fieldset>` : ''}
    ${can ? `<label class="psnote"><span>What’s happening?</span><textarea name="note" rows="3" maxlength="1000" placeholder="e.g. Talked to Mom 11/17 — moving to Lexington in March, out for 2027."></textarea></label>` : ''}
    ${x.contacts.length ? `<div class="pscon">${x.contacts.map((c) => `<div><b>${esc(c.name || 'Parent')}</b>${c.relation ? ` <span class="sub">${esc(c.relation)}</span>` : ''}${c.email ? ` · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? ` · <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> · <a href="sms:${esc(c.phone)}">text</a>` : ''}</div>`).join('')}</div>` : '<p class="note">No parent contact on file.</p>'}
    <details class="pshist" open><summary>History <span class="sub">${tidyHistory(x.history).length} ${tidyHistory(x.history).length === 1 ? 'entry' : 'entries'} · ${x.season.year}</span></summary>
      ${x.history.length ? `<ol>${tidyHistory(x.history).map((h) => `<li class="${h.action === 'player_note' ? 'isnote' : ''}"><div class="psw"><b>${esc(who(h.by))}</b> · ${esc(when(h.at))}</div><div>${historyLine(h)}</div></li>`).join('')}</ol>` : '<p class="note">Nothing recorded yet.</p>'}
      ${x.seasons.length ? `<p class="note">Earlier: ${x.seasons.map((s) => `${s.year} ${esc(s.division || '')}${s.team ? ` · ${esc(s.team)}` : ''}${s.record ? ` (${esc(s.record)})` : ''}`).join(' · ')}</p>` : ''}
    </details>
    <div class="row dlgfoot psfoot">
      <button type="button" class="btn" data-go="${esc(prev || '')}" ${prev ? '' : 'disabled'} aria-label="Previous player">←</button>
      <span class="sub">${i + 1} of ${order.length}</span>
      <button type="button" class="btn" data-go="${esc(next || '')}" ${next ? '' : 'disabled'} aria-label="Next player">→</button>
      <span class="spacer"></span>
      ${can ? `<button type="submit" class="btn" value="save">Save</button>${next ? '<button type="submit" class="btn primary" value="next">Save &amp; next</button>' : ''}` : ''}
      <button type="button" class="btn" data-close>Close</button>
    </div></form>`, (dl) => {
    const f = dl.querySelector('form');
    dl.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => b.dataset.go && openSheet(b.dataset.go)));
    dl.onkeydown = (e) => { if (e.target.tagName === 'TEXTAREA') return; if (e.key === 'ArrowLeft' && prev) openSheet(prev); if (e.key === 'ArrowRight' && next) openSheet(next); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const go = e.submitter?.value === 'next';
      const dec = f.querySelector('[name=decision]:checked')?.value, note = f.note?.value.trim() || '';
      const body = { ...(dec && dec !== cur ? { decision: dec } : {}), ...(note ? { note } : {}) };
      if (!Object.keys(body).length) return go ? openSheet(next) : toast('Nothing changed');
      const r = await act('POST', A(`/players/${encodeURIComponent(id)}`), body);
      if (r) go ? openSheet(next) : openSheet(id, r);
    };
  });
  setTimeout(() => $('dlg').querySelector('textarea')?.focus(), 0);
}
$('reviewBtn').onclick = () => {
  const order = sheetOrder(), first = order.find((pid) => !['Registered', ...OUT].includes(player(pid)?.status)) || order[0];
  if (first) openSheet(first); else toast('No players yet');
};

/* ---------- setup (admin) ---------- */
function renderSetup() {
  const st = S.st, d = st.draft;
  $('format').value = d.format; $('mode').value = d.mode;
  const opts = (v) => '<option value="">—</option>' + st.teams.map((t) => `<option value="${esc(t.id)}" ${t.id === v ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('swapA').innerHTML = opts(d.swap?.[0]); $('swapB').innerHTML = opts(d.swap?.[1]);
  $('flowNote').innerHTML = [d.prev ? `Players come from the <b>${esc(d.prev)}</b> draft: whoever isn't picked there is available here once it closes.` : '',
    d.next ? `When this draft closes, everyone not picked moves to the <b>${esc(d.next)}</b> draft.` : ''].filter(Boolean).join(' ');
  $('order').innerHTML = st.teams.map((t, i) => `<li data-t="${esc(t.id)}"><input type="color" data-c="color" value="${esc(t.color)}" aria-label="${esc(t.name)} color" title="Header color">
    <input type="color" data-c="fg" value="${esc(t.fg)}" aria-label="${esc(t.name)} text color" title="Header text color">
    <input type="text" data-c="name" value="${esc(t.name)}" class="nm" aria-label="Team name">${t.record ? `<span class="sub">${esc(t.record)}</span>` : ''}
    <button class="mini" data-mv="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} up">↑</button><button class="mini" data-mv="${i}" data-d="1" ${i === st.teams.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} down">↓</button>
    <button class="mini" data-rmt="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">✕</button></li>`).join('') || '<li class="note">No teams yet.</li>';
  $('numbersPanel').hidden = d.format !== 'blind';
  const numbered = poolPlayers().filter((p) => p.number).length;
  $('numbersNote').innerHTML = `${numbered} ${numbered === 1 ? 'kid has' : 'kids have'} a number; ${st.unnumbered} waiting. Handing out numbers shuffles only the kids without one, continuing after the highest number, so a late registration never changes anyone else's number. Reshuffling all is only possible before the first pick.`;
  $('siblingPanel').hidden = d.format === 'blind';
  const avail = poolPlayers().filter((p) => !takenIds().has(p.id) && !OUT.includes(p.status)).sort((a, b) => a.name.localeCompare(b.name));
  const sp = $('sibPlayer').value, stt = $('sibTeam').value;
  $('sibPlayer').innerHTML = '<option value="">Player…</option>' + avail.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.age ? ` (${esc(p.age)})` : ''}</option>`).join('');
  $('sibTeam').innerHTML = '<option value="">Team…</option>' + st.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  $('sibPlayer').value = sp; $('sibTeam').value = stt;
  const sibs = st.picks.filter((x) => x.sibling);
  $('sibList').innerHTML = sibs.map((x) => `<li>${esc(st.players.find((p) => p.id === x.player)?.name)} — ${esc(team(x.team)?.name)}, round ${x.round} (pick #${x.n})</li>`).join('');
  $('closeDraft').hidden = d.status === 'closed'; $('reopenDraft').hidden = d.status !== 'closed';
  const rest = poolPlayers().filter((p) => !takenIds().has(p.id) && !OUT.includes(p.status));
  const back = rest.filter((p) => p.from).length, left = rest.length - back;
  $('closeNote').innerHTML = d.status === 'closed' ? 'Reopening is only possible until the next draft makes its first pick.'
    : `Closing ends this draft${d.next ? ` and moves the ${left} undrafted ${left === 1 ? 'player' : 'players'} to the <b>${esc(d.next)}</b> draft` : ''}${back ? `; ${back} undrafted Minors ${back === 1 ? 'returner goes' : 'returners go'} back to their own team` : ''}.`;
}
const saveDraft = (b, msg = 'Saved') => act('PUT', `/api/admin/divisions/${encodeURIComponent(S.st.draft.divisionId)}/draft`, b, msg);
$('format').onchange = (e) => saveDraft({ format: e.target.value });
$('mode').onchange = (e) => saveDraft({ mode: e.target.value });
$('swapA').onchange = $('swapB').onchange = () => saveDraft({ swap: [$('swapA').value, $('swapB').value] });
$('order').onchange = (e) => {
  const li = e.target.closest('[data-t]'); if (!li) return;
  const t = team(li.dataset.t);
  act('PATCH', `/api/admin/teams/${t.id}`, { name: t.name, color: t.color, fg: t.fg, [e.target.dataset.c]: e.target.value }, 'Team saved');
};
$('order').onclick = (e) => {
  const mv = e.target.closest('[data-mv]');
  if (mv) { const o = S.st.teams.map((t) => t.id), i = +mv.dataset.mv, j = i + +mv.dataset.d; [o[i], o[j]] = [o[j], o[i]]; return act('PUT', `/api/admin/divisions/${S.st.draft.divisionId}/teams/order`, { order: o }); }
  const rm = e.target.closest('[data-rmt]');
  if (rm) { if (rm.dataset.armed) act('DELETE', `/api/admin/teams/${rm.dataset.rmt}`, undefined, 'Team removed'); else { rm.dataset.armed = '1'; rm.textContent = 'Remove?'; } }
};
$('addTeam').onclick = () => act('POST', `/api/admin/divisions/${S.st.draft.divisionId}/teams`, { name: 'New team', color: '#14213D', fg: '#FFFFFF' }, 'Team added');
$('byRecord').onclick = () => act('POST', `/api/admin/divisions/${S.st.draft.divisionId}/teams/order-by-record`, {});
$('assignNumbers').onclick = () => act('POST', A('/numbers'), {});
$('clearNumbers').onclick = (e) => { if (e.target.dataset.armed) act('POST', A('/numbers/clear'), {}, 'Numbers cleared'); else { e.target.dataset.armed = '1'; e.target.textContent = 'Click again to reshuffle'; } };
$('sibAdd').onclick = () => {
  const body = { playerId: $('sibPlayer').value, teamId: $('sibTeam').value, round: +$('sibRound').value };
  if (!body.playerId || !body.teamId) return toast('Pick a player and a team', true);
  act('POST', A('/sibling'), body);
};
$('undo').onclick = () => act('POST', A('/undo'), {}, 'Last pick undone');
$('restartClock').onclick = () => act('POST', A('/clock/start'), {}, 'Clock restarted');
$('closeDraft').onclick = (e) => { if (e.target.dataset.armed) { act('POST', A('/close'), {}); delete e.target.dataset.armed; e.target.textContent = 'Close draft'; } else { e.target.dataset.armed = '1'; e.target.textContent = 'Click again to close'; } };
$('reopenDraft').onclick = () => act('POST', A('/reopen'), {}, 'Draft reopened');
$('reset').onclick = async () => {
  if ($('clearConfirm').value.trim() !== 'CLEAR') return toast('Type CLEAR in the box to confirm', true);
  if (await act('POST', A('/picks/clear'), { confirm: 'CLEAR' }, 'All picks cleared')) $('clearConfirm').value = '';
};

/* ---------- tabs ---------- */
function setTab(t) {
  const btn = document.querySelector(`[data-tab="${t}"]`);
  if (!btn || (btn.hasAttribute('data-admin') && !isAdmin())) t = 'board';
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  ['board', 'teams', 'setup'].forEach((v) => ($('view-' + v).hidden = v !== t));
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

/* ---------- boot ---------- */
async function refresh() {
  try {
    const st = await call('GET', `/api/drafts/${encodeURIComponent(S.id)}/state`);
    S.skew = st.serverNow - Date.now();
    S.st = st;
    render();
  } catch (e) { toast(e.message, true); }
}
let refreshTimer;
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('change', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); });
  es.onopen = () => { S.live = true; refresh(); };
  es.onerror = () => { S.live = false; if (S.st) { renderWho(); renderClock(); } };
}

(async () => {
  [S.me, S.home] = await Promise.all([call('GET', '/api/me'), call('GET', '/api/home')]);
  const m = /^\/draft\/([^/]+)\/([^/]+)/.exec(location.pathname);
  S.id = m ? `${decodeURIComponent(m[1])}-${decodeURIComponent(m[2])}` : S.home.draft;
  if (!S.id) { document.body.innerHTML = '<p style="padding:24px">No draft room here. <a href="/">League home</a></p>'; return; }
  if (!S.me.user) { location.href = `/signin?next=${encodeURIComponent(location.pathname)}`; return; }
  $('app').hidden = false;
  await refresh();
  setTab('board');
  connect();
})();
