/* ==========================================================================
 * admin.js
 * Client-side admin lock for the System and Method tabs.
 * Check: PBKDF2-SHA256(password, salt + ':' + username, iterations) compared
 * with the stored hash. Neither username nor password is stored in clear text.
 * ========================================================================== */
(function (FP) {
  'use strict';
  const TABS = ['system', 'method'];
  const KEY = 'fallpipe.admin';
  let ok = false;
  try { ok = sessionStorage.getItem(KEY) === '1'; } catch (e) { /* ignore */ }

  async function derive(user, pass, salt, iter) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt + ':' + user.trim().toLowerCase()), iterations: iter }, key, 256);
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

  async function login(user, pass) {
    const C = FP.ADMIN_CRED;
    if (!C) return { ok: false, msg: 'Login is not available.' };
    if (!(self.crypto && crypto.subtle)) return { ok: false, msg: 'This browser blocks secure hashing here. Open the page over https (GitHub Pages) or localhost.' };
    const h = await derive(user, pass, C.salt, C.iter);
    if (!same(h, C.hash)) return { ok: false, msg: 'Wrong username or password.' };
    ok = true; try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
    apply(); return { ok: true };
  }
  function logout() { ok = false; try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } apply(); }

  function apply() {
    document.querySelectorAll('.tabs button[data-tab]').forEach(b => { if (TABS.includes(b.dataset.tab)) b.hidden = !ok; });
    const btn = document.getElementById('adminBtn');
    if (btn) { btn.textContent = ok ? 'Admin: log out' : 'Admin'; btn.setAttribute('aria-pressed', ok ? 'true' : 'false'); }
    if (!ok) {
      const cur = document.querySelector('.tabs button[aria-selected="true"]');
      if (cur && TABS.includes(cur.dataset.tab) && FP.ui && FP.ui.switchTab) FP.ui.switchTab('sim');
    }
  }

  function openDialog() {
    if (ok) { logout(); return; }
    const dlg = document.getElementById('adminDlg');
    document.getElementById('adminMsg').textContent = '';
    document.getElementById('adminUser').value = ''; document.getElementById('adminPass').value = '';
    dlg.showModal(); document.getElementById('adminUser').focus();
  }

  function init() {
    const btn = document.getElementById('adminBtn'); if (!btn) return;
    btn.addEventListener('click', openDialog);
    document.getElementById('adminForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('adminMsg'); msg.textContent = 'Checking...';
      const r = await login(document.getElementById('adminUser').value, document.getElementById('adminPass').value);
      document.getElementById('adminPass').value = '';
      if (r.ok) document.getElementById('adminDlg').close(); else msg.textContent = r.msg;
    });
    document.getElementById('adminCancel').addEventListener('click', () => document.getElementById('adminDlg').close());
    apply();
  }

  FP.admin = { allowed: (tab) => ok || !TABS.includes(tab), isAdmin: () => ok, init, apply, derive, TABS };
})(self.FP = self.FP || {});
