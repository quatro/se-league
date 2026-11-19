/* My players: a coach's team(s) and division(s). The coach's job here, while families sign up:
   1. tell the league which returners are coming back (what the family told them),
   2. slot in a returner from last season's team that's missing,
   3. watch registrations come in.
   A first-time coach gets a short guide that walks through those steps; "How this works" brings it back.
   Admins see the same page as any coach (pick one), so they know what coaches see. */
const CV = { as: '', v: null, guideStep: 0 };
const CV_INTENT = { yes: 'Coming back', no: 'Not returning', unsure: 'Not sure yet' };
const CV_BY = { family: 'family told us', coach: 'coach heard', league: 'league noted' };
const cvKey = () => `coach-guide-done:${CV.as || S.me?.user?.email || ''}`;
const guideDone = () => { try { return localStorage.getItem(cvKey()) === '1'; } catch { return false; } };
const setGuideDone = () => { try { localStorage.setItem(cvKey(), '1'); } catch { /* private window */ } };
const cvQ = (extra = {}) => new URLSearchParams({ season: CV.v?.season.id || S.sid, ...(isAdmin() ? { as: CV.as } : {}), ...extra });

async function loadCoach() {
  const coaches = isAdmin() ? [...new Map(S.st.teams.filter((t) => t.coach_email).map((t) => [t.coach_email, t])).values()] : [];
  if (isAdmin()) {
    if (!coaches.length) { $('coachAs').innerHTML = ''; $('coachSub').textContent = ''; $('coachBody').innerHTML = '<p class="note">No coaches yet. Add a coach’s name and email to a team under <b>Season → Divisions &amp; teams</b>; they’ll see this page when they sign in.</p>'; return; }
    if (!coaches.some((t) => t.coach_email === CV.as)) CV.as = (coaches.find((t) => t.coach_email === S.me.user.email) || coaches[0]).coach_email;
    $('coachAs').innerHTML = `<label class="row" style="gap:8px"><span class="sub">See it as</span><select id="coachPick">${coaches.map((t) => `<option value="${esc(t.coach_email)}" ${t.coach_email === CV.as ? 'selected' : ''}>${esc(t.coach || t.coach_email)} · ${esc(t.name)}</option>`).join('')}</select></label>`;
    $('coachPick').onchange = (e) => { CV.as = e.target.value; loadCoach(); };
  } else {
    $('coachAs').innerHTML = '<button class="btn" data-guide>How this works</button>';
  }
  const v = await act('GET', `/api/coach?${cvQ()}`);
  if (!v) return;
  CV.v = v;
  // Changing answers is for the coach themselves (or an admin); a Board member looking at another coach's page only reads it.
  $('coachBody').classList.toggle('mine', canEdit() || !isAdmin() || CV.as === S.me.user.email);
  renderCoach();
}

function renderCoach() {
  const v = CV.v;
  document.querySelector('#view-coach h2').textContent = isAdmin() ? 'Coach view' : 'My players';
  $('coachSub').textContent = v.teams.length ? `${v.season.year} · ${v.teams.map((t) => `${t.name} (${t.division})`).join(', ')}` : `${v.season.year}`;
  if (!v.divisions.length) { $('coachBody').innerHTML = `<p class="note">You’re not coaching a team in ${v.season.year}.</p>`; return; }
  const live = v.season.status !== 'complete';
  const where = v.divisions.join(' + ');
  const row = (p, extra) => `<tr><td><b>${esc(p.name)}</b>${p.age != null ? `<div class="sub">Age ${p.age}</div>` : ''}</td><td>${esc(p.division)}</td>
    <td>${p.lastTeam ? `Returning · ${esc(p.lastTeam)}` : p.returning ? 'Returning' : '<span class="tag">New</span>'}</td>${extra(p)}</tr>`;
  const table = (head, list, extra, empty) => list.length
    ? `<div class="scroll"><table class="kt cvtable"><tr><th>Player</th><th>Division</th><th>Last season</th>${head}</tr>${list.map((p) => row(p, extra)).join('')}</table></div>`
    : `<p class="note">${empty}</p>`;
  const tryout = (p) => (v.divisions.length > 1 ? `<td>${p.tryout ? 'Trying out for Majors' : p.team ? `On the ${esc(p.team)}` : '—'}</td>` : '');
  const tryHead = v.divisions.length > 1 ? '<th>Majors tryout</th>' : '';
  const when = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  const heard = (p) => (p.intent ? `${CV_INTENT[p.intent]} <span class="sub">(${CV_BY[p.intentBy] || ''})</span>` : p.status === 'Need to contact' ? 'Needs a call' : 'No answer yet');
  $('coachBody').innerHTML = `
    ${live && (!guideDone() || CV.guideStep) ? guideHtml(v) : ''}
    <div class="cvstats">
      <div><b>${v.registered.length}</b><span>Registered</span></div>
      <div><b>${v.expected.length}</b><span>Returning, not yet registered</span></div>
      <div><b>${v.waitlist.length}</b><span>Waitlist</span></div>
    </div>
    ${v.rosters.map((t) => rosterHtml(t, live)).join('')}
    <h3 class="subhd" id="cvRegistered">Registered <span class="sub">${esc(where)}</span></h3>
    ${table(`${tryHead}<th>Registered</th>`, v.registered, (p) => `${tryout(p)}<td class="sub">${esc(when(p.registeredAt))}</td>`, 'Nobody has registered yet.')}
    <h3 class="subhd">Returning players who haven’t registered yet <span class="sub">${esc(where)}</span></h3>
    ${table('<th>What we’ve heard</th>', v.expected, (p) => `<td>${heard(p)}</td>`, 'Every returning player has registered.')}
    ${v.waitlist.length ? `<h3 class="subhd">Waitlist</h3>${table('', v.waitlist, () => '', '')}` : ''}
    <p class="note">You’ll get an email each time a player registers for ${esc(where)}.</p>`;
}

/* ---- your team: returners, what each family said, add a missing one ---- */
function rosterHtml(t, live) {
  if (!t.keepsTeams) return '';
  const ps = t.players;
  const answered = ps.filter((p) => p.registered || p.intent).length;
  const opt = (p, val, label) => `<button type="button" class="cvans ${val}" data-intent="${val}" aria-pressed="${p.intent === val}">${label}</button>`;
  const rowFor = (p) => `<li class="cvret ${p.registered ? 'done' : ''}" data-e="${esc(p.enrollmentId)}">
      <div><b>${esc(p.name)}</b><div class="sub">${p.age != null ? `Age ${p.age}` : ''}${p.addedByCoach ? ' · added by you' : ''}</div></div>
      <div class="cvstate">${p.registered ? '<span class="okchip">✓ Registered</span>'
        : p.intent ? `<span class="cvconf ${p.intentBy === 'family' ? 'hi' : ''}">${CV_INTENT[p.intent]}<small>${p.intentBy === 'family' ? 'Family answered' : p.intentBy === 'coach' ? 'You heard' : 'League noted'}</small></span>`
        : '<span class="cvconf none">No answer yet<small>Expected by default</small></span>'}</div>
      ${live && !p.registered ? `<div class="cvopts" role="group" aria-label="What did ${esc(p.name)}’s family say?">${opt(p, 'yes', 'Coming back')}${opt(p, 'unsure', 'Not sure')}${opt(p, 'no', 'Not returning')}</div>${p.addedByCoach ? '<button class="linkbtn" data-unslot title="Added by mistake? Take them off your team">Remove</button>' : ''}` : ''}
    </li>`;
  return `<section class="cvteam" id="cvTeam-${esc(t.id)}">
    <div class="cvteamhd"><h3>${esc(t.name)} <span class="sub">${esc(t.division)} · last season’s players</span></h3>
      <span class="sub">${answered} of ${ps.length} answered or registered</span></div>
    ${ps.length ? `<ul class="cvrets">${ps.map(rowFor).join('')}</ul>` : '<p class="note">No returners on this team yet.</p>'}
    ${live ? `<div class="cvadd" data-team="${esc(t.id)}"><label for="cvq-${esc(t.id)}">Missing someone from last season’s ${esc(t.name)}?</label>
      <input type="search" id="cvq-${esc(t.id)}" data-cvsearch placeholder="Type a player’s name" autocomplete="off"><ul class="cvhits" data-cvhits></ul></div>` : ''}
  </section>`;
}

/* ---- onboarding guide for coaches ---- */
const GUIDE = [
  ['Welcome, Coach', (v) => `This page is yours for ${v.season.year}. It shows the players on your team${v.teams.length > 1 ? 's' : ''} and everyone registering for ${esc(v.divisions.join(' + '))}. Three things to know — about a minute.`, null],
  ['Tell us who’s coming back', () => 'Under your team, each of last season’s players has three buttons. When a family tells you their plans, tap <b>Coming back</b>, <b>Not sure</b> or <b>Not returning</b>. “Not returning” frees their spot for a new player; the others hold it. If a family already answered us themselves, their answer wins.', '.cvteam'],
  ['Add a missing returner', () => 'Someone from last season’s team not listed? Type their name in <b>Missing someone?</b> under your team and tap them. Only players who were on your team last season can be added — anyone else goes through the draft.', '.cvadd'],
  ['Watch registrations', () => 'Registered players show up below, and you’ll get an email each time someone registers. Families never see this page, and you won’t see their contact details here.', '#cvRegistered'],
];
function guideHtml(v) {
  const i = CV.guideStep, [title, body] = GUIDE[i];
  return `<aside class="cvguide" aria-live="polite"><div class="cvgsteps">${GUIDE.map((_, n) => `<i class="${n <= i ? 'on' : ''}"></i>`).join('')}<span class="sub">Step ${i + 1} of ${GUIDE.length}</span></div>
    <h3>${title}</h3><p>${body(v)}</p>
    <div class="row">${i ? '<button class="btn" data-gprev>Back</button>' : ''}<button class="btn primary" data-gnext>${i === GUIDE.length - 1 ? 'Got it' : i ? 'Next' : 'Show me'}</button><span class="spacer"></span><button class="linkbtn" data-gskip>Skip the tour</button></div></aside>`;
}
function guideFocus() {
  document.querySelectorAll('.cvspot').forEach((x) => x.classList.remove('cvspot'));
  const sel = GUIDE[CV.guideStep][2]; const el = sel && document.querySelector(`#coachBody ${sel}`);
  if (el) { el.classList.add('cvspot'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

/* ---- events ---- */
$('view-coach').addEventListener('click', async (e) => {
  if (e.target.closest('[data-guide]')) { CV.guideStep = 0; try { localStorage.removeItem(cvKey()); } catch { /* */ } renderCoach(); return; }
  if (e.target.closest('[data-gnext]')) {
    if (CV.guideStep === GUIDE.length - 1) { setGuideDone(); CV.guideStep = 0; renderCoach(); document.querySelector('#view-coach').scrollIntoView({ behavior: 'smooth' }); return; }
    CV.guideStep++; renderCoach(); guideFocus(); return;
  }
  if (e.target.closest('[data-gprev]')) { CV.guideStep = Math.max(0, CV.guideStep - 1); renderCoach(); guideFocus(); return; }
  if (e.target.closest('[data-gskip]')) { setGuideDone(); CV.guideStep = 0; renderCoach(); return; }
  const ans = e.target.closest('[data-intent]');
  if (ans) {
    const li = ans.closest('[data-e]');
    if (ans.getAttribute('aria-pressed') === 'true') return;
    if (await act('POST', `/api/coach/intent?${cvQ()}`, { season: CV.v.season.id, enrollmentId: li.dataset.e, intent: ans.dataset.intent }, `Saved — ${CV_INTENT[ans.dataset.intent].toLowerCase()}`)) loadCoach();
    return;
  }
  const un = e.target.closest('[data-unslot]');
  if (un) {
    if (!un.dataset.armed) { un.dataset.armed = '1'; un.textContent = 'Remove from team?'; return; }
    if (await act('POST', `/api/coach/unslot?${cvQ()}`, { season: CV.v.season.id, enrollmentId: un.closest('[data-e]').dataset.e }, 'Removed from your team')) loadCoach();
    return;
  }
  const hit = e.target.closest('[data-slot]');
  if (hit) {
    const team = hit.closest('[data-team]').dataset.team;
    if (await act('POST', `/api/coach/slot?${cvQ()}`, { season: CV.v.season.id, team, kidId: hit.dataset.slot }, `Added ${hit.dataset.name} to your team`)) loadCoach();
  }
});
let cvTimer;
$('view-coach').addEventListener('input', (e) => {
  const box = e.target.closest('[data-cvsearch]'); if (!box) return;
  const wrap = box.closest('[data-team]'), out = wrap.querySelector('[data-cvhits]');
  clearTimeout(cvTimer);
  const q = box.value.trim();
  if (q.length < 2) { out.innerHTML = ''; return; }
  cvTimer = setTimeout(async () => {
    let hits = await act('GET', `/api/coach/candidates?${cvQ({ team: wrap.dataset.team, q })}`);
    if (!Array.isArray(hits)) return;
    // Only last season's players from this team are worth showing; everyone else is just counted.
    const others = hits.filter((h) => /ask the league/.test(h.blocked)).length;
    hits = hits.filter((h) => !/ask the league/.test(h.blocked));
    out.innerHTML = (hits.length ? hits.map((h) => `<li>${h.blocked
      ? `<span class="cvhit off"><b>${esc(h.name)}</b><span class="sub">${esc(h.blocked)}</span></span>`
      : `<button class="cvhit" data-slot="${esc(h.kidId)}" data-name="${esc(h.name)}"><b>${esc(h.name)}</b><span class="sub">${h.age != null ? `Age ${h.age} · ` : ''}${esc(h.last)} (${h.lastYear})</span><span class="cvhitadd">Add to team</span></button>`}</li>`).join('')
      : `<li class="sub">No one from last season’s team matches “${esc(q)}”.</li>`)
      + (others ? `<li class="sub">${others} other ${others === 1 ? 'player matches' : 'players match'} but played for another team — the league places them.</li>` : '');
  }, 250);
});
