/* Users tab: one entry per person who may sign in, with every hat they wear —
   Admin (changes things), Board of Directors (sees every admin area, view only),
   Coach (from being named on a team; shown here, set on Divisions & teams). Shares helpers with app.js. */
'use strict';

const US = { list: [], mail: false, loaded: false };

async function loadUsers() {
  US.loaded = true;
  try { const r = await call('GET', '/api/admin/users'); US.list = r.users; US.mail = r.mail; renderUsers(); }
  catch (e) { toast(e.message, true); }
}

function renderUsers() {
  const note = $('uMailNote');
  note.hidden = US.mail;
  note.textContent = 'Email isn’t set up yet, so nothing will be sent — use “Copy link” in the list and send it to them yourself.';
  $('uInvite').closest('label').hidden = !US.mail;
  const me = S.me.user.email;
  $('userTable').innerHTML = '<tr><th>Person</th><th>Admin</th><th>Board</th><th>Coach</th><th>Last sign-in (UTC)</th><th></th></tr>'
    + (US.list.length ? '' : '<tr><td colspan="6" class="note">Nobody yet.</td></tr>')
    + US.list.map((u) => {
      const coach = u.coaching || [];
      const latest = coach.length ? coach.filter((c) => c.season_id === coach[0].season_id) : [];
      return `<tr data-uid="${u.id}">
      <td><div>${esc(u.email)}${u.email === me ? ' <span class="sub">(you)</span>' : ''}</div><input type="text" data-uname value="${esc(u.name)}" placeholder="Name" aria-label="Name for ${esc(u.email)}" style="min-width:9em;margin-top:4px"></td>
      <td><label class="hat"><input type="checkbox" data-uadmin ${u.role === 'admin' ? 'checked' : ''} ${u.email === me ? 'disabled title="You can’t remove your own admin access"' : ''}> Admin</label></td>
      <td><label class="hat"><input type="checkbox" data-uboard ${u.board || u.role === 'admin' ? 'checked' : ''} ${u.role === 'admin' ? 'disabled title="Admins already see everything"' : ''}> Board</label></td>
      <td>${latest.length ? latest.map((c) => `<span class="chip">${esc(c.name)} · ${esc(c.division)} ${esc(c.season_id)}</span>`).join(' ') : '<span class="sub">—</span>'}</td>
      <td class="sub">${esc(u.last_login_at || 'Never')}</td>
      <td class="row" style="flex-wrap:nowrap">${US.mail ? '<button class="mini" data-uemail>Email link</button>' : ''}<button class="mini" data-ucopy>Copy link</button>${u.email === me ? '' : '<button class="mini" data-uremove>Remove</button>'}</td></tr>`;
    }).join('');
}

$('userAdd').onsubmit = async (e) => {
  e.preventDefault();
  const body = { email: $('uEmail').value, name: $('uName').value, role: $('uRole').value, board: $('uBoard').checked, invite: US.mail && $('uInvite').checked };
  if (await act('POST', '/api/admin/users', body)) { $('uEmail').value = ''; $('uName').value = ''; $('uBoard').checked = false; loadUsers(); }
};

$('userTable').onchange = async (e) => {
  const tr = e.target.closest('[data-uid]'); if (!tr) return;
  const u = US.list.find((x) => x.id === Number(tr.dataset.uid));
  if (e.target.matches('[data-uadmin]')) {
    const on = e.target.checked;
    await act('PATCH', `/api/admin/users/${u.id}`, { role: on ? 'admin' : 'user' }, `${u.email} ${on ? 'is now an admin' : 'is no longer an admin'}`);
    loadUsers();
  }
  if (e.target.matches('[data-uboard]')) {
    const on = e.target.checked;
    await act('PATCH', `/api/admin/users/${u.id}`, { board: on }, `${u.email} ${on ? 'is on the Board of Directors' : 'is off the Board'}`);
    loadUsers();
  }
  if (e.target.matches('[data-uname]')) { if (await act('PATCH', `/api/admin/users/${u.id}`, { name: e.target.value }, 'Saved')) u.name = e.target.value; }
};

$('userTable').onclick = async (e) => {
  const tr = e.target.closest('[data-uid]'); if (!tr) return;
  const u = US.list.find((x) => x.id === Number(tr.dataset.uid));
  if (e.target.matches('[data-uemail]')) act('POST', `/api/admin/users/${u.id}/email-link`, {});
  if (e.target.matches('[data-ucopy]')) {
    const r = await act('POST', `/api/admin/users/${u.id}/link`, {});
    if (!r?.url) return;
    try { await navigator.clipboard.writeText(r.url); toast(`Sign-in link for ${u.email} copied — it works once, for 20 minutes`); }
    catch { prompt(`Sign-in link for ${u.email} (works once, for 20 minutes):`, r.url); }
  }
  if (e.target.matches('[data-uremove]')) {
    if (!confirm(`Remove ${u.email}? They'll be signed out and can't sign in again unless re-added.`)) return;
    if (await act('DELETE', `/api/admin/users/${u.id}`, {}, `Removed ${u.email}`)) loadUsers();
  }
};
