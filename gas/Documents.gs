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
function renderTemplate_(templateId, folderId, fileName, map, roomId, tableHook, keepDoc, cleanTail) {
  if (!templateId) throw new Error('ยังไม่มีแม่แบบ (รัน setup() ก่อน)');
  const folder = DriveApp.getFolderById(folderId);
  const copy = DriveApp.getFileById(templateId).makeCopy(fileName, folder);
  let doc = DocumentApp.openById(copy.getId());
  let body = doc.getBody();
  fillPlaceholders_(body, map);
  if (cleanTail) {
    // ตัดตัวแบ่งหน้า/ตัวแบ่งส่วนท้ายเอกสาร (มาจากไฟล์ Word) ก่อนต่อหน้าอื่น ไม่ให้เกิดหน้าว่าง
    doc.saveAndClose();
    cleanDocTail_(copy.getId());
    doc = DocumentApp.openById(copy.getId());
    body = doc.getBody();
  }
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
    'สัญญาเช่า ' + t.roomId + ' ' + tenant.name, map, t.roomId,
    function (body) { stampOwnerSign_(body, s); const tail = trimTail_(body); attachIdCard_(body, t, tenant, tail); }, true, true);
  // ผูกไฟล์สัญญากับการเข้าพักครั้งนี้ (ผู้เช่าคนถัดไปของห้องเดียวกันเปิดไม่ได้)
  DriveApp.getFileById(r.pdfId).setDescription('room:' + t.roomId + '|tenancy:' + tenancyId);
  const upd = {
    contractFileId: r.pdfId, contractDocId: r.docId,
    contractCreatedAt: today_(), contractRetainUntil: t.moveOut ? retainUntil_(t.moveOut) : '',
    contractCreatedBy: me.name || me.email || '',
    contractHash: bytesHash_(DriveApp.getFileById(r.pdfId).getBlob().getBytes()),
    // สัญญาฉบับใหม่ต้องลงนามใหม่ (ฉบับที่ลงนามแล้วก่อนหน้า เก็บไว้ในประวัติ)
    eSignStatus: 'pending', eSignCode: signCode_(), eSignedFileId: '', eSignedHash: '', eSign: {},
  };
  if (t.eSignedFileId) {
    upd.eSignHistory = (t.eSignHistory || []).concat([{ fileId: t.eSignedFileId, hash: t.eSignedHash || '', at: (t.eSign && t.eSign.signedAt) || '', code: t.eSignCode || '' }]);
  }
  fsUpdate_(COL.TENANCIES, tenancyId, upd);
  audit_(me, 'สร้างสัญญาเช่า', 'ห้อง ' + t.roomId, tenant.name || '');
  return { pdfId: r.pdfId, docUrl: 'https://docs.google.com/document/d/' + r.docId + '/edit' };
}

/**
 * วางลายเซ็นผู้ให้เช่าแทนเส้นจุดในบรรทัด "ลงชื่อ....... ผู้ให้เช่า" (ทุกจุดที่พบ)
 * ไม่มีลายเซ็นในการตั้งค่า = ปล่อยเส้นจุดไว้ให้เซ็นมือ
 */
function stampOwnerSign_(body, s) {
  if (!s.ownerSignatureFileId) return 0;
  let blob;
  try { blob = DriveApp.getFileById(s.ownerSignatureFileId).getBlob(); } catch (e) { return 0; }
  return stampAt_(body, blob, (Number(s.ownerSignatureW) || 3) / (Number(s.ownerSignatureH) || 1), 'ผู้ให้เช่า', !!s.ownerSignatureLined);
}

/**
 * วางรูปลายเซ็นแทนเส้นจุดในบรรทัด "ลงชื่อ....... <role>" ทุกจุดที่พบ (สูงสุด 5)
 * lined = รูปมีเส้นจุดวาดไว้ที่ขอบล่างแล้ว (ทำจากแอป) : กว้างเท่าเส้นจุดเดิม เส้นจุดจึงยังอยู่ ลายเซ็นทับบนเส้น
 */
function stampAt_(body, blob, ratio, role, lined) {
  let h0 = 34, w0 = h0 * ratio;
  if (w0 > 150) { w0 = 150; h0 = w0 / ratio; }
  const PAT = 'ลงชื่อ\\s*[\\.…_]{3,}\\s*' + role;
  let n = 0, f;
  while (n < 5 && (f = body.findText(PAT))) {
    const el = f.getElement().asText();
    const full = el.getText();
    const seg = full.slice(f.getStartOffset(), f.getEndOffsetInclusive() + 1);
    const m = seg.match(/[\.…_]{3,}/);
    const s0 = f.getStartOffset() + m.index, e0 = s0 + m[0].length - 1;
    const tail = full.slice(e0 + 1);
    const fmt = { font: el.getFontFamily(s0), size: el.getFontSize(s0), bold: el.isBold(s0), color: el.getForegroundColor(s0) };
    let w = w0, h = h0;
    if (lined) {
      // ความกว้างของเส้นจุดเดิมโดยประมาณ (. ≈ 0.25em, _ ≈ 0.5em, … ≈ 1em)
      const em = Number(fmt.size) || 14;
      const dots = m[0].split('').reduce(function (a, ch) { return a + (ch === '…' ? 1 : ch === '_' ? 0.5 : 0.25); }, 0);
      w = Math.max(100, Math.min(240, dots * em));
      h = w / ratio;
    }
    el.deleteText(s0, full.length - 1);
    const par = el.getParent();
    const idx = par.getChildIndex(el);
    par.insertInlineImage(idx + 1, blob.copyBlob()).setWidth(Math.round(w)).setHeight(Math.round(h));
    if (tail) {
      const tt = par.insertText(idx + 2, tail);
      if (fmt.font) tt.setFontFamily(fmt.font);
      if (fmt.size) tt.setFontSize(fmt.size);
      if (fmt.bold != null) tt.setBold(!!fmt.bold);
      if (fmt.color) tt.setForegroundColor(fmt.color);
    }
    n++;
  }
  return n;
}

/**
 * ตัดย่อหน้าว่างท้ายเอกสาร (กันหน้าว่างเกินเมื่อแม่แบบแปลงจาก Word แล้วฟอนต์ต่างไปนิด)
 * ย่อหน้าสุดท้ายลบไม่ได้ จึงย่อให้เล็กที่สุดแทน คืนย่อหน้านั้นถ้าว่าง
 */
function trimTail_(body) {
  const ET = DocumentApp.ElementType;
  // ย่อหน้าว่าง = มีแต่ช่องว่างหรือตัวแบ่งหน้า
  const isBlank = function (el) {
    if (el.getType() !== ET.PARAGRAPH) return false;
    const p = el.asParagraph();
    if (p.getText().replace(/\s/g, '')) return false;
    for (let i = 0; i < p.getNumChildren(); i++) {
      const tp = p.getChild(i).getType();
      if (tp !== ET.TEXT && tp !== ET.PAGE_BREAK) return false;
    }
    return true;
  };
  let n = body.getNumChildren();
  while (n > 1 && isBlank(body.getChild(n - 1)) && isBlank(body.getChild(n - 2))) {
    body.removeChild(body.getChild(n - 2));
    n--;
  }
  const last = body.getChild(n - 1);
  if (!isBlank(last)) return null;
  const p = last.asParagraph();
  for (let i = p.getNumChildren() - 1; i >= 0; i--) {
    if (p.getChild(i).getType() === ET.PAGE_BREAK) p.removeChild(p.getChild(i));
  }
  p.setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1);
  const a = {}; a[DocumentApp.Attribute.FONT_SIZE] = 1;
  p.setAttributes(a);
  return p;
}

/**
 * ลบของว่างท้ายเอกสารผ่าน Docs API: ย่อหน้าว่าง ตัวแบ่งหน้า และตัวแบ่งส่วน (DocumentApp มองไม่เห็นตัวแบ่งส่วน)
 * ลบไม่ได้ก็ปล่อยไว้ (ไม่ให้การสร้างสัญญาล้ม)
 */
function cleanDocTail_(docId) {
  const url = 'https://docs.googleapis.com/v1/documents/' + docId;
  try {
    const c = (JSON.parse(gFetch_(url + '?fields=body.content', 'get').getContentText()).body || {}).content || [];
    const blank = function (el) {
      if (el.sectionBreak) return true;
      if (!el.paragraph) return false;
      return (el.paragraph.elements || []).every(function (e) {
        if (e.pageBreak) return true;
        if (e.textRun) return !/\S/.test(e.textRun.content || '');
        return false;
      });
    };
    let i = c.length - 1;
    while (i > 0 && blank(c[i])) i--;
    if (i <= 0) return;
    const from = c[i].endIndex, to = c[c.length - 1].endIndex - 1;
    if (to <= from) return;
    try {
      gFetch_(url + ':batchUpdate', 'post', { requests: [{ deleteContentRange: { range: { startIndex: from, endIndex: to } } }] });
    } catch (e) {
      // ลบข้ามตัวแบ่งส่วนไม่ได้: ลบเฉพาะส่วนหลังตัวแบ่งส่วนตัวสุดท้าย
      const sb = c.filter(function (x) { return x.sectionBreak && x.startIndex; }).pop();
      if (sb && to > sb.endIndex) gFetch_(url + ':batchUpdate', 'post', { requests: [{ deleteContentRange: { range: { startIndex: sb.endIndex, endIndex: to } } }] });
    }
  } catch (e) { Logger.log('cleanDocTail_: ' + e.message); }
}

/** แนบรูปบัตรประชาชนผู้เช่าเป็นหน้าสุดท้ายของสัญญา พร้อมช่องรับรองสำเนา */
function attachIdCard_(body, t, tenant, tail) {
  if (!t.idCardFileId) return;
  let blob;
  try { blob = DriveApp.getFileById(t.idCardFileId).getBlob(); } catch (e) { return; }
  const C = DocumentApp.HorizontalAlignment.CENTER;
  const para = function (text, size, bold) {
    const p = body.appendParagraph(text).setAlignment(C);
    if (text) p.editAsText().setFontFamily('Sarabun').setFontSize(size || 12).setBold(!!bold);
    return p;
  };
  // ใส่ตัวแบ่งหน้าในย่อหน้าว่างท้ายเดิม (ไม่เพิ่มย่อหน้าใหม่ที่อาจล้นเป็นหน้าว่าง)
  if (tail) tail.appendPageBreak(); else body.appendPageBreak();
  para('สำเนาบัตรประจำตัวประชาชนผู้เช่า', 14, true);
  para('ประกอบสัญญาเช่าห้อง ' + t.roomId, 12, false);
  const img = para('', 12).appendInlineImage(blob);
  const w = img.getWidth(), h = img.getHeight();
  let nw = Math.min(360, w), nh = h * nw / w;
  if (nh > 460) { nh = 460; nw = w * nh / h; }
  img.setWidth(Math.round(nw)).setHeight(Math.round(nh));
  para('ใช้ประกอบสัญญาเช่าห้อง ' + t.roomId + ' เท่านั้น · รับรองสำเนาถูกต้อง', 12, false);
  para('', 12);
  para('ลงชื่อ ........................................ ผู้เช่า', 12, false);
  para('(' + (tenant.name || t.tenantName || '') + ')', 12, false);
}

/** อัปโหลดรูปบัตรประชาชนผู้เช่า ผูกกับการเข้าพักครั้งนั้น (ใช้แนบท้ายสัญญา) */
function apiUploadIdCard(token, tenancyId, upload) {
  const me = requireSession_(token, 'admin');
  const t = fsGet_(COL.TENANCIES, tenancyId);
  if (!t) throw new Error('ไม่พบข้อมูลการเข้าพัก');
  if (!upload || !/^image\//.test(upload.mimeType || '')) throw new Error('กรุณาเลือกไฟล์รูปภาพ');
  const id = saveUpload_(idFolder_(), upload, t.roomId, 'idcard', { tenancyId: tenancyId, maxMB: 8 });
  fsUpdate_(COL.TENANCIES, tenancyId, { idCardFileId: id, idCardUploadedAt: new Date().toISOString() });
  audit_(me, t.idCardFileId ? 'เปลี่ยนรูปบัตรประชาชน' : 'อัปโหลดรูปบัตรประชาชน', 'ห้อง ' + t.roomId + ' · ' + (t.tenantName || ''), '');
  return id;
}

function idFolder_() {
  const s = getSettings_();
  if (s.idFolderId) return s.idFolderId;
  const id = DriveApp.getFolderById(s.rootFolderId).createFolder('บัตรประชาชนผู้เช่า').getId();
  fsUpdate_(COL.SETTINGS, 'main', { idFolderId: id });
  clearSettingsCache_();
  return id;
}

/** ลายเซ็นผู้ให้เช่า (ใช้ในสัญญาเช่า) : {data, w, h} หรือ null */
function apiGetOwnerSignature(token) {
  requireSession_(token, 'admin');
  const s = getSettings_();
  if (!s.ownerSignatureFileId) return null;
  try {
    const b = DriveApp.getFileById(s.ownerSignatureFileId).getBlob();
    return { data: Utilities.base64Encode(b.getBytes()), w: s.ownerSignatureW || 0, h: s.ownerSignatureH || 0 };
  } catch (e) { return null; }
}

/** บันทึกลายเซ็นผู้ให้เช่า (PNG พื้นใส) sig: {data, w, h} ; null = ลบ */
function apiSaveOwnerSignature(token, sig) {
  const me = requireSession_(token, 'admin');
  const s = getSettings_();
  if (s.ownerSignatureFileId) { try { DriveApp.getFileById(s.ownerSignatureFileId).setTrashed(true); } catch (e) { /* ไม่มีไฟล์เดิม */ } }
  if (!sig) {
    fsUpdate_(COL.SETTINGS, 'main', { ownerSignatureFileId: '', ownerSignatureW: 0, ownerSignatureH: 0 });
    clearSettingsCache_();
    audit_(me, 'ลบลายเซ็นผู้ให้เช่า', s.ownerName || '', '');
    return true;
  }
  const bytes = Utilities.base64Decode(sig.data || '');
  if (!bytes.length || bytes.length > 400 * 1024) throw new Error('ไฟล์ลายเซ็นไม่ถูกต้องหรือใหญ่เกินไป');
  const f = DriveApp.getFolderById(signFolder_()).createFile(Utilities.newBlob(bytes, 'image/png', 'signature_owner.png'));
  f.setDescription('signature:owner');
  fsUpdate_(COL.SETTINGS, 'main', { ownerSignatureFileId: f.getId(), ownerSignatureW: Number(sig.w) || 0, ownerSignatureH: Number(sig.h) || 0, ownerSignatureLined: !!sig.lined });
  clearSettingsCache_();
  audit_(me, 'ตั้งลายเซ็นผู้ให้เช่า', s.ownerName || '', '');
  return true;
}

// ---------- ลงนามสัญญาบนระบบ ----------

function bytesHash_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** รหัสอ้างอิงเอกสาร 10 ตัว (ไม่มีตัวที่สับสนง่าย เช่น O/0, I/1) */
function signCode_() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 10; i++) c += A.charAt(Math.floor(Math.random() * A.length));
  return c.slice(0, 5) + '-' + c.slice(5);
}

/** ผู้เช่าใช้การเข้าพักของตัวเอง ผู้ดูแลระบุ tenancyId (เซ็นต่อหน้าบนเครื่องผู้ดูแล) */
function signTarget_(token, tenancyId) {
  const s = requireSession_(token);
  const tid = s.role === 'tenant' ? s.tenancyId : tenancyId;
  const t = tid ? fsGet_(COL.TENANCIES, tid) : null;
  if (!t || t.status !== 'active') throw new Error('ไม่พบการเข้าพักที่ยังอยู่');
  return { s: s, t: t };
}

/**
 * เปิดสัญญาเพื่ออ่านก่อนลงนาม: ส่ง PDF ฉบับล่าสุด (ถ้า Docs ถูกแก้หลังออก PDF จะออก PDF ใหม่ให้ตรงกัน)
 * บันทึกเวลาที่เปิดอ่าน (เวลาเซิร์ฟเวอร์) ไว้ใช้ในหน้าหลักฐาน
 */
function apiContractToSign(token, tenancyId) {
  const x = signTarget_(token, tenancyId), t = x.t;
  if (t.eSignStatus !== 'pending' || !t.contractDocId) throw new Error('ไม่มีสัญญาที่รอลงนาม');
  const s = getSettings_();
  const docFile = DriveApp.getFileById(t.contractDocId);
  let pdfId = t.contractFileId;
  let pdf = DriveApp.getFileById(pdfId);
  // แก้ไขใน Google Docs หลังจากออก PDF: ออก PDF ใหม่จาก Docs ปัจจุบัน
  if (docFile.getLastUpdated().getTime() > pdf.getDateCreated().getTime() + 60000) {
    const np = DriveApp.getFolderById(s.pdfFolderId).createFile(docFile.getAs(MimeType.PDF).setName(docFile.getName() + '.pdf'));
    np.setDescription('room:' + t.roomId + '|tenancy:' + t.id);
    pdfId = np.getId();
    pdf = np;
    fsUpdate_(COL.TENANCIES, t.id, { contractFileId: pdfId, contractHash: bytesHash_(np.getBlob().getBytes()) });
  }
  const bytes = pdf.getBlob().getBytes();
  const hash = bytesHash_(bytes);
  CacheService.getScriptCache().put('esopen_' + t.id, JSON.stringify({
    at: new Date().toISOString(), hash: hash, docAt: docFile.getLastUpdated().getTime(), pdfId: pdfId,
  }), 21600);
  return {
    tenancyId: t.id, roomId: t.roomId, tenantName: t.tenantName, code: t.eSignCode || '',
    data: Utilities.base64Encode(bytes),
  };
}

/**
 * ลงนามสัญญา
 * p: {tenancyId (ผู้ดูแล), agree, sig:{data,w,h}, photo:{name,mimeType,data}, pin (ผู้ดูแล), readSeconds, pages, device}
 */
function apiSignContract(token, p) {
  p = p || {};
  const x = signTarget_(token, p.tenancyId), me = x.s, t = x.t;
  const inPerson = me.role === 'admin';
  if (t.eSignStatus !== 'pending' || !t.contractDocId) throw new Error('ไม่มีสัญญาที่รอลงนาม');
  if (p.agree !== true) throw new Error('ต้องยืนยันว่าอ่านและยอมรับสัญญาก่อน');
  if (inPerson) {
    // ผู้เช่ายืนยันตัวด้วย PIN ของห้อง (ผู้ดูแลไม่ควรรู้ PIN นี้)
    const lockKey = 'sign_' + t.roomId;
    checkLock_(lockKey);
    if (!t.pinHash || t.pinHash !== hash_(t.roomId + ':' + String(p.pin || '').trim())) {
      throw new Error('PIN ไม่ถูกต้อง (' + loginFailed_(lockKey) + ')');
    }
    clearFail_(lockKey);
  }
  const cache = CacheService.getScriptCache();
  const open = JSON.parse(cache.get('esopen_' + t.id) || 'null');
  if (!open) throw new Error('หมดเวลา กรุณาเปิดอ่านสัญญาใหม่อีกครั้ง');
  const docFile = DriveApp.getFileById(t.contractDocId);
  if (docFile.getLastUpdated().getTime() !== open.docAt) throw new Error('สัญญาถูกแก้ไขระหว่างที่อ่าน กรุณาเปิดอ่านใหม่');

  const sigBytes = Utilities.base64Decode((p.sig && p.sig.data) || '');
  if (!sigBytes.length || sigBytes.length > 400 * 1024) throw new Error('กรุณาเซ็นชื่อในกรอบ');
  if (!p.photo || !/^image\//.test(p.photo.mimeType || '')) throw new Error('กรุณาถ่ายรูปผู้เช่าคู่บัตรประชาชน');

  const s = getSettings_();
  const stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmmss');
  const sigFile = DriveApp.getFolderById(signFolder_()).createFile(Utilities.newBlob(sigBytes, 'image/png', 'signature_tenant_' + t.roomId + '_' + stamp + '.png'));
  sigFile.setDescription('room:' + t.roomId + '|tenancy:' + t.id);
  const photoId = saveUpload_(idFolder_(), p.photo, t.roomId, 'sign_photo', { tenancyId: t.id, maxMB: 8 });

  const signedAt = new Date();
  const fmtTh = function (d) {
    return thaiDate_(Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd')) + ' เวลา ' + Utilities.formatDate(d, 'Asia/Bangkok', 'HH:mm:ss') + ' น.';
  };
  const ev = {
    code: t.eSignCode || '', mode: inPerson ? 'inperson' : 'self',
    adminName: inPerson ? (me.name || me.email || '') : '',
    openedAt: open.at, signedAt: signedAt.toISOString(),
    readSeconds: Math.max(0, Math.round(Number(p.readSeconds) || 0)), pages: Number(p.pages) || 0,
    device: String(p.device || '').slice(0, 200), contractHash: open.hash,
    sigFileId: sigFile.getId(), photoFileId: photoId,
  };

  // สำเนา Docs -> วางลายเซ็นผู้เช่า -> หน้าหลักฐาน -> PDF
  const copy = docFile.makeCopy('สัญญาเช่า (ลงนามแล้ว) ' + t.roomId + ' ' + t.tenantName, DriveApp.getFolderById(s.pdfFolderId));
  let out;
  try {
    const doc = DocumentApp.openById(copy.getId());
    const body = doc.getBody();
    const sigBlob = Utilities.newBlob(sigBytes, 'image/png', 'sig.png');
    if (p.sigLine && p.sigLine.data) {
      stampAt_(body, Utilities.newBlob(Utilities.base64Decode(p.sigLine.data), 'image/png', 'sigline.png'),
        (Number(p.sigLine.w) || 4) / (Number(p.sigLine.h) || 1), 'ผู้เช่า', true);
    } else stampAt_(body, sigBlob, (Number(p.sig.w) || 3) / (Number(p.sig.h) || 1), 'ผู้เช่า');
    const tail = trimTail_(body);
    if (tail) tail.appendPageBreak(); else body.appendPageBreak();
    evidencePage_(body, t, ev, fmtTh, sigBlob, DriveApp.getFileById(photoId).getBlob());
    doc.saveAndClose();
    out = DriveApp.getFolderById(signedFolder_()).createFile(copy.getAs(MimeType.PDF).setName('สัญญาเช่า (ลงนามแล้ว) ' + t.roomId + ' ' + ev.code + '.pdf'));
    out.setDescription('room:' + t.roomId + '|tenancy:' + t.id);
  } finally {
    copy.setTrashed(true);
  }
  const finalHash = bytesHash_(out.getBlob().getBytes());
  fsUpdate_(COL.TENANCIES, t.id, { eSignStatus: 'signed', eSignedFileId: out.getId(), eSignedHash: finalHash, eSign: ev });
  cache.remove('esopen_' + t.id);
  audit_(me, inPerson ? 'ผู้เช่าลงนามสัญญาต่อหน้าผู้ดูแล' : 'ผู้เช่าลงนามสัญญาบนระบบ',
    'ห้อง ' + t.roomId + ' · ' + t.tenantName, 'รหัส ' + ev.code + ' · SHA-256 ' + finalHash.slice(0, 16) + '…');
  return { fileId: out.getId(), code: ev.code, hash: finalHash };
}

/** หน้าหลักฐานการลงนามอิเล็กทรอนิกส์ (ต่อท้ายสัญญา) */
function evidencePage_(body, t, ev, fmtTh, sigBlob, photoBlob) {
  const C = DocumentApp.HorizontalAlignment.CENTER;
  const st = function (el, size, bold) { el.editAsText().setFontFamily('Sarabun').setFontSize(size).setBold(!!bold); return el; };
  st(body.appendParagraph('หลักฐานการลงนามสัญญาเช่าด้วยวิธีการทางอิเล็กทรอนิกส์').setAlignment(C), 14, true);
  st(body.appendParagraph('ตามพระราชบัญญัติว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ พ.ศ. 2544').setAlignment(C), 10, false);
  const mins = Math.floor(ev.readSeconds / 60), secs = ev.readSeconds % 60;
  const rows = [
    ['รหัสอ้างอิงเอกสาร', ev.code || '-'],
    ['ห้อง / ผู้เช่า', t.roomId + ' / ' + t.tenantName],
    ['สัญญาสร้างโดย', (t.contractCreatedBy || '-') + (t.contractCreatedAt ? ' เมื่อ ' + thaiDate_(t.contractCreatedAt) : '')],
    ['วิธีลงนาม', ev.mode === 'inperson'
      ? 'ลงนามต่อหน้าผู้ดูแล (' + ev.adminName + ') บนอุปกรณ์ของผู้ดูแล ผู้เช่ายืนยันตัวตนด้วย PIN ของห้อง'
      : 'ผู้เช่าลงนามด้วยอุปกรณ์ของตนเอง หลังเข้าสู่ระบบด้วยเลขห้องและ PIN'],
    ['เปิดอ่านสัญญาเมื่อ', fmtTh(new Date(ev.openedAt))],
    ['ลงนามเมื่อ', fmtTh(new Date(ev.signedAt))],
    ['การอ่าน', 'เลื่อนอ่านครบ ' + ev.pages + ' หน้า ใช้เวลา ' + (mins ? mins + ' นาที ' : '') + secs + ' วินาที (ตามที่อุปกรณ์รายงาน) และยืนยันว่าได้อ่านและยอมรับข้อความทั้งหมดแล้ว'],
    ['อุปกรณ์ที่ใช้ลงนาม', ev.device || '-'],
    ['รหัสตรวจสอบสัญญาที่อ่าน (SHA-256)', ev.contractHash],
  ];
  const tb = body.appendTable(rows);
  tb.setBorderColor('#9aa5b1');
  for (let r = 0; r < tb.getNumRows(); r++) {
    const row = tb.getRow(r);
    st(row.getCell(0).setWidth(150), 10, true);
    st(row.getCell(1), 10, false);
  }
  const imgs = body.appendTable([['รูปผู้เช่าคู่บัตรประชาชน ขณะลงนาม', 'ลายมือชื่อผู้เช่า'], [' ', ' ']]);
  imgs.setBorderColor('#9aa5b1');
  st(imgs.getRow(0).getCell(0), 10, true);
  st(imgs.getRow(0).getCell(1), 10, true);
  const put = function (cell, blob, maxW, maxH) {
    const im = cell.getChild(0).asParagraph().setAlignment(C).appendInlineImage(blob);
    const w = im.getWidth(), h = im.getHeight();
    let nw = Math.min(maxW, w), nh = h * nw / w;
    if (nh > maxH) { nh = maxH; nw = w * nh / h; }
    im.setWidth(Math.round(nw)).setHeight(Math.round(nh));
  };
  try { put(imgs.getRow(1).getCell(0), photoBlob, 200, 220); } catch (e) { /* รูปเปิดไม่ได้ */ }
  put(imgs.getRow(1).getCell(1), sigBlob.copyBlob(), 200, 90);
  st(body.appendParagraph('การตรวจสอบ: ระบบบันทึกรหัส SHA-256 ของไฟล์ PDF ฉบับนี้ไว้ ณ เวลาลงนาม นำไฟล์มาตรวจได้ที่เมนู "ตรวจสอบเอกสาร" ในระบบ หากไฟล์ถูกแก้ไขแม้เพียงเล็กน้อย รหัสจะไม่ตรง และระบบจะแจ้งว่าไม่ใช่ฉบับที่ลงนาม'), 9, false);
}

/** ตรวจไฟล์ PDF ว่าตรงกับสัญญาในระบบหรือไม่ (เทียบ SHA-256) */
function apiVerifyDocument(token, upload) {
  const me = requireSession_(token, 'admin');
  if (!upload || !upload.data) throw new Error('กรุณาเลือกไฟล์');
  const h = bytesHash_(Utilities.base64Decode(upload.data));
  const pick = function (t) { return { roomId: t.roomId, tenantName: t.tenantName, code: t.eSignCode || '', status: t.status }; };
  let res;
  let hit = fsWhere_(COL.TENANCIES, { eSignedHash: h })[0];
  if (hit) {
    res = Object.assign(pick(hit), { ok: true, kind: 'signed', signedAt: (hit.eSign && hit.eSign.signedAt) || '', mode: (hit.eSign && hit.eSign.mode) || '' });
  } else {
    hit = fsList_(COL.TENANCIES).filter(function (t) {
      return (t.eSignHistory || []).some(function (x) { return x.hash === h; });
    })[0];
    if (hit) {
      const old = hit.eSignHistory.filter(function (x) { return x.hash === h; })[0];
      res = Object.assign(pick(hit), { ok: true, kind: 'superseded', signedAt: old.at, code: old.code });
    } else {
      hit = fsWhere_(COL.TENANCIES, { contractHash: h })[0];
      res = hit ? Object.assign(pick(hit), { ok: true, kind: 'unsigned' }) : { ok: false };
    }
  }
  audit_(me, 'ตรวจสอบเอกสาร', upload.name || '', res.ok ? res.kind + ' ' + (res.code || '') : 'ไม่ตรงกับเอกสารในระบบ');
  res.hash = h;
  return res;
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
 * ฟอนต์ไทยของ Windows (Angsana/Cordia/Browallia/TH Sarabun) ไม่มีใน Google Docs ทำให้ตัวใหญ่และหน้าเพี้ยน
 * แทนด้วยฟอนต์ Google ที่หน้าตาใกล้เคียง และย่อขนาดตามสัดส่วน (ฟอนต์ตระกูลนี้ตัวเล็กกว่าปกติ ~0.7 เท่า)
 */
const THAI_FONT_MAP = {
  'angsana new': 'Taviraj', 'angsanaupc': 'Taviraj', 'cordia new': 'Sarabun', 'cordiaupc': 'Sarabun',
  'browallia new': 'Sarabun', 'browalliaupc': 'Sarabun', 'th sarabunpsk': 'Sarabun', 'th sarabun new': 'Sarabun',
  'th niramit as': 'Niramit', 'th krub': 'Krub', 'th k2d july8': 'K2D',
};
function thaiFonts_(el, fallbackFont) {
  const T = DocumentApp.ElementType;
  const type = el.getType();
  if (type === T.TEXT) {
    const txt = el.asText();
    const len = txt.getText().length;
    if (!len) return;
    const idx = txt.getTextAttributeIndices();
    for (let i = 0; i < idx.length; i++) {
      const s = idx[i], e = (i + 1 < idx.length ? idx[i + 1] : len) - 1;
      if (e < s) continue;
      const fam = String(txt.getFontFamily(s) || fallbackFont || '').toLowerCase();
      const to = THAI_FONT_MAP[fam];
      if (!to) continue;
      const size = txt.getFontSize(s) || 16;
      txt.setFontFamily(s, e, to);
      txt.setFontSize(s, e, Math.max(7, Math.round(size * 0.7 * 2) / 2));
    }
    return;
  }
  if (type === T.PARAGRAPH || type === T.LIST_ITEM) {
    try { el.setLineSpacing(1); } catch (err) { /* บางชนิดตั้งไม่ได้ */ }
  }
  if (typeof el.getNumChildren === 'function') {
    for (let i = 0; i < el.getNumChildren(); i++) thaiFonts_(el.getChild(i), fallbackFont);
  }
}

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
  thaiFonts_(body);
  doc.saveAndClose();

  fsUpdate_(COL.SETTINGS, 'main', { contractTemplateId: id, contractTemplatePrevId: s.contractTemplateId || '' });
  clearSettingsCache_();
  audit_(me, 'ตั้งสัญญาเช่าต้นแบบ', file.name || '', 'ใส่ช่องข้อมูลอัตโนมัติ ' + found.length + ' จุด');
  return { url: 'https://docs.google.com/document/d/' + id + '/edit', found: found, missing: missing };
}
