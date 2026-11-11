/**
 * อัปเดตโค้ดทั้งโปรเจกต์จาก GitHub
 * วิธีใช้: เลือกฟังก์ชัน updateFromGitHub แล้วกด Run
 * (ต้องเปิด Apps Script API ที่ https://script.google.com/home/usersettings)
 *
 * หมายเหตุ: หลังอัปเดต ต้อง Deploy > Manage deployments > แก้ไข > New version
 * เว็บแอปที่ผู้เช่าใช้จึงจะได้โค้ดใหม่
 */

const GITHUB_REPO = '224thusboon/apartment';
const GAS_FILES = [
  'appsscript.json', 'Code.gs', 'Config.gs', 'Firestore.gs', 'Auth.gs', 'Rooms.gs',
  'Billing.gs', 'Invoice.gs', 'Documents.gs', 'Payments.gs', 'Repairs.gs', 'Accounts.gs', 'Ops.gs', 'Updater.gs',
  'Index.html', 'Styles.html', 'App.html',
];

/**
 * รหัส commit ล่าสุดของ main
 * อ่านจาก git (ไม่ใช้ api.github.com เพราะ IP ของ Google โดนจำกัดจำนวนครั้งบ่อย)
 */
function headSha_() {
  try {
    const txt = UrlFetchApp.fetch('https://github.com/' + GITHUB_REPO + '.git/info/refs?service=git-upload-pack').getContentText();
    const m = txt.match(/([0-9a-f]{40}) refs\/heads\/main/);
    if (m) return m[1];
  } catch (e) {
    Logger.log('อ่าน commit ล่าสุดไม่ได้ ใช้ main แทน: ' + e.message);
  }
  return 'main';
}

function updateFromGitHub() {
  // ดึงตาม commit ล่าสุด (ลิงก์ raw ของ main ถูกแคชไว้ ~5 นาที อาจได้ไฟล์เก่า)
  const sha = headSha_();
  const raw = 'https://raw.githubusercontent.com/' + GITHUB_REPO + '/' + sha + '/gas/';
  Logger.log('commit ' + sha.slice(0, 7));
  const files = GAS_FILES.map(function (f) {
    const res = UrlFetchApp.fetch(raw + f, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('โหลด ' + f + ' ไม่ได้ (' + res.getResponseCode() + ')');
    const ext = f.split('.').pop();
    return {
      name: f.replace(/\.(gs|html|json)$/, ''),
      type: ext === 'json' ? 'JSON' : ext === 'html' ? 'HTML' : 'SERVER_JS',
      source: res.getContentText(),
    };
  });
  const res = UrlFetchApp.fetch('https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + '/content', {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ files: files }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('อัปเดตไม่สำเร็จ: ' + res.getContentText());
  Logger.log('อัปเดตแล้ว ' + files.length + ' ไฟล์ — รีโหลดหน้า editor เพื่อดูโค้ดใหม่');
}
