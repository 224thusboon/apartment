/**
 * จุดเข้า web app + ฟังก์ชันติดตั้งครั้งแรก
 */

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  let s;
  try { s = getSettings_(); } catch (err) { s = DEFAULT_SETTINGS; }
  t.pub = JSON.stringify(publicSettings_(s));
  return t.evaluate()
    .setTitle(s.dormName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    // ให้หน้า GitHub Pages (PWA shell) ฝัง iframe ได้
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * รันครั้งเดียวจาก editor หลังตั้ง FIRESTORE_PROJECT_ID แล้ว
 * - สร้างโฟลเดอร์ใน Drive
 * - สร้างแม่แบบใบแจ้งหนี้/สัญญา (Google Docs)
 * - สร้างห้อง 20 ห้อง (101-110, 201-210) ถ้ายังไม่มี
 * - สร้างรหัสผ่านแอดมิน ถ้ายังไม่มี (ดูใน Logs)
 */
function setup() {
  const s = getSettings_();

  if (!s.rootFolderId) {
    const root = DriveApp.createFolder(s.dormName + ' - ระบบหอพัก');
    s.rootFolderId = root.getId();
    s.slipFolderId = root.createFolder('สลิปโอนเงิน').getId();
    s.pdfFolderId = root.createFolder('ใบแจ้งหนี้และสัญญา').getId();
    s.photoFolderId = root.createFolder('รูปซ่อมบำรุง').getId();
  }
  const root = DriveApp.getFolderById(s.rootFolderId);
  if (!s.invoiceTemplateId) s.invoiceTemplateId = createInvoiceTemplate_(root);
  if (!s.contractTemplateId) s.contractTemplateId = createContractTemplate_(root);

  fsSet_(COL.SETTINGS, 'main', s);
  clearSettingsCache_();

  const existing = fsList_(COL.ROOMS);
  if (existing.length === 0) {
    [1, 2].forEach(function (floor) {
      for (let i = 1; i <= 10; i++) {
        const id = String(floor * 100 + i);
        fsSet_(COL.ROOMS, id, {
          number: id, floor: floor, rent: 3000, deposit: 3000,
          status: 'vacant', currentTenancyId: '', note: '',
        });
      }
    });
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_PASSWORD')) {
    const pw = Utilities.getUuid().slice(0, 8);
    props.setProperty('ADMIN_PASSWORD', pw);
    Logger.log('รหัสผ่านแอดมิน: ' + pw + '  (เปลี่ยนได้ใน Script properties)');
  }
  Logger.log('ติดตั้งเสร็จ โฟลเดอร์: ' + root.getUrl());
}

// ---------- ตัวช่วยทั่วไป ----------

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** '2026-11-11' -> '11 พฤศจิกายน 2569' */
function thaiDate_(iso) {
  if (!iso) return '-';
  const p = String(iso).slice(0, 10).split('-').map(Number);
  return p[2] + ' ' + TH_MONTHS[p[1] - 1] + ' ' + (p[0] + 543);
}

/** '2026-11' -> 'พฤศจิกายน 2569' */
function thaiMonth_(ym) {
  const p = ym.split('-').map(Number);
  return TH_MONTHS[p[1] - 1] + ' ' + (p[0] + 543);
}

function prevMonth_(ym) {
  const p = ym.split('-').map(Number);
  const d = new Date(p[0], p[1] - 2, 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

function today_() {
  return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
}

function money_(n) {
  return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
