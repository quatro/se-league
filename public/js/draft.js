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
const now = () => Date.now() + S.skew;
const OUT = ['Not returning', 'Withdrawn'];
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
  if (S.tab === 'board') { renderBoard(); renderPool(); }
  if (S.tab === 'teams') renderTeams();
  const ae = document.activeElement;
  const typing = ae?.closest?.('section') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox';
  if (S.tab === 'setup' && !typing) renderSetup();
}

function renderWho() {
  const adminUrl = location.pathname.replace(/\/admin$/, '').replace(/\/$/, '') + '/admin';
  $('whoami').innerHTML = S.me?.admin
    ? `Signed in as <b>${esc(S.me.admin)}</b> · <button id="logout">Log out</button>`
    : `<a href="${esc(adminUrl === '/admin' ? '/admin' : adminUrl)}">Admin login</a>`;
  const lo = $('logout');
  if (lo) lo.onclick = async () => { await act('POST', '/api/logout', {}); location.reload(); };
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
  let h = `<thead><tr><th class="rd">Round</th>${teams.map((t) => `<th style="${hdrStyle(t)}">${esc(t.name)}${t.record ? `<div style="font-size:.7rem;font-weight:600;opacity:.85">${esc(t.record)}</div>` : ''}</th>`).join('')}</tr></thead><tbody>`;
  for (let r = 1; r <= rounds; r++) {
    const comp = r > st.minRound;
    h += `<tr><th class="rd">Rd ${r}${comp ? '<br><span class="chip comp">Comp</span>' : ''}</th>`;
    for (const t of teams) {
      const s = byKey[`${r}-${t.id}`];
      if (!s) { h += `<td class="full" title="${esc(t.name)} roster is full">—</td>`; continue; }
      const p = pm[s.key];
      if (p) {
        const pl = player(p.player);
        h += `<td class="picked${isAdmin() ? ' editable' : ''}" ${isAdmin() ? `data-slot="${esc(s.key)}" title="Edit this pick"` : ''}><span class="nm">${esc(label(pl))}</span>${pl?.age ? ` <span class="ag">(${esc(pl.age)})</span>` : ''}<span class="pk">#${s.n}${pl?.number ? ` · no. ${pl.number}` : ''}</span>${p.took != null ? `<span class="tk" title="Time on the clock">${fmt(p.took)}</span>` : ''}</td>`;
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
      .map((p) => `<div class="kp ${OUT.includes(p.status) ? 'gone' : ''}" title="${esc(p.status)}"><i class="dot ${dotCls(p.status)}"></i>${esc(p.name)}${p.age ? ` (${esc(p.age)})` : ''}</div>`).join('')}</td>`).join('')}</tr></tbody>`;
  }
  $('board').innerHTML = h;
}
$('board').onclick = (e) => { const td = e.target.closest('[data-slot]'); if (td && isAdmin()) editPick(td.dataset.slot); };

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
  const ages = [...new Set(pool.map((p) => p.age).filter(Boolean))].sort((a, b) => a - b);
  const sel = $('poolAge'), prev = sel.value;
  sel.innerHTML = '<option value="">All ages</option>' + ages.map((a) => `<option value="${a}">Age ${a}</option>`).join('');
  sel.value = prev;
  $('poolCount').textContent = `${avail.length} left · ${avail.filter((p) => p.status === 'Registered').length} registered`;
  if (!pool.length) { $('pool').innerHTML = `<li class="empty">No players in this draft yet.${isAdmin() ? ' Kids join as they register, or from the league site\'s Kids tab.' : ''}</li>`; return; }
  const list = pool.filter((p) => (showT || !taken.has(p.id)) && (!q || p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q)) && (!age || String(p.age) === age))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  if (!list.length) { $('pool').innerHTML = '<li class="empty">No players match.</li>'; return; }
  $('pool').innerHTML = list.map((p) => {
    const tk = taken.has(p.id), by = tk ? team(st.picks.find((x) => x.player === p.id).team)?.name : '';
    const out = OUT.includes(p.status);
    return `<li class="${tk || out ? 'taken' : ''}"><div><div class="nm kp ${out ? 'gone' : ''}" title="${esc(p.status)}"><i class="dot ${dotCls(p.status)}"></i>${p.rank != null ? `<span class="sub">${esc(p.rank)}.</span> ` : ''}${esc(p.name)}</div>
      <div class="sub">${esc(p.status)}${p.age ? ` · Age ${esc(p.age)}` : ''}${p.prior ? ` · ${esc(p.prior)}` : ''}${p.notes ? ` · ${esc(p.notes)}` : ''}${tk ? ` · ${esc(by)}` : ''}</div></div>
      ${!tk && !out && canPick ? `<button class="btn primary" data-draft="${esc(p.id)}" title="Draft to ${esc(t.name)}">Draft</button>` : ''}</li>`;
  }).join('');
}
$('poolSearch').oninput = $('poolAge').onchange = $('showTaken').onchange = () => S.st && renderPool();
$('pool').onclick = async (e) => {
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
    return `<div class="team"><div class="bar" style="${hdrStyle(t)};${t.color.toUpperCase() === '#FFFFFF' ? 'border-bottom:1px solid var(--line)' : ''}"><span>${esc(t.name)}</span><span>${ks.length + ps.length}/${st.draft.rosterSize}</span></div><ol>
      ${ks.map((p) => `<li><i class="dot ${dotCls(p.status)}" title="${esc(p.status)}"></i> ${esc(p.name)}${p.age ? ` (${esc(p.age)})` : ''}<span class="tag">returning</span></li>`).join('')}
      ${ps.map((p) => { const pl = player(p.player); return `<li><i class="dot ${dotCls(pl?.status)}" title="${esc(pl?.status)}"></i> ${esc(label(pl))}${pl?.age ? ` (${esc(pl.age)})` : ''}<span class="tag">Rd ${p.round} · #${p.n}</span></li>`; }).join('')}</ol></div>`;
  }).join('') || '<p class="note">No teams yet.</p>';
}

/* ---------- dialogs ---------- */
function openDialog(html, bind) {
  const d = $('dlg'); d.innerHTML = html; bind?.(d); d.showModal();
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
  $('closeDraft').hidden = d.status === 'closed'; $('reopenDraft').hidden = d.status !== 'closed';
  const left = poolPlayers().filter((p) => !takenIds().has(p.id) && !OUT.includes(p.status)).length;
  $('closeNote').innerHTML = d.status === 'closed' ? 'Reopening is only possible until the next draft makes its first pick.'
    : `Closing ends this draft${d.next ? ` and moves the ${left} undrafted ${left === 1 ? 'player' : 'players'} to the <b>${esc(d.next)}</b> draft` : ''}.`;
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

/* ---------- gates ---------- */
function gate(html, bind) { $('app').hidden = true; const g = $('gate'); g.innerHTML = html; g.hidden = false; bind(g); }
function loginGate() {
  gate(`<form class="gate" id="lf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">Draft room</small>Admin login</h1>
    <input type="text" id="lu" placeholder="Username" autocomplete="username" required aria-label="Username">
    <input type="password" id="lp" placeholder="Password" autocomplete="current-password" required aria-label="Password">
    <p class="err-text" id="le"></p><button class="btn primary" type="submit">Log in</button><a href="${esc(location.pathname.replace(/\/admin$/, '') || '/')}" class="note">← Back to the draft</a></form>`, (g) => {
    g.querySelector('#lu').focus();
    g.querySelector('#lf').onsubmit = async (e) => {
      e.preventDefault();
      try { await call('POST', '/api/login', { username: g.querySelector('#lu').value, password: g.querySelector('#lp').value }); location.reload(); }
      catch (err) { g.querySelector('#le').textContent = err.message; }
    };
  });
}
function viewerGate() {
  gate(`<form class="gate" id="vf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">${esc(S.home?.league || 'SE Baseball')}</small>Draft Room</h1>
    <p class="note">Enter the league's code to watch the draft.</p>
    <input type="password" id="vc" placeholder="League code" required aria-label="League code">
    <p class="err-text" id="ve"></p><button class="btn primary" type="submit">Watch the draft</button></form>`, (g) => {
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
  if (/\/admin$/.test(location.pathname) && !S.me.admin) return loginGate();
  if (!S.me.viewer) return viewerGate();
  $('app').hidden = false;
  await refresh();
  setTab('board');
  connect();
})();
