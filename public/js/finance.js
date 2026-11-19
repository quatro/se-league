/* Finance tab: registration revenue (booked vs collected) and the payment-plan
   receivables — what families still owe, how late, and the collections work:
   automatic charges and reminders, plus an admin's own emails, texts, calls and
   notes, all in one history per family. Shares helpers with app.js. */
'use strict';

const FS = { data: null, campaign: '', filter: 'attention', q: '', busy: false, open: null };
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const fDate = (d) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const fWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (iso) => {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const PSTATE = {
  card_failed: { cls: 'crit', label: 'Card declined', rank: 0 },
  past_due: { cls: 'crit', label: 'Past due', rank: 1 },
  no_card: { cls: 'warn', label: 'No card on file', rank: 2 },
  due_today: { cls: 'warn', label: 'Due today', rank: 3 },
  on_track: { cls: 'good', label: 'On track', rank: 4 },
  paid_off: { cls: 'done', label: 'Paid off', rank: 5 },
};
const ATTENTION = ['card_failed', 'past_due', 'no_card', 'due_today'];

async function loadFinance() {
  if (FS.busy) return;
  FS.busy = true;
  try {
    if (!CS.list.length) CS.list = await call('GET', '/api/admin/campaigns'); // campaigns.js keeps the list
    FS.data = await call('GET', `/api/admin/finance${FS.campaign ? `?campaign=${encodeURIComponent(FS.campaign)}` : ''}`);
    renderFinance();
  } catch (e) { toast(e.message, true); } finally { FS.busy = false; }
}

function renderFinance() {
  const d = FS.data; if (!d) return;
  const t = d.totals, ar = d.receivables, k = ar.kpis;
  $('finCampaign').innerHTML = `<option value="">All registrations</option>${CS.list.map((c) => `<option value="${esc(c.id)}" ${c.id === FS.campaign ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
  $('finCsv').href = `/api/admin/finance/payments.csv${FS.campaign ? `?campaign=${encodeURIComponent(FS.campaign)}` : ''}`;

  // ---- revenue ----
  const meterTotal = Math.max(1, t.collected + k.outstanding + k.waived);
  const notDue = Math.max(0, k.outstanding - k.pastDue);
  const seg = (cls, n, label) => (n > 0 ? `<i class="${cls}" style="width:${(100 * n / meterTotal).toFixed(2)}%" data-tip="${esc(`${label}: ${usd(n)}`)}"></i>` : '');
  const maxProg = Math.max(1, ...d.byProgram.map((r) => r.cents)), maxItem = Math.max(1, ...d.byItem.map((r) => r.cents)), maxMonth = Math.max(1, ...d.byMonth.map((r) => r.cents));
  const dataBar = (n, max) => `<span class="databar"><i style="width:${(100 * n / max).toFixed(1)}%"></i></span>`;
  const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  $('finRevenue').innerHTML = `
    ${d.testOnly ? '<p class="banner">Everything here is from Stripe test mode — rehearsal payments, no real money. Real payments replace these once the league switches to live keys.</p>' : ''}
    <div class="fintiles">
      <div class="fintile"><span>Booked</span><b>${usd(t.booked)}</b><small>${t.players} players · ${t.orders} registrations</small></div>
      <div class="fintile"><span>Collected</span><b>${usd(t.collected)}</b><small>${t.booked ? Math.round(100 * t.collected / t.booked) : 0}% of booked</small></div>
      <div class="fintile"><span>Outstanding on plans</span><b>${usd(k.outstanding)}</b><small>${k.plans} payment plan${k.plans === 1 ? '' : 's'}</small></div>
      <div class="fintile ${k.pastDue ? 'alert' : ''}"><span>Past due</span><b>${usd(k.pastDue)}</b><small>${ar.plans.filter((p) => p.past_due_cents > 0).length} families</small></div>
      <div class="fintile"><span>Refunded</span><b>${usd(t.refunded)}</b><small>in full, in Stripe</small></div>
    </div>
    <div class="finmeter-wrap">
      <div class="finmeter" role="img" aria-label="${esc(`Collected ${usd(t.collected)}, not yet due ${usd(notDue)}, past due ${usd(k.pastDue)}, waived ${usd(k.waived)}`)}">
        ${seg('col', t.collected, 'Collected')}${seg('due', notDue, 'On plans, not yet due')}${seg('late', k.pastDue, 'Past due')}${seg('waived', k.waived, 'Waived')}</div>
      <div class="vlegend"><span><i class="sw fin-col"></i>Collected ${usd(t.collected)}</span><span><i class="sw fin-due"></i>Not yet due ${usd(notDue)}</span><span><i class="sw fin-late"></i>Past due ${usd(k.pastDue)}</span>${k.waived ? `<span><i class="sw fin-waived"></i>Waived ${usd(k.waived)}</span>` : ''}</div>
    </div>
`;
  $('finBreak').innerHTML = `
    <div class="grid3">
      <div><h3>By division</h3><table class="kt fintable">${d.byProgram.map((r) => `<tr><td>${esc(r.name)}<div class="sub">${r.players} players</div></td><td>${dataBar(r.cents, maxProg)}</td><td class="num">${usd(r.cents)}</td></tr>`).join('') || '<tr><td class="note">Nothing yet.</td></tr>'}</table></div>
      <div><h3>By fee</h3><table class="kt fintable">${d.byItem.map((r) => `<tr><td>${esc(r.name)}<div class="sub">${r.qty} sold</div></td><td>${dataBar(r.cents, maxItem)}</td><td class="num">${usd(r.cents)}</td></tr>`).join('') || '<tr><td class="note">Nothing yet.</td></tr>'}</table></div>
      <div><h3>Collected by month</h3><table class="kt fintable">${d.byMonth.map((r) => `<tr><td>${esc(monthName(r.month))}</td><td>${dataBar(r.cents, maxMonth)}</td><td class="num">${usd(r.cents)}</td></tr>`).join('') || '<tr><td class="note">Nothing yet.</td></tr>'}</table></div>
    </div>`;

  // ---- receivables ----
  const ag = ar.aging;
  $('finAging').innerHTML = [['Not yet due', ag.current, ''], ['1–30 days late', ag.d1_30, ag.d1_30 ? 'warn' : ''], ['31–60 days late', ag.d31_60, ag.d31_60 ? 'alert' : ''], ['61+ days late', ag.d61, ag.d61 ? 'alert' : '']]
    .map(([l, n, c]) => `<div class="fintile small ${c}"><span>${l}</span><b>${usd(n)}</b></div>`).join('')
    + `<div class="fintile small"><span>Due in the next 30 days</span><b>${usd(k.next30)}</b></div>`;
  const counts = { attention: ar.plans.filter((p) => ATTENTION.includes(p.state)).length, all: ar.plans.length,
    on_track: ar.plans.filter((p) => p.state === 'on_track').length, paid_off: ar.plans.filter((p) => p.state === 'paid_off').length };
  $('finBadge').hidden = !counts.attention; $('finBadge').textContent = counts.attention;
  $('finFilters').innerHTML = [['attention', 'Needs attention'], ['all', 'All plans'], ['on_track', 'On track'], ['paid_off', 'Paid off']]
    .map(([v, l]) => `<button class="seg ${FS.filter === v ? 'on' : ''}" data-ffilter="${v}">${l} <span class="sub">${counts[v]}</span></button>`).join('');
  const q = FS.q.toLowerCase();
  const rows = ar.plans
    .filter((p) => FS.filter === 'all' || (FS.filter === 'attention' ? ATTENTION.includes(p.state) : p.state === FS.filter))
    .filter((p) => !q || `${p.family} ${p.email} ${p.phone} ${p.players.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => PSTATE[a.state].rank - PSTATE[b.state].rank || b.days_late - a.days_late || b.owed_cents - a.owed_cents);
  $('finPlans').innerHTML = ar.plans.length ? `<tr><th>Family</th><th>Status</th><th>Progress</th><th class="num">Owed</th><th>Next payment</th><th>Last contact</th></tr>`
    + (rows.map((p) => {
      const s = PSTATE[p.state];
      return `<tr class="click" data-plan="${esc(p.order_id)}" tabindex="0">
        <td><b>${esc(p.family || p.email)}</b><div class="sub">${esc(p.players.join(', '))}${FS.campaign ? '' : ` · ${esc(p.campaign)}`}</div></td>
        <td><span class="risk ${s.cls}">${s.label}</span>${p.days_late ? `<div class="sub">${p.days_late} day${p.days_late === 1 ? '' : 's'} late</div>` : ''}</td>
        <td><span class="pips" aria-label="${p.paid_count} of ${p.count} paid">${p.installments.map((i) => `<i class="${i.status === 'paid' ? 'paid' : i.status === 'waived' ? 'waived' : i.late || i.status === 'failed' ? 'late' : ''}"></i>`).join('')}</span><div class="sub">${p.paid_count} of ${p.count} · ${usd(p.paid_cents)} paid</div></td>
        <td class="num"><b>${usd(p.owed_cents)}</b>${p.past_due_cents ? `<div class="sub warn-text">${usd(p.past_due_cents)} late</div>` : ''}</td>
        <td>${p.next ? `${usd(p.next.cents)} · ${fDate(p.next.due)}` : '—'}</td>
        <td class="sub">${p.last_contact ? `${esc(p.last_contact.channel === 'text' ? 'Text' : p.last_contact.channel === 'call' ? 'Call' : 'Email')} · ${ago(p.last_contact.at)}` : 'None yet'}</td></tr>`;
    }).join('') || `<tr><td colspan="6" class="note">No plans ${FS.filter === 'attention' ? 'need attention right now 🎉' : 'match'}.</td></tr>`)
    : `<tr><td class="note">No payment plans yet. Turn them on for a registration under <b>Registration → Payment plan</b>; families who choose one show up here.</td></tr>`;
}

/* ---------- one family's plan: the drill-in ---------- */
async function openPlan(orderId) {
  const r = await act('GET', `/api/admin/finance/orders/${encodeURIComponent(orderId)}`); if (!r) return;
  FS.open = orderId;
  const p = r.plan, s = PSTATE[p.state], d = FS.data.receivables;
  const iState = (i) => (i.status === 'paid' ? `<span class="risk done">Paid${i.method ? ` · ${esc(i.method)}` : ''}</span>` : i.status === 'waived' ? '<span class="risk done">Waived</span>'
    : i.status === 'failed' ? `<span class="risk crit">Declined</span>` : i.late ? '<span class="risk crit">Past due</span>' : '<span class="sub">Scheduled</span>');
  const smsHref = (phone, msg) => `sms:${phone.replace(/[^\d+]/g, '')}${/iPhone|iPad|Mac/.test(navigator.userAgent) ? '&' : '?'}body=${encodeURIComponent(msg)}`;
  const CH = { email: 'Email', text: 'Text', call: 'Call', note: 'Note', charge: 'Card charge', payment: 'Payment' };
  openDialog(`<div class="dlg findlg">
    <div class="row"><h2 style="margin:0">${esc(p.family || p.email)}</h2><span class="risk ${s.cls}">${s.label}</span><span class="spacer"></span><button class="btn" data-close>Close</button></div>
    <div class="sub">${esc(p.players.join(', '))} · ${esc(p.campaign)}</div>
    <div class="fincontact">
      <div><span class="sub">Email</span>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}</div>
      <div><span class="sub">Phone</span>${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>` : '—'}</div>
      <div><span class="sub">Card on file</span>${esc(p.card || 'None')}</div>
      <div><span class="sub">Pay link</span><button class="mini" data-fcopy="${esc(r.payUrl)}">Copy pay link</button></div>
    </div>
    <div class="fintiles slim">
      <div class="fintile small"><span>Total</span><b>${usd(p.total_cents)}</b></div>
      <div class="fintile small"><span>Paid</span><b>${usd(p.paid_cents)}</b></div>
      <div class="fintile small ${p.past_due_cents ? 'alert' : ''}"><span>Owed</span><b>${usd(p.owed_cents)}</b>${p.past_due_cents ? `<small>${usd(p.past_due_cents)} past due</small>` : ''}</div>
    </div>
    ${p.last_error ? `<p class="err-text" style="margin:0">Bank said: ${esc(p.last_error)}</p>` : ''}

    <h3>Payments</h3>
    <div class="scroll"><table class="kt">${p.installments.map((i) => `<tr data-inst="${esc(i.id)}">
      <td>${i.seq}</td><td>${fDate(i.due)}</td><td class="num">${usd(i.cents)}</td><td>${iState(i)}${i.attempts && i.status !== 'paid' ? `<div class="sub">${i.attempts} of ${d.maxAttempts} tries${i.next_attempt_at ? ` · next ${fDate(i.next_attempt_at)}` : ''}</div>` : ''}${i.note ? `<div class="sub">${esc(i.note)}</div>` : ''}</td>
      <td><div class="row instacts">${['due', 'failed'].includes(i.status) ? `${p.card ? '<button class="mini" data-icharge>Charge card</button>' : ''}<button class="mini" data-irecord>Record payment</button><button class="mini" data-imove>Move date</button><button class="mini" data-iwaive>Waive</button>` : ''}</div></td></tr>`).join('')}</table></div>

    <h3>Reach out</h3>
    <div class="fintabs" role="tablist">
      <button class="seg on" data-fpane="text" role="tab">Text</button><button class="seg" data-fpane="email" role="tab">Email</button><button class="seg" data-fpane="log" role="tab">Log a call or note</button>
    </div>
    <div class="fpane" data-pane="text">
      <p class="note" style="margin:0">Sends from <b>your</b> phone with the family’s pay link in the message. ${p.phone ? '' : '<b>No phone number on file.</b>'}</p>
      <textarea id="ftText" rows="3">${esc(r.text.message)}</textarea>
      <div class="row">${p.phone ? `<a class="btn primary" id="ftSms" href="${esc(smsHref(p.phone, r.text.message))}">Open in Messages</a>` : ''}<button class="btn" id="ftCopy">Copy text</button><span class="spacer"></span><button class="btn" id="ftLog">I sent it — log it</button></div>
    </div>
    <div class="fpane" data-pane="email" hidden>
      <div class="row"><button class="btn" id="feStd">Send the standard reminder</button><span class="note">Past-due amount (or next payment), the schedule and a pay button.</span></div>
      <input type="text" id="feSubj" placeholder="Subject" value="About {players}'s registration payment">
      <textarea id="feBody" rows="5">Hi {first},

Just checking in on {players}'s registration. The balance is {balance} ({due} past due). You can pay or update your card here:
{link}

If something's come up, reply and let us know — we're happy to work out a different schedule.</textarea>
      <div class="row"><button class="btn primary" id="feSend" ${d.mail ? '' : 'disabled title="Email isn’t set up yet"'}>Send email</button><span class="note">Merge fields: ${r.mergeFields.map(esc).join(' ')} — the pay link is added if you leave it out.</span></div>
    </div>
    <div class="fpane" data-pane="log" hidden>
      <div class="row"><select id="flCh" style="width:auto"><option value="call">Phone call</option><option value="note">Note</option><option value="text">Text (sent elsewhere)</option><option value="email">Email (sent elsewhere)</option></select></div>
      <textarea id="flBody" rows="3" placeholder="What happened — e.g. “Spoke to Lauren, paying Friday”"></textarea>
      <div class="row"><button class="btn primary" id="flSave">Save to history</button></div>
    </div>

    <h3>History</h3>
    <ol class="finlog">${r.log.map((x) => `<li class="${x.ok ? '' : 'bad'}"><span class="when">${esc(fWhen(x.at))}</span><span class="ch">${CH[x.channel] ?? esc(x.channel)}</span>
      <span class="what">${esc(x.subject || x.kind)}${x.error ? ` <span class="err-text">— ${esc(x.error)}</span>` : ''}${x.body && x.channel !== 'email' ? `<span class="sub">${esc(x.body)}</span>` : ''}${x.body && x.channel === 'email' ? `<details><summary class="sub">Show message</summary><pre>${esc(x.body)}</pre></details>` : ''}</span>
      <span class="sub who">${esc(x.actor)}</span></li>`).join('') || '<li class="note">Nothing yet.</li>'}</ol>
  </div>`, (dl) => {
    dl.classList.add('wide');
    dl.addEventListener('close', () => dl.classList.remove('wide'), { once: true });
    const reload = async () => { await loadFinance(); if (dl.open) openPlan(orderId); };
    dl.querySelectorAll('[data-fpane]').forEach((b) => (b.onclick = () => {
      dl.querySelectorAll('[data-fpane]').forEach((x) => x.classList.toggle('on', x === b));
      dl.querySelectorAll('.fpane').forEach((x) => (x.hidden = x.dataset.pane !== b.dataset.fpane));
    }));
    dl.querySelector('[data-fcopy]').onclick = (e) => copyText(e.target.dataset.fcopy, 'Pay link copied');
    const txt = dl.querySelector('#ftText');
    txt.oninput = () => { const a = dl.querySelector('#ftSms'); if (a) a.href = smsHref(p.phone, txt.value); };
    dl.querySelector('#ftCopy').onclick = () => copyText(txt.value, 'Text copied — paste it into a message');
    dl.querySelector('#ftLog').onclick = async () => { if (await act('POST', `/api/admin/finance/orders/${encodeURIComponent(orderId)}/log`, { channel: 'text', body: txt.value }, 'Logged')) reload(); };
    dl.querySelector('#feStd').onclick = async () => { const x = await act('POST', `/api/admin/finance/orders/${encodeURIComponent(orderId)}/remind`, {}); if (x) { toast(x.emailed ? `Reminder emailed to ${x.emailed}` : 'Email isn’t set up — copy the pay link instead', !x.emailed); reload(); } };
    dl.querySelector('#feSend').onclick = async () => {
      const x = await act('POST', `/api/admin/finance/orders/${encodeURIComponent(orderId)}/email`, { subject: dl.querySelector('#feSubj').value, body: dl.querySelector('#feBody').value });
      if (x) { toast(`Emailed ${x.emailed}`); reload(); }
    };
    dl.querySelector('#flSave').onclick = async () => {
      const body = dl.querySelector('#flBody').value.trim(); if (!body) return toast('Write what happened first', true);
      if (await act('POST', `/api/admin/finance/orders/${encodeURIComponent(orderId)}/log`, { channel: dl.querySelector('#flCh').value, body }, 'Saved to history')) reload();
    };
    dl.querySelector('table').onclick = async (e) => {
      const tr = e.target.closest('[data-inst]'); if (!tr || !e.target.matches('button')) return;
      const id = encodeURIComponent(tr.dataset.inst), I = `/api/admin/finance/installments/${id}`;
      const amount = tr.children[2].textContent;
      if (e.target.matches('[data-icharge]')) {
        if (!confirm(`Charge ${amount} to ${p.card} now?`)) return;
        e.target.disabled = true;
        const x = await act('POST', `${I}/charge`, {});
        if (x) toast(x.message, !x.ok);
        return reload();
      }
      if (e.target.matches('[data-irecord]')) {
        const m = prompt(`Record ${amount} paid outside the card. How? (cash, check, venmo, other)`, 'check'); if (!m) return;
        const method = m.trim().toLowerCase();
        if (!['cash', 'check', 'venmo', 'other'].includes(method)) return toast('Use cash, check, venmo or other', true);
        const note = prompt('Note (check number, who took it…)', '') ?? '';
        if (await act('POST', `${I}/record`, { method, note }, 'Payment recorded')) reload();
      }
      if (e.target.matches('[data-imove]')) {
        const due = prompt('New due date (YYYY-MM-DD)', ''); if (!due) return;
        if (await act('POST', `${I}/move`, { due: due.trim() }, 'Due date moved')) reload();
      }
      if (e.target.matches('[data-iwaive]')) {
        const note = prompt(`Waive ${amount}? Say why (kept in the history):`, ''); if (note === null) return;
        if (await act('POST', `${I}/waive`, { note }, 'Waived')) reload();
      }
    };
  });
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copy this:', text); }
}

$('finCampaign').onchange = (e) => { FS.campaign = e.target.value; loadFinance(); };
$('finSearch').oninput = (e) => { FS.q = e.target.value; renderFinance(); };
$('finFilters').onclick = (e) => { const b = e.target.closest('[data-ffilter]'); if (b) { FS.filter = b.dataset.ffilter; renderFinance(); } };
$('finPlans').onclick = (e) => { const tr = e.target.closest('[data-plan]'); if (tr) openPlan(tr.dataset.plan); };
$('finPlans').onkeydown = (e) => { const tr = e.target.closest('[data-plan]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPlan(tr.dataset.plan); } };
$('finRun').onclick = async () => {
  const r = await act('POST', '/api/admin/finance/run', {});
  if (r) { toast(`${r.charged} charged · ${r.failed} declined · ${r.reminded} reminders sent`); loadFinance(); }
};

/* Finance categories — same side navigation as Settings. */
FS.pane = FS.pane || 'overview';
function finPane(k) {
  FS.pane = k;
  document.querySelectorAll('#finNav [data-fin]').forEach((b) => b.setAttribute('aria-selected', b.dataset.fin === k));
  document.querySelectorAll('#view-finance [data-finpane]').forEach((p) => (p.hidden = p.dataset.finpane !== k));
}
$('finNav').onclick = (e) => { const b = e.target.closest('[data-fin]'); if (b) finPane(b.dataset.fin); };
finPane(FS.pane);
