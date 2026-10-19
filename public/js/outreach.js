/* Outreach tab: email returning families to register early, each with a
   personal link that fills in the form; paste parent contacts; follow up on
   who has clicked and registered. Shares helpers with app.js. */
'use strict';

const OS = { campaigns: [], list: [], defaults: null, form: null, preview: null, timer: null, seq: 0, loadedFor: null };

async function loadOutreach() {
  OS.loadedFor = S.sid;
  if (OS.form?.seasonId === S.sid) outreachForm(); // keep what's typed
  try {
    const [cs, o] = await Promise.all([call('GET', '/api/admin/campaigns'), call('GET', `/api/admin/outreach?season=${encodeURIComponent(S.sid)}`)]);
    OS.campaigns = cs.filter((c) => c.season_id === S.sid);
    OS.list = o.list; OS.defaults = o.defaults;
    if (!OS.form || OS.form.seasonId !== S.sid) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('league-outreach') || 'null'); } catch { /* private */ }
      OS.form = { seasonId: S.sid, campaignId: OS.campaigns[0]?.id || '', divisionIds: [], statuses: ['Expected', 'Need to contact'],
        subject: saved?.subject || o.defaults.subject, body: saved?.body || o.defaults.body };
    }
    renderOutreach();
    refreshPreview();
  } catch (e) { toast(e.message, true); }
}

function outreachForm() {
  const f = OS.form, el = $('outreachEditor');
  const val = (id) => el.querySelector('#' + id);
  if (!val('oSubject')) return f;
  f.campaignId = val('oCampaign').value;
  f.divisionIds = [...el.querySelectorAll('[data-odiv]:checked')].map((x) => x.value);
  f.statuses = [...el.querySelectorAll('[data-ostatus]:checked')].map((x) => x.value);
  f.subject = val('oSubject').value; f.body = val('oBody').value;
  try { localStorage.setItem('league-outreach', JSON.stringify({ subject: f.subject, body: f.body })); } catch { /* private */ }
  return f;
}

function renderOutreach() {
  const f = OS.form, ed = $('outreachEditor');
  if (complete()) { ed.innerHTML = `<div class="panel wide"><div class="bd"><p class="note">${S.st.season.year} is finished. Pick the season you're signing families up for in the header.</p></div></div>`; renderOutreachList(); return; }
  const divs = S.st.divisions.map((d) => `<label class="chk"><input type="checkbox" data-odiv value="${esc(d.id)}" ${f.divisionIds.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('');
  const sts = ['Expected', 'Need to contact'].map((s) => `<label class="chk"><input type="checkbox" data-ostatus value="${esc(s)}" ${f.statuses.includes(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('');
  ed.innerHTML = `
  <div class="panel wide"><div class="hd"><h2>Email returning families</h2><div class="row" id="oMail"></div></div><div class="bd">
    <p class="note">Asks returning families to register early, so we know our numbers sooner. Each parent email on file gets <b>one</b> message covering all of their kids, with a <b>personal link</b> that opens the registration form already filled in. Kids already Registered are never emailed — so sending again later only reaches the families who haven't signed up yet.</p>
    ${OS.campaigns.length ? '' : `<p class="err-text">There's no ${S.st.season.year} registration campaign yet — create one on the Signups tab first.</p>`}
    <div class="row"><label for="oCampaign">Sign up for</label><select id="oCampaign" style="width:auto">${OS.campaigns.map((c) => `<option value="${esc(c.id)}" ${c.id === f.campaignId ? 'selected' : ''}>${esc(c.name)} · ${esc(c.status)}</option>`).join('')}</select></div>
    <div class="row" style="align-items:flex-start"><label>Divisions</label><div class="row" style="flex:1;gap:4px 14px">${divs}<span class="sub">(none ticked = all)</span></div></div>
    <div class="row"><label>Returners who are</label><div class="row" style="gap:4px 14px">${sts}</div></div>
    <div class="row"><label for="oSubject">Subject</label><input type="text" id="oSubject" value="${esc(f.subject)}" style="flex:1"></div>
    <textarea id="oBody" rows="14" aria-label="Message">${esc(f.body)}</textarea>
    <p class="note">Fill-ins: <code>{parent_first}</code> <code>{players}</code> (first names, “Sam and Ella”) <code>{player_details}</code> (each kid's division and team) <code>{link}</code> (their personal link — required) <code>{season}</code> <code>{league}</code>. <button class="mini" id="oReset">Reset to the standard message</button></p>
    <div id="oPreview"><p class="note">Counting families…</p></div>
    <div class="row"><button class="btn primary" id="oSend" disabled>Send</button><button class="btn" id="oExport">Export list with personal links</button>
      <span class="spacer"></span><input type="email" id="oTestTo" placeholder="you@example.com" style="width:200px" aria-label="Send a test to"><button class="btn" id="oTest">Send me a test</button></div>
  </div></div>
  <div class="panel wide"><div class="hd"><h2>Sent</h2></div><div class="bd"><div class="scroll"><table class="kt" id="oList"></table></div></div></div>
  <div class="panel wide"><div class="hd"><h2>Parent contacts</h2></div><div class="bd">
    <p class="note">Paste a contact list (or the SportsEngine parent export): a header row with the player's <b>First Name</b> and <b>Last Name</b> (or <b>Name</b>), optionally <b>Birthdate</b>, then any parent columns — <b>Guardian First Name</b>, <b>Email</b>, <b>Phone Number 1</b>, <b>Parent/Guardian 2 Email</b>, <b>Mother Email</b>… Contacts are added to each kid's record and kept every season; every paid registration adds the parent automatically too. Edit one kid's contacts by clicking their name.</p>
    <input type="file" id="cFile" accept=".csv,text/csv"><textarea id="cCsv" rows="4" placeholder="…or paste CSV here"></textarea>
    <div class="row"><button class="btn primary" id="cImport">Add contacts</button></div><div id="cResult"></div>
  </div></div>`;
  renderOutreachList();
}

function renderOutreachPreview() {
  const p = OS.preview, box = $('oPreview'); if (!box || !p) return;
  const send = $('oSend');
  $('oMail').innerHTML = p.mail ? `<span class="chip good" title="Sent from ${esc(p.mail.from)}">Email ready</span>` : '<span class="chip meh" title="Set RESEND_API_KEY and MAIL_FROM on the server">Email not set up — export the list instead</span>';
  send.disabled = !p.mail || !p.families;
  send.textContent = p.families ? `Send to ${plural(p.families, 'parent')}` : 'Send';
  $('oTest').disabled = !p.mail;
  box.innerHTML = `<div class="totals"><span><b>${p.families}</b> parent ${p.families === 1 ? 'email' : 'emails'}</span><span><b>${p.reached}</b> of ${plural(p.kids, 'kid')} reachable</span>${p.missing.length ? `<span><b>${p.missing.length}</b> with no email on file</span>` : ''}</div>
    ${p.missing.length ? `<details><summary class="note">Kids with no parent email — click a name to add one</summary><div class="row" style="gap:4px 12px">${p.missing.map((k) => `<button class="mini" data-kid="${esc(k.id)}">${esc(k.name)}</button> <span class="sub">${esc(k.division)}${k.team ? ` · ${esc(k.team)}` : ''}</span>`).join('')}</div></details>` : ''}
    ${p.sample ? `<details open><summary class="note">How it reads for the first family (${esc(p.sample.to)})</summary><div class="mailprev"><b>${esc(p.sample.subject)}</b><pre>${esc(p.sample.text)}</pre></div></details>` : ''}`;
}

function refreshPreview() {
  clearTimeout(OS.timer);
  OS.timer = setTimeout(async () => {
    const f = outreachForm(), seq = ++OS.seq;
    const p = await call('POST', '/api/admin/outreach/preview', f).catch((e) => { toast(e.message, true); return null; });
    if (seq !== OS.seq || !p) return;
    OS.preview = p; renderOutreachPreview();
  }, 250);
}

function renderOutreachList() {
  const t = $('oList'); if (!t) return;
  t.innerHTML = '<tr><th>When (UTC)</th><th>Subject</th><th>For</th><th class="num">Parents</th><th>Delivery</th><th class="num">Clicked</th><th class="num">Registered</th><th></th></tr>'
    + (OS.list.length ? OS.list.map((o) => `<tr data-out="${esc(o.id)}"><td class="sub">${esc(o.created_at)}</td><td>${esc(o.subject)}</td>
      <td class="sub">${esc(o.campaign)}${o.filter.divisionIds.length ? ` · ${o.filter.divisionIds.map((id) => esc(div(id)?.name || '?')).join(', ')}` : ''}</td>
      <td class="num">${o.families}</td>
      <td>${[o.sent && `${o.sent} sent`, o.exported && `${o.exported} exported`, o.failed && `<span class="err-text">${o.failed} failed</span>`, o.queued && `${o.queued} not sent`].filter(Boolean).join(' · ')}</td>
      <td class="num">${o.clicked}</td><td class="num">${o.registered} of ${o.kids} kids</td>
      <td class="row" style="flex-wrap:nowrap"><button class="mini" data-oview>Families</button>${o.failed || o.queued ? '<button class="mini" data-oretry>Send the rest</button>' : ''}<a class="mini btn" href="/api/admin/outreach/${encodeURIComponent(o.id)}/export.csv">CSV</a></td></tr>`).join('')
      : '<tr><td colspan="8" class="note">Nothing sent for this season yet.</td></tr>');
}

async function showOutreach(id) {
  const o = await act('GET', `/api/admin/outreach/${encodeURIComponent(id)}`); if (!o) return;
  openDialog(`<div class="dlg"><h2>${esc(o.subject)}</h2>
    <p class="note">${o.sent} sent · ${o.clicked} clicked their link · ${o.registered} of ${o.kids} kids registered since.</p>
    <div class="scroll"><table class="kt"><tr><th>Family</th><th>Players</th><th>Email</th><th>Clicked</th></tr>
    ${o.messages.map((m) => `<tr><td><b>${esc(m.name || '—')}</b><div class="sub">${esc(m.email)}</div></td>
      <td>${m.kids.map((k) => `<div><button class="mini" data-kid="${esc(k.id)}" style="border:0;background:none;padding:0;font-weight:600">${esc(k.name)}</button> <i class="dot ${dotCls(k.status)}"></i> <span class="sub">${esc(k.status)}</span></div>`).join('')}</td>
      <td>${esc(m.status)}${m.error ? `<div class="err-text">${esc(m.error)}</div>` : ''}${m.sent_at ? `<div class="sub">${esc(m.sent_at)}</div>` : ''}</td>
      <td class="sub">${esc(m.clicked_at || '')}</td></tr>`).join('')}</table></div>
    <div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`, (dl) => {
    dl.addEventListener('click', (e) => { const kb = e.target.closest('[data-kid]'); if (kb) { dl.close(); showKid(kb.dataset.kid); } });
  });
}

$('outreachEditor').addEventListener('input', (e) => { if (e.target.closest('#oSubject, #oBody')) refreshPreview(); });
$('outreachEditor').addEventListener('change', (e) => {
  if (e.target.matches('#oCampaign, [data-odiv], [data-ostatus]')) refreshPreview();
  if (e.target.id === 'cFile' && e.target.files[0]) e.target.files[0].text().then((t) => ($('cCsv').value = t));
});
$('outreachEditor').addEventListener('click', async (e) => {
  const t = e.target;
  const kb = t.closest('[data-kid]'); if (kb) return showKid(kb.dataset.kid);
  if (t.id === 'oReset') { $('oSubject').value = OS.defaults.subject; $('oBody').value = OS.defaults.body; return refreshPreview(); }
  if (t.id === 'oTest') { const r = await act('POST', '/api/admin/outreach/test', { ...outreachForm(), to: $('oTestTo').value.trim() }); return r; }
  if (t.id === 'oSend') {
    const n = OS.preview?.families || 0;
    if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = `Really email ${plural(n, 'parent')}?`; return; }
    t.disabled = true; t.textContent = 'Sending…';
    const r = await act('POST', '/api/admin/outreach', { ...outreachForm(), mode: 'send' });
    delete t.dataset.armed;
    if (r) loadOutreach(); else refreshPreview();
    return;
  }
  if (t.id === 'oExport') {
    const r = await act('POST', '/api/admin/outreach', { ...outreachForm(), mode: 'export' });
    if (r?.id) { location.href = `/api/admin/outreach/${encodeURIComponent(r.id)}/export.csv`; setTimeout(loadOutreach, 800); }
    return;
  }
  if (t.id === 'cImport') {
    const text = $('cCsv').value.trim(); if (!text) return toast('Paste or choose a CSV first', true);
    const r = await act('POST', '/api/admin/contacts/import', { text }); if (!r) return;
    const list = (label, xs) => (xs.length ? `<details><summary class="note">${xs.length} ${label}</summary><p class="sub">${xs.map(esc).join(' · ')}</p></details>` : '');
    $('cResult').innerHTML = `<p><b>${r.added}</b> contacts added${r.updated ? `, ${r.updated} updated` : ''} for <b>${r.kids}</b> of ${r.rows} players.</p>
      ${list('players not found — check the spelling, or add their contacts from the kid’s record', r.unmatched)}${list('names shared by more than one kid — add these by hand', r.ambiguous)}${list('rows with no email or phone', r.noContact)}`;
    return refreshPreview();
  }
  const row = t.closest('[data-out]'); if (!row) return;
  if (t.matches('[data-oview]')) return showOutreach(row.dataset.out);
  if (t.matches('[data-oretry]')) { t.disabled = true; if (await act('POST', `/api/admin/outreach/${encodeURIComponent(row.dataset.out)}/send`, {})) loadOutreach(); else t.disabled = false; }
});
