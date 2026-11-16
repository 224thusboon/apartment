/**
 * บันทึกการทำงาน (audit log) + สำรองข้อมูล
 */

// ---------- บันทึกการทำงาน ----------

/**
 * บันทึกว่าใครทำอะไร  who: session (หรือ {role,email,name,roomId})
 * ไม่ทำให้งานหลักล้มถ้าบันทึกไม่สำเร็จ
 */
function audit_(who, action, target, detail) {
  try {
    const now = new Date();
    const date = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
    fsSet_(COL.AUDIT, null, {
      at: now.toISOString(), date: date, month: date.slice(0, 7),
      role: (who && who.role) || 'system',
      email: (who && who.email) || '',
      name: (who && (who.name || who.email)) || (who && who.role === 'tenant' ? 'ผู้เช่า' : 'ระบบ'),
      roomId: (who && who.roomId) || '',
      action: action, target: target || '', detail: detail || '',
    });
  } catch (e) {
    Logger.log('บันทึก audit ไม่สำเร็จ: ' + e.message);
  }
}

/** month: 'YYYY-MM' หรือ 'all' (ทั้งหมดที่เก็บไว้) */
function apiListAudit(token, month) {
  requireSession_(token, 'admin');
  const rows = month === 'all' ? fsList_(COL.AUDIT) : fsWhere_(COL.AUDIT, { month: month });
  return sortBy_(rows, 'at', true);
}

const AUDIT_KEEP_DAYS = 120; // เก็บบันทึกการทำงาน 120 วัน

/** ลบบันทึกการทำงานที่เก่ากว่า AUDIT_KEEP_DAYS (เรียกจาก weeklyBackup หลังสำรองข้อมูลแล้ว) */
function purgeAudit_() {
  const cutoff = new Date(Date.now() - AUDIT_KEEP_DAYS * 864e5).toISOString();
  const old = fsList_(COL.AUDIT).filter(function (a) { return a.at && a.at < cutoff; });
  const base = fsBase_();
  for (let i = 0; i < old.length; i += 50) {
    UrlFetchApp.fetchAll(old.slice(i, i + 50).map(function (a) {
      return fsReq_(base + '/' + COL.AUDIT + '/' + encodeURIComponent(a.id), 'delete');
    }));
  }
  return old.length;
}

// ---------- สำรองข้อมูล ----------

const BACKUP_KEEP = 12; // เก็บไฟล์สำรองล่าสุด 12 ชุด (~3 เดือนถ้าสำรองทุกสัปดาห์)

/** ตั้ง trigger รายสัปดาห์ให้เรียกฟังก์ชันนี้ (ตั้งที่เมนู ทริกเกอร์ ใน Apps Script) */
function weeklyBackup() {
  const name = backupFirestore_();
  let purged = 0;
  try { purged = purgeAudit_(); } catch (e) { Logger.log('ลบบันทึกเก่าไม่สำเร็จ: ' + e.message); }
  audit_({ role: 'system', name: 'ระบบ' }, 'สำรองข้อมูลอัตโนมัติ', name,
    purged ? 'ลบบันทึกการทำงานเก่ากว่า ' + AUDIT_KEEP_DAYS + ' วัน ' + purged + ' รายการ' : '');
}

function apiBackupNow(token) {
  const me = requireSession_(token, 'admin');
  const name = backupFirestore_();
  audit_(me, 'สำรองข้อมูล', name);
  return name;
}

/** ส่งออกทุก collection (ยกเว้น sessions) เป็นไฟล์ JSON ในโฟลเดอร์ "สำรองข้อมูล" */
function backupFirestore_() {
  const s = getSettings_();
  let folderId = s.backupFolderId;
  if (!folderId) {
    folderId = DriveApp.getFolderById(s.rootFolderId).createFolder('สำรองข้อมูล').getId();
    fsUpdate_(COL.SETTINGS, 'main', { backupFolderId: folderId });
    clearSettingsCache_();
  }
  const cols = Object.keys(COL).map(function (k) { return COL[k]; })
    .filter(function (c) { return c !== COL.SESSIONS; });
  const res = fsMulti_(cols.map(function (c) { return { list: c }; }));
  const data = {};
  cols.forEach(function (c, i) { data[c] = res[i]; });
  // ไม่เก็บ hash รหัสผ่านผู้ดูแลในไฟล์สำรอง
  data[COL.ADMINS] = (data[COL.ADMINS] || []).map(function (a) {
    return { id: a.id, email: a.email, name: a.name, active: a.active };
  });

  const stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmm');
  const name = 'backup-' + stamp + '.json';
  const folder = DriveApp.getFolderById(folderId);
  folder.createFile(name, JSON.stringify({ createdAt: new Date().toISOString(), data: data }), 'application/json');

  // ลบชุดเก่าเกิน BACKUP_KEEP (ย้ายลงถังขยะ กู้คืนได้ 30 วัน)
  const files = [];
  const it = folder.getFilesByType('application/json');
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  return name;
}

// ---------- ล้างข้อมูล (reset) ----------

/**
 * ล้างข้อมูลการใช้งานทั้งหมด เพื่อเริ่มใช้งานจริง  ต้องยืนยันด้วยรหัส master
 * - สำรองข้อมูลทั้งหมดไว้ก่อนเสมอ (กู้คืนได้จากไฟล์สำรอง)
 * - ลบ: ผู้เช่า การเข้าพัก มิเตอร์ ใบแจ้งหนี้ ใบเสร็จ สลิป งานซ่อม รายการเรียกเก็บ บัญชี ตัวนับเลขที่ บันทึกการทำงาน
 *   และ session ผู้เช่าทั้งหมด
 * - คงไว้: การตั้งค่า ผู้ดูแล (รวมลายเซ็น) และห้อง (รีเซ็ตเป็นห้องว่าง)
 * - ไฟล์ใน Drive ไม่ถูกลบ
 */
function apiResetDatabase(token, masterPassword) {
  const me = requireSession_(token, 'admin');
  const lockKey = 'reset';
  checkLock_(lockKey);
  const master = prop_('ADMIN_PASSWORD');
  if (!master || String(masterPassword || '') !== master) {
    throw new Error('รหัส master ไม่ถูกต้อง (' + loginFailed_(lockKey) + ')');
  }
  clearFail_(lockKey);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const backup = backupFirestore_();
    const wipe = [COL.TENANTS, COL.TENANCIES, COL.READINGS, COL.INVOICES, COL.PAYMENTS, COL.REPAIRS,
      COL.CHARGES, COL.LEDGER, COL.RECEIPTS, COL.COUNTERS, COL.AUDIT];
    const base = fsBase_();
    let n = 0;
    const del = function (col, rows) {
      for (let i = 0; i < rows.length; i += 50) {
        UrlFetchApp.fetchAll(rows.slice(i, i + 50).map(function (x) {
          return fsReq_(base + '/' + col + '/' + encodeURIComponent(x.id), 'delete');
        }));
      }
      n += rows.length;
    };
    const lists = fsMulti_(wipe.map(function (c) { return { list: c }; }));
    wipe.forEach(function (c, i) { del(c, lists[i]); });
    // session ผู้เช่าทั้งหมด (ผู้ดูแลยังอยู่ในระบบ)
    del(COL.SESSIONS, fsWhere_(COL.SESSIONS, { role: 'tenant' }));
    // ห้องกลับเป็นห้องว่าง
    const rooms = fsList_(COL.ROOMS);
    const docs = {};
    rooms.forEach(function (r) {
      docs[r.id] = Object.assign({}, r, { status: r.status === 'maintenance' ? 'maintenance' : 'vacant', currentTenancyId: '' });
    });
    fsSetMany_(COL.ROOMS, docs);
    audit_(me, 'ล้างข้อมูลทั้งหมด', backup, 'ลบ ' + n + ' รายการ · สำรองไว้ที่ไฟล์ ' + backup);
    return { backup: backup, deleted: n };
  } finally {
    lock.releaseLock();
  }
}

function apiListBackups(token) {
  requireSession_(token, 'admin');
  const s = getSettings_();
  if (!s.backupFolderId) return [];
  const out = [];
  const it = DriveApp.getFolderById(s.backupFolderId).getFilesByType('application/json');
  while (it.hasNext()) {
    const f = it.next();
    out.push({ name: f.getName(), at: f.getDateCreated().toISOString(), size: f.getSize() });
  }
  return out.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
}
