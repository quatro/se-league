/* SE League — the league site: seats, kids across seasons, registrations,
   divisions and teams, draft rooms and season rollover. The server owns the
   numbers and rules; this file renders /api/seasons/:id/state and sends admin
   actions back. Draft rooms live on their own page (draft.js). */
'use strict';

const STATUSES = ['Registered', 'Expected', 'Need to contact', 'Waitlist', 'Not returning', 'Withdrawn'];
const OUT = ['Not returning', 'Withdrawn'];
const S = { me: null, home: null, sid: null, st: null, regs: null, log: null, tab: 'seats', live: false, sel: new Set(), pendingRender: false };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dotCls = (s) => ({ Registered: 'Registered', Expected: 'Expected', 'Need to contact': 'Need', Waitlist: 'Waitlist', 'Not returning': 'Not-returning', Withdrawn: 'Withdrawn' }[s] || '');
const isAdmin = () => !!S.me?.admin;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), err ? 4500 : 2600); }
async function call(method, url, body) {
  // Every mutation goes out as JSON (even a bodiless DELETE) — the server's CSRF guard requires it.
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && data?.error === 'login_required') location.href = '/admin';
    throw new Error(data?.error || `Request failed (${r.status})`);
  }
  return data;
}
async function act(method, url, body, okMsg) {
  try { const d = await call(method, url, body); if (okMsg || d?.message) toast(d?.message || okMsg); return d || {}; }
  catch (e) { toast(e.message, true); return null; }
}

/* ---------- lookups ---------- */
const div = (id) => S.st.divisions.find((d) => d.id === id);
const teamOf = (id) => S.st.teams.find((t) => t.id === id);
const draftOf = (id) => S.st.drafts.find((r) => r.id === id);
const kidRow = (id) => S.st.kids?.find((k) => k.id === id);
const divOpts = (v, blank = '— No division —') => `<option value="">${esc(blank)}</option>` + S.st.divisions.map((d) => `<option value="${esc(d.id)}" ${d.id === v ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
const ageRange = (d) => (d.min_age == null && d.max_age == null ? '' : d.min_age === d.max_age ? `age ${d.min_age}` : `ages ${d.min_age ?? '?'}–${d.max_age ?? '?'}`);
const fitsAge = (d, age) => age == null || !d || ((d.min_age == null || age >= d.min_age) && (d.max_age == null || age <= d.max_age));
const complete = () => S.st?.season.status === 'complete';
const draftUrl = (r) => `/draft/${encodeURIComponent(S.sid)}/${encodeURIComponent(r.key)}`;
const record = (t) => (t.wins != null && t.losses != null ? `${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ''}` : '');

/* ---------- render ---------- */
function render() {
  if (!S.st) return;
  const st = S.st;
  document.title = `${st.season.year} ${S.home?.league || 'League'}`;
  $('league').textContent = S.home?.league || 'SE Baseball';
  $('seasonTitle').textContent = `${st.season.year} Season${complete() ? ' (finished)' : ''}`;
  $('seasonSel').innerHTML = st.seasons.slice().reverse().map((s) => `<option value="${esc(s.id)}" ${s.id === S.sid ? 'selected' : ''}>${s.year}${s.id === st.current ? ' · current' : s.status === 'complete' ? ' · finished' : ''}</option>`).join('');
  document.querySelectorAll('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
  $('live').innerHTML = `<span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'Live' : 'Reconnecting'}</span>`;
  $('whoami').innerHTML = S.me?.admin ? `Signed in as <b>${esc(S.me.admin)}</b> · <button id="logout">Log out</button>` : `<a href="/admin">Admin login</a>`;
  const lo = $('logout'); if (lo) lo.onclick = async () => { await act('POST', '/api/logout', {}); location.href = '/'; };
  $('capCsv').href = `/api/seasons/${encodeURIComponent(S.sid)}/capacity.csv`;
  if (S.tab === 'seats') renderSeats();
  if (S.tab === 'drafts') renderDrafts();
  // Admin tabs hold inputs; don't rebuild under someone's cursor. Re-render on blur instead.
  const ae = document.activeElement;
  const typing = ae?.closest?.('section') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox' && ae.type !== 'file';
  if (typing && ['kids', 'divisions', 'regs', 'seasons', 'campaigns'].includes(S.tab)) { S.pendingRender = true; return; }
  if (S.tab === 'kids') renderKids();
  if (S.tab === 'divisions') renderDivisions();
  if (S.tab === 'regs') renderRegs();
  if (S.tab === 'seasons') renderSeasons();
  if (S.tab === 'log') renderLog();
  if (S.tab === 'campaigns') loadCampaigns(); // campaigns.js
  if (S.tab === 'outreach' && OS.loadedFor !== S.sid) loadOutreach(); // outreach.js — reloads on tab open, not on every change, so a message being typed survives
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !document.activeElement?.closest?.('section')) { S.pendingRender = false; render(); } }, 0));
$('seasonSel').onchange = (e) => { S.sid = e.target.value; S.sel.clear(); try { localStorage.setItem('league-season', S.sid); } catch { /* private */ } refresh(); if (S.tab === 'log') loadLog(); };

/* ---------- seats ---------- */
const STATE = { open: ['good', 'Open'], closing: ['meh', 'Closing soon'], full: ['bad', 'Full'], over: ['bad', 'Over capacity'], closed: ['', 'Registration closed'], unset: ['', 'No teams set'] };
/** Seat cards: a group (Majors + Minors) shows as one card because families register for it once. */
function units() {
  const st = S.st, out = [];
  for (const d of st.divisions) {
    const g = d.group_key && st.groups.find((x) => x.key === d.group_key);
    if (g) { if (!out.some((u) => u.group === g)) out.push({ group: g, name: g.name, seats: g.seats, members: st.divisions.filter((x) => x.group_key === g.key) }); }
    else out.push({ div: d, name: d.name, seats: d.seats });
  }
  return out;
}
function renderSeats() {
  const st = S.st, us = units(), h = $('headline');
  if (complete()) {
    const played = st.divisions.reduce((a, d) => a + d.seats.registered, 0);
    h.className = 'headline';
    h.innerHTML = `<div class="big">${st.season.year} season — finished</div><div class="meta">${plural(played, 'kid')} played. This is the record the next season was built from.</div>`;
  } else {
    const act = us.filter((u) => u.seats.state === 'full' || u.seats.state === 'over');
    const soon = us.filter((u) => u.seats.state === 'closing');
    if (!us.length || us.every((u) => u.seats.state === 'unset')) {
      h.className = 'headline';
      h.innerHTML = `<div class="big">No divisions set up yet</div><div class="meta">${isAdmin() ? 'Add divisions and team counts under <b>Divisions &amp; Teams</b>.' : 'Seat counts will appear here once the league sets up its divisions.'}</div>`;
    } else if (act.length) {
      h.className = 'headline act';
      h.innerHTML = `<div class="big">Close registration: ${act.map((u) => esc(u.name)).join(', ')}</div>
        <div class="meta">${act.map((u) => u.seats.open < 0 ? `${esc(u.name)} is ${plural(-u.seats.open, 'player')} over` : `${esc(u.name)} is full`).join(' · ')} — counting seats held for returners who haven't registered yet.${soon.length ? ` Closing soon: ${soon.map((u) => `${esc(u.name)} (${u.seats.open} left)`).join(', ')}.` : ''}</div>`;
    } else if (soon.length) {
      h.className = 'headline soon';
      h.innerHTML = `<div class="big">Closing soon: ${soon.map((u) => `${esc(u.name)} — ${plural(u.seats.open, 'seat')} left`).join(', ')}</div><div class="meta">Every other division has room.</div>`;
    } else {
      h.className = 'headline';
      h.innerHTML = `<div class="big">Registration open — ${plural(st.total.open, 'seat')} left</div><div class="meta">No division is close to full.</div>`;
    }
    if (st.total.held) h.insertAdjacentHTML('beforeend', st.total.registered
      ? `<div class="meta"><b>${plural(st.total.held, 'seat')}</b> held for expected returners are placeholders until those kids register or drop out.</div>`
      : `<div class="meta"><b>No one has registered yet.</b> The ${plural(st.total.held, 'seat')} held for expected returners are placeholders until those kids register or drop out.</div>`);
  }

  $('divs').innerHTML = us.map((u) => {
    const s = u.seats, [cls, label] = STATE[s.state];
    const base = Math.max(s.capacity, s.projected, 1), w = (n) => `${(100 * n / base).toFixed(2)}%`;
    const flags = [];
    if (s.atRisk) flags.push(`<span class="chip meh" title="Returners marked Need to contact still hold a seat">${s.atRisk} need contact · best case ${s.bestCaseOpen} open</span>`);
    if (u.div && s.coachGap) flags.push(`<span class="chip bad">${plural(s.coachGap, 'team')} without a coach</span>`);
    if (u.div && s.capacity && s.teamsNeeded > u.div.teams) flags.push(`<span class="chip bad">Projected ${s.projected} kids = ${s.teamsNeeded} teams</span>`);
    if (s.waitlist) flags.push(`<span class="chip">${s.waitlist} waitlisted</span>`);
    const mism = u.div ? u.div.ageMismatches : u.members.reduce((a, d) => a + (d.ageMismatches || 0), 0);
    if (mism) flags.push(`<span class="chip meh">${plural(mism, 'kid')} outside the age range</span>`);
    const exc = u.div ? u.div.ageExceptions : u.members.reduce((a, d) => a + (d.ageExceptions || 0), 0);
    if (exc) flags.push(`<span class="chip" title="Pinned here by an admin as an age exception">${plural(exc, 'kid')} moved up by an admin</span>`);
    const sub = u.div ? `${u.div.teams} teams × ${u.div.roster_size}${ageRange(u.div) ? ` · ${esc(ageRange(u.div))}` : ''}`
      : `${u.members.map((d) => `${esc(d.name)} ${d.teams}×${d.roster_size}`).join(' · ')} · one registration, drafts decide`;
    const members = u.members ? `<div class="sub">${u.members.map((d) => `<b>${esc(d.name)}</b>: ${d.seats.registered + d.seats.held} placed of ${d.seats.capacity}`).join(' · ')}</div>` : '';
    return `<article class="div ${complete() ? 'closed' : s.state}">
      <div class="top"><div><h3>${esc(u.name)}</h3><div class="sub">${sub}</div>
        ${complete() ? '' : `<span class="chip ${cls}" style="margin-top:6px">${label}</span>`}</div>
        <div class="open"><b>${complete() ? s.registered : s.capacity ? (s.open < 0 ? `+${-s.open}` : s.open) : '—'}</b><span>${complete() ? 'played' : s.open < 0 ? 'over' : 'seats open'}</span></div></div>
      <div class="bar ${s.open < 0 ? 'over' : ''}" role="img" aria-label="${s.registered} registered, ${s.expected} returners expected, ${s.atRisk} need contact, of ${s.capacity} seats">
        <i class="reg" style="width:${w(s.registered)}"></i><i class="exp" style="width:${w(s.expected)}"></i><i class="risk" style="width:${w(s.atRisk)}"></i></div>
      <div class="nums">
        <div><b>${s.capacity}</b><span>Seats</span></div>
        <div><b>${s.registered}</b><span>Registered${s.registered ? ` (${s.returnersRegistered} ret · ${s.newRegistered} new)` : ''}</span></div>
        <div title="Placeholders: expected returners who have not registered yet"><b>${s.held}</b><span>Held · expected returners</span></div>
      </div>
      ${members}${flags.length && !complete() ? `<div class="flags">${flags.join('')}</div>` : ''}
    </article>`;
  }).join('');
  loadAges();
  const t = st.total;
  $('totals').innerHTML = `<span>League: <b>${t.capacity}</b> seats</span><span><b>${t.registered}</b> registered</span><span><b>${t.held}</b> held for expected returners</span><span><b>${t.open}</b> open</span>${st.unplaced && isAdmin() ? `<span class="warn-text">${st.unplaced} not in a division</span>` : ''}`;
}

/* ---------- drafts ---------- */
/* ---------- ages: kids per age year over year, and what each division is made of ---------- */
const AG = { sid: null, at: 0, data: null, busy: false };
async function loadAges() {
  if (AG.busy || (AG.sid === S.sid && Date.now() - AG.at < 30e3)) return renderAges();
  AG.busy = true;
  try { AG.data = await call('GET', `/api/seasons/${encodeURIComponent(S.sid)}/ages`); AG.sid = S.sid; AG.at = Date.now(); }
  catch { AG.data = null; } finally { AG.busy = false; }
  renderAges();
}
const ageWord = (a) => (a == null ? 'Age unknown' : `${a}s`);
function niceTicks(max) {
  const step = [5, 10, 20, 25, 50, 100, 200].find((s) => max / s <= 5) || 500;
  const ticks = []; for (let v = 0; v <= max; v += step) ticks.push(v);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}
function renderAges() {
  const box = $('ages'), d = AG.data;
  if (!box) return;
  if (!d || AG.sid !== S.sid) { box.innerHTML = ''; return; }
  const yrs = d.byAge, label = (y) => `${y.year} ${y.kind}`;
  // Every age any shown season has, youngest first.
  const ages = [...new Set(yrs.flatMap((y) => y.ages.map((a) => a.age)))].sort((a, b) => a - b);
  const count = (y, a) => y.ages.find((x) => x.age === a)?.count ?? 0;
  const ticks = niceTicks(Math.max(1, ...yrs.flatMap((y) => y.ages.map((a) => a.count))));
  const top = ticks.at(-1), pct = (n) => `${(100 * n / top).toFixed(2)}%`;
  const last = yrs.at(-1);
  const unknown = yrs.filter((y) => y.unknown).map((y) => `${y.unknown} in ${y.year}`).join(', ');
  const byAge = `<div class="panel"><div class="hd"><h2>Players by age</h2>
      <div class="vlegend">${yrs.map((y, i) => `<span><i class="sw yr${i + 1}"></i>${esc(label(y))}</span>`).join('')}</div></div>
    <div class="bd">
      <p class="note">League age on ${esc(S.st.season.age_cutoff.replace('-', '/'))} of each season. ${last.kind === 'projected' ? `${last.year} counts every kid holding a seat — registered or expected back — before anyone drops out or new families sign up.` : ''}</p>
      <div class="colchart" role="img" aria-label="${esc(yrs.map((y) => `${label(y)}: ${y.ages.map((a) => `${a.count} age ${a.age}`).join(', ')}`).join('; '))}">
        <div class="plot">
          ${ticks.map((t) => `<div class="grid" style="bottom:${pct(t)}"><span>${t}</span></div>`).join('')}
          <div class="cols">${ages.map((a) => `<div class="agecol" data-tip="${esc(`Age ${a} — ${yrs.map((y) => `${y.year}: ${count(y, a)} ${y.kind}`).join(' · ')}`)}">
            <div class="bars">${yrs.map((y, i) => `<i class="yr${i + 1}" style="height:${pct(count(y, a))}">${i === yrs.length - 1 && count(y, a) ? `<b>${count(y, a)}</b>` : ''}</i>`).join('')}</div>
            <span class="x">${a}</span></div>`).join('')}</div>
        </div>
      </div>
      ${unknown ? `<p class="note">Not shown: kids with no birthdate or age on file (${esc(unknown)}).</p>` : ''}
      <details><summary class="note">Show as a table</summary><div class="scroll"><table class="kt"><tr><th>Age</th>${yrs.map((y) => `<th class="num">${esc(label(y))}</th>`).join('')}</tr>
        ${ages.map((a) => `<tr><td>${a}</td>${yrs.map((y) => `<td class="num">${count(y, a)}</td>`).join('')}</tr>`).join('')}
        ${unknown ? `<tr><td>Unknown</td>${yrs.map((y) => `<td class="num">${y.unknown}</td>`).join('')}</tr>` : ''}</table></div></details>
    </div></div>`;

  // Each division as one bar split by age; the line marks its seats.
  const scale = Math.max(1, ...d.composition.map((u) => Math.max(u.total, u.capacity)));
  const own = (u, from) => u.name.split(' + ').includes(from);
  const fromText = (u, f) => !f.division ? '' : f.division === 'new' ? `${f.count} new` : own(u, f.division) ? `${f.count} back in ${f.division}` : `${f.count} up from ${f.division}`;
  const shade = (u, a) => {
    if (a == null) return 'unk';
    if (u.min_age == null || u.max_age == null || u.max_age === u.min_age) return 'age2';
    return `age${1 + Math.round(2 * (Math.min(Math.max(a, u.min_age), u.max_age) - u.min_age) / (u.max_age - u.min_age))}`;
  };
  const comp = `<div class="panel"><div class="hd"><h2>What each division is made of</h2></div><div class="bd">
      <p class="note">${d.season.year} ${d.season.kind === 'played' ? 'players' : 'kids holding a seat'}, by league age${d.prevYear ? ` and where they played in ${d.prevYear}` : ''}. Darker = older. The line marks the division's seats.</p>
      ${d.composition.map((u) => `<div class="comp">
        <div class="row"><b>${esc(u.name)}</b><span class="spacer"></span><span class="sub">${u.total} of ${u.capacity} seats${u.capacity && u.total > u.capacity ? ` · <span class="warn-text">${u.total - u.capacity} over</span>` : ''}</span></div>
        <div class="stack" role="img" aria-label="${esc(`${u.name}: ${u.ages.map((a) => `${a.count} ${ageWord(a.age)}`).join(', ')}; ${u.capacity} seats`)}">
          ${u.ages.map((a) => `<i class="${shade(u, a.age)}" style="width:${(100 * a.count / scale).toFixed(2)}%" data-tip="${esc(`${ageWord(a.age)}: ${a.count}${a.from.some((f) => f.division) ? ` — ${a.from.map((f) => fromText(u, f)).join(', ')}` : ''}`)}">${a.count / scale > 0.06 ? `<b>${a.count}</b>` : ''}</i>`).join('')}
          ${u.capacity ? `<span class="cap" style="left:${(100 * u.capacity / scale).toFixed(2)}%" title="${u.capacity} seats"></span>` : ''}
        </div>
        <div class="vlegend">${u.ages.map((a) => `<span><i class="sw ${shade(u, a.age)}"></i><b>${ageWord(a.age)} · ${a.count}</b>${a.from.some((f) => f.division) ? ` <span class="sub">${esc(a.from.map((f) => fromText(u, f)).join(', '))}</span>` : ''}</span>`).join('') || '<span class="sub">No one yet</span>'}</div>
      </div>`).join('')}
    </div></div>`;
  box.innerHTML = byAge + comp;
}
// One small tooltip for every chart mark that has data-tip.
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest?.('[data-tip]'), tip = $('tip');
  if (!tip) return;
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
});

function renderDrafts() {
  const st = S.st;
  if (!st.drafts.length) { $('draftCards').innerHTML = `<p class="note">No draft rooms for ${st.season.year}.${isAdmin() ? ' Set one up per division under <b>Divisions &amp; Teams</b>.' : ''}</p>`; return; }
  $('draftCards').innerHTML = st.drafts.map((r) => {
    const d = div(r.division_id), prev = st.drafts.find((x) => x.next_id === r.id), next = r.next_id && draftOf(r.next_id);
    const waiting = r.status === 'open' && prev && prev.status !== 'closed';
    const status = r.status === 'closed' ? 'Closed' : waiting ? `Waiting for ${div(prev.division_id)?.name}` : r.picks ? 'In progress' : 'Not started';
    return `<article class="draftcard ${r.status}">
      <div class="row"><h3>${esc(d?.name)}</h3><span class="spacer"></span><span class="chip ${r.status === 'closed' ? '' : waiting ? 'meh' : 'good'}">${esc(status)}</span></div>
      <div class="sub">${r.format === 'blind' ? 'Blind draft — coaches pick hidden numbers' : 'Standard draft'} · ${plural(r.picks, 'pick')} made · ${r.pool} available${next ? ` · undrafted go to ${esc(div(next.division_id)?.name)}` : ''}</div>
      <div class="row"><a class="btn primary" href="${esc(draftUrl(r))}">Open draft room</a>${isAdmin() ? `<a class="btn" href="${esc(draftUrl(r))}/admin">Run the draft</a>` : ''}</div>
    </article>`;
  }).join('');
}

/* ---------- dialogs ---------- */
function openDialog(html, bind) {
  const d = $('dlg'); d.innerHTML = html; bind?.(d); d.showModal();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); d.close(); }));
}
async function showKid(kidId) {
  const h = await act('GET', `/api/admin/kids/${encodeURIComponent(kidId)}`); if (!h) return;
  const k = h.kid;
  openDialog(`<form class="dlg" id="kf"><h2>${esc(k.name)}</h2>
    <div class="row"><label for="kfName">Name</label><input type="text" id="kfName" value="${esc(k.name)}" style="flex:1"></div>
    <div class="row"><label for="kfDob">Birthdate</label><input type="date" id="kfDob" value="${esc(k.birthdate || '')}" style="width:auto">${k.se_profile_id ? `<span class="sub">SE id <code>${esc(k.se_profile_id)}</code></span>` : ''}</div>
    <label class="note" for="kfNotes">Notes that follow this kid every season (admins only)</label><textarea id="kfNotes" rows="2">${esc(k.notes)}</textarea>
    <div class="row"><button class="btn primary" type="submit">Save</button></div>
    <h3>Parents &amp; guardians</h3>
    ${h.contacts.length ? `<table class="kt">${h.contacts.map((c) => `<tr><td><b>${esc(c.name || '—')}</b>${c.relation ? ` <span class="sub">${esc(c.relation)}</span>` : ''}</td><td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</td><td>${esc(c.phone)}</td><td class="sub">${esc(c.source)}</td><td><button class="mini" type="button" data-delcontact="${esc(c.id)}">Remove</button></td></tr>`).join('')}</table>` : '<p class="note">No parent contact on file — returning-player emails can’t reach this family yet.</p>'}
    <div class="row"><input type="text" id="kcName" placeholder="Parent name" style="flex:1" aria-label="Parent name"><input type="email" id="kcEmail" placeholder="Email" style="flex:1" aria-label="Email"><input type="tel" id="kcPhone" placeholder="Phone" style="width:130px" aria-label="Phone"><button class="btn" type="button" id="kcAdd">Add contact</button></div>
    <h3>Seasons</h3>
    <table class="hist"><tr><th>Season</th><th>Age</th><th>Division</th><th>Team</th><th>Record</th><th>How</th><th>Status</th></tr>
    ${h.seasons.map((s) => `<tr><td>${s.year}</td><td>${esc(s.age ?? '')}</td><td>${esc(s.division || '—')}</td><td>${esc(s.team || '—')}</td><td>${esc(s.record || '')}</td><td>${esc(s.how)}</td><td><i class="dot ${dotCls(s.status)}"></i> ${esc(s.status)}</td></tr>`).join('')}</table>
    ${h.registrations.length ? `<h3>Registrations</h3><table class="kt">${h.registrations.map((r) => `<tr><td>${esc(r.received_at)}</td><td>${esc(r.season_id || '')}</td><td>${esc(r.program || '')}</td><td>${esc(r.outcome)}</td><td>${esc(r.note)}</td></tr>`).join('')}</table>` : ''}
    <h3>History</h3>${h.audit.length ? `<table class="kt">${h.audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.season_id || '')}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td class="mono">${esc(a.detail)}</td></tr>`).join('')}</table>` : '<p class="note">No changes recorded.</p>'}
    <div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></form>`, (d) => {
    d.querySelector('#kcAdd').onclick = async () => {
      const v = (id) => d.querySelector(id).value.trim();
      if (await act('POST', `/api/admin/kids/${encodeURIComponent(kidId)}/contacts`, { name: v('#kcName'), email: v('#kcEmail'), phone: v('#kcPhone') })) { d.close(); showKid(kidId); }
    };
    d.querySelectorAll('[data-delcontact]').forEach((b) => (b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Remove?'; return; }
      if (await act('DELETE', `/api/admin/contacts/${encodeURIComponent(b.dataset.delcontact)}`, undefined, 'Removed')) { d.close(); showKid(kidId); }
    }));
    d.querySelector('#kf').onsubmit = async (e) => {
      e.preventDefault();
      if (await act('PATCH', `/api/admin/kids/${encodeURIComponent(kidId)}`, { name: d.querySelector('#kfName').value, birthdate: d.querySelector('#kfDob').value || null, notes: d.querySelector('#kfNotes').value }, 'Saved')) d.close();
    };
  });
}
function addKidForm() {
  openDialog(`<form class="dlg" id="af"><h2>Add a kid to ${S.st.season.year}</h2>
    <div class="row"><label for="afName">Name</label><input type="text" id="afName" required style="flex:1" autocomplete="off"></div>
    <div id="afMatches" class="note"></div>
    <div class="row"><label for="afDob">Birthdate</label><input type="date" id="afDob" style="width:auto"></div>
    <div class="row"><label for="afDiv">Division</label><select id="afDiv" style="width:auto">${divOpts('')}</select></div>
    <div class="row"><label for="afRet">Returner?</label><select id="afRet" style="width:auto"><option value="0">New — Registered</option><option value="1">Returner — holds a seat as Expected</option></select></div>
    <p class="err-text" id="afErr"></p>
    <div class="row"><button class="btn primary" type="submit">Add</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (d) => {
    let kidId = null, timer;
    const name = d.querySelector('#afName'), box = d.querySelector('#afMatches');
    name.oninput = () => {
      kidId = null; clearTimeout(timer);
      const q = name.value.trim(); if (q.length < 2) { box.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const ks = await call('GET', `/api/admin/kids/search?q=${encodeURIComponent(q)}`).catch(() => []);
        box.innerHTML = ks.length ? `Already in the league: ${ks.map((k) => `<button type="button" class="mini" data-k="${esc(k.id)}">${esc(k.name)}${k.birthdate ? ` (${esc(k.birthdate)})` : ''}</button>`).join(' ')} — pick one to keep their history, or add as a new kid.` : '';
      }, 200);
    };
    box.onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; kidId = b.dataset.k; name.value = b.textContent.replace(/ \(.*\)$/, ''); box.innerHTML = 'Adding the existing kid.'; };
    d.querySelector('#af').onsubmit = async (e) => {
      e.preventDefault();
      const ret = d.querySelector('#afRet').value === '1';
      const body = { ...(kidId ? { kidId } : { name: name.value, birthdate: d.querySelector('#afDob').value || null }), divisionId: d.querySelector('#afDiv').value || null, returner: ret, status: ret ? 'Expected' : 'Registered' };
      try { await call('POST', `/api/admin/seasons/${encodeURIComponent(S.sid)}/kids`, body); toast('Kid added'); d.close(); }
      catch (err) { d.querySelector('#afErr').textContent = err.message; }
    };
  });
}

/* ---------- kids ---------- */
function groupAges() {
  const g = S.st.divisions.filter((d) => d.group_key);
  return g.length ? { min: Math.min(...g.map((d) => d.min_age ?? 99)), max: Math.max(...g.map((d) => d.max_age ?? 0)) } : null;
}
function canTryout(k) {
  if (k.picked_in || OUT.includes(k.status)) return false;
  const d = div(k.division_id);
  if (d?.se_match.trim() === '-') return false; // already in Majors
  if (d?.group_key) return true;
  const g = groupAges();
  return !!g && k.league_age != null && k.league_age >= g.min - 1 && k.league_age < g.min;
}
function filteredKids() {
  const st = S.st, q = $('kSearch').value.trim().toLowerCase(), dv = $('kDiv').value, sv = $('kStatus').value, kv = $('kKind').value;
  const order = Object.fromEntries(st.divisions.map((d, i) => [d.id, i]));
  return (st.kids || []).filter((k) => (!q || k.name.toLowerCase().includes(q) || (k.notes || '').toLowerCase().includes(q) || (k.prior || '').toLowerCase().includes(q))
    && (!dv || (dv === '-' ? !k.eff_division_id : k.eff_division_id === dv)) && (!sv || k.status === sv) && (kv === '' || String(k.returner) === kv)
    && (!$('kTry').checked || k.tryout) && (!$('kMismatch').checked || (k.eff_division_id && !fitsAge(div(k.eff_division_id), k.league_age))))
    .sort((a, b) => (order[a.eff_division_id] ?? 999) - (order[b.eff_division_id] ?? 999) || (teamOf(a.eff_team_id)?.name || '~').localeCompare(teamOf(b.eff_team_id)?.name || '~') || a.name.localeCompare(b.name));
}
function renderKids() {
  const st = S.st;
  const dSel = $('kDiv'), sSel = $('kStatus'), dv = dSel.value, sv = sSel.value;
  dSel.innerHTML = '<option value="">All divisions</option><option value="-">Not in a division</option>' + st.divisions.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  sSel.innerHTML = '<option value="">All statuses</option>' + STATUSES.map((s) => `<option>${s}</option>`).join('');
  dSel.value = dv; sSel.value = sv;
  $('kidsCsv').href = `/api/admin/seasons/${encodeURIComponent(S.sid)}/kids.csv`;
  const list = filteredKids();
  for (const id of [...S.sel]) if (!kidRow(id)) S.sel.delete(id);
  const allSel = list.length && list.every((k) => S.sel.has(k.id));
  $('kTable').innerHTML = `<tr><th><input type="checkbox" id="selAll" ${allSel ? 'checked' : ''} aria-label="Select all shown"></th><th>Kid</th><th class="num">Age</th><th>Division</th><th>Team</th><th>Type</th><th>Last season</th><th>Status</th><th title="Lock status against SportsEngine updates">Lock</th><th title="Trying out for the Majors draft">Tryout</th><th>Draft</th><th>Notes</th><th></th></tr>`
    + (list.length ? list.map((k) => {
      const d = div(k.eff_division_id), bad = d && !fitsAge(d, k.league_age);
      const homeDiv = div(k.division_id);
      const team = k.picked_in
        ? `<b>${esc(teamOf(k.eff_team_id)?.name)}</b> <span class="tag">drafted · #${k.pick_n}</span>`
        : homeDiv?.keep_teams ? `<select data-f="teamId" aria-label="Team"><option value="">—</option>${st.teams.filter((t) => t.division_id === homeDiv.id).map((t) => `<option value="${esc(t.id)}" ${t.id === k.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>${k.tryout && k.returning_team_id ? `<span class="tag">left ${esc(teamOf(k.returning_team_id)?.name)} to try out</span>` : ''}`
          : '<span class="sub">—</span>';
      const pool = k.picked_in ? `<span class="sub">${esc(div(draftOf(k.picked_in)?.division_id)?.name)} draft</span>` : k.draft_id ? `<a href="${esc(draftUrl(draftOf(k.draft_id) || { key: '' }))}">${esc(div(draftOf(k.draft_id)?.division_id)?.name)}</a> pool` : '<span class="sub">—</span>';
      return `<tr data-e="${esc(k.id)}" class="${OUT.includes(k.status) ? 'dim' : ''} ${S.sel.has(k.id) ? 'sel' : ''}">
        <td><input type="checkbox" data-sel ${S.sel.has(k.id) ? 'checked' : ''} aria-label="Select ${esc(k.name)}"></td>
        <td><button class="mini" data-kid="${esc(k.kid_id)}" style="border:0;background:none;padding:0;font-weight:600;text-align:left">${esc(k.name)}</button></td>
        <td class="num ${bad ? 'warn-text' : ''}" title="${bad ? `Outside ${esc(d.name)} ${esc(ageRange(d))}` : 'League age'}">${esc(k.league_age ?? '')}</td>
        <td><span class="dv"><select data-f="divisionId" aria-label="Division" ${k.picked_in ? 'disabled title="Drafted — change the pick in the draft room"' : ''}>${divOpts(k.division_id)}</select>${k.division_locked ? `<button class="mini pin" data-unpin title="Placed by an admin; SportsEngine won't move them. Click to let their program decide again.">Pinned ✕</button>` : ''}</span>${k.picked_in && k.eff_division_id !== k.division_id ? `<div class="tag">now ${esc(d?.name)}</div>` : ''}</td>
        <td>${team}</td>
        <td><select data-f="returner" aria-label="Returner or new"><option value="1" ${k.returner ? 'selected' : ''}>Returner</option><option value="0" ${k.returner ? '' : 'selected'}>New</option></select></td>
        <td class="sub">${esc(k.prior)}</td>
        <td><span class="kp"><i class="dot ${dotCls(k.status)}"></i><select data-f="status" aria-label="Status">${STATUSES.map((s) => `<option ${s === k.status ? 'selected' : ''}>${s}</option>`).join('')}</select></span></td>
        <td><input type="checkbox" data-f="locked" ${k.status_locked ? 'checked' : ''} aria-label="Lock status"></td>
        <td>${canTryout(k) ? `<input type="checkbox" data-f="tryout" ${k.tryout ? 'checked' : ''} aria-label="Trying out">` : k.tryout ? '✓' : ''}</td>
        <td>${pool}</td>
        <td><input type="text" data-f="notes" value="${esc(k.notes)}" style="min-width:150px" aria-label="Notes">${k.bought?.length ? `<div class="tag" title="Bought at registration">${esc(k.bought.join(' · '))}</div>` : ''}</td>
        <td><button class="mini" data-del>Remove</button></td></tr>`;
    }).join('') : `<tr><td colspan="13" class="note">No kids match.</td></tr>`);
  renderMoveBar();
}
function renderMoveBar() {
  $('moveBar').hidden = !S.sel.size;
  $('moveCount').textContent = `${plural(S.sel.size, 'kid')} selected`;
  const v = $('moveTo').value; $('moveTo').innerHTML = divOpts(v, 'Choose a division'); $('moveTo').value = v;
}
['kSearch', 'kDiv', 'kStatus', 'kKind', 'kTry', 'kMismatch'].forEach((id) => ($(id)[id === 'kSearch' ? 'oninput' : 'onchange'] = () => renderKids()));
$('addKid').onclick = () => addKidForm();
$('kTable').onchange = async (e) => {
  if (e.target.id === 'selAll') { filteredKids().forEach((k) => (e.target.checked ? S.sel.add(k.id) : S.sel.delete(k.id))); return renderKids(); }
  const tr = e.target.closest('[data-e]'); if (!tr) return;
  const id = tr.dataset.e;
  if (e.target.matches('[data-sel]')) { e.target.checked ? S.sel.add(id) : S.sel.delete(id); tr.classList.toggle('sel', e.target.checked); return renderMoveBar(); }
  const f = e.target.dataset.f; if (!f) return;
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f === 'returner') v = v === '1';
  if (f === 'divisionId' || f === 'teamId') v = v || null;
  const msg = f === 'divisionId' ? `Moved to ${div(v)?.name || 'no division'}` : f === 'tryout' ? (v ? 'Trying out — in the Majors draft pool' : 'Not trying out') : 'Saved';
  if (!(await act('PATCH', `/api/admin/enrollments/${encodeURIComponent(id)}`, { [f]: v }, msg))) render();
};
$('kTable').onclick = async (e) => {
  const kb = e.target.closest('[data-kid]'); if (kb) return showKid(kb.dataset.kid);
  const tr = e.target.closest('[data-e]'); if (!tr) return;
  const id = tr.dataset.e;
  if (e.target.matches('[data-unpin]')) return act('PATCH', `/api/admin/enrollments/${encodeURIComponent(id)}`, { divisionLocked: false }, 'Unpinned — their program decides again');
  const dl = e.target.closest('[data-del]');
  if (dl) { if (dl.dataset.armed) act('DELETE', `/api/admin/enrollments/${encodeURIComponent(id)}`, undefined, `Removed from ${S.st.season.year}`); else { dl.dataset.armed = '1'; dl.textContent = `Remove from ${S.st.season.year}?`; } }
};
$('moveGo').onclick = async () => {
  const to = $('moveTo').value;
  if (!to) return toast('Choose a division to move them to', true);
  if (await act('POST', '/api/admin/enrollments/move', { ids: [...S.sel], divisionId: to, reason: $('moveReason').value.trim() || undefined })) { S.sel.clear(); $('moveReason').value = ''; renderKids(); }
};
$('moveClear').onclick = () => { S.sel.clear(); renderKids(); };

/* ---------- divisions & teams ---------- */
function renderDivisions() {
  const st = S.st;
  const num = (f, v, w = 54) => `<input type="number" data-f="${f}" value="${esc(v ?? '')}" min="0" style="width:${w}px" aria-label="${f}">`;
  $('divTable').innerHTML = `<tr><th></th><th>Division</th><th class="num">Teams</th><th class="num">Roster</th><th class="num">Seats</th><th class="num">Coaches</th><th>Ages</th><th>SE words</th><th>Group</th><th title="Last season's players return to the same team">Keep teams</th><th>Closed</th><th>Draft</th><th></th></tr>`
    + (st.divisions.length ? st.divisions.map((d, i) => `<tr data-d="${esc(d.id)}">
      <td style="white-space:nowrap"><button class="mini" data-up ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="mini" data-down ${i < st.divisions.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button></td>
      <td><input type="text" data-f="name" value="${esc(d.name)}" style="min-width:120px" aria-label="Name"></td>
      <td class="num">${num('teams', d.teams)}</td><td class="num">${num('roster_size', d.roster_size)}</td><td class="num"><b>${d.seats.capacity}</b></td>
      <td class="num">${num('coaches', d.coaches)}</td>
      <td style="white-space:nowrap">${num('min_age', d.min_age, 48)}–${num('max_age', d.max_age, 48)}</td>
      <td><input type="text" data-f="se_match" value="${esc(d.se_match)}" placeholder="${esc(d.name.toLowerCase())}" style="min-width:150px" aria-label="SE words"></td>
      <td><input type="text" data-f="group_key" value="${esc(d.group_key)}" style="width:64px" aria-label="Group"></td>
      <td><input type="checkbox" data-f="keep_teams" ${d.keep_teams ? 'checked' : ''} aria-label="Keep teams"></td>
      <td><input type="checkbox" data-f="closed" ${d.closed ? 'checked' : ''} aria-label="Registration closed"></td>
      <td><select data-draft aria-label="Draft room"><option value="">None</option><option value="standard" ${d.draft?.format === 'standard' ? 'selected' : ''}>Standard</option><option value="blind" ${d.draft?.format === 'blind' ? 'selected' : ''}>Blind numbers</option></select>
        ${d.draft ? `<select data-next aria-label="Undrafted go to"><option value="">then —</option>${st.drafts.filter((r) => r.id !== d.draft.id).map((r) => `<option value="${esc(r.id)}" ${draftOf(d.draft.id)?.next_id === r.id ? 'selected' : ''}>then ${esc(div(r.division_id)?.name)}</option>`).join('')}</select>` : ''}</td>
      <td><button class="mini" data-del>Delete</button></td></tr>`).join('')
      : `<tr><td colspan="13" class="note">No divisions in ${st.season.year} yet.</td></tr>`);
  $('teamLists').innerHTML = st.divisions.map((d) => {
    const ts = st.teams.filter((t) => t.division_id === d.id);
    return `<div class="panel" data-tdiv="${esc(d.id)}"><div class="hd"><h3>${esc(d.name)}</h3><span class="sub">${ts.length} of ${d.teams} teams named</span><button class="mini" data-addteam>Add team</button></div>
      <div class="bd scroll"><table class="kt"><tr><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">T</th><th>Coach</th><th></th></tr>
      ${ts.map((t) => `<tr data-t="${esc(t.id)}"><td><input type="text" data-tf="name" value="${esc(t.name)}" style="width:110px" aria-label="Team name"></td>
        ${['wins', 'losses', 'ties'].map((f) => `<td class="num"><input type="number" data-tf="${f}" value="${esc(t[f] ?? '')}" min="0" style="width:46px" aria-label="${f}"></td>`).join('')}
        <td><input type="text" data-tf="coach" value="${esc(t.coach || '')}" style="width:100px" aria-label="Coach"></td><td><button class="mini" data-deltm>✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="note">No teams named yet.</td></tr>'}
      </table></div></div>`;
  }).join('');
  $('rosterSeason').textContent = st.season.year;
  const v = $('rosterDefault').value; $('rosterDefault').innerHTML = divOpts(v, 'Skip that row'); $('rosterDefault').value = v;
  $('ageCutoff').value = st.season.age_cutoff; $('warnAt').value = st.season.warn_at;
}
function divBody(tr) {
  const val = (f) => tr.querySelector(`[data-f="${f}"]`);
  const n = (f) => (val(f).value === '' ? null : parseInt(val(f).value, 10));
  return { name: val('name').value, teams: n('teams') ?? 0, roster_size: n('roster_size') ?? 12, coaches: n('coaches'), min_age: n('min_age'), max_age: n('max_age'),
    se_match: val('se_match').value, group_key: val('group_key').value, keep_teams: val('keep_teams').checked, closed: val('closed').checked };
}
$('divTable').onchange = async (e) => {
  const tr = e.target.closest('[data-d]'); if (!tr) return;
  const id = tr.dataset.d, d = div(id);
  if (e.target.matches('[data-draft]')) {
    const f = e.target.value;
    const ok = f ? await act('PUT', `/api/admin/divisions/${encodeURIComponent(id)}/draft`, { format: f }, 'Draft room saved')
      : d.draft ? await act('DELETE', `/api/admin/drafts/${encodeURIComponent(d.draft.id)}`, undefined, 'Draft room removed') : {};
    if (!ok) render();
    return;
  }
  if (e.target.matches('[data-next]')) { if (!(await act('PUT', `/api/admin/divisions/${encodeURIComponent(id)}/draft`, { nextId: e.target.value || null }, 'Saved'))) render(); return; }
  if (!e.target.dataset.f) return;
  if (!(await act('PATCH', `/api/admin/divisions/${encodeURIComponent(id)}`, divBody(tr), 'Saved'))) render();
};
$('divTable').onclick = async (e) => {
  const tr = e.target.closest('[data-d]'); if (!tr) return;
  const ids = S.st.divisions.map((d) => d.id), i = ids.indexOf(tr.dataset.d);
  if (e.target.matches('[data-up],[data-down]')) { const j = e.target.matches('[data-up]') ? i - 1 : i + 1; [ids[i], ids[j]] = [ids[j], ids[i]]; return act('PUT', `/api/admin/seasons/${encodeURIComponent(S.sid)}/divisions/order`, { order: ids }); }
  const dl = e.target.closest('[data-del]');
  if (dl) { if (dl.dataset.armed) act('DELETE', `/api/admin/divisions/${encodeURIComponent(tr.dataset.d)}`, undefined, 'Division deleted'); else { dl.dataset.armed = '1'; dl.textContent = 'Delete?'; } }
};
$('teamLists').onchange = async (e) => {
  const tr = e.target.closest('[data-t]'); if (!tr) return;
  const t = teamOf(tr.dataset.t), body = { name: t.name };
  tr.querySelectorAll('[data-tf]').forEach((el) => { const f = el.dataset.tf; body[f] = el.type === 'number' ? (el.value === '' ? null : parseInt(el.value, 10)) : el.value; });
  if (!(await act('PATCH', `/api/admin/teams/${encodeURIComponent(t.id)}`, body, 'Team saved'))) render();
};
$('teamLists').onclick = (e) => {
  const p = e.target.closest('[data-tdiv]'); if (!p) return;
  if (e.target.matches('[data-addteam]')) return act('POST', `/api/admin/divisions/${encodeURIComponent(p.dataset.tdiv)}/teams`, { name: 'New team' }, 'Team added');
  const del = e.target.closest('[data-deltm]');
  if (del) { const id = del.closest('[data-t]').dataset.t; if (del.dataset.armed) act('DELETE', `/api/admin/teams/${encodeURIComponent(id)}`, undefined, 'Team removed'); else { del.dataset.armed = '1'; del.textContent = 'Remove?'; } }
};
$('addDiv').onclick = () => openDialog(`<form class="dlg" id="df"><h2>Add a ${S.st.season.year} division</h2>
  <div class="row"><label for="dName">Name</label><input type="text" id="dName" required style="flex:1" placeholder="e.g. Minors"></div>
  <div class="row"><label for="dTeams">Teams</label><input type="number" id="dTeams" min="0" value="0" style="width:80px"><label for="dRoster" style="min-width:0">× roster</label><input type="number" id="dRoster" min="1" value="12" style="width:80px"></div>
  <div class="row"><label for="dMin">League ages</label><input type="number" id="dMin" min="0" style="width:70px" aria-label="Youngest">–<input type="number" id="dMax" min="0" style="width:70px" aria-label="Oldest"></div>
  <div class="row"><label for="dMatch">SE words</label><input type="text" id="dMatch" style="flex:1" placeholder="defaults to the name"></div>
  <p class="err-text" id="dErr"></p>
  <div class="row"><button class="btn primary" type="submit">Add</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (d) => {
  const n = (id) => { const v = d.querySelector(id).value; return v === '' ? null : parseInt(v, 10); };
  d.querySelector('#df').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call('POST', `/api/admin/seasons/${encodeURIComponent(S.sid)}/divisions`, { name: d.querySelector('#dName').value, teams: n('#dTeams') ?? 0, roster_size: n('#dRoster') ?? 12, min_age: n('#dMin'), max_age: n('#dMax'), se_match: d.querySelector('#dMatch').value });
      toast('Division added'); d.close();
    } catch (err) { d.querySelector('#dErr').textContent = err.message; }
  };
});
$('rosterImport').onclick = async () => {
  const text = $('rosterBox').value.trim(); if (!text) return toast('Paste rosters first', true);
  const r = await act('POST', `/api/admin/seasons/${encodeURIComponent(S.sid)}/rosters/import`, { text, divisionId: $('rosterDefault').value || null });
  if (!r) return;
  toast(`Added ${r.added}, updated ${r.updated} (${r.newKids} new kids, ${r.teamsCreated} new teams)${r.carried ? ` · ${r.carried} carried into next season` : ''}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`);
  if (r.skipped.length) openDialog(`<div class="dlg"><h2>Rows skipped</h2><ul>${r.skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`);
  $('rosterBox').value = '';
};
$('ageCutoff').onchange = (e) => act('PATCH', `/api/admin/seasons/${encodeURIComponent(S.sid)}`, { age_cutoff: e.target.value.trim() }, 'Saved');
$('warnAt').onchange = (e) => act('PATCH', `/api/admin/seasons/${encodeURIComponent(S.sid)}`, { warn_at: parseInt(e.target.value, 10) || 0 }, 'Saved');

/* ---------- seasons ---------- */
let rollPreview = null;
async function renderSeasons() {
  const st = S.st;
  $('seasonTable').innerHTML = '<tr><th>Season</th><th>Status</th><th></th></tr>' + st.seasons.slice().reverse().map((s) => `<tr data-s="${esc(s.id)}">
    <td><b>${s.year}</b></td>
    <td><select data-status aria-label="Status"><option value="planning" ${s.status === 'planning' ? 'selected' : ''}>Planning</option><option value="active" ${s.status === 'active' ? 'selected' : ''}>Playing</option><option value="complete" ${s.status === 'complete' ? 'selected' : ''}>Finished</option></select></td>
    <td>${s.id === st.current ? '<span class="chip good">Current</span>' : `<button class="mini" data-cur>Make current</button>`}</td></tr>`).join('');
  const next = st.seasons.find((s) => s.year === st.season.year + 1);
  $('rollTitle').textContent = `Finish ${st.season.year} → start ${st.season.year + 1}`;
  if (next) { $('rollBox').innerHTML = `<p>${st.season.year + 1} already exists. Kids added to ${st.season.year} rosters later (Divisions &amp; Teams → Paste rosters) are carried into it automatically.</p>`; return; }
  if (rollPreview?.from !== S.sid) { rollPreview = { from: S.sid, loading: true }; rollPreview = await call('GET', `/api/admin/seasons/${encodeURIComponent(S.sid)}/rollover`).catch(() => null); }
  const p = rollPreview;
  if (!p || p.loading) { $('rollBox').innerHTML = '<p class="note">Loading…</p>'; return; }
  $('rollBox').innerHTML = `<p>Starting ${p.to} copies ${st.season.year}'s divisions, teams (same names and draft order) and draft rooms, then gives every kid who played an <i>Expected</i> spot:</p>
    <ul><li><b>${p.returning}</b> back on the same team (Majors, Minors, Rookie)</li><li><b>${p.movingUp}</b> moving to the division their new age fits, into its draft</li><li><b>${p.graduating}</b> aged out — not carried forward</li><li><b>${p.skipped}</b> didn't play (Not returning / Withdrawn) — they come back through registration</li></ul>
    <p class="note">${Object.entries(p.byDivision).map(([k, v]) => `${esc(k)}: ${v.returning} returning, ${v.new} new`).join(' · ') || 'Nobody to carry forward yet.'}</p>
    <p class="note">${st.season.year} is then marked finished and ${p.to} becomes the current season. Enter ${st.season.year}'s team records first if next year's draft order uses them.</p>
    <div class="row"><button class="btn primary" id="rollGo">Finish ${st.season.year} and start ${p.to}</button></div>`;
  $('rollGo').onclick = async (e) => {
    if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = `Click again to start ${p.to}`; return; }
    const r = await act('POST', `/api/admin/seasons/${encodeURIComponent(S.sid)}/rollover`, { confirm: 'yes' }, `${p.to} season started`);
    if (r) { S.sid = r.to; rollPreview = null; try { localStorage.setItem('league-season', S.sid); } catch { /* private */ } refresh(); }
  };
}
$('seasonTable').onchange = (e) => { const tr = e.target.closest('[data-s]'); if (tr && e.target.matches('[data-status]')) act('PATCH', `/api/admin/seasons/${encodeURIComponent(tr.dataset.s)}`, { status: e.target.value }, 'Saved'); };
$('seasonTable').onclick = (e) => { const tr = e.target.closest('[data-s]'); if (tr && e.target.matches('[data-cur]')) act('POST', `/api/admin/seasons/${encodeURIComponent(tr.dataset.s)}/current`, {}, `${tr.dataset.s} is now the current season`); };
$('addSeason').onclick = async () => {
  const y = parseInt($('newYear').value, 10); if (!y) return toast('Enter a year', true);
  if (await act('POST', '/api/admin/seasons', { year: y }, `${y} added`)) { S.sid = String(y); $('newYear').value = ''; refresh(); }
};

/* ---------- registrations ---------- */
const OUTCOME_CHIP = { placed: 'good', returner: 'good', withdrawn: 'meh', no_division: 'bad', ambiguous: 'bad', error: 'bad', pending: 'meh', wrong_year: '', ignored: '' };
const LABELS = { placed: 'New kid placed', returner: 'Returner', withdrawn: 'Withdrawn', no_division: 'No division', ambiguous: 'Ambiguous', error: 'Error', pending: 'Pending', wrong_year: 'Other season', ignored: 'Ignored' };
async function loadRegs() {
  const d = await call('GET', `/api/admin/registrations?filter=${encodeURIComponent($('regFilter').value)}`).catch((e) => { toast(e.message, true); return null; });
  if (!d) return;
  S.regs = d;
  const open = ['no_division', 'ambiguous', 'error', 'pending'].reduce((a, k) => a + (d.counts[k] || 0), 0);
  $('regBadge').hidden = !open; $('regBadge').textContent = open;
  if (S.tab === 'regs') renderRegs();
}
function renderRegs() {
  const d = S.regs; if (!d) return;
  const w = d.webhook;
  $('whInfo').innerHTML = w.configured
    ? `<p>Give SportsEngine this endpoint (POST, JSON):</p><code>${esc(w.url)}</code>
       <p class="note">${w.signed ? `Signatures are <b>required</b> (HMAC-SHA256 in <code>${esc(w.signatureHeader)}</code>).` : 'No signing secret set yet: deliveries are accepted on the URL token alone and marked unverified.'}</p>
       <p class="note">A registration goes to the season matching its year (or the current season). Every delivery is kept, so a mapping fix can be re-run.</p>`
    : `<p>Not switched on yet. Set <code>SPORTSENGINE_WEBHOOK_TOKEN</code> in <code>.env</code> and restart.</p><p class="note">Meanwhile, import the registration report CSV below.</p>`;
  $('regCounts').innerHTML = Object.entries(LABELS).filter(([k]) => d.counts[k]).map(([k, l]) => `<span class="chip ${OUTCOME_CHIP[k]}">${l} ${d.counts[k]}</span>`).join('') || '<span class="note">No registrations received yet.</span>';
  const kidOpts = (S.st.kids || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((k) => `<option value="k:${esc(k.kid_id)}">${esc(k.name)}${k.league_age != null ? ` (${k.league_age})` : ''} · ${esc(div(k.eff_division_id)?.name || 'no division')}</option>`).join('');
  const divChoices = S.st.divisions.map((x) => `<option value="d:${esc(x.id)}">${esc(x.name)}</option>`).join('');
  $('regTable').innerHTML = `<tr><th>Received (UTC)</th><th>Source</th><th>Participant</th><th>DOB</th><th>Program</th><th>Season</th><th>Outcome</th><th>Division</th><th>Note</th><th></th></tr>`
    + (d.rows.length ? d.rows.map((r) => {
      const needs = ['no_division', 'ambiguous', 'error', 'pending'].includes(r.outcome);
      return `<tr data-r="${r.id}"><td class="sub">${esc(r.received_at)}</td><td>${esc(r.source)}${r.source === 'webhook' && !r.verified ? ' <span class="tag">unverified</span>' : ''}</td>
        <td>${r.kid_id ? `<button class="mini" data-kid="${esc(r.kid_id)}" style="border:0;background:none;padding:0;font-weight:700">${esc([r.first_name, r.last_name].filter(Boolean).join(' '))}</button>` : `<b>${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '—')}</b>`}${r.event_type ? `<div class="sub">${esc(r.event_type)}</div>` : ''}</td>
        <td>${esc(r.birthdate || '')}</td><td>${esc(r.program || '')}</td><td>${esc(r.season_id || r.reg_year || '')}</td>
        <td><span class="chip ${OUTCOME_CHIP[r.outcome] ?? ''}">${esc(LABELS[r.outcome] || r.outcome)}</span></td>
        <td>${esc(r.division_name || '')}</td><td class="sub">${esc(r.note)}</td>
        <td style="white-space:nowrap">${needs ? `<select data-place aria-label="Place" style="width:180px"><option value="">Place…</option><optgroup label="New kid in ${S.st.season.year} division">${divChoices}</optgroup><optgroup label="Known kid">${kidOpts}</optgroup></select> <button class="mini" data-ignore>Ignore</button> ` : ''}<button class="mini" data-rerun>Re-run</button> <button class="mini" data-raw>Raw</button></td></tr>`;
    }).join('') : '<tr><td colspan="10" class="note">Nothing here.</td></tr>');
}
$('regFilter').onchange = loadRegs;
$('regReprocess').onclick = async () => { const t = await act('POST', '/api/admin/registrations/reprocess-open', {}); if (t) { toast(Object.entries(t).map(([k, v]) => `${v} ${LABELS[k] || k}`).join(', ') || 'Nothing to re-run'); loadRegs(); } };
$('regTable').onchange = async (e) => {
  if (!e.target.matches('[data-place]') || !e.target.value) return;
  const id = e.target.closest('[data-r]').dataset.r, kind = e.target.value.slice(0, 1), v = e.target.value.slice(2);
  const r = await act('POST', `/api/admin/registrations/${id}/place`, kind === 'k' ? { kidId: v } : { divisionId: v });
  if (r) { toast(r.note); loadRegs(); }
};
$('regTable').onclick = async (e) => {
  const kb = e.target.closest('[data-kid]'); if (kb) return showKid(kb.dataset.kid);
  const tr = e.target.closest('[data-r]'); if (!tr) return;
  const id = tr.dataset.r;
  if (e.target.matches('[data-ignore]')) { if (await act('POST', `/api/admin/registrations/${id}/ignore`, {}, 'Ignored')) loadRegs(); }
  if (e.target.matches('[data-rerun]')) { const r = await act('POST', `/api/admin/registrations/${id}/reprocess`, {}); if (r) { toast(`${LABELS[r.outcome] || r.outcome}: ${r.note}`); loadRegs(); } }
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
  if (t) { toast(Object.entries(t).map(([k, v]) => `${v} ${LABELS[k] || k}`).join(', ')); $('regCsv').value = ''; $('regFile').value = ''; loadRegs(); }
};
$('mSave').onclick = async () => {
  const body = { firstName: $('mFirst').value.trim(), lastName: $('mLast').value.trim(), birthdate: $('mDob').value || undefined, program: $('mProgram').value.trim() || undefined, season: S.sid };
  if (!body.firstName || !body.lastName) return toast('First and last name are required', true);
  const r = await act('POST', '/api/admin/registrations/manual', body);
  if (r) { toast(`${LABELS[r.outcome] || r.outcome}: ${r.note}`); ['mFirst', 'mLast', 'mDob', 'mProgram'].forEach((i) => ($(i).value = '')); loadRegs(); }
};

/* ---------- activity ---------- */
async function loadLog() { S.log = await call('GET', `/api/admin/audit?season=${encodeURIComponent(S.sid)}`).catch(() => null); if (S.tab === 'log') renderLog(); }
function renderLog() {
  if (!S.log) { $('logTable').innerHTML = '<tr><td class="note">Loading…</td></tr>'; return; }
  $('logTable').innerHTML = '<tr><th>When (UTC)</th><th>Season</th><th>Who</th><th>What</th><th>Kid</th><th>Detail</th></tr>'
    + S.log.map((a) => `<tr><td class="sub">${esc(a.at)}</td><td>${esc(a.season_id || '')}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td>${a.kid_id ? `<button class="mini" data-kid="${esc(a.kid_id)}" style="border:0;background:none;padding:0">${esc(a.kid_name || '?')}</button>` : ''}</td><td class="mono">${esc(a.detail)}</td></tr>`).join('');
}
$('logRefresh').onclick = loadLog;
$('logTable').onclick = (e) => { const kb = e.target.closest('[data-kid]'); if (kb) showKid(kb.dataset.kid); };

/* ---------- tabs ---------- */
const VIEWS = ['seats', 'drafts', 'kids', 'campaigns', 'outreach', 'regs', 'divisions', 'seasons', 'log'];
function setTab(t) {
  const btn = document.querySelector(`[data-tab="${t}"]`);
  if (!btn || (btn.hasAttribute('data-admin') && !isAdmin())) t = 'seats';
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  VIEWS.forEach((v) => ($('view-' + v).hidden = v !== t));
  try { localStorage.setItem('league-tab', t); } catch { /* private mode */ }
  if (t === 'regs') loadRegs();
  if (t === 'log') loadLog();
  if (t === 'outreach') OS.loadedFor = null;
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

/* ---------- gates ---------- */
function gate(html, bind) { $('app').hidden = true; const g = $('gate'); g.innerHTML = html; g.hidden = false; bind(g); }
function loginGate() {
  gate(`<form class="gate" id="lf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">${esc(S.home?.league || 'League')}</small>Admin login</h1>
    <input type="text" id="lu" placeholder="Username" autocomplete="username" required aria-label="Username">
    <input type="password" id="lp" placeholder="Password" autocomplete="current-password" required aria-label="Password">
    <p class="err-text" id="le"></p><button class="btn primary" type="submit">Log in</button><a href="/" class="note">← Back to seat counts</a></form>`, (g) => {
    g.querySelector('#lu').focus();
    g.querySelector('#lf').onsubmit = async (e) => {
      e.preventDefault();
      try { await call('POST', '/api/login', { username: g.querySelector('#lu').value, password: g.querySelector('#lp').value }); location.reload(); }
      catch (err) { g.querySelector('#le').textContent = err.message; }
    };
  });
}
function viewerGate() {
  gate(`<form class="gate" id="vf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">${esc(S.home?.league || 'League')}</small>League</h1>
    <p class="note">Enter the league's code.</p>
    <input type="password" id="vc" placeholder="League code" required aria-label="League code">
    <p class="err-text" id="ve"></p><button class="btn primary" type="submit">Continue</button><a href="/admin" class="note">Admin login</a></form>`, (g) => {
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
  if (!S.sid) return;
  try {
    S.st = await call('GET', `/api/seasons/${encodeURIComponent(S.sid)}/state`);
    render();
    if (isAdmin() && S.tab !== 'regs') loadRegs(); // keep the inbox badge current
  } catch (e) { toast(e.message, true); }
}
let refreshTimer;
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('change', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); });
  es.onopen = () => { S.live = true; refresh(); };
  es.onerror = () => { S.live = false; if (S.st) $('live').innerHTML = '<span class="chip off">Reconnecting</span>'; };
}

(async () => {
  [S.me, S.home] = await Promise.all([call('GET', '/api/me'), call('GET', '/api/home')]);
  if (location.pathname.startsWith('/admin') && !S.me.admin) return loginGate();
  if (!S.me.viewer) return viewerGate();
  let saved = null;
  try { saved = localStorage.getItem('league-season'); } catch { /* private */ }
  S.sid = new URLSearchParams(location.search).get('season') || saved || S.home.current;
  if (!S.sid) { $('app').hidden = false; $('headline').innerHTML = '<div class="big">No seasons yet</div>'; return; }
  $('app').hidden = false;
  await refresh();
  if (!S.st) { S.sid = S.home.current; await refresh(); }
  const m = /^\/kids\/([^/]+)/.exec(location.pathname);
  let t = 'seats';
  try { t = localStorage.getItem('league-tab') || 'seats'; } catch { /* private mode */ }
  setTab(t);
  if (m && isAdmin()) showKid(decodeURIComponent(m[1]));
  connect();
})();
