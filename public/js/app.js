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
// isAdmin(): may *see* the admin areas (an admin or the Board of Directors). canEdit(): may change things (admins only).
const isAdmin = () => !!S.me?.admin || !!S.me?.board;
const canEdit = () => !!S.me?.admin;
const isCoach = () => isAdmin() || !!S.me?.coachSeasons?.length; // admins see the coach view too, as any coach
const signinUrl = () => `/signin?next=${encodeURIComponent(location.pathname + location.search)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), err ? 4500 : 2600); }
async function call(method, url, body) {
  // Every mutation goes out as JSON (even a bodiless DELETE) — the server's CSRF guard requires it.
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && data?.error === 'login_required') location.href = signinUrl();
    throw new Error(data?.error || `Request failed (${r.status})`);
  }
  return data;
}
async function act(method, url, body, okMsg) {
  if (method !== 'GET' && /^\/api\/admin\//.test(url) && !canEdit()) { toast('View only — Board of Directors can see this but not change it', true); return null; }
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
  $('seasonSel').innerHTML = st.seasons.slice().reverse().map((s) => `<option value="${esc(s.id)}" ${s.id === S.sid ? 'selected' : ''}>${s.year} Season${s.id === st.current ? ' · current' : s.status === 'complete' ? ' · finished' : ''}</option>`).join('');
  document.querySelectorAll('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
  document.querySelectorAll('[data-coach]').forEach((el) => (el.hidden = !isCoach()));
  document.querySelectorAll('[data-owner]').forEach((el) => (el.hidden = !canEdit())); // league-wide pages: admins only, not the Board
  document.querySelector('[data-tab=coach]').textContent = isAdmin() ? 'Coach view' : 'My players';
  $('live').innerHTML = `<span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'Live' : 'Reconnecting'}</span>`;
  const hats = [canEdit() ? 'admin' : '', S.me.board && !canEdit() ? 'Board' : '', S.me.coachSeasons?.length ? 'coach' : ''].filter(Boolean);
  $('whoami').innerHTML = `Signed in as <b>${esc(S.me.user.email)}</b>${hats.length ? ` (${hats.join(' · ')})` : ''} · <button id="logout">Log out</button>`;
  document.body.classList.toggle('viewonly', isAdmin() && !canEdit());
  $('viewOnly').hidden = !(isAdmin() && !canEdit());
  const lo = $('logout'); if (lo) lo.onclick = async () => { await act('POST', '/api/logout', {}); location.href = '/signin'; };
  $('capCsv').href = `/api/seasons/${encodeURIComponent(S.sid)}/capacity.csv`;
  if (S.tab === 'seats') renderSeats();
  if (S.tab === 'drafts') renderDrafts();
  if (S.tab === 'coach') loadCoach(); // coach.js
  // Admin tabs hold inputs; don't rebuild under someone's cursor. Re-render on blur instead.
  const ae = document.activeElement;
  const typing = ae?.closest?.('section') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox' && ae.type !== 'file';
  if (typing && ['kids', 'divisions', 'settings', 'seasons', 'campaigns'].includes(S.tab)) { S.pendingRender = true; return; }
  if (S.tab === 'kids') renderKids();
  if (S.tab === 'divisions') renderDivisions();
  if (S.tab === 'settings') renderRegs();
  if (S.tab === 'seasons') renderSeasons();
  if (S.tab === 'log') renderLog();
  if (S.tab === 'users' && !US.loaded) loadUsers(); // users.js
  if (S.tab === 'campaigns') loadCampaigns(); // campaigns.js
  if (S.tab === 'outreach' && OS.loadedFor !== S.sid) loadOutreach(); // outreach.js — reloads on tab open, not on every change, so a message being typed survives
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !document.activeElement?.closest?.('section')) { S.pendingRender = false; render(); } }, 0));
$('seasonSel').onchange = (e) => switchSeason(e.target.value);

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
      h.innerHTML = `<div class="big">No divisions set up yet</div><div class="meta">${isAdmin() ? 'Add divisions and team counts under <b>Season → Divisions &amp; teams</b>.' : 'Seat counts will appear here once the league sets up its divisions.'}</div>`;
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
  }

  renderSeatSummary(us);
  renderDivRows(us);
  loadAges();
}

/* One strip of league totals — each number appears once on the page. */
function renderSeatSummary(us) {
  const st = S.st, t = st.total, box = $('kpis');
  const sum = (f) => us.reduce((a, u) => a + f(u.seats), 0);
  const kpi = (n, label, sub = '', cls = '') => `<div class="kpi ${cls}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  if (complete()) { box.innerHTML = kpi(t.capacity, 'Seats') + kpi(sum((s) => s.registered), 'Played'); return; }
  const ret = sum((s) => s.returnersRegistered), held = sum((s) => s.held), over = us.filter((u) => u.seats.open < 0);
  box.innerHTML = kpi(t.capacity, 'Seats', `${plural(us.length, 'division')}`)
    + kpi(t.registered + held, 'Expected to play', 'if every returner comes back')
    + kpi(t.registered, 'Registered', `${ret} of ${ret + held} returners · ${ret + held ? Math.round(100 * ret / (ret + held)) : 0}%`)
    + kpi(t.open, 'Seats open', over.length ? `<span class="bad-text">${plural(over.length, 'division')} over</span>` : 'for new families', over.length ? 'bad' : '')
    + (st.unplaced && isAdmin() ? kpi(st.unplaced, 'Not in a division', 'need a home', 'warn') : '');
}

/* Divisions: one row each — the bar shows who holds the seats, the numbers say how many. */
function renderDivRows(us) {
  const warnAt = S.st.season.warn_at ?? 4, done = complete();
  document.querySelector('.sdivpanel .vlegend').hidden = done;
  $('divs').innerHTML = us.map((u) => {
    const s = u.seats, r = done ? null : riskOf(s, warnAt);
    const base = Math.max(s.capacity, s.projected, s.registered, 1), w = (n) => `${(100 * n / base).toFixed(2)}%`;
    const seg = (cls, n, tip) => (n > 0 ? `<i class="${cls}" style="width:${w(n)}" data-tip="${esc(`${u.name}: ${tip}`)}"></i>` : '');
    const notes = [];
    const note = (cls, html) => notes.push(`<span class="${cls}">${html}</span>`);
    if (!done) {
      if (r && (r.rank === 1 || r.rank === 2)) note('warn', esc(r.why));
      if (s.atRisk) note('warn', `${plural(s.atRisk, 'returner')} still need a call — best case ${s.bestCaseOpen} open`);
      if (u.div && s.coachGap) note('bad', `${plural(s.coachGap, 'team')} without a coach`);
      if (u.div && s.capacity && s.teamsNeeded > u.div.teams) note('bad', `${s.projected} kids would need ${s.teamsNeeded} teams (${u.div.teams} planned)`);
      if (s.waitlist) note('', `${s.waitlist} on the waitlist`);
      const mism = u.div ? u.div.ageMismatches : u.members.reduce((a, d) => a + (d.ageMismatches || 0), 0);
      if (mism) note('warn', `${plural(mism, 'kid')} outside the age range`);
      const exc = u.div ? u.div.ageExceptions : u.members.reduce((a, d) => a + (d.ageExceptions || 0), 0);
      if (exc) note('', `${plural(exc, 'kid')} moved up by an admin`);
    }
    if (u.members) note('', u.members.map((d) => `${esc(d.name)} ${d.seats.registered + d.seats.held} of ${d.seats.capacity}`).join(' · '));
    const sub = u.div ? `${u.div.teams} teams × ${u.div.roster_size}${ageRange(u.div) ? ` · ${esc(ageRange(u.div))}` : ''}`
      : `${u.members.map((d) => `${esc(d.name)} ${d.teams}×${d.roster_size}`).join(' · ')} · drafts decide`;
    const state = done ? 'done' : s.state;
    const open = done ? [s.registered, 'played'] : !s.capacity ? ['—', 'no teams set'] : s.open < 0 ? [`+${-s.open}`, 'over'] : [s.open, s.state === 'full' ? 'full' : s.state === 'closing' ? 'left · closing' : s.state === 'closed' ? 'reg. closed' : 'open'];
    const capAt = s.capacity ? 100 * s.capacity / base : 0;
    return `<article class="srow ${state}">
      <div class="sname"><h3>${esc(u.name)}</h3><div class="sub">${sub}</div></div>
      <div class="sviz">
        <div class="strack" role="img" aria-label="${esc(`${u.name}: ${s.registered} registered, ${s.held} returners expected, ${s.capacity} seats`)}">
          ${s.capacity && base > s.capacity ? `<span class="overzone" style="left:${capAt.toFixed(2)}%"></span>` : ''}
          ${done ? seg('ret', s.registered, `${s.registered} played`) : seg('ret', s.returnersRegistered, `${s.returnersRegistered} returners registered`) + seg('new', s.newRegistered, `${s.newRegistered} new kids registered`)}
          ${done ? '' : seg('held', s.held - s.atRisk, `${s.held - s.atRisk} returners expected back, not registered yet`) + seg('risk', s.atRisk, `${s.atRisk} returners who still need a call`)}
          ${s.capacity ? `<span class="cap" style="left:${capAt.toFixed(2)}%" data-tip="${esc(`${u.name}: ${s.capacity} seats`)}"></span>` : ''}
        </div>
        ${notes.length ? `<div class="snotes">${notes.join('')}</div>` : ''}
      </div>
      <dl class="snums">
        <div><dt>Seats</dt><dd>${s.capacity}</dd></div>
        ${done ? '' : `<div title="${s.returnersRegistered} returners · ${s.newRegistered} new"><dt>Registered</dt><dd>${s.registered}</dd></div>
        <div title="Seats held for returners who haven't registered yet"><dt>Expected</dt><dd>${s.held}</dd></div>`}
      </dl>
      <div class="sopen"><b>${open[0]}</b><span>${open[1]}</span></div>
    </article>`;
  }).join('');
  $('divTable').innerHTML = `<tr><th>Division</th><th class="num">Seats</th><th class="num">Registered</th><th class="num">Returners registered</th><th class="num">New registered</th><th class="num">Returners expected</th><th class="num">Need a call</th><th class="num">Open</th></tr>
    ${us.map(({ name, seats: s }) => `<tr><td>${esc(name)}</td><td class="num">${s.capacity}</td><td class="num">${s.registered}</td><td class="num">${s.returnersRegistered}</td><td class="num">${s.newRegistered}</td><td class="num">${s.held}</td><td class="num">${s.atRisk}</td><td class="num">${s.open}</td></tr>`).join('')}`;
}

/* ---------- anticipated vs actual, and where returners could get squeezed out ----------
   Anticipated assumes every expected returner comes back; actual is who has registered.
   The risk is a division filling up with new families while its returners haven't signed
   up yet: if they come later there may be no seat. Seats held for expected returners keep
   them safe only while the holds stand. */
const RISK = {
  over: { rank: 0, cls: 'crit', icon: '▲', label: 'Over' },
  tight: { rank: 1, cls: 'warn', icon: '◆', label: 'Tight' },
  watch: { rank: 2, cls: 'watch', icon: '●', label: 'Watch' },
  ok: { rank: 3, cls: 'good', icon: '✓', label: 'OK' },
};
function riskOf(s, warnAt) {
  const left = s.capacity - s.registered - s.held; // seats new families can still take
  const out = s.held, signed = s.returnersRegistered;
  if (!s.capacity) return null;
  if (left < 0) return { ...RISK.over, why: `If every expected returner comes back, ${plural(-left, 'returner')} won’t have a seat.` };
  const near = Math.max(warnAt, Math.ceil(s.capacity * 0.05));
  if (left <= near && out > 0) return { ...RISK.tight, why: `Only ${plural(left, 'seat')} left for new kids, with ${plural(out, 'returner')} not signed up yet.` };
  if (s.newRegistered > signed && out > left) return { ...RISK.watch, why: `New sign-ups (${s.newRegistered}) are ahead of returners (${signed}); ${plural(out, 'returner')} still to come.` };
  return { ...RISK.ok, why: `${plural(left, 'seat')} open for new kids after every expected returner.` };
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
  if (!st.drafts.length) { $('draftCards').innerHTML = `<p class="note">No draft rooms for ${st.season.year}.${isAdmin() ? ' Set one up per division under <b>Season → Divisions &amp; teams</b>.' : ''}</p>`; return; }
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
/* ---------- players (one season) ----------
   Opened from Seasons. Players are split by where they stand — registered, expected back from last season,
   waiting, out — so "who's actually signed up" never mixes with "who we're expecting". Rows read; a dialog edits. */
S.kSeg = S.kSeg || {};
const PSEGS = [
  ['reg', (st) => (st.season.status === 'complete' ? 'Played' : 'Registered'), (k) => k.status === 'Registered'],
  ['yes', () => 'Said they’re coming back', (k) => k.status === 'Expected' && k.intent === 'yes'],
  ['exp', () => 'Expected — no answer yet', (k) => k.status === 'Expected' && k.intent !== 'yes'],
  ['call', () => 'Need a call', (k) => k.status === 'Need to contact'],
  ['wait', () => 'Waitlist', (k) => k.status === 'Waitlist'],
  ['out', () => 'Not returning', (k) => OUT.includes(k.status)],
  ['all', () => 'Everyone', () => true],
];
const prevYear = (st) => (st.seasons.some((x) => x.year === st.season.year - 1) ? st.season.year - 1 : null);
const SEG_HINT = {
  reg: (st) => (st.season.status === 'complete' ? `Everyone on a ${st.season.year} roster.` : `Paid and signed up for ${st.season.year}.`),
  yes: (st) => `Returners whose family answered “we’ll be back” — on the interest check, at registration, or through their coach. Not paid for ${st.season.year} yet, but much more likely than a default.`,
  exp: (st) => `On the ${prevYear(st) ?? 'last'} rosters and still the right age, but nobody has told us their plans. They hold a seat by default until they register or answer.`,
  call: () => 'Returners the league should reach out to (e.g. moved up early and likely to drop out). They hold a seat too.',
  wait: () => 'Signed up after their division filled. Nothing charged until a spot is offered.',
  out: () => 'Not returning or withdrawn. They don’t hold a seat.',
  all: () => '',
};
function kidSeg(st) {
  const counts = Object.fromEntries(PSEGS.map(([k, , f]) => [k, (st.kids || []).filter(f).length]));
  let seg = S.kSeg[S.sid];
  if (!seg || (!counts[seg] && seg !== 'all')) seg = counts.reg ? 'reg' : counts.yes ? 'yes' : counts.exp ? 'exp' : 'all';
  return { seg, counts };
}
function filteredKids() {
  const st = S.st, q = $('kSearch').value.trim().toLowerCase(), dv = $('kDiv').value;
  const { seg } = kidSeg(st), f = PSEGS.find((x) => x[0] === seg)[2];
  return (st.kids || []).filter((k) => f(k)
    && (!q || k.name.toLowerCase().includes(q) || (k.notes || '').toLowerCase().includes(q) || (k.prior || '').toLowerCase().includes(q))
    && (!dv || (dv === '-' ? !k.eff_division_id : k.eff_division_id === dv || (k.division_id === dv && k.picked_in)))
    && (!$('kTry').checked || k.tryout) && (!$('kMismatch').checked || (k.eff_division_id && !fitsAge(div(k.eff_division_id), k.league_age))));
}
function playerPlace(k) {
  if (k.picked_in) return `<b>${esc(teamOf(k.eff_team_id)?.name || '?')}</b><span class="sub">Drafted · pick #${k.pick_n}</span>`;
  if (k.eff_team_id) return `<b>${esc(teamOf(k.eff_team_id)?.name)}</b><span class="sub">${S.st.season.status !== 'complete' && k.returner && k.returning_team_id === k.eff_team_id ? 'Back on last season’s team' : esc(div(k.eff_division_id)?.name || 'Team')}</span>`;
  if (k.draft_id) return `<a href="${esc(draftUrl(draftOf(k.draft_id) || { key: '' }))}">${esc(div(draftOf(k.draft_id)?.division_id)?.name)} draft</a><span class="sub">In the pool</span>`;
  return '<span class="sub">No team yet</span>';
}
function playerRow(k) {
  const d = div(k.eff_division_id), home = div(k.division_id), bad = d && !fitsAge(d, k.league_age);
  const last = k.prior ? `Last season: ${esc(k.prior)}` : k.returner ? 'Returning' : 'New player';
  const BY = { family: 'Family', coach: 'Coach', league: 'League' };
  const said = k.intent && k.status !== 'Registered'
    ? `<span class="chip ${k.intent === 'yes' && k.intent_by === 'family' ? 'good' : k.intent === 'no' ? '' : 'meh'}" title="Answered ${esc((k.intent_at || '').slice(0, 10))}">${BY[k.intent_by] || 'League'}: ${k.intent === 'yes' ? 'coming back' : k.intent === 'no' ? 'not returning' : 'not sure'}</span>` : '';
  const flags = [
    said,
    k.tryout ? `<span class="chip">${home && !home.group_key ? 'Majors tryout' : 'Trying out'}</span>` : '',
    k.picked_in && home && !home.group_key && k.eff_division_id !== k.division_id ? `<span class="chip">Also ${esc(d?.name)}</span>` : '',
    k.division_locked ? '<span class="chip" title="Placed by an admin; SportsEngine won’t move them">Pinned</span>' : '',
    k.status_locked ? '<span class="chip" title="SportsEngine updates won’t change this status">Status locked</span>' : '',
    bad ? `<span class="chip meh" title="${esc(d.name)} is ${esc(ageRange(d))}">Age ${k.league_age} — outside ${esc(d.name)}</span>` : '',
    k.notes ? `<span class="chip" title="${esc(k.notes)}">Note</span>` : '',
  ].join('');
  return `<li class="plrow ${S.sel.has(k.id) ? 'sel' : ''} ${OUT.includes(k.status) ? 'off' : ''}" data-e="${esc(k.id)}">
    <input type="checkbox" data-sel ${S.sel.has(k.id) ? 'checked' : ''} aria-label="Select ${esc(k.name)}">
    <div class="plmain"><button class="plname" data-kid="${esc(k.kid_id)}">${esc(k.name)}</button>
      <div class="plmeta">${k.league_age != null ? `Age ${k.league_age} · ` : ''}${last}</div>${flags ? `<div class="plflags">${flags}</div>` : ''}</div>
    <div class="plplace">${playerPlace(k)}</div>
    <div class="plstat"><i class="dot ${dotCls(k.status)}"></i>${esc(k.status)}</div>
    <button class="btn" data-pedit>Edit</button></li>`;
}
function renderKids() {
  const st = S.st, { seg, counts } = kidSeg(st);
  $('kTitle').textContent = `${st.season.year} players`;
  $('kSub').textContent = `${counts.reg} ${st.season.status === 'complete' ? 'played' : 'registered'}${counts.yes ? ` · ${counts.yes} said they’re coming back` : ''}${counts.exp + counts.call ? ` · ${counts.exp + counts.call} more expected` : ''}${counts.wait ? ` · ${counts.wait} waiting` : ''}`;
  $('kSegs').innerHTML = PSEGS.filter(([k]) => counts[k] || k === seg || k === 'all').map(([k, label]) =>
    `<button role="tab" aria-selected="${k === seg}" data-seg="${k}">${esc(label(st))} <span class="cnt">${counts[k]}</span></button>`).join('');
  $('kSegHint').textContent = SEG_HINT[seg](st);
  const dSel = $('kDiv'), dv = dSel.value;
  dSel.innerHTML = '<option value="">All divisions</option>' + st.divisions.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') + '<option value="-">Not in a division</option>';
  dSel.value = dv;
  $('kidsCsv').href = `/api/admin/seasons/${encodeURIComponent(S.sid)}/kids.csv`;
  const list = filteredKids();
  for (const id of [...S.sel]) if (!kidRow(id)) S.sel.delete(id);
  $('kCount').textContent = `${plural(list.length, 'player')}`;
  // Grouped by division in league order, then team, then name.
  const groups = [...st.divisions.map((d) => ({ d, ks: list.filter((k) => k.eff_division_id === d.id) })), { d: null, ks: list.filter((k) => !k.eff_division_id) }].filter((g) => g.ks.length);
  const byTeam = (a, b) => (teamOf(a.eff_team_id)?.name || '~').localeCompare(teamOf(b.eff_team_id)?.name || '~') || a.name.localeCompare(b.name);
  $('kList').innerHTML = groups.length ? groups.map((g) => {
    const all = g.ks.every((k) => S.sel.has(k.id));
    return `<section class="plgroup"><h3 class="plghd"><label><input type="checkbox" data-selgroup="${esc(g.d?.id || '-')}" ${all ? 'checked' : ''} aria-label="Select all in ${esc(g.d?.name || 'no division')}"> ${esc(g.d?.name || 'Not in a division')}</label><span class="sub">${plural(g.ks.length, 'player')}${g.d ? ` · ${esc(ageRange(g.d))}` : ''}</span></h3>
      <ul class="plrows">${g.ks.sort(byTeam).map(playerRow).join('')}</ul></section>`;
  }).join('') : `<p class="note">No players match.</p>`;
  renderMoveBar();
}
function renderMoveBar() {
  $('moveBar').hidden = !S.sel.size;
  $('moveCount').textContent = `${plural(S.sel.size, 'player')} selected`;
  const v = $('moveTo').value; $('moveTo').innerHTML = divOpts(v, 'Choose a division'); $('moveTo').value = v;
}
function editPlayer(k) {
  const st = S.st, home = div(k.division_id), picked = !!k.picked_in;
  const teams = home?.keep_teams && !picked ? st.teams.filter((t) => t.division_id === home.id) : [];
  openDialog(`<form class="dlg dvdlg"><h2>${esc(k.name)} <span class="sub">${st.season.year}${k.league_age != null ? ` · age ${k.league_age}` : ''}</span></h2>
    <div class="fld2">${dfld('Status', `<select name="status">${STATUSES.map((s) => `<option ${s === k.status ? 'selected' : ''}>${s}</option>`).join('')}</select>`)}
      ${dfld('Returning or new', `<select name="returner"><option value="1" ${k.returner ? 'selected' : ''}>Returning</option><option value="0" ${k.returner ? '' : 'selected'}>New</option></select>`)}</div>
    <label class="chk"><input type="checkbox" name="locked" ${k.status_locked ? 'checked' : ''}> <span><b>Keep this status</b> <small>SportsEngine updates won’t change it.</small></span></label>
    <fieldset class="dvsec"><legend>Placement</legend>
      ${dfld('Division', `<select name="division" ${picked ? 'disabled' : ''}>${divOpts(k.division_id)}</select>`, picked ? 'Drafted — change the pick in the draft room.' : 'Moving a player pins them here, so a SportsEngine registration won’t move them back.')}
      ${teams.length ? dfld('Team', `<select name="team"><option value="">No team</option>${teams.map((t) => `<option value="${esc(t.id)}" ${t.id === k.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`) : ''}
      ${canTryout(k) ? `<label class="chk"><input type="checkbox" name="tryout" ${k.tryout ? 'checked' : ''}> <span><b>${home && !home.group_key ? 'Consider for the Majors draft' : 'Trying out for Majors'}</b> <small>${home && !home.group_key ? 'They stay in their own division either way; drafted, they play both.' : 'If not drafted, a Minors returner goes back to their team.'}</small></span></label>` : ''}
    </fieldset>
    ${dfld(`Notes for ${st.season.year}`, `<textarea name="notes" rows="2">${esc(k.notes || '')}</textarea>`)}
    ${k.bought?.length ? `<p class="sub" style="margin:0">Bought at registration: ${esc(k.bought.join(' · '))}</p>` : ''}
    <div class="row dlgfoot"><button class="btn primary" type="submit">Save</button><button class="btn" data-close>Cancel</button><button class="linkbtn" type="button" data-hist>Full history &amp; parents</button>${canEdit() ? '<button class="linkbtn" type="button" data-email>Email parents</button>' : ''}<span class="spacer"></span><button class="btn danger" type="button" data-del>Remove from ${st.season.year}</button></div>
  </form>`, (dl) => {
    const f = dl.querySelector('form'), el = (n) => f.elements[n];
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = {};
      if (el('status').value !== k.status) b.status = el('status').value;
      if (el('locked').checked !== !!k.status_locked) b.locked = el('locked').checked;
      if ((el('returner').value === '1') !== !!k.returner) b.returner = el('returner').value === '1';
      if (!picked && (el('division').value || null) !== (k.division_id || null)) b.divisionId = el('division').value || null;
      if (el('team') && (el('team').value || null) !== (k.team_id || null)) b.teamId = el('team').value || null;
      if (el('tryout') && el('tryout').checked !== !!k.tryout) b.tryout = el('tryout').checked;
      if (el('notes').value !== (k.notes || '')) b.notes = el('notes').value;
      if (!Object.keys(b).length) return dl.close();
      if (await act('PATCH', `/api/admin/enrollments/${encodeURIComponent(k.id)}`, b, 'Saved')) dl.close();
    };
    f.querySelector('[data-hist]').onclick = () => { dl.close(); showKid(k.kid_id); };
    const em = f.querySelector('[data-email]'); if (em) em.onclick = () => { dl.close(); emailParents(k.kid_id); };
    const del = f.querySelector('[data-del]');
    del.onclick = async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Click again to remove'; return; }
      if (await act('DELETE', `/api/admin/enrollments/${encodeURIComponent(k.id)}`, undefined, `Removed from ${st.season.year}`)) dl.close();
    };
  });
}
['kSearch', 'kDiv', 'kTry', 'kMismatch'].forEach((id) => ($(id)[id === 'kSearch' ? 'oninput' : 'onchange'] = () => renderKids()));
$('kSegs').onclick = (e) => { const b = e.target.closest('[data-seg]'); if (!b) return; S.kSeg[S.sid] = b.dataset.seg; S.sel.clear(); renderKids(); };
$('addKid').onclick = () => addKidForm();
$('kList').onchange = (e) => {
  const g = e.target.closest('[data-selgroup]');
  if (g) { const id = g.dataset.selgroup; filteredKids().filter((k) => (id === '-' ? !k.eff_division_id : k.eff_division_id === id)).forEach((k) => (g.checked ? S.sel.add(k.id) : S.sel.delete(k.id))); return renderKids(); }
  const row = e.target.closest('[data-e]');
  if (row && e.target.matches('[data-sel]')) { e.target.checked ? S.sel.add(row.dataset.e) : S.sel.delete(row.dataset.e); row.classList.toggle('sel', e.target.checked); renderMoveBar(); }
};
$('kList').onclick = (e) => {
  const kb = e.target.closest('[data-kid]'); if (kb) return showKid(kb.dataset.kid);
  const row = e.target.closest('[data-e]');
  if (row && e.target.closest('[data-pedit]')) return editPlayer(kidRow(row.dataset.e));
};
$('moveGo').onclick = async () => {
  const to = $('moveTo').value;
  if (!to) return toast('Choose a division to move them to', true);
  if (await act('POST', '/api/admin/enrollments/move', { ids: [...S.sel], divisionId: to, reason: $('moveReason').value.trim() || undefined })) { S.sel.clear(); $('moveReason').value = ''; renderKids(); }
};
$('moveClear').onclick = () => { S.sel.clear(); renderKids(); };

/* ---------- divisions & teams ----------
   One card per division (Majors + Minors framed together, since they share seats). The card reads like a
   sentence — ages, teams × roster = seats, draft — and opens to its teams. Changes happen in dialogs. */
S.dvOpen = S.dvOpen || new Set();
const DRAFT_FMT = { standard: 'Standard draft', blind: 'Blind draft (numbers)' };
const plural2 = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** What a team still needs so its coach gets registration emails, or '' when it's done. */
const coachTodo = (t) => (!t.coach && !t.coach_email ? 'Add a coach' : !t.coach_email ? 'Add coach’s email' : !t.coach ? 'Add coach’s name' : '');
function divCard(d, i, st) {
  const ts = st.teams.filter((t) => t.division_id === d.id), open = S.dvOpen.has(d.id), todo = ts.filter(coachTodo).length;
  const ages = d.min_age != null || d.max_age != null ? `Ages ${d.min_age ?? '?'}${d.max_age !== d.min_age ? `–${d.max_age ?? '?'}` : ''}` : 'Any age';
  const next = d.draft && draftOf(d.draft.id)?.next_id ? div(draftOf(draftOf(d.draft.id).next_id)?.division_id)?.name : null;
  const direct = d.se_match.trim() !== '-';
  const chips = [d.closed ? '<span class="chip meh">Registration closed</span>' : '', !direct ? '<span class="chip">Draft only</span>' : ''].join('');
  const named = ts.length < d.teams ? `<span class="warn-text">${ts.length} of ${d.teams} named</span>` : `${plural2(ts.length, 'team')}`;
  return `<article class="dvcard ${open ? 'open' : ''}" data-d="${esc(d.id)}">
    <div class="dvtop">
      <div class="dvmain">
        <div class="lname">${esc(d.name)} ${chips}</div>
        <div class="dvfacts"><span>${ages}</span><span><b>${d.teams}</b> ${d.teams === 1 ? 'team' : 'teams'} × <b>${d.roster_size}</b> = <b>${d.seats.capacity}</b> seats</span>${d.teams ? `${todo ? `<span class="needchip"><i aria-hidden="true"></i>${plural2(todo, 'team needs', 'teams need')} coach info</span>` : ts.length ? '<span class="okchip">✓ Every team has a coach</span>' : ''}` : ''}</div>
        <div class="dvfacts sub"><span>${d.draft ? `${DRAFT_FMT[d.draft.format] || 'Draft'}${next ? ` → undrafted go to ${esc(next)}` : ''}` : 'No draft'}</span>${d.keep_teams ? '<span>Returners keep their team</span>' : ''}<span>${direct ? `SportsEngine: “${esc(d.se_match || d.name.toLowerCase())}”` : 'Nobody registers here directly'}</span>${d.notify_coaches ? '' : '<span>Coach emails off</span>'}</div>
      </div>
      <div class="dvact">
        <button class="btn dvteamsbtn" data-dvteams aria-expanded="${open}">${named}${todo ? `<span class="todobadge" title="${plural2(todo, 'team needs', 'teams need')} coach info">${todo}</span>` : ''}<span class="caret" aria-hidden="true">▾</span></button>
        <button class="btn" data-dvedit>Edit</button>
        <span class="dvorder"><button class="iconbtn" data-up ${i ? '' : 'disabled'} aria-label="Move ${esc(d.name)} up" title="Move up">↑</button><button class="iconbtn" data-down ${i < st.divisions.length - 1 ? '' : 'disabled'} aria-label="Move ${esc(d.name)} down" title="Move down">↓</button></span>
      </div>
    </div>
    ${open ? `<div class="dvteams"><div class="dvteamshd"><span class="sub">${todo ? `<b class="needtxt">${plural2(todo, 'team')} need${todo === 1 ? 's' : ''} a coach’s name and email</b> — coaches get an email when a player registers.` : 'Click a team to edit it.'}</span><button class="btn" data-setupteams>Name teams &amp; coaches</button></div><ul class="tmgrid">${ts.map((t) => {
      const rec = t.wins != null || t.losses != null || t.ties != null ? `${t.wins ?? 0}–${t.losses ?? 0}${t.ties ? `–${t.ties}` : ''}` : '';
      const need = coachTodo(t);
      return `<li><button class="tmtile ${need ? 'need' : ''}" data-team="${esc(t.id)}" ${need ? `aria-label="${esc(t.name)}: ${esc(need)}"` : ''}>${t.color && t.color.toUpperCase() !== '#14213D' ? `<i class="sw" style="background:${esc(t.color)}"></i>` : '<i></i>'}<span class="tmname">${esc(t.name)}${rec ? ` <b class="tmrec">${rec}</b>` : ''}</span>
        <span class="tmmeta">${need ? `<span class="tmneed">${esc(need)} →</span>` : `<span class="tmok">✓</span> ${esc(t.coach || t.coach_email)}`}</span></button></li>`;
    }).join('')}<li><button class="tmtile add" data-addteam>+ Add team</button></li></ul></div>` : ''}
  </article>`;
}
function renderDivisions() {
  const st = S.st, ds = st.divisions;
  const seats = ds.reduce((a, d) => a + d.seats.capacity, 0), teams = ds.reduce((a, d) => a + d.teams, 0);
  $('dvTitle').textContent = `${st.season.year} divisions & teams`;
  const todo = st.teams.filter((t) => ds.some((d) => d.id === t.division_id) && coachTodo(t)).length;
  $('dvSummary').innerHTML = ds.length ? `${st.season.year} · ${plural2(ds.length, 'division')} · ${plural2(teams, 'team')} · ${seats} seats${todo ? ` · <button class="linkbtn needlink" data-showtodo>${plural2(todo, 'team needs', 'teams need')} coach info</button>` : ''}` : `${st.season.year}`;
  const done = new Set(), out = [];
  ds.forEach((d, i) => {
    if (done.has(d.id)) return;
    const g = d.group_key && st.groups.find((x) => x.key === d.group_key);
    const members = g ? ds.filter((x) => x.group_key === d.group_key) : [d];
    members.forEach((m) => done.add(m.id));
    const cards = members.map((m) => divCard(m, ds.indexOf(m), st)).join('');
    out.push(g && members.length > 1 ? `<section class="dvgroup"><div class="dvghd"><b>${members.map((m) => esc(m.name)).join(' + ')}</b><span class="sub">Share ${g.seats.capacity} seats and one registration</span></div>${cards}</section>` : cards);
  });
  $('dvList').innerHTML = out.join('') || `<p class="note">No divisions in ${st.season.year} yet. Add one to start counting seats.</p>`;
  $('rosterSeason').textContent = st.season.year;
  const v = $('rosterDefault').value; $('rosterDefault').innerHTML = divOpts(v, 'Skip that row'); $('rosterDefault').value = v;
  if (document.activeElement !== $('ageCutoff')) $('ageCutoff').value = st.season.age_cutoff;
  if (document.activeElement !== $('warnAt')) $('warnAt').value = st.season.warn_at;
}
const dfld = (label, control, hint = '') => `<label class="fld"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;
function divisionDialog(d) {
  const st = S.st, nextId = d.draft ? draftOf(d.draft.id)?.next_id ?? '' : '';
  const others = st.drafts.filter((r) => !d.draft || r.id !== d.draft.id);
  const v = (x) => esc(x ?? '');
  openDialog(`<form class="dlg dvdlg"><h2>${esc(d.name)}</h2>
    ${dfld('Name', `<input type="text" name="name" value="${v(d.name)}" required>`)}
    <div class="fld2">${dfld('Youngest (league age)', `<input type="number" name="min_age" value="${v(d.min_age)}" min="0" max="20">`)}${dfld('Oldest', `<input type="number" name="max_age" value="${v(d.max_age)}" min="0" max="20">`)}</div>
    <fieldset class="dvsec"><legend>Size</legend>
      <div class="fld2">${dfld('Teams', `<input type="number" name="teams" value="${v(d.teams)}" min="0">`)}${dfld('Players per team', `<input type="number" name="roster_size" value="${v(d.roster_size)}" min="1">`)}</div>
      <p class="dvseats" data-seats></p>
    </fieldset>
    <fieldset class="dvsec"><legend>Teams &amp; draft</legend>
      <label class="chk"><input type="checkbox" name="keep_teams" ${d.keep_teams ? 'checked' : ''}> <span><b>Returners keep their team</b> <small>Last season's players go back to the same team.</small></span></label>
      <label class="chk"><input type="checkbox" name="notify_coaches" ${d.notify_coaches ? 'checked' : ''}> <span><b>Email coaches when a player registers</b> <small>Every coach in ${d.group_key ? 'this group' : 'this division'} with an email gets a note for each registration and waitlist signup.</small></span></label>
      <div class="fld2">${dfld('Draft room', `<select name="draft"><option value="">No draft</option>${Object.entries(DRAFT_FMT).map(([k, l]) => `<option value="${k}" ${d.draft?.format === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
        ${dfld('Undrafted players go to', `<select name="next" ${d.draft ? '' : 'disabled'}><option value="">Nowhere — they stay unplaced</option>${others.map((r) => `<option value="${esc(r.id)}" ${r.id === nextId ? 'selected' : ''}>The ${esc(div(r.division_id)?.name)} draft</option>`).join('')}</select>`, d.draft ? '' : 'Set up a draft room first.')}</div>
      ${dfld('Group', `<input type="text" name="group_key" value="${v(d.group_key)}" placeholder="None" style="max-width:140px">`, 'Divisions with the same group (e.g. 10-12 for Majors + Minors) share seats and one registration.')}
    </fieldset>
    <fieldset class="dvsec"><legend>Registration</legend>
      <label class="chk"><input type="checkbox" name="closed" ${d.closed ? 'checked' : ''}> <span><b>Closed to new registrations</b></span></label>
      ${dfld('SportsEngine words', `<input type="text" name="se_match" value="${v(d.se_match)}" placeholder="${v(d.name.toLowerCase())}">`, 'Comma-separated words matched against the program a family picks in SportsEngine. Use <code>-</code> when nobody registers here directly (Majors).')}
    </fieldset>
    <div class="row dlgfoot"><button class="btn primary" type="submit">Save</button><button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn danger" type="button" data-del>Delete division</button></div>
  </form>`, (dl) => {
    const f = dl.querySelector('form'), el = (n) => f.elements[n];
    const n = (k) => (el(k).value === '' ? null : parseInt(el(k).value, 10));
    const seatsLine = () => { const t = n('teams') ?? 0, r = n('roster_size') ?? 0; f.querySelector('[data-seats]').innerHTML = `${t} × ${r} = <b>${t * r} seats</b>`; };
    seatsLine(); f.addEventListener('input', seatsLine);
    el('draft').onchange = () => { el('next').disabled = !el('draft').value; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const id = encodeURIComponent(d.id);
      const body = { name: el('name').value, teams: n('teams') ?? 0, roster_size: n('roster_size') ?? 12, coaches: d.coaches, min_age: n('min_age'), max_age: n('max_age'),
        se_match: el('se_match').value, group_key: el('group_key').value.trim(), keep_teams: el('keep_teams').checked, closed: el('closed').checked, notify_coaches: el('notify_coaches').checked };
      try {
        await call('PATCH', `/api/admin/divisions/${id}`, body);
        const fmt = el('draft').value;
        if (fmt && (fmt !== d.draft?.format || el('next').value !== (nextId || ''))) await call('PUT', `/api/admin/divisions/${id}/draft`, { format: fmt, nextId: el('next').value || null });
        else if (!fmt && d.draft) await call('DELETE', `/api/admin/drafts/${encodeURIComponent(d.draft.id)}`);
        toast('Division saved'); dl.close();
      } catch (err) { toast(err.message, true); }
    };
    const del = f.querySelector('[data-del]');
    del.onclick = async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Click again to delete'; return; }
      if (await act('DELETE', `/api/admin/divisions/${encodeURIComponent(d.id)}`, undefined, 'Division deleted')) dl.close();
    };
  });
}
/* Name every team and assign its coach in one sheet: one row per team the division plans for. */
function teamsSetupDialog(d) {
  const ts = S.st.teams.filter((t) => t.division_id === d.id);
  const rows = [...ts, ...Array.from({ length: Math.max(0, d.teams - ts.length) }, () => ({}))];
  const line = (t, i) => `<div class="tsrow" data-row="${esc(t.id || '')}">
    <span class="tsn">${i + 1}</span>
    <input type="text" name="name" value="${esc(t.name || '')}" placeholder="Team name" aria-label="Team ${i + 1} name">
    <input type="text" name="coach" value="${esc(t.coach || '')}" placeholder="Coach name" aria-label="Team ${i + 1} coach" autocomplete="off">
    <input type="email" name="coach_email" value="${esc(t.coach_email || '')}" placeholder="coach@email.com" aria-label="Team ${i + 1} coach email" autocomplete="off"></div>`;
  openDialog(`<form class="dlg tsdlg"><h2>${esc(d.name)} teams</h2>
    <p class="note" style="margin:0">${d.teams} ${d.teams === 1 ? 'team is' : 'teams are'} planned. Coaches with an email are told when players register and can sign in to see them. Leave a row blank to skip it.</p>
    <div class="tshead" aria-hidden="true"><span></span><span>Team</span><span>Coach</span><span>Coach email</span></div>
    <div class="tsrows">${rows.map(line).join('')}</div>
    <button type="button" class="linkbtn" data-addrow style="justify-self:start">+ Another team</button>
    <p class="err-text" data-err></p>
    <div class="row dlgfoot"><button class="btn primary" type="submit">Save teams</button><button class="btn" data-close>Cancel</button></div>
  </form>`, (dl) => {
    const f = dl.querySelector('form'), list = f.querySelector('.tsrows');
    f.querySelector('[data-addrow]').onclick = () => { list.insertAdjacentHTML('beforeend', line({}, list.children.length)); list.lastElementChild.querySelector('input').focus(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const out = [];
      for (const r of list.children) {
        const g = (k) => r.querySelector(`[name=${k}]`).value.trim();
        if (!g('name')) { if (g('coach') || g('coach_email')) { f.querySelector('[data-err]').textContent = `Row ${out.length + 1}: give the team a name.`; return; } continue; }
        out.push({ ...(r.dataset.row ? { id: r.dataset.row } : {}), name: g('name'), coach: g('coach'), coach_email: g('coach_email') });
      }
      try { const res = await call('PUT', `/api/admin/divisions/${encodeURIComponent(d.id)}/teams`, { teams: out }); toast(res.message || 'Saved'); dl.close(); }
      catch (err) { f.querySelector('[data-err]').textContent = err.message; }
    };
  });
}
function teamDialog(t) {
  const v = (x) => esc(x ?? '');
  openDialog(`<form class="dlg dvdlg"><h2>${esc(t.name)} <span class="sub">${esc(div(t.division_id)?.name)}</span></h2>
    ${dfld('Team name', `<input type="text" name="name" value="${v(t.name)}" required>`)}
    <fieldset class="dvsec"><legend>Coach</legend>
      ${dfld('Name', `<input type="text" name="coach" value="${v(t.coach)}" autocomplete="off">`)}
      <div class="fld2">${dfld('Email', `<input type="email" name="coach_email" value="${v(t.coach_email)}" autocomplete="off">`)}${dfld('Phone', `<input type="tel" name="coach_phone" value="${v(t.coach_phone)}" autocomplete="off">`)}</div>
      <small class="sub">With an email, the coach is told when players register for ${esc(div(t.division_id)?.name)} and can sign in to see them.</small></fieldset>
    <fieldset class="dvsec"><legend>Record</legend><div class="fld3">${['wins', 'losses', 'ties'].map((k) => dfld(k[0].toUpperCase() + k.slice(1), `<input type="number" name="${k}" value="${v(t[k])}" min="0">`)).join('')}</div>
      <small class="sub">Sets next season's draft order and shows in each kid's history.</small></fieldset>
    <div class="row dlgfoot"><button class="btn primary" type="submit">Save</button><button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn danger" type="button" data-del>Remove team</button></div>
  </form>`, (dl) => {
    const f = dl.querySelector('form'), n = (k) => (f.elements[k].value === '' ? null : parseInt(f.elements[k].value, 10));
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (await act('PATCH', `/api/admin/teams/${encodeURIComponent(t.id)}`, { name: f.elements.name.value, coach: f.elements.coach.value, coach_email: f.elements.coach_email.value.trim(), coach_phone: f.elements.coach_phone.value.trim(), wins: n('wins'), losses: n('losses'), ties: n('ties') }, 'Team saved')) dl.close();
    };
    const del = f.querySelector('[data-del]');
    del.onclick = async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Click again to remove'; return; }
      if (await act('DELETE', `/api/admin/teams/${encodeURIComponent(t.id)}`, undefined, 'Team removed')) dl.close();
    };
  });
}
$('dvSummary').onclick = (e) => {
  if (!e.target.closest('[data-showtodo]')) return;
  // Open every division with a team missing coach info, then go to the first one.
  S.st.teams.filter(coachTodo).forEach((t) => S.dvOpen.add(t.division_id));
  renderDivisions();
  const first = document.querySelector('#dvList .tmtile.need');
  if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); }
};
$('dvList').onclick = async (e) => {
  const card = e.target.closest('[data-d]'); if (!card) return;
  const id = card.dataset.d, b = e.target.closest('button'); if (!b) return;
  if (b.matches('[data-dvteams]')) { S.dvOpen.has(id) ? S.dvOpen.delete(id) : S.dvOpen.add(id); return renderDivisions(); }
  if (b.matches('[data-dvedit]')) return divisionDialog(div(id));
  if (b.matches('[data-setupteams]')) return teamsSetupDialog(div(id));
  if (b.matches('[data-team]')) return teamDialog(teamOf(b.dataset.team));
  if (b.matches('[data-addteam]')) {
    const r = await act('POST', `/api/admin/divisions/${encodeURIComponent(id)}/teams`, { name: 'New team' }, 'Team added');
    if (r?.id) setTimeout(() => teamOf(r.id) && teamDialog(teamOf(r.id)), 300);
    return;
  }
  if (b.matches('[data-up],[data-down]')) {
    const ids = S.st.divisions.map((d) => d.id), i = ids.indexOf(id), j = b.matches('[data-up]') ? i - 1 : i + 1;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return act('PUT', `/api/admin/seasons/${encodeURIComponent(S.sid)}/divisions/order`, { order: ids });
  }
};
$('addDiv').onclick = () => openDialog(`<form class="dlg dvdlg" id="df"><h2>Add a ${S.st.season.year} division</h2>
  ${dfld('Name', '<input type="text" id="dName" required placeholder="e.g. Minors">')}
  <div class="fld2">${dfld('Youngest (league age)', '<input type="number" id="dMin" min="0" max="20">')}${dfld('Oldest', '<input type="number" id="dMax" min="0" max="20">')}</div>
  <div class="fld2">${dfld('Teams', '<input type="number" id="dTeams" min="0" value="0">')}${dfld('Players per team', '<input type="number" id="dRoster" min="1" value="12">')}</div>
  ${dfld('SportsEngine words', '<input type="text" id="dMatch" placeholder="Defaults to the name">', 'Matched against the program a family picks in SportsEngine.')}
  <p class="err-text" id="dErr"></p>
  <div class="row dlgfoot"><button class="btn primary" type="submit">Add division</button><button class="btn" data-close>Cancel</button></div></form>`, (d) => {
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
const STATUS_LABEL = { planning: 'Planning', active: 'Playing', complete: 'Finished' };
/** Pick a season from anywhere (title switcher, All seasons list): everything on every page follows it. */
async function switchSeason(id) {
  if (!id || id === S.sid) return;
  S.sid = id; S.sel.clear(); try { localStorage.setItem('league-season', S.sid); } catch { /* private */ }
  await refresh();
  if (S.tab === 'log') loadLog();
}
async function renderSeasons() {
  const st = S.st, ks = st.kids || [];
  // The selected season's home: its people, its setup, and finishing it.
  const reg = ks.filter((k) => k.status === 'Registered').length, said = ks.filter((k) => k.status === 'Expected' && k.intent === 'yes').length;
  const exp = ks.filter((k) => ['Expected', 'Need to contact'].includes(k.status)).length;
  const ts = st.teams.filter((t) => st.divisions.some((d) => d.id === t.division_id)), todo = ts.filter(coachTodo).length;
  $('shTitle').textContent = `${st.season.year} season`;
  $('shSub').textContent = st.season.id === st.current ? 'The current season — registration, seats and drafts run on it.' : st.season.status === 'complete' ? 'Finished — kept for history and last-season records.' : 'Not the current season.';
  $('shStatus').innerHTML = `<label class="row" style="gap:6px"><span class="sub">Status</span><select id="shStat" aria-label="Season status">${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${st.season.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
    + (st.season.id === st.current ? '<span class="chip good">Current</span>' : '<button class="btn" id="shCur">Make current</button>');
  $('shCards').innerHTML = `
    <button class="shcard" data-open="kids"><span class="shk">Players</span>
      <b>${reg}</b><span>${st.season.status === 'complete' ? 'played' : 'registered'}</span>
      <span class="sub">${said ? `${said} said they’re coming back · ` : ''}${exp ? `${exp} expected` : st.season.status === 'complete' ? '' : 'nobody expected yet'}</span><span class="shgo">Open players →</span></button>
    <button class="shcard" data-open="divisions"><span class="shk">Divisions &amp; teams</span>
      <b>${st.divisions.length}</b><span>divisions · ${st.divisions.reduce((a, d) => a + d.teams, 0)} teams · ${st.divisions.reduce((a, d) => a + d.seats.capacity, 0)} seats</span>
      <span class="sub ${todo ? 'needtxt' : ''}">${todo ? `${todo} ${todo === 1 ? 'team needs' : 'teams need'} coach info` : ts.length ? '✓ Every team has a coach' : 'No teams yet'}</span><span class="shgo">Open divisions &amp; teams →</span></button>`;
  $('seasonTable').innerHTML = '<tr><th>Season</th><th>Status</th><th></th></tr>' + st.seasons.slice().reverse().map((s) => `<tr data-s="${esc(s.id)}" class="${s.id === S.sid ? 'sel' : ''}">
    <td><b>${s.year}</b>${s.id === st.current ? ' <span class="chip good">Current</span>' : ''}</td><td>${STATUS_LABEL[s.status] || esc(s.status)}</td>
    <td>${s.id === S.sid ? '<span class="sub">Showing</span>' : '<button class="mini" data-open-season>Open</button>'}</td></tr>`).join('');
  const next = st.seasons.find((s) => s.year === st.season.year + 1);
  $('rollTitle').textContent = `Finish ${st.season.year} → start ${st.season.year + 1}`;
  if (next) { $('rollBox').innerHTML = `<p>${st.season.year + 1} already exists. Kids added to ${st.season.year} rosters later (Season → Divisions &amp; teams → Import rosters) are carried into it automatically.</p>`; return; }
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
$('view-seasons').addEventListener('change', (e) => { if (e.target.id === 'shStat') act('PATCH', `/api/admin/seasons/${encodeURIComponent(S.sid)}`, { status: e.target.value }, 'Saved'); });
$('view-seasons').addEventListener('click', async (e) => {
  if (e.target.closest('#shCur')) return act('POST', `/api/admin/seasons/${encodeURIComponent(S.sid)}/current`, {}, `${S.st.season.year} is now the current season`);
  const card = e.target.closest('[data-open]'); if (card) return setTab(card.dataset.open);
  const tr = e.target.closest('[data-s]');
  if (tr && e.target.closest('[data-open-season]')) { await switchSeason(tr.dataset.s); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
document.querySelectorAll('[data-back-seasons]').forEach((b) => (b.onclick = () => setTab('seasons')));
$('addSeason').onclick = async () => {
  const y = parseInt($('newYear').value, 10); if (!y) return toast('Enter a year', true);
  if (await act('POST', '/api/admin/seasons', { year: y }, `${y} added`)) { S.sid = String(y); $('newYear').value = ''; refresh(); }
};

/* ---------- settings (league-wide; admins only) ---------- */
S.setPane = S.setPane || 'general';
function setPane(k) {
  S.setPane = k;
  document.querySelectorAll('#setNav [data-set]').forEach((b) => b.setAttribute('aria-selected', b.dataset.set === k));
  document.querySelectorAll('#view-settings [data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== k));
}
$('setNav').onclick = (e) => { const b = e.target.closest('[data-set]'); if (b) setPane(b.dataset.set); };
async function loadSettings() {
  setPane(S.setPane);
  const c = await call('GET', '/api/admin/settings').catch((e) => { toast(e.message, true); return null; });
  if (!c) return;
  const row = (k, v, ok) => `<div class="setrow"><span class="setk">${k}</span><span>${ok === undefined ? '' : `<i class="dot ${ok ? 'Registered' : 'Need'}"></i> `}${v}</span></div>`;
  const foot = '<p class="note">These come from the server’s settings file; changing one needs a restart.</p>';
  $('setGeneral').innerHTML = row('League name', esc(c.league)) + row('Site address', `<code>${esc(c.baseUrl)}</code>`) + row('Time zone', esc(c.timeZone))
    + '<p class="note">Seasons, divisions and teams are set up per season under <b>Season</b>.</p>' + foot;
  $('setEmail').innerHTML = row('Sending', c.mail.on ? 'On (Resend)' : 'Off — nothing is emailed', c.mail.on)
    + (c.mail.on ? row('From', `<code>${esc(c.mail.from)}</code>`) + row('Replies go to', esc(c.mail.replyTo || 'the From address')) : '')
    + row('What gets emailed', 'Sign-in links · registration receipts and payment reminders · waitlist offers · coach notices · outreach and interest checks') + foot;
  $('setPay').innerHTML = row('Stripe', c.stripe.on ? (c.stripe.mode === 'live' ? '<b>Live</b> — real cards are charged' : 'Test mode — no real money moves') : 'Off', c.stripe.on)
    + (c.stripe.on ? row('Webhook', `<code>${esc(c.stripe.webhook)}</code>`) + row('Webhook signing', c.stripe.webhookSigned ? 'On' : '<span class="warn-text">No signing secret — payments won’t confirm</span>', c.stripe.webhookSigned) : '')
    + '<p class="note">Payment plans, refunds and what each family owes are under <b>Finance</b> for the season.</p>' + foot;
  $('setSignin').innerHTML = row('How people sign in', 'An emailed link — no passwords. Only people listed under <b>Users</b> can sign in.')
    + row('Can send links to others', c.linkSenders.length ? c.linkSenders.map(esc).join(', ') : 'Nobody (server command only)')
    + row('Admins', 'See and change everything, including Users, Settings and Activity.')
    + row('Board of Directors', 'See every season page; change nothing. No Users, Settings or Activity.')
    + row('Coaches', 'Their own team’s page, from being named on a team (Season → Divisions &amp; teams).')
    + `<div class="row" style="margin-top:12px"><button class="btn" data-goto="users">Manage users →</button></div>` + foot;
}
$('setSignin').addEventListener('click', (e) => { if (e.target.closest('[data-goto]')) setTab('users'); });

/* ---------- SportsEngine deliveries (on Settings) ---------- */
const OUTCOME_CHIP = { placed: 'good', returner: 'good', withdrawn: 'meh', no_division: 'bad', ambiguous: 'bad', error: 'bad', pending: 'meh', wrong_year: '', ignored: '' };
const LABELS = { placed: 'New kid placed', returner: 'Returner', withdrawn: 'Withdrawn', no_division: 'No division', ambiguous: 'Ambiguous', error: 'Error', pending: 'Pending', wrong_year: 'Other season', ignored: 'Ignored' };
async function loadRegs() {
  const d = await call('GET', `/api/admin/registrations?filter=${encodeURIComponent($('regFilter').value)}`).catch((e) => { toast(e.message, true); return null; });
  if (!d) return;
  S.regs = d;
  const open = ['no_division', 'ambiguous', 'error', 'pending'].reduce((a, k) => a + (d.counts[k] || 0), 0);
  $('regBadge').hidden = !open; $('regBadge').textContent = open;
  $('seBadge').hidden = !open; $('seBadge').textContent = open;
  if (S.tab === 'settings') renderRegs();
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
const VIEWS = ['seats', 'drafts', 'coach', 'kids', 'campaigns', 'finance', 'outreach', 'settings', 'divisions', 'seasons', 'users', 'log'];
function setTab(t) {
  // Divisions & teams has no tab of its own: it opens from Seasons, which stays highlighted.
  const UNDER_SEASONS = ['divisions', 'kids'];
  const btn = document.querySelector(`[data-tab="${UNDER_SEASONS.includes(t) ? 'seasons' : t}"]`);
  if (!btn || (btn.hasAttribute('data-admin') && !isAdmin()) || (btn.hasAttribute('data-owner') && !canEdit()) || (btn.hasAttribute('data-coach') && !isCoach())) t = 'seats';
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === (UNDER_SEASONS.includes(t) ? 'seasons' : t)));
  VIEWS.forEach((v) => ($('view-' + v).hidden = v !== t));
  try { localStorage.setItem('league-tab', t); } catch { /* private mode */ }
  if (t === 'settings') { loadRegs(); loadSettings(); }
  if (t === 'log') loadLog();
  if (t === 'outreach') OS.loadedFor = null;
  if (t === 'users') US.loaded = false;
  if (t === 'finance') loadFinance(); // finance.js — loads on tab open, and again after each action
  if (t === 'coach') loadCoach(); // coach.js
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

/* ---------- boot ---------- */
async function refresh() {
  if (!S.sid) return;
  try {
    S.st = await call('GET', `/api/seasons/${encodeURIComponent(S.sid)}/state`);
    render();
    if (canEdit() && S.tab !== 'settings') loadRegs(); // keep the Settings badge (SportsEngine deliveries to sort out) current
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
  if (!S.me.user) { location.href = signinUrl(); return; }
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
  // A coach's email link (/coach) opens straight to their players; so does a coach signing in with nothing saved.
  if (location.pathname === '/coach' || (!isAdmin() && isCoach() && t === 'seats')) t = 'coach';
  setTab(t);
  if (m && isAdmin()) showKid(decodeURIComponent(m[1]));
  connect();
})();
