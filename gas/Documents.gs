/**
 * แม่แบบ Google Docs -> PDF (ใบแจ้งหนี้ / สัญญาเช่า) + จัดการไฟล์ใน Drive
 *
 * แม่แบบใช้ตัวแทนแบบ {{ชื่อ}} แก้ข้อความรอบ ๆ ได้อิสระใน Google Docs
 * ตราบใดที่ตัวแทนยังอยู่ครบ
 */

// ---------- สร้างแม่แบบเริ่มต้น (เรียกจาก setup) ----------

/**
 * แม่แบบใบแจ้งหนี้ตามรูปแบบเดิมของหอ
 * แถว {{i.no}} ... {{i.total}} ในตารางรายการ จะถูกคัดลอกเป็น 1 แถวต่อรายการ
 * {{notes}} และ {{footer}} มาจากหน้าตั้งค่า (หลายบรรทัดได้)
 */
function createInvoiceTemplate_(folder) {
  const A = DocumentApp.HorizontalAlignment;
  const doc = DocumentApp.create('แม่แบบ - ใบแจ้งหนี้');
  const b = doc.getBody();
  b.setMarginTop(28).setMarginBottom(28).setMarginLeft(36).setMarginRight(36);

  const title = b.getParagraphs()[0];
  title.setText('ใบแจ้งหนี้');
  title.setAlignment(A.RIGHT);
  title.editAsText().setBold(true).setFontSize(16);
  b.appendParagraph('{{dormAddress}}');
  b.appendParagraph('');
  b.appendParagraph('โทร. {{phone}}');

  // กล่องข้อมูลผู้เช่า
  const info = b.appendTable([
    ['ชื่อ      คุณ {{tenantName}}', 'เลขที่ {{invoiceNo}}'],
    ['ที่อยู่    {{tenantAddress}}', 'วันที่ {{invoiceDate}}'],
    ['วันที่เริ่มคิดค่าบริการ  {{periodStart}} - {{periodEnd}}', 'ห้อง {{roomId}}'],
  ]);
  info.setColumnWidth(0, 373).setColumnWidth(1, 150);
  for (let r = 0; r < info.getNumRows(); r++) {
    info.getRow(r).setMinimumHeight(28);
  }

  b.appendParagraph('');

  // ตารางรายการ: แถวหัว + แถวแม่แบบ
  const W = [40, 205, 55, 65, 55, 40, 63];
  const items = b.appendTable([
    ['ลำดับ', 'รายการ', 'จำนวน', 'ราคา', 'จำนวนเงิน', 'ภาษี', 'รวมเงิน'],
    ['{{i.no}}', '{{i.name}}', '{{i.qty}}', '{{i.price}}', '{{i.amount}}', '{{i.vat}}', '{{i.total}}'],
  ]);
  W.forEach(function (w, i) { items.setColumnWidth(i, w); });
  for (let c = 0; c < W.length; c++) {
    items.getRow(0).getCell(c).getChild(0).asParagraph().setAlignment(A.CENTER);
    const align = c === 1 ? A.LEFT : c === 0 ? A.RIGHT : A.RIGHT;
    items.getRow(1).getCell(c).getChild(0).asParagraph().setAlignment(align);
  }
  items.getRow(1).setMinimumHeight(20);

  // ข้อความแจ้งผู้เช่า (อยู่ในกรอบต่อจากตารางรายการ)
  const notes = b.appendTable([['', '{{notes}}']]);
  notes.setColumnWidth(0, 40).setColumnWidth(1, 483);
  notes.getRow(0).setMinimumHeight(100);

  // ยอดรวม
  const tot = b.appendTable([
    ['', 'มูลค่าสินค้าที่ยกเว้นภาษี', ''],
    ['', 'มูลค่าสินค้าที่รวมภาษี', ''],
    ['', 'ภาษีมูลค่าเพิ่ม 7 %', ''],
    ['', 'ยอดเงินสุทธิ', '{{total}}'],
  ]);
  tot.setColumnWidth(0, 245).setColumnWidth(1, 215).setColumnWidth(2, 63);
  tot.getRow(3).getCell(2).getChild(0).asParagraph().setAlignment(A.RIGHT);

  b.appendParagraph('');
  const sign = b.appendParagraph('          ผู้รับเงิน ____________________                              วันที่ ________________');
  sign.editAsText().setBold(true);
  b.appendParagraph('');
  b.appendParagraph('{{footer}}').editAsText().setBold(true);

  b.editAsText().setFontFamily('Sarabun').setFontSize(11);
  title.editAsText().setFontSize(16);
  // ตัดระยะห่างย่อหน้า และย่อบรรทัดว่างคั่นตาราง ให้ทั้งใบอยู่ในหน้าเดียว
  b.getParagraphs().forEach(function (p) {
    p.setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
  });
  for (let i = 0; i < b.getNumChildren(); i++) {
    const ch = b.getChild(i);
    if (ch.getType() === DocumentApp.ElementType.PARAGRAPH && ch.asParagraph().getText() === '') {
      ch.asParagraph().editAsText().setFontSize(6);
    }
  }
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return doc.getId();
}

/**
 * รันจาก editor: สร้างแม่แบบใบแจ้งหนี้ใหม่ตามรูปแบบเดิมของหอ
 * (แม่แบบเก่าจะถูกเปลี่ยนชื่อเป็น "(เก่า)" ไม่ได้ลบ)
 */
function rebuildInvoiceTemplate() {
  const s = getSettings_();
  const folder = DriveApp.getFolderById(s.rootFolderId);
  if (s.invoiceTemplateId) {
    try {
      const old = DriveApp.getFileById(s.invoiceTemplateId);
      old.setName(old.getName() + ' (เก่า)');
    } catch (e) { /* ไม่มีไฟล์เก่า */ }
  }
  const id = createInvoiceTemplate_(folder);
  fsUpdate_(COL.SETTINGS, 'main', { invoiceTemplateId: id });
  clearSettingsCache_();
  Logger.log('แม่แบบใหม่: https://docs.google.com/document/d/' + id + '/edit');
}

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

function renderInvoicePdf_(settings, inv) {
  const map = {
    dormName: settings.dormName, phone: settings.phone, bankInfo: settings.bankInfo,
    month: thaiMonth_(inv.month), roomId: inv.roomId,
    tenantName: inv.tenantName, tenantAddress: inv.tenantAddress || '',
    invoiceNo: inv.number || '', invoiceDate: shortDate_(inv.issuedAt),
    periodStart: shortDate_(inv.periodStart), periodEnd: shortDate_(inv.periodEnd),
    issuedAt: thaiDate_(inv.issuedAt), dueDate: thaiDate_(inv.dueDate),
    total: money_(inv.total),
  };
  const r = renderTemplate_(settings.invoiceTemplateId, settings.pdfFolderId,
    'ใบแจ้งหนี้ ' + inv.roomId + ' ' + inv.month, map, inv.roomId, function (body) {
      fillMultiline_(body, 'dormAddress', settings.dormAddress);
      fillMultiline_(body, 'notes', settings.invoiceNotes);
      fillMultiline_(body, 'footer', settings.invoiceFooter);
      fillItemRows_(body, inv.items);
    }, false);
  return r.pdfId;
}

/** คัดลอกแถว {{i.*}} เป็น 1 แถวต่อรายการ แล้วเติมแถวว่างให้ตารางสูงพอ */
function fillItemRows_(body, items) {
  const found = body.findText('\\{\\{i\\.name\\}\\}');
  if (!found) return;
  let el = found.getElement();
  while (el && el.getType() !== DocumentApp.ElementType.TABLE_ROW) el = el.getParent();
  if (!el) return;
  const row = el.asTableRow();
  const table = row.getParentTable();
  const start = table.getChildIndex(row);
  const MIN_ROWS = 5;
  const n = Math.max(items.length, MIN_ROWS);
  for (let k = 0; k < n; k++) {
    const it = items[k];
    const map = it ? {
      no: String(k + 1), name: it.name, qty: fmtQty_(it.qty), price: money_(it.price),
      amount: '', vat: '', total: money_(it.amount),
    } : { no: '', name: '', qty: '', price: '', amount: '', vat: '', total: '' };
    const r = table.insertTableRow(start + k, row.copy());
    Object.keys(map).forEach(function (key) {
      r.replaceText('\\{\\{i\\.' + key + '\\}\\}', map[key]);
    });
  }
  table.removeRow(table.getChildIndex(row));
}

function fmtQty_(q) {
  const n = Number(q) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** แทน {{key}} ด้วยข้อความหลายบรรทัด (แต่ละบรรทัดเป็นย่อหน้า ใช้รูปแบบเดิมของย่อหน้านั้น) */
function fillMultiline_(body, key, text) {
  const pat = '\\{\\{' + key + '\\}\\}';
  const found = body.findText(pat);
  if (!found) return;
  const lines = String(text || '').split(/\r?\n/);
  let el = found.getElement();
  while (el && el.getType() !== DocumentApp.ElementType.PARAGRAPH) el = el.getParent();
  if (!el) return;
  const para = el.asParagraph();
  para.replaceText(pat, lines[0] || '');
  const parent = para.getParent();
  let idx = parent.getChildIndex(para);
  for (let i = 1; i < lines.length; i++) {
    const p = para.copy();
    p.setText(lines[i]);
    idx += 1;
    if (parent.getType() === DocumentApp.ElementType.TABLE_CELL) parent.asTableCell().insertParagraph(idx, p);
    else parent.asBody().insertParagraph(idx, p);
  }
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
