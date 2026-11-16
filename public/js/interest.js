/* "Is your player coming back?" — a family's one-click answer from an
   interest-check email. The button they clicked arrives pre-selected; one tap
   saves it (a click is needed so email link scanners can't answer for them). */
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = location.pathname.split('/').pop();
const q = new URLSearchParams(location.search);
const LABEL = { yes: 'Yes, playing', no: 'Not this year', unsure: 'Not sure yet' };
let D = null;

async function load() {
  try {
    const r = await fetch(`/api/interest/${encodeURIComponent(token)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Something went wrong');
    D = d;
    $('league').textContent = d.league;
    $('title').textContent = `${d.season} season`;
    document.title = `Coming back in ${d.season}? — ${d.league}`;
    const pick = { ...Object.fromEntries(d.kids.map((k) => [k.id, k.intent])) };
    if (q.get('kid') && LABEL[q.get('a')]) pick[q.get('kid')] = q.get('a');
    const open = d.kids.filter((k) => !k.registered);
    $('lead').textContent = `Hi${d.parent ? ` ${d.parent}` : ''} — will ${open.length === 1 ? open[0].name.split(' ')[0] : 'your players'} be playing in ${d.season}?`;
    $('kids').innerHTML = d.kids.map((k) => `<fieldset class="ix-kid" ${k.registered ? 'disabled' : ''}>
      <legend><b>${esc(k.name)}</b>${k.division ? `<span class="sub">${esc(k.division)}${k.team ? ` · ${esc(k.team)}` : ''}</span>` : ''}</legend>
      ${k.registered ? '<p class="ix-reg">Already registered — thank you!</p>' : `<div class="ix-choices">${Object.entries(LABEL).map(([v, l]) => `<label class="ix-choice ix-${v}"><input type="radio" name="k-${esc(k.id)}" value="${v}" ${pick[k.id] === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`}
    </fieldset>`).join('');
    $('save').hidden = !open.length;
    if (open.length > 1) $('save').textContent = 'Save my answers';
    $('loading').hidden = true; $('form').hidden = false;
  } catch (e) { $('loading').textContent = e.message; }
}

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const answers = D.kids.filter((k) => !k.registered).map((k) => ({ kidId: k.id, intent: document.querySelector(`[name="k-${CSS.escape(k.id)}"]:checked`)?.value })).filter((a) => a.intent);
  if (!answers.length) { $('err').textContent = 'Pick an answer first.'; return; }
  $('save').disabled = true; $('err').textContent = '';
  try {
    const r = await fetch(`/api/interest/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong — please try again');
    const name = (id) => D.kids.find((k) => k.id === id).name.split(' ')[0];
    const yes = answers.filter((a) => a.intent === 'yes');
    $('form').hidden = true;
    $('done').hidden = false;
    $('done').innerHTML = `<h2>Thank you!</h2>
      <ul class="ix-summary">${answers.map((a) => `<li><b>${esc(name(a.kidId))}</b> — ${LABEL[a.intent]}</li>`).join('')}</ul>
      ${yes.length && D.register ? `<p>Registration is open now — grab ${yes.length === 1 ? `${esc(name(yes[0].kidId))}’s` : 'their'} spot:</p><a class="btn primary big" href="${esc(D.register)}">Register now</a>`
        : yes.length ? `<p>We’ll save ${yes.length === 1 ? 'a spot' : 'spots'} and email you when registration opens.</p>`
        : answers.some((a) => a.intent === 'no') ? '<p>Thanks for letting us know — we’ll miss you this season.</p>' : '<p>No problem — we’ll check back in before registration opens.</p>'}
      <p class="note">Changed your mind? Use the same email link any time.</p>`;
  } catch (err) { $('err').textContent = err.message; $('save').disabled = false; }
};
load();
