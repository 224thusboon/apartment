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

function apiListAudit(token, month) {
  requireSession_(token, 'admin');
  return sortBy_(fsWhere_(COL.AUDIT, { month: month }), 'at', true);
}

// ---------- สำรองข้อมูล ----------

const BACKUP_KEEP = 12; // เก็บไฟล์สำรองล่าสุด 12 ชุด (~3 เดือนถ้าสำรองทุกสัปดาห์)

/** ตั้ง trigger รายสัปดาห์ให้เรียกฟังก์ชันนี้ (ตั้งที่เมนู ทริกเกอร์ ใน Apps Script) */
function weeklyBackup() {
  const name = backupFirestore_();
  audit_({ role: 'system', name: 'ระบบ' }, 'สำรองข้อมูลอัตโนมัติ', name);
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
