/* Sign in by emailed link. /signin asks for an email; the link in the email
   comes back here as /signin?token=… and needs one press to spend it, so mail
   scanners that open links don't use up someone's sign-in. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = new URLSearchParams(location.search);
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
}
const head = (league, title) => `<img class="gatecrest" src="/img/crest-180.png" alt="" width="84" height="84"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">${esc(league)}</small>${esc(title)}</h1>`;

function emailForm(league) {
  $('#gate').innerHTML = `<form class="gate" id="f">${head(league, 'Sign in')}
    <p class="note">Enter your email and we'll send you a sign-in link. Only people the league has added can sign in.</p>
    <input type="email" id="em" placeholder="you@example.com" autocomplete="email" required aria-label="Email">
    <p class="err-text" id="er"></p><button class="btn primary" type="submit">Email me a sign-in link</button>
    <a href="#" id="pw" class="note">Sign in with a password</a></form>`;
  $('#em').focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#em').value.trim();
    try {
      await post('/api/auth/link', { email, next: q.get('next') || '/' });
      $('#gate').innerHTML = `<div class="gate">${head(league, 'Check your email')}
        <p>If <b>${esc(email)}</b> is on the league's list, a sign-in link is on its way. It works once and expires in 20 minutes.</p>
        <p class="note">Nothing after a few minutes? Check spam, or ask a league admin to add your address.</p>
        <a href="${esc(location.pathname + location.search)}" class="note">Use a different email</a></div>`;
    } catch (err) { $('#er').textContent = err.message; }
  };
  $('#pw').onclick = (e) => { e.preventDefault(); passwordForm(league); };
}

function passwordForm(league) {
  $('#gate').innerHTML = `<form class="gate" id="f">${head(league, 'Password sign-in')}
    <input type="text" id="lu" placeholder="Username" autocomplete="username" required aria-label="Username">
    <input type="password" id="lp" placeholder="Password" autocomplete="current-password" required aria-label="Password">
    <p class="err-text" id="er"></p><button class="btn primary" type="submit">Sign in</button>
    <a href="${esc(location.pathname + location.search)}" class="note">← Sign in by email instead</a></form>`;
  $('#lu').focus();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { await post('/api/login', { username: $('#lu').value, password: $('#lp').value }); location.href = q.get('next') || '/'; }
    catch (err) { $('#er').textContent = err.message; }
  };
}

function confirmLink(league, token) {
  history.replaceState(null, '', '/signin'); // keep the token out of history and bookmarks
  $('#gate').innerHTML = `<form class="gate" id="f">${head(league, 'Welcome back')}
    <p class="err-text" id="er"></p><button class="btn primary" type="submit">Continue to the league site</button></form>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await post('/api/auth/verify', { token }); location.href = r.next || '/'; }
    catch (err) {
      $('#er').textContent = err.message;
      $('#f button').outerHTML = `<a class="btn primary" href="/signin">Get a new link</a>`;
    }
  };
}

(async () => {
  const [home, me] = await Promise.all(['/api/home', '/api/me'].map((u) => fetch(u, { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}))));
  const league = home.league || 'SE Baseball';
  const token = q.get('token');
  if (token) return confirmLink(league, token);
  if (me.user) { location.href = q.get('next') || '/'; return; }
  emailForm(league);
})();
