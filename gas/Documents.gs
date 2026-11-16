/**
 * แม่แบบ Google Docs -> PDF (สัญญาเช่า) + จัดการไฟล์ใน Drive
 * (ใบแจ้งหนี้อยู่ใน Invoice.gs ใช้แม่แบบ Google Sheets)
 *
 * แม่แบบใช้ตัวแทนแบบ {{ชื่อ}} แก้ข้อความรอบ ๆ ได้อิสระใน Google Docs
 * ตราบใดที่ตัวแทนยังอยู่ครบ
 */

// ---------- สร้างแม่แบบเริ่มต้น (เรียกจาก setup) ----------

function createContractTemplate_(folder) {
  const doc = DocumentApp.create('แม่แบบ - สัญญาเช่า');
  const b = doc.getBody();
  b.appendParagraph('สัญญาเช่าห้องพัก').setHeading(DocumentApp.ParagraphHeading.HEADING1)
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  b.appendParagraph('ทำที่ {{dormName}} {{dormAddress}}').setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  b.appendParagraph('วันที่ {{contractDate}}').setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  b.appendParagraph('สัญญาฉบับนี้ทำขึ้นระหว่าง {{ownerName}} ซึ่งต่อไปเรียกว่า "ผู้ให้เช่า" ฝ่ายหนึ่ง ' +
    'กับ {{tenantName}} เลขประจำตัวประชาชน {{tenantIdCard}} อยู่บ้านเลขที่ {{tenantAddress}} ' +
    'โทร {{tenantPhone}} ซึ่งต่อไปเรียกว่า "ผู้เช่า" อีกฝ่ายหนึ่ง');
  b.appendParagraph('ข้อ 1. ผู้ให้เช่าตกลงให้เช่าและผู้เช่าตกลงเช่าห้องพักเลขที่ {{roomId}} ' +
    'เริ่มตั้งแต่วันที่ {{moveIn}}');
  b.appendParagraph('ข้อ 2. ค่าเช่าเดือนละ {{rent}} บาท ชำระภายในวันที่ {{dueDay}} ของทุกเดือน');
  b.appendParagraph('ข้อ 3. ผู้เช่าวางเงินประกันจำนวน {{deposit}} บาท');
  b.appendParagraph('(ข้อความนี้เป็นตัวอย่าง — แทนที่ด้วยสัญญาฉบับจริงของหอ โดยคงตัวแทน {{...}} ไว้)');
  b.appendParagraph('\n\nลงชื่อ ........................................ ผู้ให้เช่า\n      ({{ownerName}})');
  b.appendParagraph('\nลงชื่อ ........................................ ผู้เช่า\n      ({{tenantName}})');
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return doc.getId();
}

// ---------- เติมแม่แบบ ----------

function fillPlaceholders_(body, map) {
  Object.keys(map).forEach(function (k) {
    body.replaceText('\\{\\{' + k + '\\}\\}', String(map[k] == null ? '' : map[k]));
  });
}

/** คัดลอกแม่แบบ -> เติมค่า -> export PDF ; คืน {pdfId, docId} */
function renderTemplate_(templateId, folderId, fileName, map, roomId, tableHook, keepDoc) {
  if (!templateId) throw new Error('ยังไม่มีแม่แบบ (รัน setup() ก่อน)');
  const folder = DriveApp.getFolderById(folderId);
  const copy = DriveApp.getFileById(templateId).makeCopy(fileName, folder);
  const doc = DocumentApp.openById(copy.getId());
  const body = doc.getBody();
  fillPlaceholders_(body, map);
  if (tableHook) tableHook(body);
  doc.saveAndClose();
  const pdf = folder.createFile(copy.getAs(MimeType.PDF).setName(fileName + '.pdf'));
  pdf.setDescription('room:' + roomId);
  copy.setDescription('room:' + roomId);
  if (!keepDoc) copy.setTrashed(true);
  return { pdfId: pdf.getId(), docId: keepDoc ? copy.getId() : '' };
}

/** สร้างสัญญาเช่าของการเข้าพักครั้งนั้น (เก็บทั้ง Docs ไว้แก้ไข และ PDF) */
function apiGenerateContract(token, tenancyId) {
  const me = requireSession_(token, 'admin');
  const s = getSettings_();
  const t = fsGet_(COL.TENANCIES, tenancyId);
  if (!t) throw new Error('ไม่พบข้อมูลการเข้าพัก');
  const tenant = fsGet_(COL.TENANTS, t.tenantId) || {};
  const map = {
    dormName: s.dormName, dormAddress: s.dormAddress, ownerName: s.ownerName,
    contractDate: thaiDate_(today_()), tenantName: tenant.name, tenantIdCard: tenant.idCard || '-',
    tenantAddress: tenant.address || '-', tenantPhone: tenant.phone || '-', roomId: t.roomId,
    moveIn: thaiDate_(t.moveIn), rent: money_(t.rent), deposit: money_(t.deposit), dueDay: s.dueDay,
    rentText: bahtText_(t.rent), floor: String(t.roomId).replace(/\D/g, '').slice(0, -2) || '-',
    waterRate: s.waterRate, electricRate: s.electricRate,
  };
  const r = renderTemplate_(s.contractTemplateId, s.pdfFolderId,
    'สัญญาเช่า ' + t.roomId + ' ' + tenant.name, map, t.roomId, null, true);
  // ผูกไฟล์สัญญากับการเข้าพักครั้งนี้ (ผู้เช่าคนถัดไปของห้องเดียวกันเปิดไม่ได้)
  DriveApp.getFileById(r.pdfId).setDescription('room:' + t.roomId + '|tenancy:' + tenancyId);
  fsUpdate_(COL.TENANCIES, tenancyId, {
    contractFileId: r.pdfId, contractDocId: r.docId,
    contractCreatedAt: today_(), contractRetainUntil: t.moveOut ? retainUntil_(t.moveOut) : '',
  });
  audit_(me, 'สร้างสัญญาเช่า', 'ห้อง ' + t.roomId, tenant.name || '');
  return { pdfId: r.pdfId, docUrl: 'https://docs.google.com/document/d/' + r.docId + '/edit' };
}

// ---------- ไฟล์ ----------

/**
 * upload: {name, mimeType, data(base64)}
 * opt: {tenancyId, maxMB}  ถ้าระบุ tenancyId ไฟล์จะเปิดได้เฉพาะผู้เช่าของการเข้าพักครั้งนั้น
 */
function saveUpload_(folderId, upload, roomId, prefix, opt) {
  opt = opt || {};
  if (!upload || !upload.data) throw new Error('ไม่มีไฟล์');
  const bytes = Utilities.base64Decode(upload.data);
  const maxMB = opt.maxMB || 8;
  if (bytes.length > maxMB * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + maxMB + 'MB');
  if (!/^(image\/|application\/pdf)/.test(upload.mimeType)) throw new Error('รองรับเฉพาะรูปภาพหรือ PDF');
  const ext = (upload.name.match(/\.[a-z0-9]+$/i) || [''])[0];
  const name = prefix + '_' + roomId + '_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmmss') + ext;
  const f = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(bytes, upload.mimeType, name));
  f.setDescription('room:' + roomId + (opt.tenancyId ? '|tenancy:' + opt.tenancyId : ''));
  return f.getId();
}

/**
 * ส่งไฟล์กลับเป็น base64 (ไม่ต้องแชร์ Drive สาธารณะ)
 * ผู้เช่าเปิดได้เฉพาะไฟล์ของห้องตัวเอง และถ้าไฟล์ผูกกับการเข้าพัก ต้องเป็นการเข้าพักครั้งปัจจุบันของตัวเอง
 */
function apiGetFile(token, fileId) {
  const s = requireSession_(token);
  const f = DriveApp.getFileById(fileId);
  if (s.role !== 'admin') {
    const tags = {};
    String(f.getDescription() || '').split('|').forEach(function (p) {
      const i = p.indexOf(':');
      if (i > 0) tags[p.slice(0, i)] = p.slice(i + 1);
    });
    if (tags.room !== s.roomId || (tags.tenancy && tags.tenancy !== s.tenancyId) || tags.orig) throw new Error('ไม่มีสิทธิ์เปิดไฟล์นี้');
  }
  const blob = f.getBlob();
  return { name: f.getName(), mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ---------- สัญญาที่เซ็นแล้ว ----------

/**
 * อัปโหลดสัญญาที่เซ็นแล้ว (สแกน PDF / รูปถ่าย หลายไฟล์ได้) ผูกกับการเข้าพักครั้งนั้น
 * เก็บถาวร: ไม่มีปุ่มลบ ไฟล์อยู่ในโฟลเดอร์ "สัญญาที่เซ็นแล้ว"
 */
function apiUploadSignedContract(token, tenancyId, files) {
  const me = requireSession_(token, 'admin');
  const t = fsGet_(COL.TENANCIES, tenancyId);
  if (!t) throw new Error('ไม่พบข้อมูลการเข้าพัก');
  if (!files || !files.length) throw new Error('กรุณาเลือกไฟล์');
  const folderId = signedFolder_();
  const list = (t.signedContracts || []).slice();
  files.forEach(function (fl, i) {
    const id = saveUpload_(folderId, fl, t.roomId, 'signed_contract_' + (list.length + 1), { tenancyId: tenancyId, maxMB: 15 });
    list.push({
      fileId: id, name: fl.name || ('หน้า ' + (list.length + 1)), uploadedAt: new Date().toISOString(),
      by: me.email || me.name || '',
      retainUntil: t.moveOut ? retainUntil_(t.moveOut) : '', // ระหว่างเช่ายังไม่นับ กำหนดเมื่อย้ายออก
    });
  });
  fsUpdate_(COL.TENANCIES, tenancyId, { signedContracts: list });
  audit_(me, 'อัปโหลดสัญญาที่เซ็นแล้ว', 'ห้อง ' + t.roomId + ' · ' + t.tenantName, files.length + ' ไฟล์ (รวม ' + list.length + ')');
  return list;
}

function signedFolder_() {
  const s = getSettings_();
  if (s.signedFolderId) return s.signedFolderId;
  const id = DriveApp.getFolderById(s.rootFolderId).createFolder('สัญญาที่เซ็นแล้ว').getId();
  fsUpdate_(COL.SETTINGS, 'main', { signedFolderId: id });
  clearSettingsCache_();
  return id;
}

/**
 * วันครบกำหนดเก็บเอกสารสัญญา = วันย้ายออก + 10 ปี (อายุความทั่วไป ป.พ.พ. 193/30)
 * ระหว่างที่ยังเช่าอยู่ยังไม่นับ เพราะสัญญาและเอกสารประกอบยังต้องใช้
 */
function retainUntil_(moveOutIso) {
  const p = String(moveOutIso).slice(0, 10).split('-');
  return (Number(p[0]) + RETAIN_YEARS) + '-' + p[1] + '-' + p[2];
}
const RETAIN_YEARS = 10;

// ---------- สัญญาเช่าต้นแบบจากไฟล์ Word ----------

/**
 * อัปโหลดสัญญาต้นแบบ (.docx) -> แปลงเป็น Google Docs -> แทนช่องว่างที่พบบ่อยด้วยตัวแทน {{...}}
 * file: {name, data(base64)} ; คืน {url, found:[...], missing:[...]}
 */
function apiUploadContractTemplate(token, file) {
  const me = requireSession_(token, 'admin');
  if (!file || !file.data) throw new Error('ไม่มีไฟล์');
  const bytes = Utilities.base64Decode(file.data);
  if (bytes.length > 10 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 10MB');
  const s = getSettings_();
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const meta = { name: 'แม่แบบ - สัญญาเช่า (' + String(file.name || '').replace(/\.docx$/i, '') + ')',
    mimeType: 'application/vnd.google-apps.document', parents: [s.rootFolderId] };
  const b = 'ctb' + Date.now();
  const head = Utilities.newBlob('--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--' + b + '\r\nContent-Type: ' + DOCX + '\r\n\r\n').getBytes();
  const tail = Utilities.newBlob('\r\n--' + b + '--').getBytes();
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'post', contentType: 'multipart/related; boundary=' + b, payload: head.concat(bytes).concat(tail),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('แปลงไฟล์ไม่สำเร็จ: ' + res.getContentText().slice(0, 200));
  const id = JSON.parse(res.getContentText()).id;

  // แทนช่องว่างจุดไข่ปลาที่พบบ่อยในสัญญาเช่าไทย (แก้เพิ่มเองใน Google Docs ได้)
  const doc = DocumentApp.openById(id);
  const body = doc.getBody();
  const D = '[\\.…]{3,}';
  const rules = [
    ['วันที่ทำสัญญา', 'ทำขึ้นเมื่อวันที่\\s*' + D, 'ทำขึ้นเมื่อวันที่ {{contractDate}}'],
    ['ชื่อและที่อยู่ผู้เช่า', 'กับ\\s*' + D + '\\s*ที่อยู่.*?จ\\.?\\s*' + D, 'กับ {{tenantName}} ที่อยู่ {{tenantAddress}}'],
    ['เลขห้องและชั้น', 'เลขที่\\s*' + D + '\\s*ชั้นที่\\s*' + D, 'เลขที่ {{roomId}} ชั้นที่ {{floor}}'],
    ['วันเริ่มเช่า', 'นับตั้งแต่วันที่\\s*' + D, 'นับตั้งแต่วันที่ {{moveIn}}'],
    ['ค่าเช่า', 'เดือนละ\\s*[0-9,]+\\s*บาท\\s*\\([^)]*\\)', 'เดือนละ {{rent}} บาท ({{rentText}})'],
    ['ค่าไฟ', 'ค่าไฟหน่วยละ\\s*[0-9.]+', 'ค่าไฟหน่วยละ {{electricRate}}'],
    ['ค่าน้ำ', 'ค่าน้ำประปาหน่วยละ\\s*[0-9.]+', 'ค่าน้ำประปาหน่วยละ {{waterRate}}'],
    ['วันครบกำหนดชำระ', 'ภายในวันที่\\s*[0-9]+\\s*ของทุกเดือน', 'ภายในวันที่ {{dueDay}} ของทุกเดือน'],
    ['เลขห้องในรายการสิ่งของ', 'ห้องเลขที่\\s*' + D, 'ห้องเลขที่ {{roomId}}'],
  ];
  const found = [], missing = [];
  rules.forEach(function (r) {
    if (body.findText(r[1])) { body.replaceText(r[1], r[2]); found.push(r[0]); } else missing.push(r[0]);
  });
  // ชื่อผู้เช่าใต้ช่องลงชื่อ "ผู้เช่า": วงเล็บจุดไข่ปลาวงแรก
  const sig = body.findText('\\(\\s*' + D + '\\s*\\)');
  if (sig) {
    const el = sig.getElement().asText();
    el.deleteText(sig.getStartOffset(), sig.getEndOffsetInclusive());
    el.insertText(sig.getStartOffset(), '({{tenantName}})');
    found.push('ชื่อผู้เช่าใต้ลายเซ็น');
  } else missing.push('ชื่อผู้เช่าใต้ลายเซ็น');
  doc.saveAndClose();

  fsUpdate_(COL.SETTINGS, 'main', { contractTemplateId: id, contractTemplatePrevId: s.contractTemplateId || '' });
  clearSettingsCache_();
  audit_(me, 'ตั้งสัญญาเช่าต้นแบบ', file.name || '', 'ใส่ช่องข้อมูลอัตโนมัติ ' + found.length + ' จุด');
  return { url: 'https://docs.google.com/document/d/' + id + '/edit', found: found, missing: missing };
}
