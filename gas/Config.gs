/**
 * ค่าคงที่ของระบบ + การอ่าน/เขียนค่าตั้งค่า
 *
 * Script Properties ที่ต้องตั้ง (Project Settings > Script properties):
 *   FIRESTORE_PROJECT_ID  = รหัสโปรเจกต์ Google Cloud ที่เปิด Firestore ไว้
 *   ADMIN_PASSWORD        = รหัสผ่านแอดมิน (setup() จะสร้างให้ถ้ายังไม่มี)
 *   SHELL_ORIGIN          = https://<username>.github.io  (origin ของหน้า PWA)
 *
 * ค่าอื่น ๆ (เรทค่าน้ำ/ไฟ ชื่อหอ สี ฯลฯ) อยู่ใน Firestore: settings/main
 * แก้ได้จากหน้า "ตั้งค่า" ในแอป
 */

const COL = {
  SETTINGS: 'settings',
  ROOMS: 'rooms',
  TENANTS: 'tenants',
  TENANCIES: 'tenancies',   // การเข้าพัก 1 ครั้ง = 1 เอกสาร (ย้ายเข้า/ย้ายออก)
  READINGS: 'readings',     // เลขมิเตอร์รายเดือน id = {roomId}_{YYYY-MM}
  INVOICES: 'invoices',     // id = {roomId}_{YYYY-MM}
  PAYMENTS: 'payments',     // สลิปที่ผู้เช่าอัปโหลด
  REPAIRS: 'repairs',
  CHARGES: 'charges',       // รายการเรียกเก็บเพิ่มรายห้อง (เช่น ค่าซ่อมที่ผู้เช่าทำเสียหาย) รวมเข้าบิลเดือนนั้น
  LEDGER: 'ledger',         // บัญชีรายรับ-รายจ่ายที่บันทึกเอง
  RECEIPTS: 'receipts',     // ใบเสร็จรับเงิน (ผูกกับใบแจ้งหนี้)
  COUNTERS: 'counters',     // ตัวนับเลขที่เอกสารรายวัน เช่น inv_25691031
  ADMINS: 'admins',         // ผู้ดูแล (อีเมล + รหัสผ่าน hash)
  AUDIT: 'audit',           // บันทึกการทำงาน
  SESSIONS: 'sessions',
};

/** ค่าเริ่มต้น (ค่าสมมติ) — แก้จริงในหน้าตั้งค่า */
const DEFAULT_SETTINGS = {
  dormName: 'ระบบหอพัก',
  dormAddress: 'ที่อยู่หอพัก (แก้ในหน้าตั้งค่า)',
  ownerName: 'ชื่อผู้ให้เช่า',
  phone: '-',
  bankInfo: 'ธนาคาร ... เลขบัญชี ... ชื่อบัญชี ...',
  primaryColor: '#1aa98f', // สีเน้น (teal) — พื้นหลักเป็นสีกรมท่า
  waterRate: 18,         // บาท/หน่วย
  waterMinCharge: 100,   // ค่าน้ำขั้นต่ำ/เดือน
  electricRate: 8,       // บาท/หน่วย
  electricMinCharge: 0,
  otherFees: [],         // [{name:'ค่าส่วนกลาง', amount:100}]
  dueDay: 5,             // ชำระภายในวันที่
  invoiceNotes: '',      // ข้อความแจ้งผู้เช่าในใบแจ้งหนี้ (หลายบรรทัด)
  invoiceFooter: '',     // หมายเหตุท้ายใบแจ้งหนี้
  invoiceSeq: 0,         // เลขที่ใบแจ้งหนี้ล่าสุด
  invoiceTemplateId: '', // Google Sheets template (setup() สร้างให้)
  receiptTemplateId: '', // Google Sheets template ใบเสร็จ (สร้างเองเมื่อออกใบแรก)
  invoiceStyle: 'classic', // รูปแบบใบแจ้งหนี้/ใบเสร็จ: classic แบบเดิม | modern แบบใหม่
  invoiceTemplateModernId: '',
  receiptTemplateModernId: '',
  contractTemplateId: '',
  rootFolderId: '',
  slipFolderId: '',
  pdfFolderId: '',
  photoFolderId: '',
  backupFolderId: '',
  signedFolderId: '',    // โฟลเดอร์สัญญาที่เซ็นแล้ว (สร้างเองเมื่ออัปโหลดครั้งแรก)
};

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/** ค่าตั้งค่าเก็บในแคช 10 นาที (ไม่ต้องถาม Firestore ทุกครั้ง) */
function getSettings_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('settings');
  if (hit) return JSON.parse(hit);
  const s = Object.assign({}, DEFAULT_SETTINGS, fsGet_(COL.SETTINGS, 'main') || {});
  cache.put('settings', JSON.stringify(s), 600);
  return s;
}

function clearSettingsCache_() {
  CacheService.getScriptCache().remove('settings');
}

/** ส่วนที่ผู้เช่า/หน้า login เห็นได้ (ไม่มี id ภายใน) */
function publicSettings_(s) {
  return {
    dormName: s.dormName,
    primaryColor: s.primaryColor,
    phone: s.phone,
    bankInfo: s.bankInfo,
    dueDay: s.dueDay,
    // origin ของหน้า PWA บน GitHub Pages เช่น https://username.github.io
    // ใช้ส่ง token ไปเก็บสำรองที่หน้า shell (ส่งเฉพาะ origin นี้เท่านั้น)
    shellOrigin: prop_('SHELL_ORIGIN') || '',
  };
}
