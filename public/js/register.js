/* Public registration form for one campaign (/register/<slug>).
   Families add players, pick each player's program (only the ones their age
   fits), choose items, answer the questions, then pay on Stripe's hosted
   checkout. The server re-checks everything; this file just builds the form,
   keeps a draft in the browser in case they come back, and shows the total. */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
const DRAFT = `reg-draft-${slug}`;
let C = null, nextId = 1, payPlan = false;

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null; try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || `Something went wrong (${r.status})`);
  return data;
}

/** League age: age on the cutoff month-day of the season year. */
function leagueAge(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || ''); if (!m) return null;
  const [cm, cd] = C.campaign.ageCutoff.split('-').map(Number);
  let age = C.campaign.year - +m[1];
  if (+m[2] > cm || (+m[2] === cm && +m[3] > cd)) age--;
  return age;
}
const fits = (o, age) => age != null && (o.min_age == null || age >= o.min_age) && (o.max_age == null || age <= o.max_age);
const applies = (x, offeringId) => !x.offering_ids.length || x.offering_ids.includes(offeringId);
/* Full for this player? A returner the family confirmed already holds a seat in their program. */
function fullFor(o, returnerMatch) { return o.full && !(returnerMatch && returnerMatch.seatOfferingId === o.id); }
// Full, and the league isn't keeping a waitlist for it: this player can't register for it.
function shutFor(o, returnerMatch) { return fullFor(o, returnerMatch) && o.waitlist === false; }
const matchOf = (sec) => sec._matches?.find((m) => m.id === sec._returning);

/* ---------- questions ---------- */
function questionHtml(q, name, val) {
  const req = q.required ? ' <span aria-hidden="true" style="color:var(--stitch)">*</span>' : '';
  const help = q.help ? `<small>${esc(q.help)}</small>` : '';
  const id = `${name}`;
  switch (q.type) {
    case 'textarea': return `<label><span>${esc(q.label)}${req}</span>${help}<textarea name="${id}" rows="2">${esc(val)}</textarea></label>`;
    case 'number': return `<label><span>${esc(q.label)}${req}</span>${help}<input type="number" name="${id}" value="${esc(val)}"></label>`;
    case 'date': return `<label><span>${esc(q.label)}${req}</span>${help}<input type="date" name="${id}" value="${esc(val)}"></label>`;
    case 'yesno': return `<fieldset class="choice" style="border:0;padding:0;margin:0"><legend style="font-weight:600;font-size:.88rem;padding:0">${esc(q.label)}${req}</legend>${help}
      ${['Yes', 'No'].map((o) => `<label><input type="radio" name="${id}" value="${o}" ${val === o ? 'checked' : ''}> ${o}</label>`).join('')}</fieldset>`;
    case 'select': return `<label><span>${esc(q.label)}${req}</span>${help}<select name="${id}"><option value="">Choose…</option>${q.options.map((o) => `<option ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    case 'multi': return `<fieldset class="choice" style="border:0;padding:0;margin:0"><legend style="font-weight:600;font-size:.88rem;padding:0">${esc(q.label)}${req}</legend>${help}
      ${q.options.map((o) => `<label><input type="checkbox" name="${id}" value="${esc(o)}" ${Array.isArray(val) && val.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</fieldset>`;
    case 'agreement': return `<label class="agree"><input type="checkbox" name="${id}" ${val === true ? 'checked' : ''}> <span>${esc(q.label)}${req}${help ? `<br>${help}` : ''}</span></label>`;
    default: return `<label><span>${esc(q.label)}${req}</span>${help}<input type="text" name="${id}" value="${esc(val)}"></label>`;
  }
}
function readQuestion(scope, q, name) {
  const els = [...scope.querySelectorAll(`[name="${CSS.escape(name)}"]`)];
  if (!els.length) return undefined;
  if (q.type === 'multi') return els.filter((e) => e.checked).map((e) => e.value);
  if (q.type === 'yesno') return els.find((e) => e.checked)?.value ?? '';
  if (q.type === 'agreement') return els[0].checked;
  return els[0].value.trim();
}

/* ---------- players ---------- */
function playerCard(d = {}) {
  const pid = nextId++;
  const sec = document.createElement('section');
  sec.className = 'regsec player'; sec.dataset.pid = pid;
  sec.innerHTML = `<button type="button" class="phead" data-toggle aria-expanded="true">
      <span class="pnum" aria-hidden="true"></span>
      <span class="pinfo"><b class="ptitle">New player</b><span class="pmeta"></span></span>
      <span class="pstate"></span><span class="pamt"></span><span class="chev" aria-hidden="true"></span>
    </button>
    <div class="pbody">
    <div class="fields">
      <label>First name<input type="text" name="first" value="${esc(d.firstName)}" required></label>
      <label>Last name<input type="text" name="last" value="${esc(d.lastName)}" required></label>
      <label>Birthdate<input type="date" name="dob" value="${esc(d.birthdate)}" required><small class="agehint"></small></label>
      <label>Gender<select name="gender"><option value="">Choose…</option>${['Boy', 'Girl'].map((g) => `<option ${d.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
    </div>
    <div class="returning" aria-live="polite"></div>
    <div class="siblings" aria-live="polite"></div>
    <div class="programs"></div>
    <div class="items"></div>
    <div class="qs pqs"></div>
    <p class="pmissing err-text" role="alert"></p>
    <div class="pactions"><button type="button" class="btn primary" data-done>Done with this player</button><button type="button" class="linkbtn danger" data-remove>Remove player</button></div>
    </div>`;
  sec._saved = d;
  sec._returning = d.returning || '';
  $('players').append(sec);
  openCard(sec);
  renderPlayer(sec);
  lookupReturning(sec);
  return sec;
}

/* Did this player play last season? Look them up once the name and birthdate are in,
   and have the family confirm it's the same kid (or say they're new). */
async function lookupReturning(sec) {
  const first = sec.querySelector('[name=first]').value.trim(), last = sec.querySelector('[name=last]').value.trim(), dob = sec.querySelector('[name=dob]').value;
  const key = `${first}|${last}|${dob}`;
  if (key === sec._lookedUp) return;
  sec._lookedUp = key;
  // A date box reports half-typed years ("0201-05-22"), so wait for a real birthdate of a player-aged kid.
  const age = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(dob) ? leagueAge(dob) : null;
  if (!first || !last || age == null || age < 2 || age > 20) { sec._matches = []; sec._pendingAsk = false; return renderReturning(sec); }
  const r = await call('GET', `/api/register/${encodeURIComponent(slug)}/returning?${new URLSearchParams({ first, last, dob })}`).catch(() => ({ matches: [] }));
  if (sec._lookedUp !== key) return; // they kept typing
  sec._matches = r.matches;
  if (sec._returning && sec._returning !== 'new' && !r.matches.some((m) => m.id === sec._returning)) sec._returning = '';
  renderReturning(sec);
  pickSuggested(sec);
  lookupSiblings(sec);
  renderSummary();
  // Ask once per name + birthdate; if they close it, the card keeps asking.
  sec._pendingAsk = !!r.matches.length && !sec._returning && sec._asked !== key;
  if (sec._pendingAsk) sec._askKey = key;
  maybeAsk(sec);
}
/* Don't interrupt typing: ask once they've left the name and birthdate fields (or paused on a complete birthdate). */
function maybeAsk(sec) {
  clearTimeout(sec._askT);
  if (!sec._pendingAsk || $('retDlg')?.open || !sec.isConnected) return;
  const a = document.activeElement;
  if (a && sec.contains(a) && a.matches('[name=first],[name=last]')) return;
  if (a && sec.contains(a) && a.matches('[name=dob]')) { sec._askT = setTimeout(() => maybeAsk2(sec), 1200); return; }
  maybeAsk2(sec);
}
function maybeAsk2(sec) {
  if (!sec._pendingAsk || $('retDlg')?.open || !sec.isConnected) return;
  const a = document.activeElement;
  if (a && sec.contains(a) && a.matches('[name=first],[name=last]')) return;
  sec._pendingAsk = false; sec._asked = sec._askKey;
  askReturning(sec);
}
/* A confirmed returner usually goes back to the program they're expected in: pick it if nothing is picked yet. */
function pickSuggested(sec) {
  const m = matchOf(sec);
  const radio = m?.suggestOfferingId && sec.querySelector(`[data-program][value="${CSS.escape(m.suggestOfferingId)}"]`);
  if (radio && !sec.querySelector('[data-program]:checked')) { radio.checked = true; renderPlayer(sec); renderSummary(); }
}

/* Brothers and sisters: once a player is confirmed as a returner, and the parent's email or phone is
   one we have for them, offer the other kids in the family who played last season. */
const lookupLater = (fn, sec, ms = 450) => { clearTimeout(sec._t?.[fn.name]); (sec._t ||= {})[fn.name] = setTimeout(() => fn(sec), ms); };
async function lookupSiblings(sec) {
  if (!isReturner(sec)) { sec._siblings = []; return drawSiblings(); }
  const f = $('form').elements, v = (n) => sec.querySelector(`[name=${n}]`).value.trim();
  const body = { first: v('first'), last: v('last'), dob: v('dob'), email: f.gEmail.value.trim(), phone: f.gPhone.value.trim() };
  const key = JSON.stringify(body);
  if (key === sec._sibKey) return drawSiblings();
  sec._sibKey = key;
  if (!body.email && !body.phone) { sec._siblings = []; return drawSiblings(); }
  const r = await call('POST', `/api/register/${encodeURIComponent(slug)}/siblings`, body).catch(() => ({ siblings: [] }));
  if (sec._sibKey !== key) return;
  sec._siblings = r.siblings || [];
  drawSiblings();
}
const onForm = (s) => [...document.querySelectorAll('.player')].some((p) => p._returning === s.kidId
  || (p.querySelector('[name=dob]').value === s.birthdate && p.querySelector('[name=first]').value.trim().toLowerCase() === s.firstName.toLowerCase()));
function drawSiblings() {
  // One family-level offer, right above "Add another player" — not tucked inside a card that may be collapsed.
  let box = $('sibOffer');
  if (!box) { box = document.createElement('div'); box.id = 'sibOffer'; box.setAttribute('aria-live', 'polite'); $('addPlayer').before(box); }
  const seen = new Set(), list = [];
  for (const sec of document.querySelectorAll('.player')) for (const x of sec._siblings || []) {
    if (seen.has(x.kidId) || onForm(x)) continue;
    seen.add(x.kidId); list.push({ ...x, of: sec.querySelector('[name=first]').value.trim() });
  }
  const open = list.filter((x) => !x.registered);
  // A pointer in each card that found them, since the offer can sit below a long card.
  for (const sec of document.querySelectorAll('.player')) {
    const mine = open.filter((x) => (sec._siblings || []).some((y) => y.kidId === x.kidId));
    sec.querySelector('.siblings').innerHTML = mine.length ? `<button type="button" class="sibjump" data-sibjump>+ ${mine.map((x) => esc(x.firstName)).join(' and ')} played too — add them in one tap ↓</button>` : '';
  }
  if (!list.length) { box.innerHTML = ''; return; }
  const of = [...new Set(list.map((x) => x.of))].join(' and ');
  const initials = (x) => esc(`${x.firstName[0] || ''}${x.lastName[0] || ''}`);
  box.innerHTML = `<section class="siboffer">
    <div class="sibhead"><div><p class="reyebrow">Same family</p>
      <h3>${open.length ? `Registering ${open.map((x) => esc(x.firstName)).join(' and ')} too?` : `${esc(of)}’s ${list.length === 1 ? 'brother or sister is' : 'brothers and sisters are'} already registered`}</h3>
      <p class="sub">${open.length ? `We found ${list.length === 1 ? 'a brother or sister' : 'brothers and sisters'} of ${esc(of)} who played in ${list[0].year}. Add them with one tap — we’ll fill in what we know.` : ''}</p></div>
      ${open.length > 1 ? `<button type="button" class="btn primary" data-addsib="*">Add all ${open.length}</button>` : ''}</div>
    <div class="sibcards">${list.map((x) => `<div class="sibcard ${x.registered ? 'done' : ''}">
      <span class="rcap" aria-hidden="true">${initials(x)}</span>
      <span class="rwho"><b>${esc(x.firstName)} ${esc(x.lastName)}</b><span>${x.division ? esc(x.division) : 'Played'}${x.team ? ` · ${esc(x.team)}` : ''} in ${x.year}</span></span>
      ${x.registered ? `<span class="sibreg">✓ Registered for ${C.campaign.year}</span>` : `<button type="button" class="btn ${open.length > 1 ? '' : 'primary'}" data-addsib="${esc(x.kidId)}">+ Add ${esc(x.firstName)}</button>`}</div>`).join('')}</div>
  </section>`;
}
const redrawSiblings = () => drawSiblings();
const isReturner = (sec) => !!sec._returning && sec._returning !== 'new';
function renderReturning(sec) {
  const was = isReturner(sec);
  drawReturning(sec);
  // No longer a confirmed returner (name changed): bring back the new-player questions.
  if (was !== isReturner(sec)) { renderPlayer(sec); renderSummary(); }
}
function drawReturning(sec) {
  const box = sec.querySelector('.returning'), ms = sec._matches || [];
  const prior = C.campaign.year - 1, first = sec.querySelector('[name=first]').value.trim() || 'this player';
  if (!ms.length) {
    sec._returning = '';
    box.innerHTML = sec._lookedUp && sec._lookedUp.split('|').every(Boolean) ? `<p class="note">New player — welcome! We didn’t find them on a ${prior} roster.</p>` : '';
    return;
  }
  const m = matchOf(sec);
  if (m) {
    const where = [m.division, m.team].filter(Boolean).map(esc).join(' · ');
    box.innerHTML = `<div class="rbanner yes" role="status"><span class="rcheck" aria-hidden="true">✓</span>
      <div><b>Welcome back, ${esc(first)}!</b><span>${where ? `${where} in ${m.year}. ` : ''}${m.dobDiffers ? 'We’ll update the birthdate on file.' : 'We picked their program and skipped the new-player questions.'}</span></div>
      <button type="button" class="linkbtn" data-askret>Not ${esc(first)}? Change</button></div>`;
  } else if (sec._returning === 'new') {
    box.innerHTML = `<div class="rbanner" role="status"><div><b>New player — welcome!</b></div><button type="button" class="linkbtn" data-askret>Change</button></div>`;
  } else {
    box.innerHTML = `<div class="rbanner ask"><span class="rq" aria-hidden="true">?</span>
      <div><b>${ms.length === 1 ? `Did ${esc(first)} play with us in ${prior}?` : `We found more than one ${esc(first)} from ${prior}`}</b><span>Returning players keep their spot — tell us so we can hold it.</span></div>
      <button type="button" class="btn primary" data-askret>Answer</button></div>`;
  }
}

/* The question, asked properly: a dialog as soon as we find them on last season's roster. */
function askReturning(sec) {
  const ms = sec._matches || [];
  if (!ms.length) return;
  const prior = C.campaign.year - 1, first = sec.querySelector('[name=first]').value.trim() || 'this player';
  let dlg = $('retDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'retDlg'; dlg.className = 'retdlg'; document.body.append(dlg); }
  const card = (m, asButton) => {
    const tag = asButton ? 'button' : 'div';
    return `<${tag} ${asButton ? `type="button" data-ans="${esc(m.id)}"` : ''} class="rcard">
      <span class="rcap" aria-hidden="true">${esc(m.name.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</span>
      <span class="rwho"><b>${esc(m.name)}</b><span>${m.division ? esc(m.division) : `Played in ${m.year}`}</span></span>
      ${m.team ? `<span class="rteam">${esc(m.team)}</span>` : ''}<span class="ryear">${m.year}</span></${tag}>`;
  };
  const m0 = ms[0];
  let body;
  if (ms.length === 1 && m0.dobDiffers) {
    body = `<p class="reyebrow">Welcome back?</p><h2 id="retTitle">Did ${esc(first)} play with us in ${prior}?</h2>
      <p class="rlead">We have a <b>${esc(m0.name)}</b> from ${prior}, but with a different birthdate. If the birthdate you entered is right, choose Yes and we’ll fix our records.</p>
      <div class="ractions"><button type="button" class="btn primary big" data-ans="${esc(m0.id)}">Yes, same player</button>
      <button type="button" class="btn" data-checkdob>Let me check the birthdate</button>
      <button type="button" class="linkbtn" data-ans="new">No — this is a new player</button></div>`;
  } else if (ms.length === 1) {
    body = `<p class="reyebrow">Welcome back?</p><h2 id="retTitle">Is this ${esc(first)}?</h2>
      <p class="rlead">We found this player on our ${prior} rosters${m0.name.split(' ')[0].toLowerCase() !== first.toLowerCase() ? ` — listed as <b>${esc(m0.name.split(' ')[0])}</b>` : ''}.</p>${card(m0, false)}
      <p class="rnote">Say yes and they keep their returning spot — we’ll pick their program and skip the new-player questions.</p>
      <div class="ractions"><button type="button" class="btn primary big" data-ans="${esc(m0.id)}">Yes, that’s ${esc(first)}</button>
      <button type="button" class="btn" data-ans="new">No — a different player</button></div>`;
  } else {
    body = `<p class="reyebrow">Welcome back?</p><h2 id="retTitle">Which one is ${esc(first)}?</h2>
      <p class="rlead">We found more than one match on our ${prior} rosters. Tap your player.</p>
      <div class="rcards">${ms.map((m) => card(m, true)).join('')}</div>
      <div class="ractions"><button type="button" class="btn" data-ans="new">None of these — a new player</button></div>`;
  }
  dlg.setAttribute('aria-labelledby', 'retTitle');
  dlg.innerHTML = `<div class="dlg">${body}</div>`;
  dlg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-checkdob')) { dlg.close(); sec.querySelector('[name=dob]').focus(); return; }
    if (b.dataset.ans) { dlg.close(); answerReturning(sec, b.dataset.ans); }
  };
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.btn.primary, .rcard')?.focus();
}

/* Yes: take their program (the one holding their seat, else the one their age points to), drop the
   new-player questions, then put them on the first thing still needed and say what's left. */
function answerReturning(sec, value) {
  sec._returning = value;
  const m = matchOf(sec);
  renderPlayer(sec);
  if (m) {
    const want = m.seatOfferingId || m.suggestOfferingId;
    const radio = want && sec.querySelector(`[data-program][value="${CSS.escape(want)}"]`);
    if (radio) { radio.checked = true; renderPlayer(sec); }
  }
  drawReturning(sec);
  lookupSiblings(sec);
  redrawSiblings();
  renderSummary();
  const need = missing(sec);
  const next = !sec.querySelector('[name=gender]').value ? sec.querySelector('[name=gender]')
    : sec.querySelector('.pqs :is(select,input,textarea):not([type=hidden])');
  if (m && need.length) {
    const note = document.createElement('p');
    note.className = 'rleft';
    note.textContent = `Just ${need.length === 1 ? 'one thing' : 'a few things'} left for ${sec.querySelector('[name=first]').value.trim()}: ${need.join(', ')}.`;
    sec.querySelector('.returning .rbanner')?.after(note);
  }
  next?.focus();
}
function renderPlayer(sec) {
  const d = sec._saved || {};
  const dob = sec.querySelector('[name=dob]').value, age = leagueAge(dob);
  sec.querySelector('.agehint').textContent = age != null ? `League age ${age} for ${C.campaign.year}` : '';
  const first = sec.querySelector('[name=first]').value.trim();
  const ok = C.offerings.filter((o) => fits(o, age));
  const cur = sec.querySelector('[name=program]:checked')?.value || d.offeringId;
  const prog = sec.querySelector('.programs');
  prog.innerHTML = age == null ? '<p class="note">Enter a birthdate to see the programs this player can join.</p>'
    : ok.length ? `<b style="font-size:.88rem">Program</b>${ok.map((o) => `<label><input type="radio" name="program-${sec.dataset.pid}" data-program value="${esc(o.id)}" ${o.id === cur || ok.length === 1 ? 'checked' : ''}>
        <span><b>${esc(o.name)} ${shutFor(o, matchOf(sec)) ? '<span class="pill wait">Full</span>' : fullFor(o, matchOf(sec)) ? `<span class="pill wait">${o.protected ? 'Waitlist' : 'Full — waitlist'}</span>` : o.left != null && o.left <= 5 ? `<span class="pill wait">${o.left} left</span>` : ''}</b>${o.description ? `<span class="sub">${esc(o.description)}</span>` : ''}</span></label>`).join('')}`
      : `<p class="err-text">No ${C.campaign.year} program fits league age ${age}.</p>`;
  const offeringId = sec.querySelector('[data-program]:checked')?.value;
  const offering = C.offerings.find((o) => o.id === offeringId);
  // Say it plainly the moment we know: full, but they can still sign up and pay nothing today.
  const shut = offering && shutFor(offering, matchOf(sec));
  if (shut) prog.insertAdjacentHTML('beforeend', `<div class="warnbox waitnote" role="alert"><b>${esc(offering.name)} is full for ${C.campaign.year}.</b>
    We’re not taking more registrations for it right now. Please contact the league if you have questions.</div>`);
  const waits = offering && !shut && fullFor(offering, matchOf(sec));
  if (waits && offering.protected) prog.insertAdjacentHTML('beforeend', `<div class="warnbox waitnote" role="status"><b>${esc(offering.name)} is filling up — you can still sign up.</b>
    We’re holding the remaining spots for returning players right now, so ${esc(first || 'this player')} will join the waitlist. Nothing is charged today. As spots open we’ll email you a link to pay and claim one.</div>`);
  else if (waits) prog.insertAdjacentHTML('beforeend', `<div class="warnbox waitnote" role="status"><b>${esc(offering.name)} is full for ${C.campaign.year} — but you can still sign up.</b>
    ${esc(first || 'This player')} will join the waitlist in the order families register. Nothing is charged today. If a spot opens, we’ll email you a link to pay and claim it.</div>`);
  // Items
  const its = offering ? C.items.filter((i) => applies(i, offering.id)) : [];
  const qty = (i) => { const el = sec.querySelector(`[data-item="${i.id}"]`); return el ? (el.type === 'checkbox' ? (el.checked ? 1 : 0) : +el.value) : (d.items?.[i.id] ?? 0); };
  const prevQ = Object.fromEntries(its.map((i) => [i.id, qty(i)]));
  sec.querySelector('.items').innerHTML = its.length ? `<b style="font-size:.88rem">Fees &amp; add-ons${waits ? ' <span class="sub">(charged only if a spot opens up)</span>' : ''}</b>` + its.map((i) => `<div class="itemrow"><div><b>${esc(i.name)}</b>${i.required ? ' <span class="sub">required</span>' : ''}${i.description ? `<div class="sub">${esc(i.description)}</div>` : ''}</div>
      <div class="row" style="flex-wrap:nowrap">${i.required ? '<span class="sub">×1</span>' : i.max_qty > 1
        ? `<select data-item="${esc(i.id)}" aria-label="${esc(i.name)} quantity">${Array.from({ length: i.max_qty + 1 }, (_, n) => `<option ${prevQ[i.id] === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`
        : `<input type="checkbox" data-item="${esc(i.id)}" aria-label="Add ${esc(i.name)}" ${prevQ[i.id] ? 'checked' : ''}>`}<span class="price">${money(i.price_cents)}${i.max_qty > 1 ? ' each' : ''}</span></div></div>`).join('') : '';
  // Player questions
  // A confirmed returner skips the questions only new players are asked (experience, last team).
  const qs = offering ? C.questions.filter((q) => q.scope === 'player' && applies(q, offering.id) && !(q.new_only && isReturner(sec))) : [];
  const prevA = Object.fromEntries(qs.map((q) => [q.id, readQuestion(sec, q, `pq-${sec.dataset.pid}-${q.id}`) ?? d.answers?.[q.id]]));
  sec.querySelector('.pqs').innerHTML = tryoutHtml(sec, offering, d) + qs.map((q) => questionHtml(q, `pq-${sec.dataset.pid}-${q.id}`, prevA[q.id])).join('');
  sec._saved = null;
}
/* A returning Minors player says whether they'll try out for Majors. Until they answer we assume they are;
   "no" keeps them on their Minors team. */
const asksTryout = (sec, offering) => { const m = matchOf(sec); return !!offering && (offering.tryout || !!(m?.tryoutTeam && offering.id === m.seatOfferingId)); };
function readTryout(sec) { const v = sec.querySelector(`[name=tryout-${sec.dataset.pid}]:checked`)?.value; return v ? v === 'yes' : undefined; }
function tryoutHtml(sec, offering, d) {
  if (!asksTryout(sec, offering)) return '';
  const m = matchOf(sec), v = readTryout(sec) ?? d.tryout, name = `tryout-${sec.dataset.pid}`;
  const first = sec.querySelector('[name=first]').value.trim() || 'this player';
  const stay = m?.tryoutTeam && !offering.tryout ? `stay with the ${esc(m.tryoutTeam)} in Minors` : `play in the ${esc(offering.name)}`;
  return `<fieldset class="choice"><legend>Will ${esc(first)} try out for Majors? <span aria-hidden="true" style="color:var(--stitch)">*</span></legend>
    <label><input type="radio" name="${name}" value="yes" required ${v === true ? 'checked' : ''}> <span>Yes — try out for Majors<span class="sub">${offering.tryout ? 'If not drafted to Majors, they play in the ' + esc(offering.name) + ' (Minors is for ages 10–12).' : 'If not drafted to Majors, they go into the Minors draft.'}</span></span></label>
    <label><input type="radio" name="${name}" value="no" ${v === false ? 'checked' : ''}> <span>No — ${stay}</span></label></fieldset>`;
}
function readPlayer(sec) {
  const offeringId = sec.querySelector('[data-program]:checked')?.value || '';
  const items = {}, answers = {};
  sec.querySelectorAll('[data-item]').forEach((el) => (items[el.dataset.item] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : +el.value));
  for (const q of C.questions.filter((q) => q.scope === 'player')) { const v = readQuestion(sec, q, `pq-${sec.dataset.pid}-${q.id}`); if (v !== undefined) answers[q.id] = v; }
  return { firstName: sec.querySelector('[name=first]').value.trim(), lastName: sec.querySelector('[name=last]').value.trim(), birthdate: sec.querySelector('[name=dob]').value,
    gender: sec.querySelector('[name=gender]').value, offeringId, items, answers, returning: sec._returning || undefined,
    tryout: asksTryout(sec, C.offerings.find((o) => o.id === offeringId)) ? readTryout(sec) : undefined };
}
function readForm() {
  const f = $('form'), v = (n) => f.elements[n].value.trim();
  const answers = {};
  for (const q of C.questions.filter((q) => q.scope === 'family')) { const a = readQuestion($('familyQs'), q, `fq-${q.id}`); if (a !== undefined) answers[q.id] = a; }
  return {
    guardian: { firstName: v('gFirst'), lastName: v('gLast'), email: v('gEmail'), phone: v('gPhone'), address: v('gAddress'), city: v('gCity'), state: v('gState'), zip: v('gZip') },
    answers, players: [...document.querySelectorAll('.player')].map(readPlayer), plan: payPlan,
  };
}

/* ---------- player cards: one open at a time, the rest a one-line summary ---------- */
const cards = () => [...document.querySelectorAll('.player')];
function openCard(sec) {
  for (const p of cards()) {
    const on = p === sec;
    p.classList.toggle('open', on);
    p.querySelector('.phead').setAttribute('aria-expanded', String(on));
  }
}
/** What this player still needs before checkout (the server checks again; this is for the card's status). */
function missing(sec) {
  const p = readPlayer(sec), o = C.offerings.find((x) => x.id === p.offeringId), out = [];
  if (!p.firstName || !p.lastName) out.push('name');
  if (!p.birthdate) out.push('birthdate');
  if (!p.gender) out.push('gender');
  if (sec._matches?.length && !sec._returning) out.push(`whether they played in ${C.campaign.year - 1}`);
  if (!o) { if (p.birthdate) out.push('program'); return out; }
  if (shutFor(o, matchOf(sec))) out.push(`a program with room (${o.name} is full)`);
  if (asksTryout(sec, o) && p.tryout === undefined) out.push('the Majors tryout question');
  for (const q of C.questions.filter((q) => q.scope === 'player' && q.required && applies(q, o.id) && !(q.new_only && isReturner(sec)))) {
    const v = p.answers[q.id];
    if (v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) out.push(q.label.toLowerCase().replace(/[?:]$/, ''));
  }
  return out;
}
function playerCost(sec, p) {
  const o = C.offerings.find((x) => x.id === p.offeringId);
  if (!o) return { o: null, lines: [], total: 0, waits: false };
  if (shutFor(o, matchOf(sec))) return { o, lines: [], total: 0, waits: false, shut: true };
  if (fullFor(o, matchOf(sec))) return { o, lines: [], total: 0, waits: true };
  const lines = [];
  for (const i of C.items.filter((i) => applies(i, o.id))) {
    const q = i.required ? 1 : p.items[i.id] || 0;
    if (q) lines.push({ name: i.name + (q > 1 ? ` ×${q}` : ''), cents: q * i.price_cents });
  }
  return { o, lines, total: lines.reduce((t, l) => t + l.cents, 0), waits: false };
}
function renderHead(sec, n, p, cost) {
  const age = leagueAge(p.birthdate), m = matchOf(sec), need = missing(sec);
  sec.querySelector('.pnum').textContent = n + 1;
  sec.querySelector('.ptitle').textContent = `${p.firstName} ${p.lastName}`.trim() || 'New player';
  const bits = [];
  if (age != null) bits.push(`Age ${age}`);
  if (cost.o) bits.push(esc(cost.o.name));
  if (m) bits.push(m.team ? `Returning · ${esc(m.team)}` : 'Returning');
  else if (sec._returning === 'new' || (Array.isArray(sec._matches) && !sec._matches.length && p.birthdate)) bits.push('New player');
  sec.querySelector('.pmeta').innerHTML = bits.join('<span class="dotsep">·</span>');
  sec.querySelector('.pstate').innerHTML = cost.shut ? '<span class="tag need">Full</span>' : cost.waits ? '<span class="tag wait">Waitlist</span>'
    : need.length ? '<span class="tag need">Needs info</span>' : '<span class="tag ok">Ready</span>';
  sec.querySelector('.pamt').textContent = cost.o ? money(cost.total) : '';
  sec._need = need;
  if (!need.length) sec.querySelector('.pmissing').textContent = '';
}

/* ---------- payment plan: the same schedule the server makes (it checks again at checkout) ---------- */
const dUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const dIso = (t) => new Date(t).toISOString().slice(0, 10);
function addMonthsIso(d, n) {
  const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n, day = +d.slice(8, 10), last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return dIso(Date.UTC(y, m, Math.min(day, last)));
}
function planSchedule(total) {
  const p = C.plan;
  if (!p || total <= 0 || total < (p.minCents || 0)) return null;
  const n = p.installments, start = p.today, span = Math.round((dUtc(p.finalDate) - dUtc(start)) / 864e5);
  if (span < 7 * (n - 1)) return null;
  const base = Math.floor(total / n), first = total - base * (n - 1), monthly = addMonthsIso(start, n - 1) <= p.finalDate;
  const out = [{ due: start, cents: first }];
  for (let k = 1; k < n; k++) out.push({ due: monthly ? addMonthsIso(start, k) : dIso(dUtc(start) + Math.round((span * k) / (n - 1)) * 864e5), cents: base });
  return out;
}
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/* ---------- summary ---------- */
function renderSummary() {
  const data = readForm(), secs = cards();
  let total = 0, waiting = 0;
  const blocks = [], names = [];
  data.players.forEach((p, n) => {
    const sec = secs[n], cost = playerCost(sec, p);
    renderHead(sec, n, p, cost);
    const name = `${p.firstName} ${p.lastName}`.trim() || `Player ${n + 1}`;
    names.push(p.firstName || `Player ${n + 1}`);
    total += cost.total;
    if (cost.waits) waiting++;
    blocks.push(`<li class="sumplayer"><button type="button" class="sumname" data-open="${n}"><b>${esc(name)}</b><span>${cost.o ? (cost.waits ? '$0' : money(cost.total)) : '—'}</span></button>
      <div class="sub">${cost.o ? esc(cost.o.name) : 'Pick a program'}${cost.waits ? ' · <span class="pill wait">waitlist</span>' : ''}${sec._need?.length && !cost.waits ? ' · <span class="needtxt">needs info</span>' : ''}</div>
      ${cost.lines.length ? `<ul class="sumlines">${cost.lines.map((l) => `<li><span>${esc(l.name)}</span><span>${money(l.cents)}</span></li>`).join('')}</ul>` : ''}</li>`);
  });
  const count = data.players.length;
  $('summary').innerHTML = `<ul class="sumlist">${blocks.join('')}</ul>
    <div class="sumtotal"><span id="sumTotalLabel">Total today</span><span>${money(total)}</span></div>
    <div class="sumtotal sumdue" id="sumDue" hidden></div>
    ${waiting ? `<p class="note">Waitlisted players aren’t charged. If a spot opens, we’ll email you a link to pay for it.</p>` : ''}`;
  $('sumCount').textContent = `${count} player${count === 1 ? '' : 's'}`;
  // Pay in full, or split it (when the league offers a plan for this total).
  const sched = planSchedule(total);
  if (!sched) payPlan = false;
  $('payChoice').hidden = !sched;
  if (sched) {
    const rest = sched.slice(1), same = rest.every((x) => x.cents === rest[0].cents);
    const html = `<legend>How would you like to pay?</legend>
      <label><input type="radio" name="payplan" value="full" ${payPlan ? '' : 'checked'}> <span><b>Pay in full — ${money(total)}</b></span></label>
      <label><input type="radio" name="payplan" value="plan" ${payPlan ? 'checked' : ''}> <span><b>${sched.length} payments of ${same ? money(rest[0].cents) : 'about ' + money(rest[0].cents)}</b> — no interest, no fees
        <span class="sub">${money(sched[0].cents)} today, then ${rest.map((x) => `${money(x.cents)} on ${shortDate(x.due)}`).join(', ')}. Charged automatically to the card you use today; we’ll email a reminder before each one.</span></span></label>`;
    if ($('payChoice').dataset.html !== html) { $('payChoice').innerHTML = html; $('payChoice').dataset.html = html; } // don't rebuild under a click
  }
  const now = payPlan && sched ? sched[0].cents : total;
  $('sumTotalLabel').textContent = payPlan && sched ? 'Total' : 'Total today';
  $('sumDue').hidden = !(payPlan && sched);
  if (payPlan && sched) $('sumDue').innerHTML = `<span>Due today (payment 1 of ${sched.length})</span><span>${money(now)}</span>`;
  $('submit').textContent = total > 0 ? `Continue to payment — ${money(now)}${payPlan && sched ? ' today' : ''}` : waiting ? 'Join the waitlist' : 'Register';
  $('payNote').hidden = !(total > 0);
  $('regbarText').innerHTML = `<b>${count} player${count === 1 ? '' : 's'}</b><span class="sub">${esc(names.join(', '))}</span>`;
  $('regbarTotal').textContent = payPlan && sched ? `${money(now)} today` : money(total);
  try { localStorage.setItem(DRAFT, JSON.stringify(data)); } catch { /* private mode */ }
}

/* ---------- boot ---------- */
const PSTATUS = {
  registered: 'registered',
  waitlisted: 'on the waitlist — nothing charged. We’ll email you if a spot opens.',
  offered: 'a spot is open for this player!',
  expired: 'the offer to claim a spot has expired. Please contact the league.',
  cancelled: 'not registered',
};
async function showDone() {
  const qs = new URLSearchParams(location.search);
  $('form').hidden = true; $('done').hidden = false;
  const show = (r) => {
    const ok = r.status === 'paid' || r.status === 'waitlisted';
    $('done').innerHTML = `<section class="regsec"><h2>${r.status === 'paid' ? 'You’re registered!' : r.status === 'waitlisted' ? 'You’re on the waitlist' : r.status === 'pending' ? 'Confirming your payment…' : 'This registration wasn’t completed'}</h2>
      <ul>${r.players.map((p) => `<li><b>${esc(p.name)}</b> — ${esc(p.program)}: ${PSTATUS[p.status] ?? esc(p.status)}${p.pay_url ? ` <a class="btn primary" href="${esc(p.pay_url)}">Pay to claim the spot</a> <span class="sub">by ${esc(p.pay_by)}</span>` : ''}</li>`).join('')}</ul>
      ${r.status === 'paid' && !r.plan ? `<p>Paid ${money(r.total_cents)}. Stripe emails your receipt.</p>` : ''}
      ${r.status === 'paid' && r.plan ? `<p><b>Your payment plan</b>${r.plan.card ? ` — charged to ${esc(r.plan.card)}` : ''}</p>
        <table class="sumtable">${r.plan.installments.map((i) => `<tr><td>${i.seq}. ${esc(shortDate(i.due))}</td><td>${money(i.cents)} <span class="sub">${i.status === 'paid' ? 'paid' : i.status === 'waived' ? 'waived' : 'scheduled'}</span></td></tr>`).join('')}</table>
        <p class="note">We’ll email a reminder a few days before each payment. To pay early or change your card: <a href="${esc(r.plan.pay_url)}">${esc(r.plan.pay_url)}</a></p>` : ''}
      ${ok && r.confirmation ? `<div class="intro">${esc(r.confirmation)}</div>` : ''}
      ${r.status === 'cancelled' ? `<p><a class="btn primary" href="/register/${esc(slug)}">Start again</a></p>` : ''}</section>`;
    if (ok) try { localStorage.removeItem(DRAFT); } catch { /* private */ }
    return r.status;
  };
  for (let i = 0; i < 10; i++) {
    const r = await call('GET', `/api/register/order/${encodeURIComponent(qs.get('order'))}${qs.get('session_id') ? `?session_id=${encodeURIComponent(qs.get('session_id'))}` : ''}`).catch((e) => ({ status: 'error', players: [], error: e.message }));
    if (r.status === 'error') { $('done').innerHTML = `<p class="err-text">${esc(r.error)}</p>`; return; }
    if (show(r) !== 'pending') return;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

(async () => {
  try { C = await call('GET', `/api/register/${encodeURIComponent(slug)}`); }
  catch (e) { $('loading').textContent = e.message; return; }
  document.title = `${C.campaign.name} Registration`;
  $('title').textContent = `${C.campaign.name} Registration`;
  $('loading').hidden = true;
  if (location.pathname.endsWith('/done')) return showDone();
  $('form').hidden = false;
  $('intro').textContent = C.campaign.intro;
  const qs = new URLSearchParams(location.search);
  const notes = [];
  if (C.campaign.closedReason) notes.push(C.campaign.closedReason);
  else if (C.campaign.preview) notes.push('Admin preview: this campaign is still a draft, so families can’t see it yet. Because Stripe is in test mode you can register test players here.');
  if (qs.get('cancelled')) notes.push('Payment was cancelled — nothing was charged. Your answers are still here.');
  if (C.stripe === 'test') notes.push('Test mode: use card 4242 4242 4242 4242, any future date and any CVC. No real money moves.');
  $('notice').hidden = !notes.length; $('notice').innerHTML = notes.map(esc).join('<br>');
  $('submit').disabled = !!C.campaign.closedReason;
  // Say why right where they're looking (an admin previewing a draft campaign sees this too).
  if (C.campaign.closedReason) $('payNote').insertAdjacentHTML('beforebegin', `<p class="err-text">${esc(C.campaign.closedReason)}${C.campaign.preview ? ' You’re seeing an admin preview — open it on the Registration tab to take registrations.' : ''}</p>`);
  const fam = C.questions.filter((q) => q.scope === 'family');
  $('familySec').hidden = !fam.length;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { /* private */ }
  // A personal link from a returning-player email fills in the family and their players.
  if (qs.get('invite')) {
    try {
      const inv = await call('GET', `/api/register/${encodeURIComponent(slug)}/invite/${encodeURIComponent(qs.get('invite'))}`);
      draft = { ...(draft || {}), guardian: { ...(draft?.guardian || {}), ...Object.fromEntries(Object.entries(inv.guardian).filter(([, v]) => v)) },
        players: inv.players.length ? inv.players : draft?.players || [] };
      notes.push(inv.players.length ? 'Welcome back! We’ve filled in your returning players — check the details, pick their program and answer the rest.' : 'Your players are already registered — you can add another player below.');
      $('notice').hidden = false; $('notice').innerHTML = notes.map(esc).join('<br>');
    } catch (e) { notes.push(e.message); $('notice').hidden = false; $('notice').innerHTML = notes.map(esc).join('<br>'); }
  }
  $('familyQs').innerHTML = fam.map((q) => questionHtml(q, `fq-${q.id}`, draft?.answers?.[q.id])).join('');
  if (draft?.guardian) for (const [k, v] of Object.entries({ gFirst: 'firstName', gLast: 'lastName', gEmail: 'email', gPhone: 'phone', gAddress: 'address', gCity: 'city', gState: 'state', gZip: 'zip' })) $('form').elements[k].value = draft.guardian[v] || '';
  payPlan = !!draft?.plan;
  (draft?.players?.length ? draft.players : [{}]).forEach((p) => playerCard(p));
  renderSummary();
  if (cards().length > 1) openCard(cards().find((sec) => sec._need?.length) || null);

  // Phones: a slim bar with the players and total, until the summary itself is on screen.
  const sumSec = document.querySelector('.regsec.summary');
  $('regbarGo').onclick = () => sumSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => $('regbar').classList.toggle('away', e.isIntersecting), { threshold: 0.15 }).observe(sumSec);
  $('summary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    const sec = cards()[+b.dataset.open];
    openCard(sec); sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('addPlayer').onclick = () => {
    const sec = playerCard({ lastName: document.querySelector('.player [name=last]')?.value || '' });
    renderSummary(); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); sec.querySelector('[name=first]').focus({ preventScroll: true });
  };
  $('players').addEventListener('click', (e) => {
    const sec = e.target.closest('.player');
    if (e.target.closest('[data-toggle]')) { openCard(sec.classList.contains('open') ? null : sec); return; }
    if (e.target.matches('[data-done]')) {
      renderSummary();
      if (sec._need.length) { sec.querySelector('.pmissing').textContent = `Still needed: ${sec._need.join(', ')}.`; return; }
      sec.querySelector('.pmissing').textContent = '';
      // On to the next player who still needs something, else close up so the family sees the list.
      openCard(cards().find((p) => p !== sec && p._need?.length) || null);
      sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (e.target.matches('[data-remove]')) {
      const name = sec.querySelector('[name=first]').value.trim();
      if (name && !confirm(`Remove ${name} from this registration?`)) return;
      const only = cards().length === 1;
      sec.remove();
      // A registration always has at least one player: removing the only one starts a fresh, empty card.
      if (only) playerCard().querySelector('[name=first]').focus();
      renderSummary(); redrawSiblings();
    }
  });
  // The sibling offer lives outside the cards.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-sibjump]')) { $('sibOffer').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('sibOffer').querySelector('[data-addsib]')?.focus({ preventScroll: true }); return; }
    const add = e.target.closest('#sibOffer [data-addsib]');
    if (!add) return;
    const all = [...document.querySelectorAll('.player')].flatMap((p) => p._siblings || []);
    const pick = all.filter((x, i) => !x.registered && !onForm(x) && all.findIndex((y) => y.kidId === x.kidId) === i && (add.dataset.addsib === '*' || x.kidId === add.dataset.addsib));
    let last;
    // Their details come from last season's roster, so they're already confirmed as the returning player.
    for (const x of pick) last = playerCard({ firstName: x.firstName, lastName: x.lastName, birthdate: x.birthdate, returning: x.kidId });
    redrawSiblings(); renderSummary();
    last?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('players').addEventListener('change', (e) => {
    const sec = e.target.closest('.player');
    if (e.target.matches('[name=dob],[data-program],[name=first]')) renderPlayer(sec);
    if (e.target.matches('[name=first],[name=last],[name=dob]')) lookupReturning(sec);
    if (e.target.matches('[name^="returning-"]')) {
      sec._returning = e.target.value;
      renderPlayer(sec);
      // Returners usually go back to the program they're expected in; pick it for them.
      pickSuggested(sec);
      lookupSiblings(sec);
      redrawSiblings();
    }
    renderSummary();
  });
  // Left the name/birthdate fields: now's the time to ask about a match.
  $('players').addEventListener('focusout', (e) => {
    const sec = e.target.closest('.player');
    if (sec && e.target.matches('[name=first],[name=last],[name=dob]')) setTimeout(() => maybeAsk(sec), 0);
  });
  $('players').addEventListener('input', (e) => {
    const sec = e.target.closest('.player');
    if (e.target.matches('[name=first],[name=last],[name=dob]')) clearTimeout(sec._askT);
    if (e.target.matches('[name=first]')) sec.querySelector('.ptitle').textContent = e.target.value || 'Player';
    // Check as they type, not only when they leave the field.
    if (e.target.matches('[name=first],[name=last],[name=dob]')) lookupLater(lookupReturning, sec);
  });
  // A parent's email or phone (typed or corrected later) can be what unlocks the sibling offer.
  $('form').addEventListener('input', (e) => { if (e.target.matches('[name=gEmail],[name=gPhone]')) document.querySelectorAll('.player').forEach((sec) => lookupLater(lookupSiblings, sec, 600)); });
  $('form').addEventListener('input', (e) => { if (e.target.name === 'payplan') payPlan = e.target.value === 'plan'; renderSummary(); });
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    $('err').textContent = '';
    const unsure = [...document.querySelectorAll('.player')].find((sec) => sec._matches?.length && !sec._returning);
    if (unsure) { $('err').textContent = `${unsure.querySelector('[name=first]').value.trim() || 'A player'}: tell us whether this is the player who played in ${C.campaign.year - 1}.`; askReturning(unsure); return; }
    $('submit').disabled = true;
    try {
      const r = await call('POST', `/api/register/${encodeURIComponent(slug)}/checkout`, readForm());
      location.href = r.url;
    } catch (err) { $('err').textContent = err.message; $('submit').disabled = false; }
  };
})();
