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
let C = null, nextId = 1;

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
  sec.innerHTML = `<h2><span class="ptitle">Player</span><span class="spacer"></span><button type="button" class="mini" data-remove>Remove</button></h2>
    <div class="fields">
      <label>First name<input type="text" name="first" value="${esc(d.firstName)}" required></label>
      <label>Last name<input type="text" name="last" value="${esc(d.lastName)}" required></label>
      <label>Birthdate<input type="date" name="dob" value="${esc(d.birthdate)}" required><small class="agehint"></small></label>
      <label>Gender<select name="gender"><option value="">Choose…</option>${['Boy', 'Girl'].map((g) => `<option ${d.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
    </div>
    <div class="returning" aria-live="polite"></div>
    <div class="programs"></div>
    <div class="items"></div>
    <div class="qs pqs"></div>`;
  sec._saved = d;
  sec._returning = d.returning || '';
  $('players').append(sec);
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
  if (!first || !last || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) { sec._matches = []; return renderReturning(sec); }
  const r = await call('GET', `/api/register/${encodeURIComponent(slug)}/returning?${new URLSearchParams({ first, last, dob })}`).catch(() => ({ matches: [] }));
  if (sec._lookedUp !== key) return; // they kept typing
  sec._matches = r.matches;
  if (sec._returning && sec._returning !== 'new' && !r.matches.some((m) => m.id === sec._returning)) sec._returning = '';
  renderReturning(sec);
}
const isReturner = (sec) => !!sec._returning && sec._returning !== 'new';
function renderReturning(sec) {
  const was = isReturner(sec);
  drawReturning(sec);
  // No longer a confirmed returner (name changed): bring back the new-player questions.
  if (was !== isReturner(sec)) { renderPlayer(sec); renderSummary(); }
}
function drawReturning(sec) {
  const box = sec.querySelector('.returning'), ms = sec._matches || [];
  const prior = C.campaign.year - 1, name = `returning-${sec.dataset.pid}`;
  const played = (m) => `${esc(m.name)} — ${m.division ? esc(m.division) : 'played'}${m.team ? `, ${esc(m.team)}` : ''} (${m.year})`;
  if (!ms.length) {
    sec._returning = '';
    box.innerHTML = sec._lookedUp && sec._lookedUp.split('|').every(Boolean) ? `<p class="note">New player — welcome! We didn’t find them on a ${prior} roster.</p>` : '';
    return;
  }
  box.innerHTML = `<fieldset class="choice returnbox"><legend>${ms.length === 1 ? `Is this the player who played in ${prior}?` : `Which player played in ${prior}?`} <span aria-hidden="true" style="color:var(--stitch)">*</span></legend>
    ${ms.map((m) => `<label><input type="radio" name="${name}" value="${esc(m.id)}" ${sec._returning === m.id ? 'checked' : ''}> <span>Yes — ${played(m)}</span></label>`).join('')}
    <label><input type="radio" name="${name}" value="new" ${sec._returning === 'new' ? 'checked' : ''}> <span>No — this is a new player</span></label></fieldset>`;
}
function renderPlayer(sec) {
  const d = sec._saved || {};
  const dob = sec.querySelector('[name=dob]').value, age = leagueAge(dob);
  sec.querySelector('.agehint').textContent = age != null ? `League age ${age} for ${C.campaign.year}` : '';
  const first = sec.querySelector('[name=first]').value.trim();
  sec.querySelector('.ptitle').textContent = first || 'Player';
  const ok = C.offerings.filter((o) => fits(o, age) && (!o.full || o.waitlist));
  const cur = sec.querySelector('[name=program]:checked')?.value || d.offeringId;
  const prog = sec.querySelector('.programs');
  prog.innerHTML = age == null ? '<p class="note">Enter a birthdate to see the programs this player can join.</p>'
    : ok.length ? `<b style="font-size:.88rem">Program</b>${ok.map((o) => `<label><input type="radio" name="program-${sec.dataset.pid}" data-program value="${esc(o.id)}" ${o.id === cur || ok.length === 1 ? 'checked' : ''}>
        <span><b>${esc(o.name)} ${o.full ? '<span class="pill wait">Full — free waitlist</span>' : o.left != null && o.left <= 5 ? `<span class="pill wait">${o.left} left</span>` : ''}</b>${o.description ? `<span class="sub">${esc(o.description)}</span>` : ''}</span></label>`).join('')}`
      : `<p class="err-text">No ${C.campaign.year} program fits league age ${age}.</p>`;
  const offeringId = sec.querySelector('[data-program]:checked')?.value;
  const offering = C.offerings.find((o) => o.id === offeringId);
  // Items
  const its = offering ? C.items.filter((i) => applies(i, offering.id)) : [];
  const qty = (i) => { const el = sec.querySelector(`[data-item="${i.id}"]`); return el ? (el.type === 'checkbox' ? (el.checked ? 1 : 0) : +el.value) : (d.items?.[i.id] ?? 0); };
  const prevQ = Object.fromEntries(its.map((i) => [i.id, qty(i)]));
  sec.querySelector('.items').innerHTML = its.length ? `<b style="font-size:.88rem">Fees &amp; add-ons${offering.full ? ' <span class="sub">(charged only if a spot opens up)</span>' : ''}</b>` + its.map((i) => `<div class="itemrow"><div><b>${esc(i.name)}</b>${i.required ? ' <span class="sub">required</span>' : ''}${i.description ? `<div class="sub">${esc(i.description)}</div>` : ''}</div>
      <div class="row" style="flex-wrap:nowrap">${i.required ? '<span class="sub">×1</span>' : i.max_qty > 1
        ? `<select data-item="${esc(i.id)}" aria-label="${esc(i.name)} quantity">${Array.from({ length: i.max_qty + 1 }, (_, n) => `<option ${prevQ[i.id] === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`
        : `<input type="checkbox" data-item="${esc(i.id)}" aria-label="Add ${esc(i.name)}" ${prevQ[i.id] ? 'checked' : ''}>`}<span class="price">${money(i.price_cents)}${i.max_qty > 1 ? ' each' : ''}</span></div></div>`).join('') : '';
  // Player questions
  // A confirmed returner skips the questions only new players are asked (experience, last team).
  const qs = offering ? C.questions.filter((q) => q.scope === 'player' && applies(q, offering.id) && !(q.new_only && isReturner(sec))) : [];
  const prevA = Object.fromEntries(qs.map((q) => [q.id, readQuestion(sec, q, `pq-${sec.dataset.pid}-${q.id}`) ?? d.answers?.[q.id]]));
  sec.querySelector('.pqs').innerHTML = qs.map((q) => questionHtml(q, `pq-${sec.dataset.pid}-${q.id}`, prevA[q.id])).join('');
  sec._saved = null;
}
function readPlayer(sec) {
  const offeringId = sec.querySelector('[data-program]:checked')?.value || '';
  const items = {}, answers = {};
  sec.querySelectorAll('[data-item]').forEach((el) => (items[el.dataset.item] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : +el.value));
  for (const q of C.questions.filter((q) => q.scope === 'player')) { const v = readQuestion(sec, q, `pq-${sec.dataset.pid}-${q.id}`); if (v !== undefined) answers[q.id] = v; }
  return { firstName: sec.querySelector('[name=first]').value.trim(), lastName: sec.querySelector('[name=last]').value.trim(), birthdate: sec.querySelector('[name=dob]').value,
    gender: sec.querySelector('[name=gender]').value, offeringId, items, answers, returning: sec._returning || undefined };
}
function readForm() {
  const f = $('form'), v = (n) => f.elements[n].value.trim();
  const answers = {};
  for (const q of C.questions.filter((q) => q.scope === 'family')) { const a = readQuestion($('familyQs'), q, `fq-${q.id}`); if (a !== undefined) answers[q.id] = a; }
  return {
    guardian: { firstName: v('gFirst'), lastName: v('gLast'), email: v('gEmail'), phone: v('gPhone'), address: v('gAddress'), city: v('gCity'), state: v('gState'), zip: v('gZip') },
    answers, players: [...document.querySelectorAll('.player')].map(readPlayer),
  };
}

/* ---------- summary ---------- */
function renderSummary() {
  const data = readForm();
  let total = 0, waiting = 0;
  const rows = [];
  for (const p of data.players) {
    const o = C.offerings.find((x) => x.id === p.offeringId);
    if (!o) continue;
    const name = `${p.firstName || 'Player'} ${p.lastName}`.trim();
    if (o.full) { waiting++; rows.push(`<tr><td>${esc(name)} — ${esc(o.name)} <span class="pill wait">waitlist</span></td><td>$0</td></tr>`); continue; }
    for (const i of C.items.filter((i) => applies(i, o.id))) {
      const q = i.required ? 1 : p.items[i.id] || 0;
      if (!q) continue;
      total += q * i.price_cents;
      rows.push(`<tr><td>${esc(name)} — ${esc(i.name)}${q > 1 ? ` ×${q}` : ''}</td><td>${money(q * i.price_cents)}</td></tr>`);
    }
  }
  $('summary').innerHTML = rows.length ? `<table class="sumtable">${rows.join('')}<tr class="total"><td>Total today</td><td>${money(total)}</td></tr></table>` : '<p class="note">Add a player and pick a program.</p>';
  $('submit').textContent = total > 0 ? `Continue to payment — ${money(total)}` : waiting ? 'Join the waitlist' : 'Register';
  $('payNote').hidden = !(total > 0);
  try { localStorage.setItem(DRAFT, JSON.stringify(data)); } catch { /* private mode */ }
}

/* ---------- boot ---------- */
async function showDone() {
  const qs = new URLSearchParams(location.search);
  $('form').hidden = true; $('done').hidden = false;
  const show = (r) => {
    const ok = r.status === 'paid' || r.status === 'waitlisted';
    $('done').innerHTML = `<section class="regsec"><h2>${r.status === 'paid' ? 'You’re registered!' : r.status === 'waitlisted' ? 'You’re on the waitlist' : r.status === 'pending' ? 'Confirming your payment…' : 'This registration wasn’t completed'}</h2>
      <ul>${r.players.map((p) => `<li><b>${esc(p.name)}</b> — ${esc(p.program)}: ${p.status === 'registered' ? 'registered' : p.status === 'waitlisted' || p.status === 'offered' ? 'waitlist (no charge — we’ll contact you if a spot opens)' : esc(p.status)}</li>`).join('')}</ul>
      ${r.status === 'paid' ? `<p>Paid ${money(r.total_cents)}. Stripe emails your receipt.</p>` : ''}
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
  if (C.campaign.closedReason) $('payNote').insertAdjacentHTML('beforebegin', `<p class="err-text">${esc(C.campaign.closedReason)}${C.campaign.preview ? ' You’re seeing an admin preview — open the campaign in Signups to take registrations.' : ''}</p>`);
  const fam = C.questions.filter((q) => q.scope === 'family');
  $('familySec').hidden = !fam.length;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { /* private */ }
  $('familyQs').innerHTML = fam.map((q) => questionHtml(q, `fq-${q.id}`, draft?.answers?.[q.id])).join('');
  if (draft?.guardian) for (const [k, v] of Object.entries({ gFirst: 'firstName', gLast: 'lastName', gEmail: 'email', gPhone: 'phone', gAddress: 'address', gCity: 'city', gState: 'state', gZip: 'zip' })) $('form').elements[k].value = draft.guardian[v] || '';
  (draft?.players?.length ? draft.players : [{}]).forEach((p) => playerCard(p));
  renderSummary();

  $('addPlayer').onclick = () => { playerCard({ lastName: document.querySelector('.player [name=last]')?.value || '' }).querySelector('[name=first]').focus(); renderSummary(); };
  $('players').addEventListener('click', (e) => {
    if (e.target.matches('[data-remove]')) { if (document.querySelectorAll('.player').length > 1) e.target.closest('.player').remove(); renderSummary(); }
  });
  $('players').addEventListener('change', (e) => {
    const sec = e.target.closest('.player');
    if (e.target.matches('[name=dob],[data-program],[name=first]')) renderPlayer(sec);
    if (e.target.matches('[name=first],[name=last],[name=dob]')) lookupReturning(sec);
    if (e.target.matches('[name^="returning-"]')) {
      sec._returning = e.target.value;
      renderPlayer(sec);
      // Returners usually go back to the program they're expected in; pick it for them.
      const m = sec._matches?.find((x) => x.id === e.target.value);
      const radio = m?.suggestOfferingId && sec.querySelector(`[data-program][value="${CSS.escape(m.suggestOfferingId)}"]`);
      if (radio && !sec.querySelector('[data-program]:checked')) { radio.checked = true; renderPlayer(sec); }
    }
    renderSummary();
  });
  $('players').addEventListener('input', (e) => { if (e.target.matches('[name=first]')) e.target.closest('.player').querySelector('.ptitle').textContent = e.target.value || 'Player'; });
  $('form').addEventListener('input', () => renderSummary());
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    $('err').textContent = '';
    const unsure = [...document.querySelectorAll('.player')].find((sec) => sec._matches?.length && !sec._returning);
    if (unsure) { $('err').textContent = `${unsure.querySelector('[name=first]').value.trim() || 'A player'}: tell us whether this is the player who played in ${C.campaign.year - 1}.`; unsure.querySelector('.returning input')?.focus(); return; }
    $('submit').disabled = true;
    try {
      const r = await call('POST', `/api/register/${encodeURIComponent(slug)}/checkout`, readForm());
      location.href = r.url;
    } catch (err) { $('err').textContent = err.message; $('submit').disabled = false; }
  };
})();
