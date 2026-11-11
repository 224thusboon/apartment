/**
 * การเข้าสู่ระบบ
 * - ผู้ดูแล: อีเมล + รหัสผ่านของแต่ละคน (collection admins)
 *   รหัส master = Script Property ADMIN_PASSWORD ใช้ล็อกอินด้วยชื่อ "master"
 *   ไว้ตั้งผู้ดูแลคนแรก / กู้คืนเท่านั้น
 * - ผู้เช่า: เลขห้อง + PIN 6 หลัก (ผู้ดูแลออก PIN ให้ตอนย้ายเข้า)
 * - ใส่ผิด 5 ครั้ง ล็อก 15 นาที (แยกตามห้อง / อีเมล)
 * - ย้ายออก / ออก PIN ใหม่ / ปิดผู้ดูแล -> ตัดการเข้าระบบเดิมทุกเครื่องทันที
 * session token เก็บแบบ hash ใน Firestore (sessions)
 */

const SESSION_DAYS = { admin: 7, tenant: 30 };
const MAX_FAIL = 5;
const LOCK_SEC = 15 * 60;

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** hash รหัสผ่านแบบมี salt และวนหลายรอบ (ช้าลงสำหรับคนเดารหัส) */
function pwHash_(salt, pw) {
  let h = salt + ':' + pw;
  for (let i = 0; i < 300; i++) h = hash_(h + salt);
  return h;
}

// ---------- จำกัดการใส่ผิด ----------

function checkLock_(key) {
  if (CacheService.getScriptCache().get('lock_' + key)) {
    throw new Error('ใส่ผิดเกิน ' + MAX_FAIL + ' ครั้ง กรุณารอ 15 นาทีแล้วลองใหม่');
  }
}

function loginFailed_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get('fail_' + key) || 0) + 1;
  if (n >= MAX_FAIL) {
    c.put('lock_' + key, '1', LOCK_SEC);
    c.remove('fail_' + key);
    return 'ใส่ผิดเกิน ' + MAX_FAIL + ' ครั้ง ล็อก 15 นาที';
  }
  c.put('fail_' + key, String(n), LOCK_SEC);
  return 'เหลือโอกาสอีก ' + (MAX_FAIL - n) + ' ครั้ง';
}

function clearFail_(key) {
  CacheService.getScriptCache().remove('fail_' + key);
}

// ---------- session ----------

function newSession_(info) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const exp = new Date(Date.now() + (SESSION_DAYS[info.role] || 7) * 864e5);
  fsSet_(COL.SESSIONS, hash_(token), Object.assign({
    roomId: '', tenantId: '', tenancyId: '', adminId: '', email: '', name: '',
  }, info, { expiresAt: exp.toISOString(), createdAt: new Date().toISOString() }));
  return token;
}

/** คืนข้อมูล session หรือ throw ถ้าไม่ผ่าน */
function requireSession_(token, role) {
  if (!token) throw new Error('AUTH: กรุณาเข้าสู่ระบบ');
  const key = hash_(token);
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sess_' + key);
  let s = hit ? JSON.parse(hit) : null;
  if (!s) {
    s = fsGet_(COL.SESSIONS, key);
    if (s) cache.put('sess_' + key, JSON.stringify(s), 21600);
  }
  if (!s || new Date(s.expiresAt) < new Date()) throw new Error('AUTH: เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  // session รุ่นเก่า (ก่อนมีระบบตัดการเข้าระบบ) ให้ล็อกอินใหม่
  if ((s.role === 'tenant' && !s.tenancyId) || (s.role === 'admin' && !s.adminId)) {
    throw new Error('AUTH: กรุณาเข้าสู่ระบบใหม่');
  }
  if (role && s.role !== role) throw new Error('AUTH: ไม่มีสิทธิ์ใช้งานส่วนนี้');
  s.key = key;
  return s;
}

/** ลบ session ทุกเครื่องที่ตรงเงื่อนไข เช่น {tenancyId:'x'} หรือ {adminId:'y'} */
function revokeSessions_(eq) {
  const rows = fsWhere_(COL.SESSIONS, eq);
  const cache = CacheService.getScriptCache();
  rows.forEach(function (r) {
    cache.remove('sess_' + r.id);
    fsDelete_(COL.SESSIONS, r.id);
  });
  return rows.length;
}

// ---------- ล็อกอิน ----------

function apiLogin(payload) {
  if (payload.mode === 'admin') return adminLogin_(payload);

  const roomId = String(payload.roomId || '').trim();
  const lockKey = 'room_' + roomId;
  checkLock_(lockKey);
  const room = fsGet_(COL.ROOMS, roomId);
  const tenancy = room && room.currentTenancyId ? fsGet_(COL.TENANCIES, room.currentTenancyId) : null;
  if (!tenancy || !tenancy.pinHash || tenancy.pinHash !== hash_(roomId + ':' + String(payload.pin || '').trim())) {
    const msg = loginFailed_(lockKey);
    throw new Error('เลขห้องหรือ PIN ไม่ถูกต้อง (' + msg + ')');
  }
  clearFail_(lockKey);
  const token = newSession_({ role: 'tenant', roomId: roomId, tenantId: tenancy.tenantId, tenancyId: tenancy.id, name: tenancy.tenantName });
  audit_({ role: 'tenant', roomId: roomId, name: tenancy.tenantName }, 'ผู้เช่าเข้าสู่ระบบ', 'ห้อง ' + roomId);
  return { token: token, role: 'tenant', roomId: roomId };
}

function adminLogin_(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const pw = String(payload.password || '');
  const lockKey = 'admin_' + (email || 'master');
  checkLock_(lockKey);

  if (email === 'master') {
    const master = prop_('ADMIN_PASSWORD');
    if (!master || pw !== master) throw new Error('รหัสผ่านไม่ถูกต้อง (' + loginFailed_(lockKey) + ')');
    clearFail_(lockKey);
    const who = { role: 'admin', adminId: 'master', email: 'master', name: 'master' };
    audit_(who, 'เข้าสู่ระบบด้วยรหัส master', '');
    return { token: newSession_(who), role: 'admin', name: 'master', master: true };
  }

  const a = fsWhere_(COL.ADMINS, { email: email })[0];
  if (!a || !a.active || a.passHash !== pwHash_(a.salt, pw)) {
    const msg = loginFailed_(lockKey);
    audit_({ role: 'admin', email: email }, 'ผู้ดูแลล็อกอินไม่สำเร็จ', email);
    throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง (' + msg + ')');
  }
  clearFail_(lockKey);
  const who = { role: 'admin', adminId: a.id, email: a.email, name: a.name || a.email };
  fsUpdate_(COL.ADMINS, a.id, { lastLoginAt: new Date().toISOString() });
  audit_(who, 'ผู้ดูแลเข้าสู่ระบบ', '');
  return { token: newSession_(who), role: 'admin', name: who.name };
}

function apiLogout(token) {
  if (token) {
    CacheService.getScriptCache().remove('sess_' + hash_(token));
    fsDelete_(COL.SESSIONS, hash_(token));
  }
  return true;
}

function apiWhoAmI(token) {
  const s = requireSession_(token);
  return { role: s.role, roomId: s.roomId, name: s.name || '', master: s.adminId === 'master' };
}

function randomPin_() {
  let p = '';
  for (let i = 0; i < 6; i++) p += Math.floor(Math.random() * 10);
  return p;
}

// ---------- จัดการผู้ดูแล ----------

function apiListAdmins(token) {
  requireSession_(token, 'admin');
  return sortBy_(fsList_(COL.ADMINS), 'email').map(function (a) {
    return { id: a.id, email: a.email, name: a.name, active: a.active, lastLoginAt: a.lastLoginAt || '', createdBy: a.createdBy || '' };
  });
}

/** เพิ่ม/แก้ผู้ดูแล  data: {id?, email, name, password?, active} */
function apiSaveAdmin(token, data) {
  const me = requireSession_(token, 'admin');
  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('อีเมลไม่ถูกต้อง');
  const pw = String(data.password || '');
  if (pw && pw.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัว');
  const dup = fsWhere_(COL.ADMINS, { email: email }).filter(function (x) { return x.id !== data.id; });
  if (dup.length) throw new Error('มีผู้ดูแลอีเมลนี้แล้ว');

  const old = data.id ? fsGet_(COL.ADMINS, data.id) : null;
  if (!old && !pw) throw new Error('กรุณาตั้งรหัสผ่านเริ่มต้น');
  const active = data.active !== false && data.active !== 'false';
  if (old && old.id === me.adminId && !active) throw new Error('ปิดบัญชีตัวเองไม่ได้');

  const doc = { email: email, name: String(data.name || '').trim() || email, active: active };
  if (pw) { doc.salt = Utilities.getUuid(); doc.passHash = pwHash_(doc.salt, pw); }
  let saved;
  if (old) {
    saved = fsUpdate_(COL.ADMINS, old.id, doc);
  } else {
    doc.createdAt = new Date().toISOString();
    doc.createdBy = me.email;
    saved = fsSet_(COL.ADMINS, null, doc);
  }
  // ปิดบัญชี หรือเปลี่ยนรหัส -> ตัดการเข้าระบบเดิมของคนนั้น
  if (old && (!active || pw)) revokeSessions_({ adminId: old.id });
  audit_(me, old ? 'แก้ไขผู้ดูแล' : 'เพิ่มผู้ดูแล', email,
    (old && !active ? 'ปิดใช้งาน' : '') + (pw ? ' ตั้งรหัสผ่านใหม่' : ''));
  return { id: saved.id };
}

function apiChangeMyPassword(token, oldPw, newPw) {
  const me = requireSession_(token, 'admin');
  if (me.adminId === 'master') throw new Error('รหัส master เปลี่ยนได้ที่ Script properties ใน Apps Script');
  if (String(newPw || '').length < 8) throw new Error('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัว');
  const a = fsGet_(COL.ADMINS, me.adminId);
  if (!a || a.passHash !== pwHash_(a.salt, String(oldPw || ''))) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  const salt = Utilities.getUuid();
  fsUpdate_(COL.ADMINS, a.id, { salt: salt, passHash: pwHash_(salt, String(newPw)) });
  // ออกจากระบบเครื่องอื่นทั้งหมด ยกเว้นเครื่องนี้
  fsWhere_(COL.SESSIONS, { adminId: a.id }).forEach(function (r) {
    if (r.id !== me.key) { CacheService.getScriptCache().remove('sess_' + r.id); fsDelete_(COL.SESSIONS, r.id); }
  });
  audit_(me, 'เปลี่ยนรหัสผ่านตัวเอง', me.email);
  return true;
}
