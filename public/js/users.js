/* Users tab: who may sign in, and whether they're a user (seat counts and
   draft boards) or an admin (everything). Shares helpers with app.js. */
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
  $('userTable').innerHTML = '<tr><th>Email</th><th>Name</th><th>Role</th><th>Last sign-in (UTC)</th><th></th></tr>'
    + (US.list.length ? '' : '<tr><td colspan="5" class="note">Nobody yet.</td></tr>')
    + US.list.map((u) => `<tr data-uid="${u.id}">
      <td>${esc(u.email)}${u.email === me ? ' <span class="sub">(you)</span>' : ''}</td>
      <td><input type="text" data-uname value="${esc(u.name)}" aria-label="Name" style="min-width:9em"></td>
      <td><select data-urole aria-label="Role" ${u.email === me ? 'disabled' : ''}><option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
      <td class="sub">${esc(u.last_login_at || 'Never')}</td>
      <td class="row" style="flex-wrap:nowrap">${US.mail ? '<button class="mini" data-uemail>Email link</button>' : ''}<button class="mini" data-ucopy>Copy link</button>${u.email === me ? '' : '<button class="mini" data-uremove>Remove</button>'}</td></tr>`).join('');
}

$('userAdd').onsubmit = async (e) => {
  e.preventDefault();
  const body = { email: $('uEmail').value, name: $('uName').value, role: $('uRole').value, invite: US.mail && $('uInvite').checked };
  if (await act('POST', '/api/admin/users', body)) { $('uEmail').value = ''; $('uName').value = ''; loadUsers(); }
};

$('userTable').onchange = async (e) => {
  const tr = e.target.closest('[data-uid]'); if (!tr) return;
  const u = US.list.find((x) => x.id === Number(tr.dataset.uid));
  if (e.target.matches('[data-urole]')) {
    if (!(await act('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value }, `${u.email} is now ${e.target.value === 'admin' ? 'an admin' : 'a user'}`))) e.target.value = u.role;
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
