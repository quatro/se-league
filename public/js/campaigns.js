/* Signups tab: build registration campaigns (programs, fees, questions) and
   work their orders — waitlist offers, the SportsEngine export, and marking
   orders as entered in SportsEngine. Shares helpers with app.js. */
'use strict';

const CS = { list: [], id: null, data: null, filter: 'paid', busy: false };
const dollars = (c) => `$${(c / 100).toFixed(2)}`;
const QTYPES = { text: 'Short answer', textarea: 'Paragraph', number: 'Number', date: 'Date', yesno: 'Yes / No', select: 'Pick one', multi: 'Pick any', agreement: 'Agreement (must tick)' };
const REG_MODES = [['open', 'Open'], ['waitlist', 'Waitlist only'], ['closed', 'Closed']];
const OFFER_LABEL = { 24: '24 hours', 48: '48 hours', 72: '3 days', 168: '1 week' };
const CA = (path = '') => `/api/admin/campaigns${CS.id ? `/${encodeURIComponent(CS.id)}` : ''}${path}`;

async function loadCampaigns() {
  if (CS.busy) return;
  CS.busy = true;
  try {
    CS.list = await call('GET', '/api/admin/campaigns');
    if (!CS.id || !CS.list.some((c) => c.id === CS.id)) CS.id = CS.list[0]?.id ?? null;
    CS.data = CS.id ? await call('GET', CA()) : null;
    renderCampaigns();
  } catch (e) { toast(e.message, true); } finally { CS.busy = false; }
}

function programChecks(name, chosen) {
  const offs = CS.data.offerings;
  return `<select multiple data-f="${name}" size="${Math.min(4, offs.length + 1)}" aria-label="Programs" title="None selected = every program">${offs.map((o) => `<option value="${esc(o.id)}" ${chosen.includes(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
}

function renderCampaigns() {
  $('campSel').innerHTML = CS.list.length ? CS.list.map((c) => `<option value="${esc(c.id)}" ${c.id === CS.id ? 'selected' : ''}>${esc(c.name)} · ${c.status}</option>`).join('') : '<option>No campaigns yet</option>';
  const ed = $('campEditor');
  if (!CS.data) { ed.innerHTML = '<p class="note">Create a registration campaign — for example “2027 Spring” — to open signups for the season.</p>'; return; }
  const d = CS.data, c = d.campaign, t = d.totals;
  const seasonOpts = S.st.seasons.map((s) => `<option value="${esc(s.id)}" ${s.id === c.season_id ? 'selected' : ''}>${s.year}</option>`).join('');
  const divs = c.season_id === S.sid ? S.st.divisions : [];
  const local = (iso) => (iso ? iso.slice(0, 16) : '');
  const stripeNote = !d.stripe ? '<span class="chip bad">Stripe not connected</span>' : d.stripe === 'test' ? '<span class="chip meh">Stripe test mode</span>' : '<span class="chip good">Stripe live</span>';
  ed.innerHTML = `
  <div class="panel wide"><div class="hd"><h2>${esc(c.name)}</h2><div class="row">${stripeNote}${d.webhook ? '' : ' <span class="chip meh" title="Payments still confirm when families return from Stripe">No Stripe webhook</span>'}
    <a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">${c.status === 'draft' ? 'Preview form' : 'Open form'} ↗</a></div></div>
    <div class="bd">
      <div class="totals"><span><b>${dollars(t.paid)}</b> collected</span><span><b>${t.players}</b> players registered</span><span><b>${t.waitlisted}</b> waitlisted</span><span><b>${t.pending}</b> checkouts in progress</span><span><b>${t.unsynced}</b> paid orders not yet in SportsEngine</span></div>
      <div class="grid2" id="campForm">
        <div class="bd" style="padding:0">
          <div class="row"><label for="cName">Name</label><input type="text" id="cName" value="${esc(c.name)}" style="flex:1"></div>
          <div class="row"><label for="cStatus">Status</label><select id="cStatus" style="width:auto"><option value="draft" ${c.status === 'draft' ? 'selected' : ''}>Draft — only admins see it (and can test-register while Stripe is in test mode)</option><option value="open" ${c.status === 'open' ? 'selected' : ''}>Open — families can register</option><option value="closed" ${c.status === 'closed' ? 'selected' : ''}>Closed</option></select></div>
          <div class="row"><label for="cSlug">Web address</label><span class="sub">/register/</span><input type="text" id="cSlug" value="${esc(c.slug)}" style="width:160px"></div>
          <div class="row"><label for="cSeason">Season</label><select id="cSeason" style="width:auto"><option value="">None (standalone programs)</option>${seasonOpts}</select></div>
          <div class="row"><label for="cOpens">Opens</label><input type="datetime-local" id="cOpens" value="${esc(local(c.opens_at))}" style="width:auto"><label for="cCloses" style="min-width:0">Closes</label><input type="datetime-local" id="cCloses" value="${esc(local(c.closes_at))}" style="width:auto"></div>
        </div>
        <div class="bd" style="padding:0">
          <label class="note" for="cIntro">Intro at the top of the form</label><textarea id="cIntro" rows="3">${esc(c.intro)}</textarea>
          <label class="note" for="cConf">Shown after a family registers</label><textarea id="cConf" rows="3">${esc(c.confirmation)}</textarea>
        </div>
      </div>
      <div class="row"><button class="btn primary" id="cSave">Save campaign</button><span class="note">Opening the campaign makes the form live at the web address above.</span></div>
    </div></div>

  <div class="panel wide"><div class="hd"><h2>Programs</h2><div class="row">${c.season_id ? '<button class="btn" id="fromSeason">Add the season’s divisions</button>' : ''}<button class="btn" id="addProg">Add program</button></div></div><div class="bd">
    <p class="note">What families can sign each player up for. A program tied to a division fills that division's seats (Major/Minor counts Majors + Minors together); a family only sees programs their player's league age fits.
      <b>Registration</b>: <i>Open</i> takes paid signups until the seats run out, then puts families on a free waitlist. <i>Waitlist only</i> sends every new signup to the waitlist (nothing charged), whatever the seat count. <i>Closed</i> hides the program.
      Seats open counts the waitlist as already in line, so an opening goes to the families waiting, not the next signup. Returning players expected back in a division already hold their seat, so they can always register and pay.</p>
    <div class="scroll"><table class="kt" id="progTable"><tr><th>Program</th><th>Division</th><th>Ages</th><th class="num">Cap</th><th>Registration</th><th class="num">Registered</th><th class="num">Waitlist</th><th class="num">Seats open</th><th></th></tr>
    ${d.offerings.map((o) => `<tr data-o="${esc(o.id)}"><td><input type="text" data-f="name" value="${esc(o.name)}" style="min-width:130px"><input type="text" data-f="description" value="${esc(o.description)}" placeholder="Description (optional)" style="margin-top:4px;min-width:130px"></td>
      <td><select data-f="division_id"><option value="">Standalone</option>${(c.season_id === S.sid ? S.st.divisions : []).map((x) => `<option value="${esc(x.id)}" ${x.id === o.division_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}${o.division_id && c.season_id !== S.sid ? `<option value="${esc(o.division_id)}" selected>${esc(o.division_id)}</option>` : ''}</select></td>
      <td style="white-space:nowrap"><input type="number" data-f="min_age" value="${esc(o.min_age ?? '')}" style="width:48px" aria-label="Youngest">–<input type="number" data-f="max_age" value="${esc(o.max_age ?? '')}" style="width:48px" aria-label="Oldest"></td>
      <td class="num"><input type="number" data-f="capacity" value="${esc(o.capacity ?? '')}" style="width:60px" ${o.division_id ? 'disabled title="Uses the division\'s seats"' : ''} aria-label="Capacity"></td>
      <td><select data-f="reg_mode" aria-label="Registration">${REG_MODES.map(([v, l]) => `<option value="${v}" ${o.reg_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="num">${o.registered}</td><td class="num">${o.waitlisted}</td><td class="num ${o.full && o.reg_mode !== 'closed' ? 'warn-text' : ''}">${o.reg_mode === 'closed' ? '—' : `${o.open ?? '—'}${o.reg_mode === 'waitlist' ? ' · waitlist only' : o.full ? ' · full' : ''}`}</td>
      <td><button class="mini" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="9" class="note">No programs yet.</td></tr>'}</table></div>
    ${c.season_id && c.season_id !== S.sid ? `<p class="note">Switch the season picker to ${esc(c.season_id)} to choose divisions.</p>` : ''}
  </div></div>

  <div class="panel wide"><div class="hd"><h2>Fees &amp; add-ons</h2><button class="btn" id="addItem">Add item</button></div><div class="bd">
    <p class="note">Charged <b>per player</b>. Required items are added automatically; optional ones are a checkbox, or a quantity picker when “Max” is above 1. Pick programs to limit an item to them (none = every program). The <b>tag</b> follows the purchase onto the kid's record and the export (e.g. <code>volunteer-exempt</code>).</p>
    <div class="scroll"><table class="kt" id="itemTable"><tr><th>Item</th><th class="num">Price</th><th>Required</th><th class="num">Max</th><th>Programs</th><th>Tag</th><th>On</th><th class="num">Sold</th><th></th></tr>
    ${d.items.map((i) => `<tr data-i="${esc(i.id)}"><td><input type="text" data-f="name" value="${esc(i.name)}" style="min-width:140px"><input type="text" data-f="description" value="${esc(i.description)}" placeholder="Description (optional)" style="margin-top:4px;min-width:140px"></td>
      <td class="num">$<input type="number" data-f="price" value="${(i.price_cents / 100).toFixed(2)}" step="0.01" min="0" style="width:84px" aria-label="Price"></td>
      <td><input type="checkbox" data-f="required" ${i.required ? 'checked' : ''} aria-label="Required"></td>
      <td class="num"><input type="number" data-f="max_qty" value="${i.max_qty}" min="1" max="99" style="width:56px" ${i.required ? 'disabled' : ''} aria-label="Max quantity"></td>
      <td>${programChecks('offering_ids', i.offering_ids)}</td>
      <td><input type="text" data-f="tag" value="${esc(i.tag)}" style="width:130px" aria-label="Tag"></td>
      <td><input type="checkbox" data-f="active" ${i.active ? 'checked' : ''} aria-label="Offered"></td><td class="num">${i.sold}</td>
      <td><button class="mini" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="9" class="note">No items yet.</td></tr>'}</table></div>
  </div></div>

  <div class="panel wide"><div class="hd"><h2>Questions</h2><div class="row"><button class="btn" id="addQP">Add player question</button><button class="btn" id="addQF">Add family question</button></div></div><div class="bd">
    <p class="note"><b>Player</b> questions are asked for each child (experience, shirt size); <b>family</b> questions once (volunteering, coaching experience, the waiver). For “Pick one” / “Pick any”, list the choices separated by commas.</p>
    <div class="scroll"><table class="kt" id="qTable"><tr><th>Asked</th><th>Question</th><th>Type</th><th>Choices</th><th>Required</th><th title="Skipped when the family confirms the player played last season">New players only</th><th>Programs</th><th>On</th><th class="num">Order</th><th></th></tr>
    ${d.questions.map((q) => `<tr data-q="${esc(q.id)}"><td><select data-f="scope"><option value="player" ${q.scope === 'player' ? 'selected' : ''}>Each player</option><option value="family" ${q.scope === 'family' ? 'selected' : ''}>Once per family</option></select></td>
      <td><input type="text" data-f="label" value="${esc(q.label)}" style="min-width:220px"><input type="text" data-f="help" value="${esc(q.help)}" placeholder="Help text (optional)" style="margin-top:4px;min-width:220px"></td>
      <td><select data-f="type">${Object.entries(QTYPES).map(([k, v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><input type="text" data-f="options" value="${esc(q.options.join(', '))}" style="min-width:160px" ${['select', 'multi'].includes(q.type) ? '' : 'disabled'} aria-label="Choices"></td>
      <td><input type="checkbox" data-f="required" ${q.required ? 'checked' : ''} ${q.type === 'agreement' ? 'disabled' : ''} aria-label="Required"></td>
      <td><input type="checkbox" data-f="new_only" ${q.new_only ? 'checked' : ''} ${q.scope === 'player' ? '' : 'disabled'} aria-label="New players only"></td>
      <td>${q.scope === 'player' ? programChecks('offering_ids', q.offering_ids) : '<span class="sub">—</span>'}</td>
      <td><input type="checkbox" data-f="active" ${q.active ? 'checked' : ''} aria-label="Asked"></td>
      <td class="num"><input type="number" data-f="sort" value="${q.sort}" style="width:52px" aria-label="Order"></td>
      <td><button class="mini" data-del>✕</button></td></tr>`).join('') || '<tr><td colspan="10" class="note">No questions yet.</td></tr>'}</table></div>
  </div></div>

  ${waitlistPanel(d)}

  <div class="panel wide"><div class="hd"><h2>Orders</h2><div class="row">
      <select id="ordFilter" style="width:auto" aria-label="Show">${[['paid', 'Paid'], ['unsynced', 'Paid, not in SportsEngine'], ['waitlisted', 'Waitlist'], ['pending', 'Checkout in progress'], ['refunded', 'Refunded'], ['cancelled', 'Abandoned'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${CS.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <a class="btn" href="${esc(CA('/export.csv?unsynced=1'))}">Export not yet in SportsEngine</a><a class="btn" href="${esc(CA('/export.csv'))}">Export all</a><button class="btn" id="markShown">Mark shown as in SportsEngine</button></div></div>
    <div class="bd"><p class="note">Exports have one row per player with the parent's details, every purchase and every answer, laid out for entering into SportsEngine. After entering them, mark the orders so the next export only has new ones. Refunds made in Stripe are flagged here; withdraw the kid on the Kids tab if they're leaving.</p>
      <div class="scroll"><table class="kt" id="ordTable"></table></div></div></div>`;
  renderOrders();
}

/* Each program's waitlist in sign-up order, with the offer / remove actions. */
function waitlistPanel(d) {
  if (!d.waitlist.length) return '';
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const state = (p) => p.status === 'offered' ? `<span class="chip meh">Offered — pay by ${esc(when(p.offer_expires_at))}</span>`
    : p.status === 'expired' ? `<span class="chip bad">Offer expired ${esc(when(p.offer_expires_at))}</span>` : '<span class="chip">Waiting</span>';
  return `<div class="panel wide"><div class="hd"><h2>Waitlist</h2></div><div class="bd">
    <p class="note">First come, first served. <b>Offer the spot</b> gives the family a personal pay link with a deadline${d.mail ? ' and emails it to them' : ' to send them (email isn’t set up yet, so copy it)'}; when they pay, the player is registered automatically. If the deadline passes, offer it again or remove them and offer the next family.</p>
    ${d.waitlist.map((w) => `<h3>${esc(w.program)} <span class="sub">${w.players.length} waiting</span></h3>
      <div class="scroll"><table class="kt"><tr><th class="num">#</th><th>Player</th><th>Family</th><th>Signed up</th><th class="num">Owes</th><th>Status</th><th></th></tr>
      ${w.players.map((p) => `<tr data-wp="${esc(p.id)}"><td class="num"><b>${p.pos}</b></td>
        <td><button class="mini" ${p.kid_id ? `data-kid="${esc(p.kid_id)}"` : 'disabled'} style="border:0;background:none;padding:0;font-weight:600">${esc(p.name)}</button></td>
        <td>${esc(p.family)}<div class="sub">${esc(p.email)} · ${esc(p.phone)}</div></td><td class="sub">${esc(when(p.signed_up.replace(' ', 'T') + 'Z'))}</td>
        <td class="num">${dollars(p.due_cents)}</td><td>${state(p)}</td>
        <td style="white-space:nowrap">${p.offer_url ? `<button class="mini" data-copy="${esc(p.offer_url)}">Copy pay link</button> ` : ''}<button class="mini" data-offer="${esc(p.id)}" data-who="${esc(p.name)}" data-due="${p.due_cents}">${p.status === 'waitlisted' ? 'Offer the spot' : 'Offer again'}</button>
          <button class="mini" data-remove="${esc(p.id)}">Remove</button></td></tr>`).join('')}</table></div>`).join('')}
  </div></div>`;
}

function offerDialog(btn) {
  const d = CS.data;
  openDialog(`<form class="dlg" id="offerF"><h2>Offer ${esc(btn.dataset.who)} a spot</h2>
    <p>The family gets a personal link to pay ${dollars(+btn.dataset.due)} and claim the spot. When they pay, ${esc(btn.dataset.who.split(' ')[0])} is registered automatically.</p>
    <div class="row"><label for="offerHours">They have</label><select id="offerHours" style="width:auto">${d.offerHours.map((h) => `<option value="${h}" ${h === 48 ? 'selected' : ''}>${OFFER_LABEL[h] ?? `${h} hours`}</option>`).join('')}</select><span class="sub">to pay</span></div>
    <p class="note">${d.mail ? 'We’ll email the link to the family.' : 'Email isn’t set up yet, so you’ll get the link to copy and send yourself.'}${btn.textContent.includes('again') ? ' The earlier link stops working.' : ''}</p>
    <div class="row"><button class="btn primary" type="submit">Offer the spot</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (dl) => {
    dl.querySelector('#offerF').onsubmit = async (e) => {
      e.preventDefault();
      const r = await act('POST', CA(`/players/${encodeURIComponent(btn.dataset.offer)}/offer`), { hours: +dl.querySelector('#offerHours').value });
      if (!r) return;
      dl.close();
      loadCampaigns();
      if (!r.url) return;
      openDialog(`<div class="dlg"><h2>${r.emailed ? 'Offer sent' : 'Pay link'}</h2>
        <p>${r.emailed ? `Emailed to <b>${esc(r.emailed)}</b>.` : r.emailError ? `<span class="err-text">The email didn’t send (${esc(r.emailError)}).</span> Send this link to the family yourself.` : 'Send this link to the family.'}
          It works until <b>${esc(new Date(r.expiresAt).toLocaleString())}</b>.</p>
        <input type="text" value="${esc(r.url)}" readonly onclick="this.select()"><div class="row"><button class="btn primary" id="copyLink">Copy</button><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`,
        (d2) => { d2.querySelector('#copyLink').onclick = () => navigator.clipboard?.writeText(r.url).then(() => toast('Copied')); });
    };
  });
}

function shownOrders() {
  const f = CS.filter, os = CS.data.orders;
  if (f === 'all') return os;
  if (f === 'unsynced') return os.filter((o) => o.status === 'paid' && !o.se_synced_at);
  if (f === 'waitlisted') return os.filter((o) => o.players.some((p) => ['waitlisted', 'offered'].includes(p.status)));
  return os.filter((o) => o.status === f);
}
function renderOrders() {
  const os = shownOrders();
  $('ordTable').innerHTML = '<tr><th>When (UTC)</th><th>Family</th><th>Players</th><th class="num">Paid</th><th>Status</th><th title="Entered in SportsEngine">In SE</th><th>Notes</th></tr>'
    + (os.length ? os.map((o) => `<tr data-ord="${esc(o.id)}"><td class="sub">${esc(o.created_at)}</td>
      <td><b>${esc(`${o.guardian.firstName} ${o.guardian.lastName}`)}</b><div class="sub">${esc(o.guardian.email)} · ${esc(o.guardian.phone)}</div></td>
      <td>${o.players.map((p) => `<div><button class="mini" ${p.kid_id ? `data-kid="${esc(p.kid_id)}"` : 'disabled'} style="border:0;background:none;padding:0;font-weight:600">${esc(p.first_name)} ${esc(p.last_name)}</button>${p.prior_match === 'new' ? ' <span class="sub">new</span>' : p.prior_match ? ' <span class="sub">returning</span>' : ''} — ${esc(p.program)} · ${esc(p.status)}
        ${p.lines.length ? `<span class="sub">(${p.lines.map((l) => `${esc(l.name)}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(', ')})</span>` : ''}
        ${p.wait_pos ? ` <span class="pill wait">waitlist #${p.wait_pos}</span>` : ''}</div>`).join('')}</td>
      <td class="num">${dollars(o.total_cents)}${o.stripe_mode === 'test' ? ' <span class="tag">test</span>' : ''}</td>
      <td>${esc(o.status)}</td>
      <td><input type="checkbox" data-synced ${o.se_synced_at ? 'checked' : ''} ${o.status === 'paid' ? '' : 'disabled'} aria-label="Entered in SportsEngine"></td>
      <td><input type="text" data-notes value="${esc(o.admin_notes)}" style="min-width:160px" aria-label="Notes"></td></tr>`).join('') : '<tr><td colspan="7" class="note">No orders here.</td></tr>');
}

const selVals = (el) => [...el.selectedOptions].map((o) => o.value);
function rowBody(tr, kind) {
  const f = (n) => tr.querySelector(`[data-f="${n}"]`);
  const num = (n) => (f(n).value === '' ? null : parseInt(f(n).value, 10));
  if (kind === 'o') return { name: f('name').value, description: f('description').value, division_id: f('division_id').value || null, min_age: num('min_age'), max_age: num('max_age'), capacity: num('capacity'), reg_mode: f('reg_mode').value };
  if (kind === 'i') return { name: f('name').value, description: f('description').value, price_cents: Math.round(parseFloat(f('price').value || '0') * 100), required: f('required').checked, max_qty: num('max_qty') ?? 1, offering_ids: selVals(f('offering_ids')), tag: f('tag').value, active: f('active').checked };
  return { scope: f('scope').value, label: f('label').value, help: f('help').value, type: f('type').value, options: f('options').value.split(',').map((s) => s.trim()).filter(Boolean),
    required: f('required').checked, offering_ids: f('offering_ids') ? selVals(f('offering_ids')) : [], active: f('active').checked, sort: num('sort') ?? 0, new_only: f('new_only').checked };
}

$('campSel').onchange = (e) => { CS.id = e.target.value; CS.data = null; loadCampaigns(); };
$('newCamp').onclick = () => openDialog(`<form class="dlg" id="ncf"><h2>New registration campaign</h2>
  <div class="row"><label for="ncName">Name</label><input type="text" id="ncName" required style="flex:1" placeholder="e.g. 2027 Spring"></div>
  <div class="row"><label for="ncSeason">Season</label><select id="ncSeason" style="width:auto"><option value="">None — standalone programs (summer team, fall league)</option>${S.st.seasons.map((s) => `<option value="${esc(s.id)}" ${s.id === S.st.current ? 'selected' : ''}>${s.year}</option>`).join('')}</select></div>
  <p class="note">It starts as a draft with the season’s divisions as programs, a $200 registration fee, the $5 LFUCG fee, an optional $60 value card, and starter questions on experience, volunteering and the waiver — edit anything before opening it.</p>
  <p class="err-text" id="ncErr"></p>
  <div class="row"><button class="btn primary" type="submit">Create</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (dl) => {
  dl.querySelector('#ncf').onsubmit = async (e) => {
    e.preventDefault();
    try { const c = await call('POST', '/api/admin/campaigns', { name: dl.querySelector('#ncName').value, season_id: dl.querySelector('#ncSeason').value || null }); CS.id = c.id; toast('Campaign created as a draft'); dl.close(); loadCampaigns(); }
    catch (err) { dl.querySelector('#ncErr').textContent = err.message; }
  };
});

$('campEditor').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.id === 'cSave') {
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    if (await act('PATCH', CA(), { name: $('cName').value, slug: $('cSlug').value.trim(), status: $('cStatus').value, season_id: $('cSeason').value || null,
      opens_at: iso($('cOpens').value), closes_at: iso($('cCloses').value), intro: $('cIntro').value, confirmation: $('cConf').value }, 'Campaign saved')) loadCampaigns();
    return;
  }
  if (t.id === 'fromSeason') { if (await act('POST', CA('/programs-from-season'), {})) loadCampaigns(); return; }
  if (t.id === 'addProg') { if (await act('POST', CA('/programs'), { name: 'New program', reg_mode: 'open' }, 'Program added')) loadCampaigns(); return; }
  if (t.id === 'addItem') { if (await act('POST', CA('/items'), { name: 'New item', price_cents: 0 }, 'Item added')) loadCampaigns(); return; }
  if (t.id === 'addQP' || t.id === 'addQF') { if (await act('POST', CA('/questions'), { scope: t.id === 'addQP' ? 'player' : 'family', label: 'New question', type: 'text', sort: 50 }, 'Question added')) loadCampaigns(); return; }
  if (t.id === 'markShown') {
    const ids = shownOrders().filter((o) => o.status === 'paid' && !o.se_synced_at).map((o) => o.id);
    if (!ids.length) return toast('No paid orders here that still need marking');
    if (await act('POST', CA('/orders/synced'), { ids, on: true })) loadCampaigns();
    return;
  }
  const kb = t.closest('[data-kid]'); if (kb) return showKid(kb.dataset.kid);
  if (t.matches('[data-offer]')) return offerDialog(t);
  if (t.matches('[data-copy]')) { navigator.clipboard?.writeText(t.dataset.copy).then(() => toast('Pay link copied')); return; }
  if (t.matches('[data-remove]')) {
    if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Remove?'; return; }
    if (await act('POST', CA(`/players/${encodeURIComponent(t.dataset.remove)}/remove`), {})) loadCampaigns();
    return;
  }
  const del = t.closest('[data-del]');
  if (del) {
    const tr = del.closest('tr'), kind = tr.dataset.o ? 'programs' : tr.dataset.i ? 'items' : 'questions', id = tr.dataset.o || tr.dataset.i || tr.dataset.q;
    if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Delete?'; return; }
    if (await act('DELETE', CA(`/${kind}/${encodeURIComponent(id)}`), undefined, 'Deleted')) loadCampaigns();
  }
});
$('campEditor').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'ordFilter') { CS.filter = t.value; return renderOrders(); }
  const ord = t.closest('[data-ord]');
  if (ord && t.matches('[data-synced]')) { if (await act('POST', CA('/orders/synced'), { ids: [ord.dataset.ord], on: t.checked })) loadCampaigns(); return; }
  if (ord && t.matches('[data-notes]')) { act('PATCH', CA(`/orders/${encodeURIComponent(ord.dataset.ord)}`), { admin_notes: t.value }, 'Saved'); return; }
  const tr = t.closest('tr'); if (!tr || !t.dataset.f) return;
  const [kind, id, path] = tr.dataset.o ? ['o', tr.dataset.o, 'programs'] : tr.dataset.i ? ['i', tr.dataset.i, 'items'] : tr.dataset.q ? ['q', tr.dataset.q, 'questions'] : [];
  if (!kind) return;
  if (await act('PATCH', CA(`/${path}/${encodeURIComponent(id)}`), rowBody(tr, kind), 'Saved')) loadCampaigns();
});
