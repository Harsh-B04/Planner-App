// Private journal. Journal entries and the AI's notes about them are encrypted on this device
// before they're uploaded, so the server (and whoever runs it) only stores unreadable text.
//
// How the keys work:
//  - One random "journal key" encrypts everything.
//  - The server keeps two locked copies of it: one locked with your passphrase, one with your recovery code.
//  - Each device unlocks it once and keeps it (in this browser's IndexedDB), so you aren't asked again.
// Guarding against loss:
//  - You must save the recovery code before private mode turns on.
//  - Any device that's already unlocked can set a new passphrase or recovery code without the old one.
//  - The journal key is never deleted from a device automatically, only when you log out.
'use strict';

const V = { key: null, settingsAt: 0, setup: null };
const PASS_ITER = 310000, RECOVERY_ITER = 150000;
const te = new TextEncoder(), td = new TextDecoder();

function toB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const vaultInfo = () => data.settings?.vault || null;
const vaultOn = () => !!vaultInfo() && !vaultInfo().off;       // new writes get encrypted
const vaultLocked = () => !!vaultInfo() && !V.key;               // private, but this device can't read it yet

// ---------- the key on this device (IndexedDB keeps it as a real key object) ----------

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('planner-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  try {
    const db = await idb();
    return await new Promise(res => {
      const req = fn(db.transaction('k', mode).objectStore('k'));
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => res(null);
    });
  } catch { return null; }
}
const keyLoad = () => idbDo('readonly', s => s.get(data.user.id));
const keySave = k => idbDo('readwrite', s => s.put(k, data.user.id));
const keyForget = id => idbDo('readwrite', s => s.delete(id || data.user?.id || ''));

// ---------- locking and unlocking the journal key ----------

async function kek(secret, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function lockKey(raw, secret, iter) {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await kek(secret, salt, iter), raw);
  return { salt, iv: toB64(iv), key: toB64(ct), iter };
}
async function unlockKey(lock, secret) {
  // Throws if the passphrase/code is wrong (the encryption check fails).
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(lock.iv) }, await kek(secret, lock.salt, lock.iter), fromB64(lock.key));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}
const rawOf = key => crypto.subtle.exportKey('raw', key);

// Recovery code: 32 characters, easy to read and type (no I, L, O, U).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < 160; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{4}/g).join('-');
}
const normCode = s => String(s).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

// ---------- encrypting single fields ----------

async function seal(text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, V.key, te.encode(text)));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv); all.set(ct, 12);
  return 'enc:v1:' + toB64(all);
}
async function unseal(str, aad) {
  const all = fromB64(str.slice(7));
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: te.encode(aad) }, V.key, all.subarray(12)));
}
const isSealedObs = s => typeof s === 'string' && s.startsWith('{"enc"');

// Called by sync before uploading a row. Returns null to hold the row back (kept as "waiting").
async function sealRow(t, row) {
  const { _locked, _bad, ...r } = row;
  if (t !== 'entries' && t !== 'observations') return r;
  if (_locked || r.deleted) return r;                    // already encrypted, or deleted (server wipes the text)
  if (!vaultOn()) return r;
  if (!V.key) return null;                               // private, but not unlocked here: never upload readable text
  if (t === 'entries') return { ...r, body: await seal(r.body, 'entries:' + r.id) };
  return { ...r, data: JSON.stringify({ enc: await seal(r.data, 'observations:' + r.id) }) };
}

// Called by sync after downloading a row.
async function openRow(t, row) {
  const { _locked, _bad, ...r } = row;   // start clean: the result says whether it's still locked
  const sealed = t === 'entries' ? typeof r.body === 'string' && r.body.startsWith('enc:') : t === 'observations' && isSealedObs(r.data);
  if (!sealed) return r;
  if (!vaultInfo()) V.needSettings = true;   // another device turned private mode on: check settings now
  if (!V.key && !(await loadDeviceKey())) return { ...r, _locked: true };
  try {
    return t === 'entries'
      ? { ...r, body: await unseal(r.body, 'entries:' + r.id) }
      : { ...r, data: await unseal(JSON.parse(r.data).enc, 'observations:' + r.id) };
  } catch {
    return { ...r, _locked: true, _bad: true };
  }
}

async function loadDeviceKey() {
  if (V.key) return V.key;
  const k = data.user ? await keyLoad() : null;
  if (k) V.key = k;
  return V.key;
}

// After unlocking: open everything that arrived while this device was locked.
async function openLockedRows() {
  let n = 0;
  for (const t of ['entries', 'observations']) {
    for (const r of Object.values(data[t])) {
      if (!r._locked || r.deleted) continue;
      const opened = await openRow(t, r);
      if (!opened._locked) { data[t][r.id] = opened; n++; }
    }
  }
  if (n) { persist(); safeRender(); }
  return n;
}

// Keep this device's idea of the private-journal setting fresh (another device may have turned it on).
async function refreshSettings(force) {
  if (!force && Date.now() - V.settingsAt < 60000) return;
  try {
    const was = JSON.stringify(vaultInfo());
    data.settings = (await api('/api/me')).settings;
    V.settingsAt = Date.now();
    persist();
    if (JSON.stringify(vaultInfo()) !== was) { await loadDeviceKey(); renderVaultBanner(); if (!$('#view-settings').hidden) renderVault(); }
  } catch {}
}

async function vaultInit() {
  await loadDeviceKey();
  if (V.key) await openLockedRows();
  renderVaultBanner();
}

// Re-upload every entry and note so the server copy matches the current mode (encrypted or not).
function reuploadAll() {
  let n = 0;
  for (const t of ['entries', 'observations']) {
    for (const r of Object.values(data[t])) {
      if (r.deleted || r._locked) continue;
      r.updated_at = nextTime(r);
      markDirty(t, r.id);
      n++;
    }
  }
  persist();
  return n;
}

async function saveVault(vault) {
  data.settings = (await api('/api/settings', { method: 'PUT', body: { vault } })).settings;
  V.settingsAt = Date.now();
  persist();
}

// ---------- the unlock banner (Journal) ----------

function renderVaultBanner() {
  const el = $('#vault-banner');
  if (!el) return;
  const locked = data.user && vaultLocked();
  el.hidden = !locked;
  $('#composer-card').hidden = !!locked;
  if (!locked) return;
  const useCode = el.dataset.mode === 'code';
  el.innerHTML = `<h2>🔒 Your journal is private</h2>
    <p class="muted small">${useCode ? 'Type your recovery code (the dashes are optional).' : 'Enter your passphrase once to read and write it on this device.'}</p>
    <form class="inline" id="vault-unlock">
      <input id="vault-secret" type="${useCode ? 'text' : 'password'}" autocomplete="${useCode ? 'off' : 'current-password'}" placeholder="${useCode ? 'XXXX-XXXX-…' : 'Passphrase'}" required>
      <button class="primary" type="submit">Unlock</button>
    </form>
    <p class="error" id="vault-err"></p>
    <button class="link" type="button" id="vault-mode">${useCode ? 'Use my passphrase instead' : 'Forgot it? Use your recovery code'}</button>`;
}

$('#vault-banner').addEventListener('click', e => {
  if (e.target.id !== 'vault-mode') return;
  const el = $('#vault-banner');
  el.dataset.mode = el.dataset.mode === 'code' ? '' : 'code';
  renderVaultBanner();
});

$('#vault-banner').addEventListener('submit', async e => {
  e.preventDefault();
  const el = $('#vault-banner');
  const useCode = el.dataset.mode === 'code';
  const secret = useCode ? normCode($('#vault-secret').value) : $('#vault-secret').value;
  const btn = el.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Unlocking…';
  try {
    await refreshSettings(true);
    const v = vaultInfo();
    if (!v) { renderVaultBanner(); return; }
    let key;
    try { key = await unlockKey(useCode ? v.recovery : v.pass, secret); }
    catch { $('#vault-err').textContent = useCode ? "That recovery code doesn't match." : "That passphrase doesn't match."; return; }
    V.key = key;
    await keySave(key);
    await openLockedRows();
    el.dataset.mode = '';
    renderVaultBanner();
    renderEntries();
    sync();
    if (useCode) {
      toast('Unlocked. Now set a new passphrase in Settings → Private journal.');
      show('settings');
      V.setup = { step: 'newpass' };
      renderVault();
    } else toast('Unlocked on this device.');
  } finally {
    btn.disabled = false; btn.textContent = 'Unlock';
  }
});

// ---------- Settings card ----------

function renderVault() {
  const box = $('#vault');
  const v = vaultInfo();
  const s = V.setup;
  let h;
  if (s?.step === 'pass' || s?.step === 'newpass') {
    h = `<p class="small">${s.step === 'pass' ? 'Choose a passphrase. You\'ll type it once on each device.' : 'Choose a new passphrase.'} At least 8 characters; a short sentence is easiest to remember.</p>
      <label>Passphrase <input type="password" id="vp1" autocomplete="new-password"></label>
      <label>Type it again <input type="password" id="vp2" autocomplete="new-password"></label>
      <div class="row"><button class="primary" data-vact="${s.step === 'pass' ? 'makecode' : 'savepass'}">Continue</button><button data-vact="cancel">Cancel</button></div>`;
  } else if (s?.step === 'code') {
    h = `<p class="small"><b>Save this recovery code.</b> It's the only way back in if you forget your passphrase and no device is unlocked. Nobody, including whoever runs this app, can recover your journal without it.</p>
      <div class="code-box" id="vcode">${s.code}</div>
      <div class="row"><button data-vact="copy">Copy</button><button data-vact="download">Download as a file</button></div>
      <label class="check"><input type="checkbox" id="vsaved"> I've saved my recovery code somewhere safe</label>
      <div class="row"><button class="primary" data-vact="${s.change ? 'savecode' : 'enable'}" id="vfinish" disabled>${s.change ? 'Use this new code' : 'Turn on private journal'}</button><button data-vact="cancel">Cancel</button></div>`;
  } else if (s?.step === 'working') {
    h = `<p class="small">${esc(s.text)}</p>`;
  } else if (!v || v.off) {
    h = `<p class="small">Encrypt your journal on your own devices before it's uploaded. The server only keeps unreadable text, so nobody else can read it, including whoever runs this app.</p>
      <ul class="small muted tight">
        <li>You set a passphrase and save a recovery code.</li>
        <li>Each device asks for the passphrase once, then stays unlocked.</li>
        <li>The AI can still read new entries: each one is sent for that one reading and nothing readable is kept.</li>
        <li>Tasks and plans stay unencrypted, so reminders can show their names.</li>
      </ul>
      ${v?.off ? '<p class="small">Switching off is still finishing on another device.</p>' : '<div class="row"><button class="primary" data-vact="start">Turn on private journal</button></div>'}`;
  } else if (!V.key) {
    h = '<p class="small">🔒 On. This device isn\'t unlocked yet. Unlock it from the Journal tab.</p>';
  } else {
    h = `<p class="small">🔒 On. This device is unlocked, so you won't be asked again here.</p>
      <div class="row"><button data-vact="changepass">Change passphrase</button><button data-vact="newcode">New recovery code</button></div>
      <details class="danger-zone"><summary>Turn off private journal</summary>
        <p class="small">Your entries are decrypted and uploaded as normal text again. Nothing is lost.</p>
        <button class="danger" data-vact="disable">Turn off</button></details>`;
  }
  box.innerHTML = h + '<p class="small" id="vmsg" role="status"></p>';
}

async function vaultAction(act, btn) {
  const msg = t => { const m = $('#vmsg'); if (m) m.textContent = t; };
  const v = vaultInfo();
  if (act === 'cancel') { V.setup = null; return renderVault(); }
  if (act === 'start') { V.setup = { step: 'pass' }; return renderVault(); }
  if (act === 'changepass') { V.setup = { step: 'newpass' }; return renderVault(); }
  if (act === 'newcode') { V.setup = { step: 'code', code: newRecoveryCode(), change: true }; return renderVault(); }
  if (act === 'makecode' || act === 'savepass') {
    const p1 = $('#vp1').value, p2 = $('#vp2').value;
    if (p1.length < 8) return msg('Use at least 8 characters.');
    if (p1 !== p2) return msg("The two don't match.");
    if (act === 'makecode') { V.setup = { step: 'code', code: newRecoveryCode(), pass: p1 }; return renderVault(); }
    btn.disabled = true;
    try {
      await saveVault({ ...v, pass: await lockKey(await rawOf(V.key), p1, PASS_ITER) });
      V.setup = null; renderVault(); msg('New passphrase saved. Other unlocked devices stay unlocked.');
    } catch (err) { msg(err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message); btn.disabled = false; }
    return;
  }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(V.setup.code); msg('Copied.'); } catch { msg('Select the code and copy it by hand.'); }
    return;
  }
  if (act === 'download') {
    const text = `Planner: private journal recovery code\n\n${V.setup.code}\n\nAccount: ${data.user.username}\nMade: ${new Date().toLocaleString()}\n\nKeep this safe. With it you can unlock your journal if you forget your passphrase.\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'planner-recovery-code.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  if (act === 'savecode') {
    btn.disabled = true;
    try {
      await saveVault({ ...v, recovery: await lockKey(await rawOf(V.key), normCode(V.setup.code), RECOVERY_ITER) });
      V.setup = null; renderVault(); msg('New recovery code saved. The old one no longer works.');
    } catch (err) { msg(err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message); btn.disabled = false; }
    return;
  }
  if (act === 'enable') {
    const { pass, code } = V.setup;
    V.setup = { step: 'working', text: 'Setting up…' }; renderVault();
    try {
      // 1. Make the key and save its locked copies on the server. If this fails, nothing has changed.
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
      const vault = { v: 1, pass: await lockKey(raw, pass, PASS_ITER), recovery: await lockKey(raw, normCode(code), RECOVERY_ITER), created_at: Date.now() };
      await saveVault(vault);
      // 2. Keep the key on this device.
      V.key = key;
      await keySave(key);
      // 3. Replace the readable copies on the server with encrypted ones.
      const n = reuploadAll();
      V.setup = { step: 'working', text: `Encrypting ${n} item${n === 1 ? '' : 's'}…` }; renderVault();
      await sync();
      V.setup = null; renderVault();
      msg(waitingCount() ? 'Private journal is on. Some items will finish encrypting when you are back online.' : 'Private journal is on. Everything is encrypted.');
    } catch (err) {
      V.setup = null; renderVault();
      msg((err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message) + ' Nothing was changed.');
    }
    return;
  }
  if (act === 'disable') {
    if (!confirm('Turn off the private journal? Your entries will be stored as normal text again.')) return;
    V.setup = { step: 'working', text: 'Decrypting and re-uploading…' }; renderVault();
    try {
      await saveVault({ ...v, off: true });       // other devices stop encrypting, and keep their key
      reuploadAll();
      await sync();
      if (waitingCount()) throw new Error('Some items are still uploading. Try again when you are online.');
      await saveVault(null);
      V.setup = null; renderVault(); msg('Private journal is off.');
    } catch (err) {
      V.setup = null; renderVault(); msg(err.message === 'Failed to fetch' ? 'You need internet for this.' : err.message);
    }
  }
}

$('#vault').addEventListener('click', e => {
  const btn = e.target.closest('[data-vact]');
  if (btn) vaultAction(btn.dataset.vact, btn);
});
$('#vault').addEventListener('change', e => {
  if (e.target.id === 'vsaved') $('#vfinish').disabled = !e.target.checked;
});

// Export: put the readable text back in place of the encrypted copies.
function decryptExport(x) {
  for (const e of x.entries || []) {
    const local = data.entries[e.id];
    if (String(e.body).startsWith('enc:') && local && !local._locked) e.body = local.body;
  }
  for (const o of x.noted || []) {
    const local = data.observations[o.id];
    if (o.data && o.data.enc && local && !local._locked) { try { o.data = JSON.parse(local.data); } catch {} }
  }
  return x;
}
