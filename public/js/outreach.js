/* Outreach tab: email returning families to register early, each with a
   personal link that fills in the form; paste parent contacts; follow up on
   who has clicked and registered. Shares helpers with app.js. */
'use strict';

const OS = { campaigns: [], list: [], defaults: null, interest: null, form: null, preview: null, timer: null, seq: 0, loadedFor: null };

async function loadOutreach() {
  OS.loadedFor = S.sid;
  if (OS.form?.seasonId === S.sid) outreachForm(); // keep what's typed
  try {
    const [cs, o] = await Promise.all([call('GET', '/api/admin/campaigns'), call('GET', `/api/admin/outreach?season=${encodeURIComponent(S.sid)}`)]);
    OS.campaigns = cs.filter((c) => c.season_id === S.sid);
    OS.list = o.list; OS.defaults = o.defaults; OS.interest = o.interest;
    if (!OS.form || OS.form.seasonId !== S.sid) {
      const kind = 'interest', t = savedText(kind);
      OS.form = { seasonId: S.sid, campaignId: OS.campaigns[0]?.id || '', divisionIds: [], statuses: ['Expected', 'Need to contact'], kind, subject: t.subject, body: t.body, who: 'group', pickIds: [] };
    }
    if (OS.pendingKid) { Object.assign(OS.form, { who: 'one', pickIds: [OS.pendingKid] }); OS.pendingKid = null; OS.mode = 'compose'; }
    renderOutreach();
    if (OS.mode === 'compose') refreshPreview(); else refreshReach();
  } catch (e) { toast(e.message, true); }
}

// Each kind keeps its own draft text in this browser.
const tplFor = (kind) => (kind === 'interest' ? OS.interest : OS.defaults);
function savedText(kind) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(kind === 'interest' ? 'league-outreach-interest' : 'league-outreach') || 'null'); } catch { /* private */ }
  return { subject: saved?.subject || tplFor(kind).subject, body: saved?.body || tplFor(kind).body };
}
function outreachForm() {
  const f = OS.form, el = $('outreachEditor');
  const val = (id) => el.querySelector('#' + id);
  if (!val('oSubject')) return f;
  f.campaignId = val('oCampaign').value;
  if (el.querySelector('[data-oall]')) {
    f.divisionIds = el.querySelector('[data-oall]').checked ? [] : [...el.querySelectorAll('[data-odiv]:checked')].map((x) => x.value);
    f.statuses = [...el.querySelectorAll('[data-ostatus]:checked')].map((x) => x.value);
  }
  // One player's parents: the server gets kidIds; a group send never carries them.
  f.kidIds = f.who === 'one' ? (f.pickIds || []) : undefined;
  f.subject = val('oSubject').value; f.body = val('oBody').value;
  try { localStorage.setItem(f.kind === 'interest' ? 'league-outreach-interest' : 'league-outreach', JSON.stringify({ subject: f.subject, body: f.body })); } catch { /* private */ }
  return f;
}

/* Two screens: the season's outreach at a glance (what was sent and how it's going, who we can reach),
   and the composer (what → who → message, with a live preview and the send bar always in view). */
OS.mode = OS.mode || 'list';
const FILLINS = (kind) => [['{parent_first}', 'Parent’s first name'], ['{players}', 'Kids’ first names'], ['{player_details}', 'Each kid’s division & team'],
  kind === 'interest' ? ['{answer_buttons}', 'Answer buttons (required)'] : ['{link}', 'Personal link (required)'], ['{season}', 'Season year'], ['{league}', 'League name']];

function renderOutreach() {
  const ed = $('outreachEditor');
  ed.className = '';
  if (OS.mode === 'compose' && !complete()) return renderCompose(ed);
  const y = S.st.season.year;
  ed.innerHTML = `
  <div class="orhd"><div><h2>Outreach</h2><p class="sub">Email ${y} returning families — check who’s coming back, then invite them to register.</p></div>
    ${complete() ? '' : '<button class="btn primary" id="oNew">New email</button>'}</div>
  ${complete() ? `<p class="note">${y} is finished. Pick the season you’re signing families up for from the season title.</p>` : ''}
  <nav class="ortabs" role="tablist" aria-label="Outreach">
    <button role="tab" data-oview-tab="track" aria-selected="${OS.view !== 'emails'}">Interest check <span class="sub" id="oTrackN"></span></button>
    <button role="tab" data-oview-tab="emails" aria-selected="${OS.view === 'emails'}">All emails <span class="sub">${OS.list.length || ''}</span></button>
  </nav>
  <div id="oTrack" ${OS.view === 'emails' ? 'hidden' : ''}></div>
  <div class="orgrid" ${OS.view === 'emails' ? '' : 'hidden'}>
    <section class="orsent"><h3 class="orsec">Sent this season</h3><div id="oList"></div></section>
    <aside class="orreach panel"><div class="bd" id="oReach"><p class="note">Counting families…</p></div></aside>
  </div>`;
  renderOutreachList();
  renderReach();
  if (OS.view !== 'emails') loadTracker(); else renderTracker();
}

/* Who we can reach: every returner not yet registered, against the contacts on file. */
function renderReach() {
  const box = $('oReach'), p = OS.reach; if (!box) return;
  if (!p) { box.innerHTML = '<p class="note">Counting families…</p>'; return; }
  const pct = p.kids ? Math.round((100 * p.reached) / p.kids) : 0;
  box.innerHTML = `<h3 class="orsec" style="margin-top:0">Who we can reach</h3>
    <div class="orbig"><b>${p.reached}</b><span>of ${plural(p.kids, 'returner')} not yet registered have a parent email</span></div>
    <div class="ormeter" role="img" aria-label="${pct}% reachable"><i style="width:${pct}%"></i></div>
    <p class="sub">${plural(p.families, 'parent email')} on file · email ${p.mail ? '<b>ready</b>' : 'not set up — use Export instead'}</p>
    ${p.missing.length ? `<details class="ormissing"><summary><b>${p.missing.length}</b> with no email — add one</summary><ul>${p.missing.map((k) => `<li><button class="linkbtn" data-kid="${esc(k.id)}">${esc(k.name)}</button> <span class="sub">${esc(k.division)}${k.team ? ` · ${esc(k.team)}` : ''}</span></li>`).join('')}</ul></details>` : '<p class="okchip">✓ Every returner has a parent email</p>'}
    <button class="btn" id="cOpen" style="margin-top:10px">Import parent contacts</button>`;
}

function renderCompose(ed) {
  const f = OS.form;
  OS.caret = null;
  const radio = (name, v, label, on) => `<label class="orchip"><input type="radio" name="${name}" value="${esc(v)}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  const chip = (attr, v, label, on) => `<label class="orchip"><input type="checkbox" ${attr} value="${esc(v)}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  ed.innerHTML = `
  <div class="orhd"><div><button class="linkbtn backlink" id="oBack">← Outreach</button><h2>New email</h2></div><div id="oMail"></div></div>
  <div class="orcompose">
    <div class="orsteps">
      <section class="panel orstep"><div class="bd">
        <h3 class="orsec"><i>1</i> What are you sending?</h3>
        <fieldset class="okind" role="radiogroup" aria-label="What to send">
          <label><input type="radio" name="okind" value="interest" ${f.kind === 'interest' ? 'checked' : ''}><span><b>Interest check</b><small>“Is Sam playing this year?” One click per kid: Yes, Not this year, Not sure. “Not this year” frees their seat.</small></span></label>
          <label><input type="radio" name="okind" value="register" ${f.kind === 'register' ? 'checked' : ''}><span><b>Registration invite</b><small>A personal link that opens the registration form already filled in.</small></span></label>
        </fieldset>
      </div></section>
      <section class="panel orstep"><div class="bd">
        <h3 class="orsec"><i>2</i> Who gets it?</h3>
        ${OS.campaigns.length ? '' : `<p class="err-text">There’s no ${S.st.season.year} registration yet — create one on the Registration tab first.</p>`}
        <div class="orfield"><span class="setk">Registration</span><select id="oCampaign">${OS.campaigns.map((c) => `<option value="${esc(c.id)}" ${c.id === f.campaignId ? 'selected' : ''}>${esc(c.name)} · ${esc(c.status)}</option>`).join('')}</select></div>
        <div class="orfield"><span class="setk">Send to</span><div class="orchips">${radio('owho', 'group', 'Families by division', f.who !== 'one')}${radio('owho', 'one', 'One player’s parents', f.who === 'one')}</div></div>
        ${f.who === 'one' ? `<div class="orfield"><span class="setk">Player</span><div>${pickerHtml(f)}</div></div>` : `
        <div class="orfield"><span class="setk">Divisions</span><div class="orchips">${chip('data-oall', '', 'All divisions', !f.divisionIds.length)}${S.st.divisions.map((d) => chip('data-odiv', d.id, d.name, f.divisionIds.includes(d.id))).join('')}</div></div>
        <div class="orfield"><span class="setk">Returners who are</span><div class="orchips">${chip('data-ostatus', 'Expected', 'Expected back', f.statuses.includes('Expected'))}${chip('data-ostatus', 'Need to contact', 'Need a call', f.statuses.includes('Need to contact'))}</div></div>`}
        <div id="oCount" class="orcount"></div>
        <p class="sub" style="margin:6px 0 0">${f.who === 'one' ? 'Every parent with an email on file for this player gets their own copy. Registered players are never emailed.' : `One email per parent, covering all their kids. Registered kids are never emailed, so sending again later only reaches families who haven’t ${f.kind === 'interest' ? 'answered or ' : ''}signed up.`}</p>
      </div></section>
      <section class="panel orstep"><div class="bd">
        <h3 class="orsec"><i>3</i> Message</h3>
        <label class="orfield orcol"><span class="setk">Subject</span><input type="text" id="oSubject" value="${esc(f.subject)}"></label>
        <textarea id="oBody" rows="12" aria-label="Message">${esc(f.body)}</textarea>
        <div class="orfills"><span class="sub">Insert:</span>${FILLINS(f.kind).map(([t, l]) => `<button type="button" class="orfill" data-fill="${esc(t)}" title="${esc(t)}">${esc(l)}</button>`).join('')}<span class="spacer"></span><button class="linkbtn" id="oReset">Reset to standard message</button></div>
      </div></section>
    </div>
    <aside class="orpreview"><h3 class="orsec">Preview</h3><div id="oPreview"><p class="note">Loading…</p></div></aside>
  </div>
  <div class="orbar">
    <div class="ortest"><input type="email" id="oTestTo" placeholder="you@example.com" aria-label="Send a test to"><button class="btn" id="oTest">Send me a test</button></div>
    <span class="spacer"></span>
    <button class="btn" id="oExport">Export list with links</button>
    <button class="btn primary" id="oSend" disabled>Send</button>
  </div>`;
  if (OS.preview) renderOutreachPreview();
}

function renderOutreachPreview() {
  const p = OS.preview, box = $('oPreview'); if (!box || !p) return;
  const send = $('oSend');
  $('oMail').innerHTML = p.mail ? `<span class="chip good" title="Sent from ${esc(p.mail.from)}">Email ready</span>` : '<span class="chip meh" title="Set RESEND_API_KEY and MAIL_FROM on the server">Email not set up — export the list instead</span>';
  send.disabled = !p.mail || !p.families;
  if (!send.dataset.armed) send.textContent = p.families ? `Send to ${plural(p.families, 'parent')}` : 'Nobody to send to';
  $('oTest').disabled = !p.mail;
  $('oExport').disabled = !p.families;
  $('oCount').innerHTML = p.pick ? '<span class="sub">Search for a player above.</span>'
    : p.to && !p.to.length && p.alreadyAsked ? '<span class="err-text">Already asked this season.</span> <span class="sub">One interest email per player — send a reminder from the Interest check tab instead.</span>'
    : p.to ? (p.to.length ? `<b>Goes to ${plural(p.to.length, 'parent')}:</b> ${p.to.map((x) => `${esc(x.name || 'Parent')} <span class="sub">&lt;${esc(x.email)}&gt;</span>`).join(', ')}`
      : p.kids ? '<span class="err-text">No parent email on file for this player.</span> <span class="sub">Add one with “Full history &amp; parents” on the Players page.</span>' : '<span class="err-text">This player is already registered — nothing to send.</span>')
    : `<b>${plural(p.families, 'parent')}</b> <span class="sub">for ${p.reached} of ${plural(p.kids, 'kid')}${p.missing.length ? ` · ${p.missing.length} with no email on file` : ''}${p.alreadyAsked ? ` · ${p.alreadyAsked} already asked are skipped — they get reminders instead` : ''}</span>`;
  box.innerHTML = p.sample
    ? `<div class="ormail"><div class="ormailhd"><div><span class="sub">To</span> ${esc(p.sample.to)}</div><div><span class="sub">Subject</span> <b>${esc(p.sample.subject)}</b></div></div><pre>${esc(p.sample.text)}</pre></div>
       <p class="sub">How it reads for the first family on the list.</p>`
    : `<p class="note">${p.pick ? 'Pick a player to see their email.' : p.to ? 'Nothing to send for this player.' : 'No family matches these choices.'}</p>`;
}

/* The reach card on the main screen: everyone not yet registered, all divisions. */
async function refreshReach() {
  const f = OS.form; if (!f) return;
  const r = await call('POST', '/api/admin/outreach/preview', { ...f, kind: 'register', kidIds: undefined, divisionIds: [], statuses: ['Expected', 'Need to contact'] }).catch(() => null);
  OS.reach = r || { kids: 0, reached: 0, families: 0, missing: [], mail: null };
  renderReach();
}

/* ---------- interest check, player by player ----------
   One email thread per player per season. The table shows, for every returner, whether they've been asked,
   opened it, and what the family answered; reminders go to whoever is still quiet after N days. */
OS.view = OS.view || 'track';
const TR = { data: null, seg: 'all', q: '', div: '', busy: false };
const TSEG = [['all', 'Everyone'], ['not_asked', 'Not asked'], ['waiting', 'Waiting'], ['answered', 'Answered'], ['registered', 'Registered'], ['problem', 'No email / didn’t send']];
const ANSWER = { yes: ['good', 'Coming back'], no: ['bad', 'Not this year'], unsure: ['meh', 'Not sure yet'] };
const RELAY = { yes: 'Coming back', no: 'Not returning', unsure: 'Needs a call' };
const day = (x) => (x ? new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const daysSince = (x) => (x ? Math.floor((Date.now() - new Date(x)) / 864e5) : null);
async function loadTracker() {
  if (TR.busy) return; TR.busy = true;
  try { TR.data = await call('GET', `/api/admin/interest?season=${encodeURIComponent(S.sid)}`); } catch (e) { toast(e.message, true); } finally { TR.busy = false; }
  renderTracker();
}
function trackRows() {
  const q = TR.q.trim().toLowerCase();
  return TR.data.players.filter((p) => (TR.seg === 'all' ? true : TR.seg === 'problem' ? ['no_email', 'undelivered'].includes(p.state) : p.state === TR.seg)
    && (!TR.div || p.divisionId === TR.div)
    && (!q || `${p.name} ${p.parents.map((x) => `${x.name} ${x.email}`).join(' ')}`.toLowerCase().includes(q)));
}
function answerCell(p) {
  if (p.state === 'registered') return '<span class="chip good">Registered</span>';
  if (p.state === 'answered') { const [c, l] = ANSWER[p.answer]; return `<span class="chip ${c}">${l}</span><div class="sub">Family · ${day(p.answeredAt)}</div>`; }
  const relay = p.relayed ? `<div class="sub">${p.relayed.by === 'coach' ? 'Coach' : 'League'} says ${esc(RELAY[p.relayed.intent])} — not from the family</div>` : '';
  if (p.state === 'waiting') { const d = daysSince(p.askedAt); return `<span class="itwait">No answer yet${d != null ? ` · ${d ? `${plural(d, 'day')}` : 'asked today'}` : ''}</span>${relay}`; }
  if (p.state === 'undelivered') return `<span class="chip bad">${p.delivery === 'failed' ? 'Didn’t send' : 'Not sent yet'}</span><div class="sub">Retry from All emails</div>`;
  if (p.state === 'no_email') return `<span class="chip meh">No parent email</span>${relay}`;
  if (p.state === 'out') return `<span class="sub">${esc(p.status)} — not asking</span>`;
  return `<span class="sub">Not asked yet</span>${relay}`;
}
function renderTracker() {
  const box = $('oTrack'); if (!box) return;
  const d = TR.data;
  if (!d || d.season.id !== S.sid) { box.innerHTML = '<p class="note">Loading players…</p>'; return; }
  const sm = d.summary, wait7 = d.players.filter((p) => p.state === 'waiting' && daysSince(p.lastTouch) >= 7).length;
  $('oTrackN') && ($('oTrackN').textContent = sm.waiting ? `${sm.waiting} waiting` : '');
  const tile = (seg, n, label, sub, cls = '') => `<button class="ittile ${cls} ${TR.seg === seg ? 'on' : ''}" data-tseg="${seg}"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</button>`;
  const ans = sm.yes + sm.no + sm.unsure, w = (n) => `${ans ? (100 * n / ans).toFixed(1) : 0}%`;
  const rows = trackRows();
  box.innerHTML = `
    <p class="sub itlead">One interest email per player each season. Families answer with one click; reminders go to the same thread, only for players still unanswered.</p>
    <div class="ittiles">
      ${tile('not_asked', sm.not_asked, 'Not asked yet', sm.no_email || sm.undelivered ? `<span class="warn-text">+${sm.no_email + sm.undelivered} can’t be reached</span>` : 'have a parent email')}
      ${tile('waiting', sm.waiting, 'Waiting for an answer', wait7 ? `${wait7} for 7+ days` : 'all asked recently', sm.waiting ? 'warn' : '')}
      ${tile('answered', sm.answered, 'Family answered', ans ? `<span class="itbar" aria-label="${sm.yes} yes, ${sm.no} no, ${sm.unsure} not sure"><i class="y" style="width:${w(sm.yes)}"></i><i class="n" style="width:${w(sm.no)}"></i><i class="u" style="width:${w(sm.unsure)}"></i></span>${sm.yes} yes · ${sm.no} no · ${sm.unsure} not sure` : 'none yet')}
      ${tile('registered', sm.registered, 'Registered', 'counts as a yes')}
    </div>
    ${canEdit() && !complete() ? `<div class="itactions">
      ${sm.not_asked ? `<button class="btn primary" data-task>Ask the ${plural(sm.not_asked, 'player')} not asked yet</button>` : ''}
      <button class="btn ${sm.not_asked ? '' : 'primary'}" data-tremind ${sm.waiting ? '' : 'disabled'}>Send reminders…</button>
      <span class="sub">${sm.waiting ? `${plural(sm.waiting, 'player')} waiting${wait7 ? `, ${wait7} for a week or more` : ''}` : 'No one is waiting on a reply.'}</span></div>` : ''}
    <div class="row itfilters">
      <div class="segs finsegs">${TSEG.map(([v, l]) => `<button class="seg ${TR.seg === v ? 'on' : ''}" data-tseg="${v}">${l}</button>`).join('')}</div>
      <span class="spacer"></span>
      <select id="itDiv" aria-label="Division" style="width:auto"><option value="">All divisions</option>${S.st.divisions.map((x) => `<option value="${esc(x.id)}" ${TR.div === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <input type="search" id="itQ" placeholder="Search player or parent" value="${esc(TR.q)}" style="width:min(260px,100%)" aria-label="Search">
    </div>
    <div class="scroll"><table class="kt ittable">
      <tr><th>Player</th><th>Parents</th><th>Asked</th><th>Opened</th><th>Answer</th></tr>
      ${rows.slice(0, 800).map((p) => `<tr class="it-${p.state}">
        <td><button class="linkbtn itname" data-kid="${esc(p.id)}">${esc(p.name)}</button><div class="sub">${esc([p.division, p.team].filter(Boolean).join(' · '))}${p.returner ? '' : ' · new'}</div></td>
        <td>${p.parents.length ? `${esc(p.parents[0].name || p.parents[0].email)}${p.parents.length > 1 ? ` <span class="sub">+${p.parents.length - 1}</span>` : ''}<div class="sub" title="${esc(p.parents.map((x) => x.email).join(', '))}">${esc(p.parents[0].email)}</div>` : '<span class="sub">—</span>'}</td>
        <td>${p.askedAt ? `${day(p.askedAt)}${p.reminders ? `<div class="sub">${plural(p.reminders, 'reminder')} · last ${day(p.remindedAt)}</div>` : ''}` : '<span class="sub">—</span>'}</td>
        <td>${p.opened ? `✓ <span class="sub">${day(p.opened)}</span>` : p.askedAt ? '<span class="sub">Not yet</span>' : '<span class="sub">—</span>'}</td>
        <td>${answerCell(p)}</td></tr>`).join('') || '<tr><td colspan="5" class="note">No players match.</td></tr>'}
    </table></div>
    <p class="sub">${plural(rows.length, 'player')} shown${TR.seg === 'all' ? ` · ${sm.out} not returning without being asked are included` : ''}.</p>`;
}
function startAsk() {
  outreachForm?.();
  const t = savedText('interest');
  Object.assign(OS.form, { kind: 'interest', who: 'group', pickIds: [], divisionIds: [], statuses: ['Expected', 'Need to contact'], subject: t.subject, body: t.body });
  OS.mode = 'compose'; renderOutreach(); window.scrollTo({ top: 0 }); refreshPreview();
}
function reminderDialog() {
  let body = '';
  try { body = localStorage.getItem('league-reminder') || ''; } catch { /* private */ }
  body ||= TR.data.reminderBody;
  openDialog(`<form class="dlg itdlg"><h2>Remind families who haven’t answered</h2>
    <p class="sub">Goes to the same email thread (“Re:” the first subject) with the same one-click buttons — only for the players still unanswered. Each family’s reminder count goes up by one.</p>
    <label class="orfield"><span class="setk">No answer for</span><select name="days" style="width:auto">${[3, 5, 7, 10, 14, 21].map((n) => `<option value="${n}" ${n === 7 ? 'selected' : ''}>${n}+ days</option>`).join('')}<option value="0">Any time (everyone waiting)</option></select></label>
    <div class="orcount" id="rmCount">Counting…</div>
    <label class="orfield orcol"><span class="setk">Message</span><textarea name="body" rows="9">${esc(body)}</textarea></label>
    <div class="ormail" id="rmSample" hidden></div>
    <div class="row dlgfoot"><button class="btn primary" type="submit" value="send" id="rmSend" disabled>Send</button><button class="btn" type="submit" value="export" id="rmExport" disabled>Export reminder list</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div>
  </form>`, (dl) => {
    const f = dl.querySelector('form');
    let seq = 0, timer;
    const look = () => { clearTimeout(timer); timer = setTimeout(async () => {
      const n = ++seq, r = await call('POST', '/api/admin/interest/remind/preview', { seasonId: S.sid, days: +f.days.value, body: f.body.value }).catch((e) => (toast(e.message, true), null));
      if (n !== seq || !r) return;
      dl.querySelector('#rmCount').innerHTML = r.families ? `<b>${plural(r.families, 'parent')}</b> <span class="sub">for ${plural(r.kids, 'player')} still unanswered</span>` : '<span class="sub">Nobody to remind with this choice.</span>';
      const sb = dl.querySelector('#rmSend'); sb.disabled = !r.families || !r.mail; sb.textContent = r.mail ? `Send to ${plural(r.families, 'parent')}` : 'Email not set up';
      dl.querySelector('#rmExport').disabled = !r.families;
      const smp = dl.querySelector('#rmSample'); smp.hidden = !r.sample;
      if (r.sample) smp.innerHTML = `<div class="ormailhd"><div><span class="sub">To</span> ${esc(r.sample.to)}</div><div><span class="sub">Subject</span> <b>${esc(r.sample.subject)}</b></div></div><pre>${esc(r.sample.text)}</pre>`;
    }, 250); };
    f.days.onchange = look; f.body.oninput = () => { try { localStorage.setItem('league-reminder', f.body.value); } catch { /* private */ } look(); };
    look();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const mode = e.submitter?.value === 'export' ? 'export' : 'send';
      if (mode === 'send' && !confirm('Send the reminder now?')) return;
      const r = await act('POST', '/api/admin/interest/remind', { seasonId: S.sid, days: +f.days.value, body: f.body.value, mode });
      if (!r) return;
      if (r.rows) {
        const csv = r.rows.map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `interest-reminders-${S.st.season.year}.csv`; a.click(); URL.revokeObjectURL(a.href);
      }
      dl.close(); loadTracker();
    };
  });
}

/* ---------- one player's parents ---------- */
const kidById = (id) => S.st.kids?.find((k) => k.kid_id === id);
const kidLine = (k) => [div(k.division_id)?.name, teamOf(k.team_id)?.name, k.status].filter(Boolean).map(esc).join(' · ');
function pickerHtml(f) {
  const k = f.pickIds?.[0] && kidById(f.pickIds[0]);
  if (k) return `<div class="orpicked"><b>${esc(k.name)}</b> <span class="sub">${kidLine(k)}</span><button type="button" class="linkbtn" data-ounpick>Change</button></div>`;
  return `<div class="orpick"><input type="search" id="oKidQ" placeholder="Type a player’s name" autocomplete="off" aria-label="Find a player"><ul id="oKidHits" class="orhits" role="listbox"></ul></div>`;
}
function renderKidHits(q) {
  const box = $('oKidHits'); if (!box) return;
  const n = q.trim().toLowerCase();
  if (n.length < 2) { box.innerHTML = ''; return; }
  const hits = (S.st.kids || []).filter((k) => k.name.toLowerCase().includes(n))
    .sort((a, b) => a.name.toLowerCase().indexOf(n) - b.name.toLowerCase().indexOf(n) || a.name.localeCompare(b.name)).slice(0, 8);
  box.innerHTML = hits.length ? hits.map((k) => `<li><button type="button" data-opick="${esc(k.kid_id)}" ${k.status === 'Registered' ? 'class="reg"' : ''}><b>${esc(k.name)}</b><span class="sub">${kidLine(k)}</span></button></li>`).join('')
    : `<li class="sub">No ${S.st.season.year} player matches “${esc(q.trim())}”.</li>`;
}
/** From anywhere (the Players page): open a new email to one player's parents. */
function emailParents(kidId) {
  OS.pendingKid = kidId; OS.loadedFor = null;
  if (OS.form?.seasonId === S.sid) { Object.assign(OS.form, { who: 'one', pickIds: [kidId] }); OS.pendingKid = null; OS.mode = 'compose'; }
  setTab('outreach');
}

function refreshPreview() {
  clearTimeout(OS.timer);
  if (OS.form?.who === 'one' && !OS.form.pickIds?.length) { ++OS.seq; OS.preview = { families: 0, kids: 0, reached: 0, missing: [], sample: null, mail: OS.preview?.mail ?? null, pick: true }; return renderOutreachPreview(); }
  OS.timer = setTimeout(async () => {
    const f = outreachForm(), seq = ++OS.seq;
    const p = await call('POST', '/api/admin/outreach/preview', f).catch((e) => { toast(e.message, true); return null; });
    if (seq !== OS.seq || !p) return;
    OS.preview = p; renderOutreachPreview();
  }, 250);
}

function renderOutreachList() {
  const t = $('oList'); if (!t) return;
  const when = (x) => { const d = new Date(x.replace(' ', 'T') + 'Z'); return isNaN(d) ? x : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  t.innerHTML = OS.list.length ? OS.list.map((o) => {
    const reg = o.kids ? Math.round((100 * o.registered) / o.kids) : 0;
    return `<article class="orcard" data-out="${esc(o.id)}">
      <div class="orcardhd"><span class="chip ${o.kind === 'interest' ? '' : 'good'}">${o.kind === 'interest' ? 'Interest check' : 'Registration invite'}</span><span class="sub">${esc(when(o.created_at))}</span></div>
      <h4>${esc(o.subject)}</h4>
      <p class="sub">${esc(o.campaign)}${o.filter.kidIds?.length ? ` · ${o.filter.kidIds.map((id) => esc(S.st.kids?.find((k) => k.kid_id === id)?.name || 'one player')).join(', ')}’s parents` : o.filter.divisionIds.length ? ` · ${o.filter.divisionIds.map((id) => esc(div(id)?.name || '?')).join(', ')}` : ' · all divisions'}</p>
      <div class="orstats">
        <div><b>${o.families}</b><span>parents</span></div>
        <div><b>${o.sent || o.exported}</b><span>${o.sent ? 'sent' : 'exported'}${o.failed ? ` · <span class="err-text">${o.failed} failed</span>` : ''}${o.queued ? ` · ${o.queued} waiting` : ''}</span></div>
        <div><b>${o.clicked}</b><span>clicked</span></div>
        <div><b>${o.registered}</b><span>of ${o.kids} kids registered</span></div>
      </div>
      ${o.kind === 'interest' ? answersBar(o.answers) : `<div class="ormeter"><i style="width:${reg}%"></i></div>`}
      <div class="orcardft"><button class="btn" data-oview>See families</button>${o.failed || o.queued ? '<button class="btn primary" data-oretry>Send the rest</button>' : ''}<a class="linkbtn" href="/api/admin/outreach/${encodeURIComponent(o.id)}/export.csv">Download CSV</a></div>
    </article>`;
  }).join('') : `<div class="orempty"><b>Nothing sent for ${S.st.season.year} yet.</b><p class="sub">Start with an <b>interest check</b>: families answer with one click, and every “not this year” frees a seat before registration opens.</p>${complete() ? '' : '<button class="btn primary" data-onew>Write the first email</button>'}</div>`;
}

// Yes / not sure / no / no answer for an interest check, as a small stacked bar with the counts spelled out.
function answersBar(a) {
  const tot = a.yes + a.no + a.unsure + a.none || 1, seg = (n, cls) => (n ? `<i class="${cls}" style="width:${(100 * n / tot).toFixed(1)}%"></i>` : '');
  return `<div class="ansbar" role="img" aria-label="${a.yes} yes, ${a.unsure} not sure, ${a.no} not this year, ${a.none} no answer">${seg(a.yes, 'y')}${seg(a.unsure, 'u')}${seg(a.no, 'n')}</div>
    <div class="anskey"><span><i class="y"></i>${a.yes} yes</span><span><i class="u"></i>${a.unsure} not sure</span><span><i class="n"></i>${a.no} no</span><span class="sub">${a.none} no answer</span></div>`;
}
const INTENT = { yes: ['Yes, playing', 'good'], no: ['Not this year', ''], unsure: ['Not sure', 'meh'] };
async function showOutreach(id) {
  const o = await act('GET', `/api/admin/outreach/${encodeURIComponent(id)}`); if (!o) return;
  openDialog(`<div class="dlg"><h2>${esc(o.subject)}</h2>
    <p class="note">${o.sent} sent · ${o.clicked} clicked their link · ${o.registered} of ${o.kids} kids registered since.</p>${o.kind === 'interest' ? answersBar(o.answers) : ''}
    <div class="scroll"><table class="kt"><tr><th>Family</th><th>Players</th><th>Email</th><th>Clicked</th></tr>
    ${o.messages.map((m) => `<tr><td><b>${esc(m.name || '—')}</b><div class="sub">${esc(m.email)}</div></td>
      <td>${m.kids.map((k) => `<div><button class="mini" data-kid="${esc(k.id)}" style="border:0;background:none;padding:0;font-weight:600">${esc(k.name)}</button> <i class="dot ${dotCls(k.status)}"></i> <span class="sub">${esc(k.status)}</span>${o.kind === 'interest' && k.intent ? ` <span class="chip ${INTENT[k.intent][1]}">${INTENT[k.intent][0]}</span>` : ''}</div>`).join('')}</td>
      <td>${esc(m.status)}${m.error ? `<div class="err-text">${esc(m.error)}</div>` : ''}${m.sent_at ? `<div class="sub">${esc(m.sent_at)}</div>` : ''}</td>
      <td class="sub">${esc(m.clicked_at || '')}</td></tr>`).join('')}</table></div>
    <div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`, (dl) => {
    dl.addEventListener('click', (e) => { const kb = e.target.closest('[data-kid]'); if (kb) { dl.close(); showKid(kb.dataset.kid); } });
  });
}

$('outreachEditor').addEventListener('input', (e) => { if (e.target.closest('#oSubject, #oBody')) refreshPreview(); if (e.target.id === 'oKidQ') renderKidHits(e.target.value); if (e.target.id === 'itQ') { TR.q = e.target.value; renderTracker(); const q = $('itQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
['keyup', 'click', 'select'].forEach((ev) => $('outreachEditor').addEventListener(ev, (e) => { if (e.target.id === 'oBody') OS.caret = [e.target.selectionStart, e.target.selectionEnd]; }));
$('outreachEditor').addEventListener('change', (e) => {
  // "All divisions" and the single divisions are exclusive: pick one, the other side clears.
  if (e.target.matches('[data-oall]') && e.target.checked) $('outreachEditor').querySelectorAll('[data-odiv]').forEach((x) => (x.checked = false));
  if (e.target.matches('[data-odiv]')) { const any = $('outreachEditor').querySelector('[data-odiv]:checked'); $('outreachEditor').querySelector('[data-oall]').checked = !any; }
  if (e.target.matches('[data-oall]') && !e.target.checked && !$('outreachEditor').querySelector('[data-odiv]:checked')) e.target.checked = true;
  if (e.target.matches('#oCampaign, [data-odiv], [data-oall], [data-ostatus]')) refreshPreview();
  if (e.target.id === 'itDiv') { TR.div = e.target.value; return renderTracker(); }
  if (e.target.name === 'owho') { outreachForm(); OS.form.who = e.target.value; renderOutreach(); refreshPreview(); if (OS.form.who === 'one') $('oKidQ')?.focus(); }
  if (e.target.name === 'okind') { outreachForm(); const k = e.target.value, t = savedText(k); Object.assign(OS.form, { kind: k, subject: t.subject, body: t.body }); renderOutreach(); refreshPreview(); }
});
$('outreachEditor').addEventListener('click', async (e) => {
  const t = e.target;
  const kb = t.closest('[data-kid]'); if (kb) return showKid(kb.dataset.kid);
  if (t.closest('#oNew, [data-onew]')) { OS.mode = 'compose'; renderOutreach(); window.scrollTo({ top: 0 }); return refreshPreview(); }
  if (t.closest('#oBack')) { outreachForm(); OS.mode = 'list'; renderOutreach(); return refreshReach(); }
  if (t.closest('#cOpen')) return importContactsDialog();
  const tv = t.closest('[data-oview-tab]'); if (tv) { OS.view = tv.dataset.oviewTab; renderOutreach(); return; }
  const ts = t.closest('[data-tseg]'); if (ts) { TR.seg = TR.seg === ts.dataset.tseg && ts.classList.contains('ittile') ? 'all' : ts.dataset.tseg; return renderTracker(); }
  if (t.closest('[data-task]')) return startAsk();
  if (t.closest('[data-tremind]')) return reminderDialog();
  const pk = t.closest('[data-opick]'); if (pk) { outreachForm(); OS.form.pickIds = [pk.dataset.opick]; renderOutreach(); return refreshPreview(); }
  if (t.closest('[data-ounpick]')) { outreachForm(); OS.form.pickIds = []; renderOutreach(); refreshPreview(); return $('oKidQ')?.focus(); }
  const fill = t.closest('[data-fill]');
  // Goes where the cursor last was in the message — or at the end if they haven't clicked into it yet.
  if (fill) { const ta = $('oBody'), c = OS.caret ?? [ta.value.length, ta.value.length]; ta.setRangeText(fill.dataset.fill, c[0], c[1], 'end'); OS.caret = [ta.selectionStart, ta.selectionEnd]; ta.focus(); return refreshPreview(); }
  if (t.id === 'oReset') { const d = tplFor(OS.form.kind); $('oSubject').value = d.subject; $('oBody').value = d.body; return refreshPreview(); }
  if (t.id === 'oTest') { const r = await act('POST', '/api/admin/outreach/test', { ...outreachForm(), to: $('oTestTo').value.trim() }); return r; }
  if (t.id === 'oSend') {
    const n = OS.preview?.families || 0;
    if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = `Really email ${plural(n, 'parent')}?`; return; }
    t.disabled = true; t.textContent = 'Sending…';
    const r = await act('POST', '/api/admin/outreach', { ...outreachForm(), mode: 'send' });
    delete t.dataset.armed;
    if (r) { OS.mode = 'list'; loadOutreach(); } else refreshPreview();
    return;
  }
  if (t.id === 'oExport') {
    const r = await act('POST', '/api/admin/outreach', { ...outreachForm(), mode: 'export' });
    if (r?.id) { location.href = `/api/admin/outreach/${encodeURIComponent(r.id)}/export.csv`; OS.mode = 'list'; setTimeout(loadOutreach, 800); }
    return;
  }
  const row = t.closest('[data-out]'); if (!row) return;
  if (t.matches('[data-oview]')) return showOutreach(row.dataset.out);
  if (t.matches('[data-oretry]')) { t.disabled = true; if (await act('POST', `/api/admin/outreach/${encodeURIComponent(row.dataset.out)}/send`, {})) loadOutreach(); else t.disabled = false; }
});

/** Parent contacts arrive as a pasted or chosen CSV — a dialog, since it's an occasional job. */
function importContactsDialog() {
  openDialog(`<form class="dlg dvdlg"><h2>Import parent contacts</h2>
    <p class="note" style="margin:0">A header row with the player’s <b>First Name</b> and <b>Last Name</b> (or <b>Name</b>), optionally <b>Birthdate</b>, then any parent columns — <b>Guardian First Name</b>, <b>Email</b>, <b>Phone Number 1</b>, <b>Parent/Guardian 2 Email</b>… The SportsEngine parent export works as is. Contacts stay on each kid’s record every season.</p>
    <input type="file" name="file" accept=".csv,text/csv">
    <textarea name="csv" rows="6" placeholder="…or paste CSV here"></textarea>
    <div id="cResult"></div>
    <div class="row dlgfoot"><button class="btn primary" type="submit">Add contacts</button><button class="btn" data-close>Close</button></div>
  </form>`, (d) => {
    const f = d.querySelector('form');
    f.elements.file.onchange = () => { const x = f.elements.file.files[0]; if (x) x.text().then((t) => (f.elements.csv.value = t)); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const text = f.elements.csv.value.trim(); if (!text) return toast('Paste or choose a CSV first', true);
      const r = await act('POST', '/api/admin/contacts/import', { text }); if (!r) return;
      const list = (label, xs) => (xs.length ? `<details><summary class="note">${xs.length} ${label}</summary><p class="sub">${xs.map(esc).join(' · ')}</p></details>` : '');
      d.querySelector('#cResult').innerHTML = `<p><b>${r.added}</b> contacts added${r.updated ? `, ${r.updated} updated` : ''} for <b>${r.kids}</b> of ${r.rows} players.</p>
        ${list('players not found — check the spelling, or add their contacts from the kid’s record', r.unmatched)}${list('names shared by more than one kid — add these by hand', r.ambiguous)}${list('rows with no email or phone', r.noContact)}`;
      refreshReach();
    };
  });
}
