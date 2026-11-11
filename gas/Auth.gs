/**
 * การเข้าสู่ระบบ
 * - แอดมิน: รหัสผ่านเดียว (Script Property ADMIN_PASSWORD)
 * - ผู้เช่า: เลขห้อง + PIN 6 หลัก (แอดมินออก PIN ให้ตอนย้ายเข้า)
 * session token เก็บใน Firestore (sessions) อายุ 30 วัน
 */

const SESSION_DAYS = 30;

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function newSession_(role, roomId, tenantId) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5);
  fsSet_(COL.SESSIONS, hash_(token), { role: role, roomId: roomId || '', tenantId: tenantId || '', expiresAt: exp.toISOString() });
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
    // เก็บในแคชสูงสุด 6 ชม. (ขีดจำกัดของ CacheService) จะได้ไม่ต้องถาม Firestore ทุกครั้ง
    if (s) cache.put('sess_' + key, JSON.stringify(s), 21600);
  }
  if (!s || new Date(s.expiresAt) < new Date()) throw new Error('AUTH: เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (role && s.role !== role) throw new Error('AUTH: ไม่มีสิทธิ์ใช้งานส่วนนี้');
  return s;
}

function apiLogin(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    if (payload.mode === 'admin') {
      const pw = prop_('ADMIN_PASSWORD');
      if (!pw || payload.password !== pw) throw new Error('รหัสผ่านไม่ถูกต้อง');
      return { token: newSession_('admin'), role: 'admin' };
    }
    const roomId = String(payload.roomId || '').trim();
    const room = fsGet_(COL.ROOMS, roomId);
    if (!room || !room.currentTenancyId) throw new Error('ไม่พบผู้เช่าในห้องนี้');
    const tenancy = fsGet_(COL.TENANCIES, room.currentTenancyId);
    if (!tenancy || tenancy.pinHash !== hash_(roomId + ':' + String(payload.pin || '').trim())) {
      throw new Error('เลขห้องหรือ PIN ไม่ถูกต้อง');
    }
    return { token: newSession_('tenant', roomId, tenancy.tenantId), role: 'tenant', roomId: roomId };
  } finally {
    lock.releaseLock();
  }
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
  return { role: s.role, roomId: s.roomId };
}

function randomPin_() {
  let p = '';
  for (let i = 0; i < 6; i++) p += Math.floor(Math.random() * 10);
  return p;
}
