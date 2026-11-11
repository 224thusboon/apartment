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
  requireSession_(token, 'admin');
  const s = getSettings_();
  const t = fsGet_(COL.TENANCIES, tenancyId);
  if (!t) throw new Error('ไม่พบข้อมูลการเข้าพัก');
  const tenant = fsGet_(COL.TENANTS, t.tenantId) || {};
  const map = {
    dormName: s.dormName, dormAddress: s.dormAddress, ownerName: s.ownerName,
    contractDate: thaiDate_(today_()), tenantName: tenant.name, tenantIdCard: tenant.idCard || '-',
    tenantAddress: tenant.address || '-', tenantPhone: tenant.phone || '-', roomId: t.roomId,
    moveIn: thaiDate_(t.moveIn), rent: money_(t.rent), deposit: money_(t.deposit), dueDay: s.dueDay,
  };
  const r = renderTemplate_(s.contractTemplateId, s.pdfFolderId,
    'สัญญาเช่า ' + t.roomId + ' ' + tenant.name, map, t.roomId, null, true);
  fsUpdate_(COL.TENANCIES, tenancyId, { contractFileId: r.pdfId, contractDocId: r.docId });
  return { pdfId: r.pdfId, docUrl: 'https://docs.google.com/document/d/' + r.docId + '/edit' };
}

// ---------- ไฟล์ ----------

/** upload: {name, mimeType, data(base64)} */
function saveUpload_(folderId, upload, roomId, prefix) {
  if (!upload || !upload.data) throw new Error('ไม่มีไฟล์');
  const bytes = Utilities.base64Decode(upload.data);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 8MB');
  if (!/^(image\/|application\/pdf)/.test(upload.mimeType)) throw new Error('รองรับเฉพาะรูปภาพหรือ PDF');
  const ext = (upload.name.match(/\.[a-z0-9]+$/i) || [''])[0];
  const name = prefix + '_' + roomId + '_' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmmss') + ext;
  const f = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(bytes, upload.mimeType, name));
  f.setDescription('room:' + roomId);
  return f.getId();
}

/**
 * ส่งไฟล์กลับเป็น base64 (ไม่ต้องแชร์ Drive สาธารณะ)
 * ผู้เช่าเปิดได้เฉพาะไฟล์ของห้องตัวเอง
 */
function apiGetFile(token, fileId) {
  const s = requireSession_(token);
  const f = DriveApp.getFileById(fileId);
  if (s.role !== 'admin' && f.getDescription() !== 'room:' + s.roomId) throw new Error('ไม่มีสิทธิ์เปิดไฟล์นี้');
  const blob = f.getBlob();
  return { name: f.getName(), mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}
