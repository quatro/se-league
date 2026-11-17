/* Registration tab: set up a registration (programs, fees, questions, payment
   plan) and work its orders — waitlist offers, the SportsEngine export, and
   marking orders as entered in SportsEngine. Shares helpers with app.js.

   Layout: a header (status, web address, numbers, the one primary action),
   then one section at a time. Everything reads as plain text; editing happens
   in a focused dialog, never in a grid of always-open inputs. */
'use strict';

const CS = { list: [], id: null, data: null, filter: 'paid', busy: false, section: 'details' };
try { CS.section = localStorage.getItem('league-reg-section') || 'details'; } catch { /* private mode */ }
const dollars = (c) => `$${(c / 100).toFixed(2)}`;
const cash = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const QTYPES = { text: 'Short answer', textarea: 'Paragraph', number: 'Number', date: 'Date', yesno: 'Yes / No', select: 'Pick one', multi: 'Pick any', agreement: 'Agreement (must tick)' };
const REG_MODES = {
  open: ['Open', 'Takes registrations up to the spots you set below.'],
  waitlist: ['Waitlist only', 'Every new registration joins the waitlist and pays nothing until you offer a spot.'],
  closed: ['Closed', 'Hidden from families.'],
};
const STATUS = {
  draft: { label: 'Draft', cls: 'meh', line: 'Only admins can see the form. Families can’t register until you open it.' },
  open: { label: 'Open', cls: 'good', line: 'Families can register now.' },
  closed: { label: 'Closed', cls: '', line: 'The form is closed — families see a “registration is closed” message.' },
};
const KINDS = {
  spring: ['Spring league', 'The annual league: returning players hold their seats, protection keeps room for them, and interest checks ask who’s coming back.'],
  standard: ['Simple sign-up', 'Summer, fall ball, camps: divisions, fees, spots and a waitlist — no returner tracking.'],
};
const PHASE = { open: ['Open to everyone', 'good'], protected: ['Protecting returners', 'meh'], full: ['Full', 'bad'], waitlist: ['Waitlist only', 'meh'] };
const OFFER_LABEL = { 24: '24 hours', 48: '48 hours', 72: '3 days', 168: '1 week' };
const CA = (path = '') => `/api/admin/campaigns${CS.id ? `/${encodeURIComponent(CS.id)}` : ''}${path}`;
const whenLocal = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const dayLocal = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

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

/* ---------- reading helpers ---------- */
const progName = (id) => CS.data.offerings.find((o) => o.id === id)?.name ?? '?';
const appliesTo = (ids) => (!ids.length || ids.length === CS.data.offerings.length ? 'All divisions' : ids.map(progName).join(', '));
// The program's own limit on new players, in plain words (division seats and expected returners don't enter into it).
function spotLine(o) {
  const after = o.when_full === 'close' ? 'closed to new players' : 'new players join the waitlist';
  if (o.reg_mode === 'closed') return { cls: 'muted', text: 'Hidden from families' };
  if (o.reg_mode === 'waitlist') return { cls: 'warn', text: 'Waitlist only' };
  if (o.capacity == null) return { cls: '', text: 'No limit' };
  if (o.open <= 0) return { cls: 'warn', text: `Full — ${after}` };
  return { cls: 'ok', text: `${o.open} of ${o.capacity} spot${o.capacity === 1 ? '' : 's'} left` };
}
// Taken = new players registered or waiting; checkouts still in progress are shown but don't hold a spot.
const spotMeter = (o) => (o.capacity ? `<span class="spotbar" role="img" aria-label="${o.taken} of ${o.capacity} spots taken"><i style="width:${Math.min(100, (100 * o.taken) / o.capacity).toFixed(1)}%"></i></span>` : '');
// A one-player example for the payment plan: the required fees every program charges.
const sampleTotal = () => CS.data.items.filter((i) => i.active && i.required && !i.offering_ids.length).reduce((a, i) => a + i.price_cents, 0) || 20500;
// Same schedule the server makes (src/lib/plans.ts planSchedule; register.js mirrors it too).
function planPreview(total, n, finalDate) {
  const today = new Date().toLocaleDateString('en-CA');
  if (!n || !finalDate || total <= 0) return null;
  const dUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), dIso = (t) => new Date(t).toISOString().slice(0, 10);
  const addM = (d, k) => { const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + k, day = +d.slice(8, 10), last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return dIso(Date.UTC(y, m, Math.min(day, last))); };
  const span = Math.round((dUtc(finalDate) - dUtc(today)) / 864e5);
  if (span < 7 * (n - 1)) return null;
  const base = Math.floor(total / n), monthly = addM(today, n - 1) <= finalDate;
  return Array.from({ length: n }, (_, k) => ({ due: k === 0 ? today : monthly ? addM(today, k) : dIso(dUtc(today) + Math.round((span * k) / (n - 1)) * 864e5), cents: k === 0 ? total - base * (n - 1) : base }));
}

/* ---------- page ---------- */
function renderCampaigns() {
  $('campSel').innerHTML = CS.list.length ? CS.list.map((c) => `<option value="${esc(c.id)}" ${c.id === CS.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('') : '<option>No registrations yet</option>';
  const ed = $('campEditor');
  if (!CS.data) {
    ed.innerHTML = `<div class="panel"><div class="bd regempty"><h2>No registrations yet</h2><p>Create one — for example “2027 Spring” — to start registering players for the season.</p><div><button class="btn primary" data-act="new">New registration</button></div></div></div>`;
    return;
  }
  const d = CS.data, c = d.campaign, t = d.totals, st = STATUS[c.status];
  const fullUrl = new URL(d.url, location.origin).href;
  const primary = c.status === 'draft' ? ['open', 'Open registration'] : c.status === 'open' ? ['closed', 'Close registration'] : ['open', 'Reopen registration'];
  const stripe = !d.stripe ? '<span class="chip bad">Stripe not connected</span>' : d.stripe === 'test' ? '<span class="chip meh" title="Payments are rehearsals — no real money moves">Stripe test mode</span>' : '<span class="chip good">Stripe live</span>';
  const timing = [c.opens_at ? `Opens ${whenLocal(c.opens_at)}` : '', c.closes_at ? `Closes ${whenLocal(c.closes_at)}` : ''].filter(Boolean).join(' · ');
  const stat = (n, label, cls = '') => `<div class="rstat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  const qOn = d.questions.filter((q) => q.active).length, iOn = d.items.filter((i) => i.active).length, progOn = d.offerings.filter((o) => o.reg_mode !== 'closed').length;
  const waiting = d.waitlist.reduce((a, w) => a + w.players.length, 0);
  const plan = c.plan_installments >= 2 && c.plan_final_date, planWorks = plan && planPreview(sampleTotal(), c.plan_installments, c.plan_final_date);
  const SECTIONS = [['details', 'Details', ''], ['programs', 'Divisions', progOn], ['fees', 'Fees', iOn], ['questions', 'Questions', qOn], ['plan', 'Payment plan', plan ? (planWorks ? 'On' : '!') : 'Off'],
    ['waitlist', 'Waitlist', waiting], ['orders', 'Orders', d.orders.filter((o) => o.status === 'paid').length]];
  if (!SECTIONS.some(([k]) => k === CS.section)) CS.section = 'details';

  ed.innerHTML = `
  <div class="panel reghero">
    <div class="rh-top">
      <div class="rh-title">
        <div class="row" style="gap:10px"><h2 class="rh-name">${esc(c.name)}</h2><span class="chip ${st.cls}">${st.label}</span><span class="chip">${esc(KINDS[c.kind][0])}</span></div>
        <p class="rh-line">${st.line}${timing ? ` <span class="sub">${esc(timing)}</span>` : ''}</p>
        <div class="rh-url"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(fullUrl.replace(/^https?:\/\//, ''))}</a><button class="mini" data-act="copyurl" data-url="${esc(fullUrl)}">Copy link</button></div>
      </div>
      <div class="rh-actions">
        <button class="btn primary big" data-act="status" data-to="${primary[0]}">${primary[1]}</button>
        <a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">${c.status === 'draft' ? 'Preview the form' : 'View the form'} ↗</a>
      </div>
    </div>
    <div class="rstats">
      ${stat(t.players, 'players registered')}${stat(t.waitlisted, 'on the waitlist', t.waitlisted ? 'warn' : '')}${stat(cash(t.paid), 'collected')}
      ${stat(t.pending, 'checkouts in progress')}${stat(t.unsynced, 'paid, not yet in SportsEngine', t.unsynced ? 'warn' : '')}
    </div>
    <div class="rh-meta">${stripe}${d.webhook ? '' : ' <span class="chip meh" title="Payments still confirm when families return from Stripe">No Stripe webhook</span>'}</div>
  </div>

  <nav class="secnav" role="tablist" aria-label="Registration sections">
    ${SECTIONS.map(([k, l, n]) => `<button role="tab" aria-selected="${CS.section === k}" data-sec="${k}">${l}${n !== '' ? ` <span class="cnt ${n === '!' ? 'warn' : ''}" ${n === '!' ? 'title="Set up, but families aren’t being offered it — see why"' : ''}>${n}</span>` : ''}</button>`).join('')}
  </nav>
  <div id="regSection">${sectionHtml(CS.section)}</div>`;
  if (CS.section === 'orders') renderOrders();
}

function sectionHtml(s) {
  const d = CS.data, c = d.campaign;
  if (s === 'details') {
    const dl = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
    const season = c.season_id ? S.st.seasons.find((x) => x.id === c.season_id)?.year ?? c.season_id : 'None — standalone registration';
    return `<div class="panel"><div class="hd"><h2>Details</h2><button class="btn" data-act="details">Edit details</button></div><div class="bd">
      <dl class="kvs">
        ${dl('Name', esc(c.name))}
        ${dl('Type', `${esc(KINDS[c.kind][0])} <span class="sub">— ${esc(KINDS[c.kind][1])}</span>`)}
        ${dl('Season', esc(String(season)))}
        ${dl('Web address', `<code>/register/${esc(c.slug)}</code>`)}
        ${dl('Opens', c.opens_at ? esc(whenLocal(c.opens_at)) : '<span class="sub">No date — opens when you click <b>Open registration</b></span>')}
        ${dl('Closes', c.closes_at ? esc(whenLocal(c.closes_at)) : '<span class="sub">No date — stays open until you close it</span>')}
        ${dl('Intro', c.intro ? `<div class="quote">${esc(c.intro)}</div>` : '<span class="sub">None — the form starts with the parent’s details</span>')}
        ${dl('After registering', c.confirmation ? `<div class="quote">${esc(c.confirmation)}</div>` : '<span class="sub">None — families see the standard “You’re registered” page</span>')}
      </dl></div></div>`;
  }
  if (s === 'programs') {
    return `<div class="panel"><div class="hd"><h2>Divisions</h2><div class="row">${c.season_id ? '<button class="linkbtn" data-act="fromSeason">Add the season’s divisions</button>' : ''}<button class="btn" data-act="addProg">Add division</button></div></div><div class="bd">
      <p class="note">What a family can register each player for. Families only see the divisions their player’s league age fits.</p>
      <details class="explain"><summary>How spots and the waitlist work</summary>
        <p>Each division has its own number of spots for <b>new</b> players, and its own rule for when they’re gone: start a free waitlist, or stop taking registrations. Returning players expected back in that division always get in and don’t use a spot. In the spring league, <b>returner protection</b> watches each division’s buffer and sends new players to the waitlist when it gets tight. People on the waitlist count as already in line, so if you add spots they go to the families waiting (offer them from the Waitlist section), not to the next registration.</p></details>
      <ul class="lrows">${d.offerings.map((o) => {
        const sl = spotLine(o), g = o.guard, ph = PHASE[o.phase], div = o.division_id ? S.st.divisions.find((x) => x.id === o.division_id)?.name : null;
        const ages = o.min_age != null || o.max_age != null ? `Ages ${o.min_age ?? '?'}${o.max_age !== o.min_age ? `–${o.max_age ?? '?'}` : ''}` : 'Any age';
        return `<li class="lrow ${o.reg_mode === 'closed' ? 'off' : ''}">
          <div class="lmain"><div class="lname">${esc(o.name)} ${o.reg_mode === 'closed' ? '<span class="chip">Closed</span>' : `<span class="chip ${ph[1]}">${ph[0]}</span>`}</div>
            <div class="lmeta">${ages}${div ? ` · goes to ${esc(div)}` : o.division_id ? '' : ' · standalone'}${o.capacity != null && o.reg_mode === 'open' ? ` · ${o.capacity} spots, then ${o.when_full === 'close' ? 'closes' : 'waitlist'}` : ''}</div>
            ${o.description ? `<div class="ldesc">${esc(o.description)}</div>` : ''}
            ${g && o.reg_mode !== 'closed' ? `<div class="guard ${o.phase !== 'open' || (g.protectAt == null && g.buffer <= 10) ? 'on' : ''}"><b>Buffer ${g.buffer}</b> <span>= ${g.capacity - g.registered} open seats − ${g.outstanding} returners still to register${g.waitlist ? ` − ${g.waitlist} waiting` : ''}</span>
              <span class="sub ${g.protectAt == null && g.buffer <= 10 ? 'warn-text' : ''}">${g.protectAt == null ? (g.buffer <= 10 ? 'Protection off — new players could take seats returners need' : 'Protection off') : `Protects returners at ${g.protectAt} or fewer`}</span></div>` : ''}</div>
          <div class="lstat"><div class="seat ${sl.cls}">${sl.text}</div>${spotMeter(o)}
            <div class="regcounts"><span><b>${o.new_registered}</b> new</span><span><b>${o.returning_registered}</b> returning</span>${o.waitlisted ? `<span class="w"><b>${o.waitlisted}</b> waiting</span>` : ''}${o.in_checkout ? `<span><b>${o.in_checkout}</b> checking out</span>` : ''}</div></div>
          <div class="lact"><button class="btn" data-act="editProg" data-id="${esc(o.id)}">Edit</button></div></li>`;
      }).join('') || '<li class="note">No divisions yet — add one, or add the season’s divisions.</li>'}</ul>
      ${c.season_id && c.season_id !== S.sid ? `<p class="note">Switch the season picker (top right) to ${esc(c.season_id)} to tie these to its season divisions.</p>` : ''}
    </div></div>`;
  }
  if (s === 'fees') {
    const on = d.items.filter((i) => i.active), off = d.items.filter((i) => !i.active);
    const row = (i) => `<li class="lrow ${i.active ? '' : 'off'}">
      <div class="lmain"><div class="lname">${esc(i.name)}${i.active ? '' : ' <span class="chip">Not offered</span>'}</div>
        <div class="lmeta">${i.required ? '<b>Required</b> — added to every player' : i.max_qty > 1 ? `Optional — up to ${i.max_qty} per player` : 'Optional — a checkbox'} · ${esc(appliesTo(i.offering_ids))}${i.tag ? ` · tag <code>${esc(i.tag)}</code>` : ''}</div>
        ${i.description ? `<div class="ldesc">${esc(i.description)}</div>` : ''}</div>
      <div class="lstat"><div class="price">${cash(i.price_cents)}</div><div class="sub">${i.sold} sold</div></div>
      <div class="lact"><button class="btn" data-act="editItem" data-id="${esc(i.id)}">Edit</button></div></li>`;
    const perPlayer = on.filter((i) => i.required && !i.offering_ids.length).reduce((a, i) => a + i.price_cents, 0);
    return `<div class="panel"><div class="hd"><h2>Fees &amp; add-ons</h2><button class="btn" data-act="addItem">Add fee</button></div><div class="bd">
      <p class="note">Charged per player.${perPlayer ? ` Every player pays at least <b>${cash(perPlayer)}</b> in required fees.` : ''}</p>
      <ul class="lrows">${on.map(row).join('') || '<li class="note">No fees yet.</li>'}</ul>
      ${off.length ? `<h3 class="subhd">Not offered</h3><ul class="lrows">${off.map(row).join('')}</ul>` : ''}
    </div></div>`;
  }
  if (s === 'questions') {
    const group = (scope, title, sub) => {
      const qs = d.questions.filter((q) => q.scope === scope).sort((a, b) => a.sort - b.sort);
      return `<section class="qgroup"><div class="row"><h3>${title}</h3><span class="sub">${sub}</span><span class="spacer"></span><button class="btn" data-act="addQ" data-scope="${scope}">Add question</button></div>
        <ol class="lrows qlist">${qs.map((q, n) => `<li class="lrow ${q.active ? '' : 'off'}">
          <div class="qnum">${n + 1}</div>
          <div class="lmain"><div class="lname">${esc(q.label)}${q.active ? '' : ' <span class="chip">Not asked</span>'}</div>
            <div class="lmeta">${QTYPES[q.type]}${q.required || q.type === 'agreement' ? ' · <b>Required</b>' : ' · Optional'}${q.new_only ? ' · New players only' : ''}${scope === 'player' && q.offering_ids.length ? ` · Only for ${esc(appliesTo(q.offering_ids))}` : ''}</div>
            ${q.help ? `<div class="ldesc">${esc(q.help)}</div>` : ''}
            ${['select', 'multi'].includes(q.type) && q.options.length ? `<div class="opts">${q.options.map((o) => `<span>${esc(o)}</span>`).join('')}</div>` : ''}</div>
          <div class="lact"><button class="mini" data-act="moveQ" data-id="${esc(q.id)}" data-dir="-1" ${n ? '' : 'disabled'} aria-label="Move up">↑</button><button class="mini" data-act="moveQ" data-id="${esc(q.id)}" data-dir="1" ${n < qs.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button><button class="btn" data-act="editQ" data-id="${esc(q.id)}">Edit</button></div></li>`).join('') || '<li class="note">None yet.</li>'}</ol></section>`;
    };
    return `<div class="panel"><div class="hd"><h2>Questions</h2></div><div class="bd">
      ${group('player', 'For each player', 'experience, shirt size…')}
      ${group('family', 'Once per family', 'volunteering, the waiver…')}
    </div></div>`;
  }
  if (s === 'plan') {
    const on = c.plan_installments >= 2 && c.plan_final_date, ex = sampleTotal(), sched = on ? planPreview(ex, c.plan_installments, c.plan_final_date) : null;
    return `<div class="panel"><div class="hd"><h2>Payment plan</h2><button class="btn ${on ? '' : 'primary'}" data-act="plan">${on ? 'Change' : 'Set up a payment plan'}</button></div><div class="bd">
      ${on ? `<p class="lead">Families can split their total into <b>${c.plan_installments} payments</b>, the last by <b>${esc(dayLocal(c.plan_final_date))}</b>${c.plan_min_cents ? `, when their total is <b>${cash(c.plan_min_cents)}</b> or more` : ''}. No interest, no fees.</p>
        ${sched ? `<div><h3 class="subhd">Example: one player, ${cash(ex)}, registering today</h3><table class="kt sched">${sched.map((x, k) => `<tr><td>${k === 0 ? 'Today, at checkout' : esc(dayLocal(x.due))}</td><td class="num">${dollars(x.cents)}</td></tr>`).join('')}</table></div>`
          : `<div class="alertbox"><b>Families aren’t being offered this plan.</b> ${c.plan_final_date <= new Date().toLocaleDateString('en-CA') ? `The last payment date, ${esc(dayLocal(c.plan_final_date))}, has already passed.` : 'The last payment date is too close for this many payments — they need to be at least a week apart.'} <button class="linkbtn" data-act="plan">Pick a new date</button></div>`}
        <p class="note">The first payment is taken at checkout and the card is saved; the rest are charged on their dates, with an email reminder 3 days before each. Declined cards are retried and show in <b>Finance</b>.</p>`
      : `<p class="lead">Off — families pay in full at checkout.</p><p class="note">Turn it on to let families split their total into 2–6 equal payments with no interest or fees. The league collects them automatically from the card used at checkout; missed payments show in <b>Finance</b>.</p>`}
    </div></div>`;
  }
  if (s === 'waitlist') return waitlistPanel(d);
  return `<div class="panel"><div class="hd"><h2>Orders</h2><div class="row">
      <select id="ordFilter" style="width:auto" aria-label="Show">${[['paid', 'Paid'], ['unsynced', 'Paid, not in SportsEngine'], ['waitlisted', 'Waitlist'], ['pending', 'Checkout in progress'], ['refunded', 'Refunded'], ['cancelled', 'Abandoned'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${CS.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <a class="btn" href="${esc(CA('/export.csv?unsynced=1'))}">Export new for SportsEngine</a><a class="linkbtn" href="${esc(CA('/export.csv'))}">Export all</a></div></div>
    <div class="bd"><p class="note">Exports have one row per player with the parent’s details, purchases and answers, laid out for SportsEngine. After entering them, tick <b>In SE</b> (or <button class="linkbtn" data-act="markShown">mark everything shown</button>) so the next export only has new ones.</p>
      <div class="scroll"><table class="kt ordt" id="ordTable"></table></div></div></div>`;
}

/* Each program's waitlist in sign-up order, with the offer / remove actions. */
function waitlistPanel(d) {
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const state = (p) => p.status === 'offered' ? `<span class="chip meh">Offered — pay by ${esc(when(p.offer_expires_at))}</span>`
    : p.status === 'expired' ? `<span class="chip bad">Offer expired ${esc(when(p.offer_expires_at))}</span>` : '<span class="chip">Waiting</span>';
  return `<div class="panel"><div class="hd"><h2>Waitlist</h2></div><div class="bd">
    <p class="note">First come, first served. <b>Offer the spot</b> gives the family a personal pay link with a deadline${d.mail ? ' and emails it to them' : ' to send them (email isn’t set up yet, so copy it)'}; when they pay, the player is registered automatically.</p>
    ${d.waitlist.length ? d.waitlist.map((w) => `<h3 class="subhd">${esc(w.program)} <span class="sub">${w.players.length} waiting</span></h3>
      <div class="scroll"><table class="kt"><tr><th class="num">#</th><th>Player</th><th>Family</th><th>Joined</th><th class="num">Owes</th><th>Status</th><th></th></tr>
      ${w.players.map((p) => `<tr data-wp="${esc(p.id)}"><td class="num"><b>${p.pos}</b></td>
        <td><button class="linkbtn" ${p.kid_id ? `data-kid="${esc(p.kid_id)}"` : 'disabled'}>${esc(p.name)}</button></td>
        <td>${esc(p.family)}<div class="sub">${esc(p.email)} · ${esc(p.phone)}</div></td><td class="sub">${esc(when(p.signed_up.replace(' ', 'T') + 'Z'))}</td>
        <td class="num">${dollars(p.due_cents)}</td><td>${state(p)}</td>
        <td style="white-space:nowrap">${p.offer_url ? `<button class="mini" data-copy="${esc(p.offer_url)}">Copy pay link</button> ` : ''}<button class="mini" data-offer="${esc(p.id)}" data-who="${esc(p.name)}" data-due="${p.due_cents}">${p.status === 'waitlisted' ? 'Offer the spot' : 'Offer again'}</button>
          <button class="mini" data-remove="${esc(p.id)}">Remove</button></td></tr>`).join('')}</table></div>`).join('') : '<p class="lead">Nobody is waiting.</p>'}
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
const ORDER_STATUS = { paid: ['Paid', 'ok'], pending: ['Checking out', 'need'], waitlisted: ['Waitlist', 'wait'], refunded: ['Refunded', 'need'], cancelled: ['Abandoned', ''] };
/* Notes stay out of the way: an icon to add one, the note itself (click to edit) once there is one. */
const NOTE_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 3h9l3 3v11H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 9h6M7 12h6M7 15h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
function noteHtml(o) {
  return o.admin_notes
    ? `<button class="notebtn has" data-note title="Edit note">${NOTE_ICON}<span>${esc(o.admin_notes)}</span></button>`
    : `<button class="notebtn" data-note title="Add a note" aria-label="Add a note">${NOTE_ICON}</button>`;
}
function openNote(cell) {
  const o = CS.data.orders.find((x) => x.id === cell.closest('[data-ord]').dataset.ord);
  cell.innerHTML = `<div class="noteedit"><textarea rows="3" aria-label="Note" placeholder="Note for the league (families don’t see it)">${esc(o.admin_notes)}</textarea>
    <div class="row"><button class="btn primary" data-notesave>Save</button><button class="linkbtn" data-notecancel>Cancel</button></div></div>`;
  const ta = cell.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cell.querySelector('[data-notecancel]').click();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) cell.querySelector('[data-notesave]').click();
  });
}
async function saveNote(cell, save) {
  const o = CS.data.orders.find((x) => x.id === cell.closest('[data-ord]').dataset.ord);
  if (save) {
    const v = cell.querySelector('textarea').value.trim();
    if (v !== (o.admin_notes || '') && await act('PATCH', CA(`/orders/${encodeURIComponent(o.id)}`), { admin_notes: v }, v ? 'Note saved' : 'Note removed')) o.admin_notes = v;
  }
  cell.innerHTML = noteHtml(o);
  cell.querySelector('[data-note]').focus();
}
function renderOrders() {
  const el = $('ordTable'); if (!el) return;
  const os = shownOrders();
  el.innerHTML = '<tr><th>Placed</th><th>Family</th><th>Players</th><th class="num">Amount</th><th>Status</th><th title="Tick once this family is entered in SportsEngine. “Export new” leaves ticked families out.">In SportsEngine</th><th><span class="vh">Notes</span></th></tr>'
    + (os.length ? os.map((o) => {
      const [sl, sc] = ORDER_STATUS[o.status] ?? [o.status, ''];
      return `<tr data-ord="${esc(o.id)}"><td class="sub" style="white-space:nowrap">${esc(whenLocal(o.created_at.replace(' ', 'T') + (o.created_at.includes('Z') ? '' : 'Z')))}</td>
      <td><b>${esc(`${o.guardian.firstName} ${o.guardian.lastName}`)}</b><div class="sub">${esc(o.guardian.email)}<br>${esc(o.guardian.phone)}</div></td>
      <td>${o.players.map((p) => `<div class="oplayer"><button class="linkbtn" ${p.kid_id ? `data-kid="${esc(p.kid_id)}"` : 'disabled'}>${esc(p.first_name)} ${esc(p.last_name)}</button>
        <span class="sub">${esc(p.program)}${p.prior_match === 'new' ? ' · new' : p.prior_match ? ' · returning' : ''}${p.status !== 'registered' ? ` · ${esc(p.status)}` : ''}</span>${p.wait_pos ? ` <span class="pill wait">waitlist #${p.wait_pos}</span>` : ''}</div>`).join('')}</td>
      <td class="num">${dollars(o.total_cents)}${o.stripe_mode === 'test' ? '<div class="sub">test</div>' : ''}</td>
      <td><span class="tag ${sc}">${esc(sl)}</span></td>
      <td><input type="checkbox" data-synced ${o.se_synced_at ? 'checked' : ''} ${o.status === 'paid' ? '' : 'disabled'} aria-label="Entered in SportsEngine"
        title="${o.status === 'paid' ? 'Tick once this family is entered in SportsEngine' : 'Only paid registrations go into SportsEngine'}"></td>
      <td class="notecell">${noteHtml(o)}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="note">No orders here.</td></tr>');
}

/* ---------- edit dialogs ---------- */
const fld = (label, control, hint = '') => `<label class="fld"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;
const progChecks = (chosen, allLabel) => `<fieldset class="fld checks"><legend>${allLabel}</legend>${CS.data.offerings.map((o) => `<label class="chk"><input type="checkbox" name="prog" value="${esc(o.id)}" ${chosen.includes(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('')}<small>Leave all unticked for every program.</small></fieldset>`;
const checkedProgs = (f) => [...f.querySelectorAll('[name=prog]:checked')].map((x) => x.value);
function footer(delLabel) {
  return `<div class="row dlgfoot"><button class="btn primary" type="submit">Save</button><button class="btn" data-close>Cancel</button><span class="spacer"></span>${delLabel ? `<button class="btn danger" type="button" data-del>${delLabel}</button>` : ''}</div>`;
}
// Shared wiring: submit → save, delete needs a second click.
function editDialog(html, save, del) {
  openDialog(html, (dl) => {
    const f = dl.querySelector('form');
    f.onsubmit = async (e) => { e.preventDefault(); if (await save(f)) { dl.close(); loadCampaigns(); } };
    const db = f.querySelector('[data-del]');
    if (db) db.onclick = async () => {
      if (!db.dataset.armed) { db.dataset.armed = '1'; db.textContent = 'Click again to delete'; return; }
      if (await del()) { dl.close(); loadCampaigns(); }
    };
    f.querySelector('input:not([type=checkbox]):not([type=radio]),textarea')?.focus();
  });
}

function detailsDialog() {
  const c = CS.data.campaign, local = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '');
  editDialog(`<form class="dlg"><h2>Registration details</h2>
    ${fld('Name', `<input type="text" name="name" value="${esc(c.name)}" required>`)}
    ${fld('Status', `<select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${v.label} — ${v.line}</option>`).join('')}</select>`)}
    ${fld('Season', `<select name="season"><option value="">None — standalone (summer team, fall league)</option>${S.st.seasons.map((s) => `<option value="${esc(s.id)}" ${s.id === c.season_id ? 'selected' : ''}>${s.year}</option>`).join('')}</select>`)}
    ${fld('Type', `<select name="kind">${Object.entries(KINDS).map(([k, [l]]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'Spring league turns on returner seats, protection and interest checks.')}
    ${fld('Web address', `<div class="prefix"><span>/register/</span><input type="text" name="slug" value="${esc(c.slug)}" required></div>`, 'Changing it breaks links you’ve already sent.')}
    <div class="fld2">${fld('Opens', `<input type="datetime-local" name="opens" value="${esc(local(c.opens_at))}">`, 'Optional')}${fld('Closes', `<input type="datetime-local" name="closes" value="${esc(local(c.closes_at))}">`, 'Optional')}</div>
    ${fld('Intro at the top of the form', `<textarea name="intro" rows="3">${esc(c.intro)}</textarea>`)}
    ${fld('Message after a family registers', `<textarea name="conf" rows="3">${esc(c.confirmation)}</textarea>`)}
    ${footer()}</form>`, (f) => {
    const v = (n) => f.elements[n].value, iso = (x) => (x ? new Date(x).toISOString() : null);
    return act('PATCH', CA(), { name: v('name'), slug: v('slug').trim(), status: v('status'), season_id: v('season') || null, kind: v('kind'), opens_at: iso(v('opens')), closes_at: iso(v('closes')), intro: v('intro'), confirmation: v('conf') }, 'Saved');
  });
}

function programDialog(o) {
  const c = CS.data.campaign, divs = c.season_id === S.sid ? S.st.divisions : [];
  editDialog(`<form class="dlg"><h2>${o.id ? esc(o.name) : 'New division'}</h2>
    ${fld('Name', `<input type="text" name="name" value="${esc(o.name)}" required>`)}
    ${fld('Description', `<input type="text" name="description" value="${esc(o.description)}" placeholder="Optional — shown under the name">`)}
    ${fld('Players go to', `<select name="division"><option value="">Nowhere — standalone</option>${divs.map((x) => `<option value="${esc(x.id)}" ${x.id === o.division_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}${o.division_id && !divs.some((x) => x.id === o.division_id) ? `<option value="${esc(o.division_id)}" selected>${esc(o.division_id)}</option>` : ''}</select>`, 'Where registered players are placed for the season. It doesn’t limit signups — spots below do.')}
    <div class="fld2">${fld('Youngest (league age)', `<input type="number" name="min" value="${esc(o.min_age ?? '')}" min="3" max="19">`)}${fld('Oldest', `<input type="number" name="max" value="${esc(o.max_age ?? '')}" min="3" max="19">`)}</div>
    <fieldset class="fld radios"><legend>Registration</legend>${Object.entries(REG_MODES).map(([k, [l, h]]) => `<label class="chk"><input type="radio" name="mode" value="${k}" ${o.reg_mode === k ? 'checked' : ''}> <span><b>${l}</b> <small>${h}</small></span></label>`).join('')}</fieldset>
    ${CS.data.campaign.kind === 'spring' ? `<div class="spotbox" data-show="open">
      <label class="chk"><input type="checkbox" name="protect" ${o.protect_at != null ? 'checked' : ''}> <span><b>Protect returning players’ seats</b>
        <small>When the buffer — open seats in the division, minus returners who haven’t registered yet and anyone waiting — drops to the number below, new players go to the waitlist while returners keep registering.${o.guard ? ` Right now: ${o.guard.capacity - o.guard.registered} open − ${o.guard.outstanding} returners${o.guard.waitlist ? ` − ${o.guard.waitlist} waiting` : ''} = <b>${o.guard.buffer}</b>.` : ''}</small></span></label>
      <div data-show="protect">${fld('Start protecting at a buffer of', `<input type="number" name="protectAt" value="${esc(o.protect_at ?? 10)}" min="0" max="500" style="max-width:120px">`, 'For example 10: once only 10 seats are left beyond the returners still out, new players wait.')}</div>
    </div>` : ''}
    <div class="spotbox" data-show="open">
      ${fld('Spots for new players', `<input type="number" name="cap" value="${esc(o.capacity ?? '')}" min="0" placeholder="No limit" style="max-width:160px">`, `Leave blank for no limit. Returning players expected back always get in and don’t use a spot.${o.id ? ` Taken now: ${o.taken} (${o.new_registered} registered${o.waitlisted ? `, ${o.waitlisted} waiting` : ''}).` : ''}`)}
      <fieldset class="fld radios"><legend>When the spots are gone</legend>
        <label class="chk"><input type="radio" name="whenfull" value="waitlist" ${o.when_full !== 'close' ? 'checked' : ''}> <span><b>Start a waitlist</b> <small>New players sign up free and wait in line; you offer spots from the Waitlist section.</small></span></label>
        <label class="chk"><input type="radio" name="whenfull" value="close" ${o.when_full === 'close' ? 'checked' : ''}> <span><b>Stop taking registrations</b> <small>Families see that this division is full.</small></span></label></fieldset>
    </div>
    ${footer(o.id && 'Delete division')}</form>`, (f) => {
    const v = (n) => f.elements[n].value, num = (n) => (v(n) === '' ? null : parseInt(v(n), 10));
    return act(o.id ? 'PATCH' : 'POST', CA(o.id ? `/programs/${encodeURIComponent(o.id)}` : '/programs'), { name: v('name'), description: v('description'), division_id: v('division') || null, min_age: num('min'), max_age: num('max'), capacity: num('cap'), reg_mode: f.querySelector('[name=mode]:checked').value, when_full: f.querySelector('[name=whenfull]:checked').value,
      ...(f.elements.protect ? { protect_at: f.elements.protect.checked ? Math.max(0, parseInt(v('protectAt'), 10) || 0) : null } : {}) }, o.id ? 'Saved' : 'Division added');
  }, () => act('DELETE', CA(`/programs/${encodeURIComponent(o.id)}`), undefined, 'Division deleted'));
  // Spots only matter while the program is open.
  const f = $('dlg').querySelector('form'), sync = () => {
    const open = f.querySelector('[name=mode]:checked').value === 'open';
    f.querySelectorAll('[data-show=open]').forEach((x) => (x.hidden = !open));
    const p = f.querySelector('[data-show=protect]'); if (p) p.hidden = !f.elements.protect.checked;
  };
  f.addEventListener('change', sync); sync();
}

function itemDialog(i) {
  editDialog(`<form class="dlg"><h2>${i.id ? esc(i.name) : 'New fee'}</h2>
    ${fld('Name', `<input type="text" name="name" value="${esc(i.name)}" required>`)}
    ${fld('Description', `<input type="text" name="description" value="${esc(i.description)}" placeholder="Optional — shown to families">`)}
    <div class="fld2">${fld('Price per player', `<div class="prefix"><span>$</span><input type="number" name="price" value="${(i.price_cents / 100).toFixed(2)}" step="0.01" min="0" required></div>`)}
      ${fld('Most per player', `<input type="number" name="max" value="${i.max_qty}" min="1" max="99">`, '1 = a checkbox')}</div>
    <fieldset class="fld radios"><legend>Families</legend>
      <label class="chk"><input type="radio" name="req" value="1" ${i.required ? 'checked' : ''}> <span><b>Must pay it</b> <small>Added to every player automatically.</small></span></label>
      <label class="chk"><input type="radio" name="req" value="0" ${i.required ? '' : 'checked'}> <span><b>Can choose it</b> <small>An optional add-on.</small></span></label></fieldset>
    ${progChecks(i.offering_ids, 'Charged for')}
    ${fld('Tag', `<input type="text" name="tag" value="${esc(i.tag)}" placeholder="Optional, e.g. volunteer-exempt">`, 'Follows the purchase onto the kid’s record and the export.')}
    <label class="chk"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> Offered on the form</label>
    ${footer(i.id && 'Delete fee')}</form>`, (f) => {
    const v = (n) => f.elements[n].value, req = f.querySelector('[name=req]:checked').value === '1';
    return act(i.id ? 'PATCH' : 'POST', CA(i.id ? `/items/${encodeURIComponent(i.id)}` : '/items'), { name: v('name'), description: v('description'), price_cents: Math.round(parseFloat(v('price') || '0') * 100), required: req, max_qty: req ? 1 : Math.max(1, parseInt(v('max'), 10) || 1), offering_ids: checkedProgs(f), tag: v('tag').trim(), active: f.elements.active.checked }, i.id ? 'Saved' : 'Fee added');
  }, () => act('DELETE', CA(`/items/${encodeURIComponent(i.id)}`), undefined, 'Fee deleted'));
}

function questionDialog(q) {
  editDialog(`<form class="dlg"><h2>${q.id ? '' : 'New '}${q.scope === 'player' ? 'player' : 'family'} question</h2>
    ${fld('Question', `<input type="text" name="label" value="${esc(q.label)}" required>`)}
    ${fld('Help text', `<input type="text" name="help" value="${esc(q.help)}" placeholder="Optional — shown under the question">`)}
    <div class="fld2">${fld('Answer type', `<select name="type">${Object.entries(QTYPES).map(([k, v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}
      ${fld('Asked', `<select name="scope"><option value="player" ${q.scope === 'player' ? 'selected' : ''}>For each player</option><option value="family" ${q.scope === 'family' ? 'selected' : ''}>Once per family</option></select>`)}</div>
    <div data-show="choices">${fld('Choices', `<textarea name="options" rows="4">${esc(q.options.join('\n'))}</textarea>`, 'One per line.')}</div>
    <label class="chk" data-show="required"><input type="checkbox" name="required" ${q.required ? 'checked' : ''}> Required</label>
    <label class="chk" data-show="player"><input type="checkbox" name="new_only" ${q.new_only ? 'checked' : ''}> <span>New players only <small>Skipped when the family confirms the player played last season.</small></span></label>
    <div data-show="player">${progChecks(q.offering_ids, 'Asked for')}</div>
    <label class="chk"><input type="checkbox" name="active" ${q.active ? 'checked' : ''}> Asked on the form</label>
    ${footer(q.id && 'Delete question')}</form>`, (f) => {
    const v = (n) => f.elements[n].value, player = v('scope') === 'player';
    if (['select', 'multi'].includes(v('type')) && !v('options').trim()) { toast('List the choices, one per line', true); return null; }
    return act(q.id ? 'PATCH' : 'POST', CA(q.id ? `/questions/${encodeURIComponent(q.id)}` : '/questions'), { scope: v('scope'), label: v('label'), help: v('help'), type: v('type'),
      options: v('options').split(/\n|,(?=\s)/).map((s) => s.trim()).filter(Boolean), required: f.elements.required.checked, new_only: player && f.elements.new_only.checked,
      offering_ids: player ? checkedProgs(f) : [], active: f.elements.active.checked, sort: q.sort }, q.id ? 'Saved' : 'Question added');
  }, () => act('DELETE', CA(`/questions/${encodeURIComponent(q.id)}`), undefined, 'Question deleted'));
  // Show only what applies to the chosen type and scope.
  const f = $('dlg').querySelector('form');
  const sync = () => {
    const type = f.elements.type.value, player = f.elements.scope.value === 'player';
    f.querySelector('[data-show=choices]').hidden = !['select', 'multi'].includes(type);
    f.querySelector('[data-show=required]').hidden = type === 'agreement';
    f.querySelectorAll('[data-show=player]').forEach((x) => (x.hidden = !player));
  };
  f.addEventListener('change', sync); sync();
}

function planDialog() {
  const c = CS.data.campaign, ex = sampleTotal();
  editDialog(`<form class="dlg"><h2>Payment plan</h2>
    ${fld('Offer', `<select name="n"><option value="0">No payment plan — pay in full</option>${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${c.plan_installments === n ? 'selected' : ''}>${n} payments</option>`).join('')}</select>`)}
    <div data-show="on"><div class="fld2">${fld('Last payment by', `<input type="date" name="final" value="${esc(c.plan_final_date || '')}">`)}
      ${fld('Only for totals of at least', `<div class="prefix"><span>$</span><input type="number" name="min" min="0" step="1" value="${Math.round((c.plan_min_cents || 0) / 100)}"></div>`, '0 = any total')}</div>
      <div class="planex" id="planEx"></div></div>
    ${footer()}</form>`, (f) => {
    const n = +f.elements.n.value;
    if (n && !f.elements.final.value) { toast('Pick the date the last payment is due', true); return null; }
    return act('PATCH', CA(), { name: c.name, plan_installments: n, plan_final_date: n ? f.elements.final.value : null, plan_min_cents: Math.round(+f.elements.min.value * 100) || 0 }, n ? 'Payment plan saved' : 'Payment plan turned off');
  });
  const f = $('dlg').querySelector('form');
  const sync = () => {
    const n = +f.elements.n.value, s = planPreview(ex, n, f.elements.final.value);
    f.querySelector('[data-show=on]').hidden = !n;
    $('planEx').innerHTML = !n ? '' : !f.elements.final.value ? '<p class="note">Pick the last payment date to see the schedule.</p>'
      : s ? `<p class="note">One player at ${cash(ex)}, registering today:</p><table class="kt sched">${s.map((x, k) => `<tr><td>${k === 0 ? 'Today, at checkout' : esc(dayLocal(x.due))}</td><td class="num">${dollars(x.cents)}</td></tr>`).join('')}</table>`
      : f.elements.final.value <= new Date().toLocaleDateString('en-CA') ? '<p class="warn-text">That date has already passed — pick a date in the future.</p>'
      : '<p class="warn-text">Too close — payments need to be at least a week apart. Pick a later date or fewer payments.</p>';
  };
  f.addEventListener('input', sync); sync();
}

function newDialog() {
  openDialog(`<form class="dlg" id="ncf"><h2>New registration</h2>
    ${fld('Name', '<input type="text" id="ncName" required placeholder="e.g. 2027 Spring">')}
    <fieldset class="fld radios"><legend>Type</legend>${Object.entries(KINDS).map(([k, [l, h]], i) => `<label class="chk"><input type="radio" name="nckind" value="${k}" ${i ? '' : 'checked'}> <span><b>${l}</b> <small>${h}</small></span></label>`).join('')}</fieldset>
    ${fld('Season', `<select id="ncSeason"><option value="">None — standalone (summer team, fall league)</option>${S.st.seasons.map((s) => `<option value="${esc(s.id)}" ${s.id === S.st.current ? 'selected' : ''}>${s.year}</option>`).join('')}</select>`)}
    <p class="note">It starts as a draft with the season’s divisions, a $200 registration fee, the $5 LFUCG fee, an optional $60 value card, and starter questions on experience, volunteering and the waiver — change anything before opening it.</p>
    <p class="err-text" id="ncErr"></p>
    <div class="row dlgfoot"><button class="btn primary" type="submit">Create</button><button class="btn" data-close>Cancel</button></div></form>`, (dl) => {
    dl.querySelector('#ncf').onsubmit = async (e) => {
      e.preventDefault();
      try { const c = await call('POST', '/api/admin/campaigns', { name: dl.querySelector('#ncName').value, season_id: dl.querySelector('#ncSeason').value || null, kind: dl.querySelector('[name=nckind]:checked').value }); CS.id = c.id; CS.section = 'details'; toast('Registration created as a draft'); dl.close(); loadCampaigns(); }
      catch (err) { dl.querySelector('#ncErr').textContent = err.message; }
    };
  });
}

function statusDialog(to) {
  const c = CS.data.campaign, d = CS.data, url = new URL(d.url, location.origin).href;
  const opening = to === 'open';
  openDialog(`<form class="dlg"><h2>${opening ? `Open ${esc(c.name)}?` : `Close ${esc(c.name)}?`}</h2>
    ${opening ? `<p>Families will be able to register and pay at <b>${esc(url.replace(/^https?:\/\//, ''))}</b>.</p>
      ${d.stripe === 'test' ? '<p class="warn-text">Stripe is still in test mode — families can’t actually pay until the league switches to live keys.</p>' : ''}
      ${!d.offerings.some((o) => o.reg_mode !== 'closed') ? '<p class="err-text">No divisions are open yet.</p>' : ''}`
      : '<p>Families will see that registration is closed. Waitlist offers you’ve already sent keep working.</p>'}
    <div class="row dlgfoot"><button class="btn primary" type="submit">${opening ? 'Open registration' : 'Close registration'}</button><button class="btn" data-close>Cancel</button></div></form>`, (dl) => {
    dl.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      if (await act('PATCH', CA(), { name: c.name, status: to }, opening ? 'Registration is open' : 'Registration closed')) { dl.close(); loadCampaigns(); }
    };
  });
}

/* Swap a question with its neighbor (renumbering the group so the order is unambiguous). */
async function moveQuestion(id, dir) {
  const q = CS.data.questions.find((x) => x.id === id);
  const qs = CS.data.questions.filter((x) => x.scope === q.scope).sort((a, b) => a.sort - b.sort);
  const i = qs.indexOf(q), j = i + dir;
  if (j < 0 || j >= qs.length) return;
  [qs[i], qs[j]] = [qs[j], qs[i]];
  const body = (x, sort) => ({ scope: x.scope, label: x.label, help: x.help, type: x.type, options: x.options, required: !!x.required, new_only: !!x.new_only, offering_ids: x.offering_ids, active: !!x.active, sort });
  try { for (const [k, x] of qs.entries()) if (x.sort !== k + 1) await call('PATCH', CA(`/questions/${encodeURIComponent(x.id)}`), body(x, k + 1)); }
  catch (e) { toast(e.message, true); }
  loadCampaigns();
}

/* ---------- events ---------- */
$('campSel').onchange = (e) => { CS.id = e.target.value; CS.data = null; loadCampaigns(); };
$('newCamp').onclick = newDialog;

$('campEditor').addEventListener('click', async (e) => {
  const t = e.target.closest('button,a,[data-kid]'); if (!t) return;
  if (t.matches('[data-note]')) return openNote(t.closest('td'));
  if (t.matches('[data-notesave],[data-notecancel]')) return saveNote(t.closest('td'), t.matches('[data-notesave]'));
  const sec = t.dataset.sec;
  if (sec) {
    CS.section = sec;
    try { localStorage.setItem('league-reg-section', sec); } catch { /* private mode */ }
    document.querySelectorAll('.secnav [data-sec]').forEach((b) => b.setAttribute('aria-selected', b.dataset.sec === sec));
    $('regSection').innerHTML = sectionHtml(sec);
    if (sec === 'orders') renderOrders();
    return;
  }
  const a = t.dataset.act, id = t.dataset.id, d = CS.data;
  if (a === 'new') return newDialog();
  if (a === 'status') return statusDialog(t.dataset.to);
  if (a === 'copyurl') { navigator.clipboard?.writeText(t.dataset.url).then(() => toast('Link copied'), () => prompt('Copy this:', t.dataset.url)); return; }
  if (a === 'details') return detailsDialog();
  if (a === 'plan') return planDialog();
  if (a === 'editProg') return programDialog(d.offerings.find((x) => x.id === id));
  if (a === 'editItem') return itemDialog(d.items.find((x) => x.id === id));
  if (a === 'editQ') return questionDialog(d.questions.find((x) => x.id === id));
  if (a === 'moveQ') return moveQuestion(id, +t.dataset.dir);
  if (a === 'fromSeason') { if (await act('POST', CA('/programs-from-season'), {}, 'Divisions added')) loadCampaigns(); return; }
  // "Add" opens an empty form; nothing is created until Save.
  if (a === 'addProg') return programDialog({ id: null, name: '', description: '', division_id: null, min_age: null, max_age: null, capacity: null, reg_mode: 'open', when_full: 'waitlist', protect_at: null, guard: null });
  if (a === 'addItem') return itemDialog({ id: null, name: '', description: '', price_cents: 0, required: false, max_qty: 1, offering_ids: [], tag: '', active: true });
  if (a === 'addQ') {
    const scope = t.dataset.scope, last = Math.max(0, ...d.questions.filter((x) => x.scope === scope).map((x) => x.sort));
    return questionDialog({ id: null, scope, label: '', help: '', type: 'text', options: [], required: false, new_only: false, offering_ids: [], active: true, sort: last + 1 });
  }
  if (a === 'markShown') {
    const ids = shownOrders().filter((o) => o.status === 'paid' && !o.se_synced_at).map((o) => o.id);
    if (!ids.length) return toast('No paid orders here that still need marking');
    if (await act('POST', CA('/orders/synced'), { ids, on: true })) loadCampaigns();
    return;
  }
  if (t.dataset.kid) return showKid(t.dataset.kid);
  if (t.dataset.offer) return offerDialog(t);
  if (t.dataset.copy) { navigator.clipboard?.writeText(t.dataset.copy).then(() => toast('Pay link copied')); return; }
  if (t.dataset.remove) {
    if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Remove?'; return; }
    if (await act('POST', CA(`/players/${encodeURIComponent(t.dataset.remove)}/remove`), {})) loadCampaigns();
  }
});
$('campEditor').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'ordFilter') { CS.filter = t.value; return renderOrders(); }
  const ord = t.closest('[data-ord]');
  if (ord && t.matches('[data-synced]')) { if (await act('POST', CA('/orders/synced'), { ids: [ord.dataset.ord], on: t.checked })) loadCampaigns(); return; }
});
