/**
 * สลิปโอนเงิน: ผู้เช่าอัปโหลด -> แอดมินตรวจ -> อนุมัติ/ปฏิเสธ
 */

/** ผู้เช่าแนบสลิปให้บิล */
function apiUploadSlip(token, invoiceId, upload, amount) {
  const s = requireSession_(token, 'tenant');
  const inv = fsGet_(COL.INVOICES, invoiceId);
  // ต้องเป็นบิลของการเข้าพักครั้งนี้เท่านั้น (กันผู้เช่าเก่าแนบสลิปให้บิลผู้เช่าใหม่)
  if (!inv || inv.roomId !== s.roomId || inv.tenancyId !== s.tenancyId) throw new Error('ไม่พบใบแจ้งหนี้');
  if (inv.status === 'paid') throw new Error('บิลนี้ชำระแล้ว');
  const settings = getSettings_();
  const fileId = saveUpload_(settings.slipFolderId, upload, s.roomId, 'slip_' + inv.month);
  const p = fsSet_(COL.PAYMENTS, null, {
    invoiceId: invoiceId, roomId: s.roomId, month: inv.month,
    amount: Number(amount) || inv.total, fileId: fileId,
    uploadedAt: new Date().toISOString(), status: 'pending', note: '',
  });
  fsUpdate_(COL.INVOICES, invoiceId, { status: 'pending' });
  audit_(s, 'ผู้เช่าแนบสลิป', 'ใบแจ้งหนี้ ' + (inv.number || invoiceId) + ' ห้อง ' + s.roomId, money_(p.amount) + ' บาท');
  return p;
}

function apiListPayments(token, status) {
  requireSession_(token, 'admin');
  const rows = status ? fsWhere_(COL.PAYMENTS, { status: status }) : fsList_(COL.PAYMENTS);
  rows.sort(function (a, b) { return a.uploadedAt < b.uploadedAt ? 1 : -1; });
  return rows;
}

/** แอดมินตรวจสลิป */
function apiReviewPayment(token, paymentId, approve, note) {
  const me = requireSession_(token, 'admin');
  const p = fsGet_(COL.PAYMENTS, paymentId);
  if (!p) throw new Error('ไม่พบรายการ');
  fsUpdate_(COL.PAYMENTS, paymentId, {
    status: approve ? 'approved' : 'rejected', note: note || '',
    reviewedBy: me.email || me.name || '', reviewedAt: new Date().toISOString(),
  });
  let rcNo = '';
  if (approve) {
    const paidAt = today_();
    fsUpdate_(COL.INVOICES, p.invoiceId, { status: 'paid', paidAt: paidAt });
    const rc = issueReceipt_(p.invoiceId, paidAt, paymentId, me);
    if (rc) { fsUpdate_(COL.PAYMENTS, paymentId, { receiptId: rc.id, receiptNo: rc.number }); rcNo = rc.number; }
  } else {
    fsUpdate_(COL.INVOICES, p.invoiceId, { status: 'unpaid', paidAt: '' });
  }
  audit_(me, approve ? 'อนุมัติสลิป' : 'ไม่อนุมัติสลิป', 'ห้อง ' + p.roomId + ' บิล ' + p.month,
    money_(p.amount) + ' บาท' + (rcNo ? ' · ออกใบเสร็จ ' + rcNo : '') + (note ? ' · ' + note : ''));
  return true;
}

// ---------- ใบเสร็จรับเงิน ----------

/**
 * ออกใบเสร็จของใบแจ้งหนี้ (ถ้ามีใบที่ยังใช้งานอยู่แล้ว คืนใบเดิม)
 * เลขที่ = พ.ศ.เดือนวันที่ที่ยืนยันการโอน-ลำดับ เช่น 25691105-001
 */
function issueReceipt_(invoiceId, paidAt, paymentId, me) {
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv) return null;
  if (inv.receiptId) {
    const old = fsGet_(COL.RECEIPTS, inv.receiptId);
    if (old && old.status !== 'void') return old;
  }
  const s = getSettings_();
  const rc = {
    number: nextDocNo_('rc', paidAt), status: 'issued',
    invoiceId: invoiceId, invoiceNo: inv.number || '', roomId: inv.roomId, month: inv.month,
    tenantName: inv.tenantName || '', amount: Number(inv.total) || 0, paidAt: paidAt,
    paymentId: paymentId || '', pdfFileId: '', origFileId: '',
  };
  const signer = signer_(me);
  rc.issuedBy = signer ? signer.name : '';
  rc.issuedById = (me && me.adminId) || '';
  const f = renderReceiptPair_(s, inv, rc, signer);
  rc.pdfFileId = f.copy;
  rc.origFileId = f.orig;
  const saved = fsSet_(COL.RECEIPTS, null, rc);
  fsUpdate_(COL.INVOICES, invoiceId, {
    receiptId: saved.id, receiptNo: rc.number, receiptPdfId: f.copy, receiptOrigId: f.orig,
    receiptOrigPrints: 0, receiptCopyPrints: 0,
  });
  return saved;
}

/**
 * ใบเสร็จมี 2 ไฟล์: "สำเนา" (ใช้เปิดดู/ดาวน์โหลด/ผู้เช่าพิมพ์) และ "ต้นฉบับ" (แอดมินสั่งพิมพ์เท่านั้น)
 * ไฟล์ต้นฉบับติดแท็ก orig ผู้เช่าเปิดไม่ได้
 */
function renderReceiptPair_(s, inv, rc, signer) {
  const copy = renderReceiptPdf_(s, inv, rc, 'สำเนา', null, signer);
  const orig = renderReceiptPdf_(s, inv, rc, 'ต้นฉบับ', null, signer);
  DriveApp.getFileById(orig).setDescription('room:' + inv.roomId + '|orig:1');
  return { copy: copy, orig: orig };
}

/** ใบเสร็จที่ออกก่อนมีระบบต้นฉบับ/สำเนา: สร้างไฟล์ทั้งสองแบบให้ (คืนใบแจ้งหนี้ที่อัปเดตแล้ว) */
function ensureReceiptPair_(inv, s) {
  if (!inv.receiptId || inv.receiptOrigId) return inv;
  const rc = fsGet_(COL.RECEIPTS, inv.receiptId);
  if (!rc) return inv;
  const f = renderReceiptPair_(s || getSettings_(), inv, rc,
    rc.issuedById ? signer_({ adminId: rc.issuedById }) : null);
  fsUpdate_(COL.RECEIPTS, rc.id, { pdfFileId: f.copy, origFileId: f.orig, oldPdfFileId: rc.pdfFileId || '' });
  const upd = {
    receiptPdfId: f.copy, receiptOrigId: f.orig,
    receiptOrigPrints: Number(inv.receiptOrigPrints) || 0, receiptCopyPrints: Number(inv.receiptCopyPrints) || 0,
  };
  fsUpdate_(COL.INVOICES, inv.id, upd);
  return Object.assign(inv, upd);
}

/** รันจาก editor ครั้งเดียว: ทำไฟล์ต้นฉบับ/สำเนาให้ใบเสร็จที่ออกไปแล้ว */
function migrateReceiptLabels() {
  const s = getSettings_();
  let n = 0;
  fsWhere_(COL.INVOICES, { status: 'paid' }).forEach(function (inv) {
    if (inv.receiptId && !inv.receiptOrigId) { ensureReceiptPair_(inv, s); n++; }
  });
  Logger.log('ทำไฟล์ต้นฉบับ/สำเนาแล้ว ' + n + ' ใบ');
}

/**
 * แอดมินสั่งพิมพ์หลายใบในครั้งเดียว
 * kind: 'invoice' ใบแจ้งหนี้ | 'original' ใบเสร็จต้นฉบับ | 'copy' ใบเสร็จสำเนา
 * นับจำนวนครั้งที่พิมพ์ใบเสร็จ (เปิดดูไม่นับ) และบันทึกประวัติ
 * คืน [{invoiceId, roomId, mimeType, data, origPrints}] เรียงตามเลขห้อง
 */
function apiPrintDocs(token, invoiceIds, kind) {
  const me = requireSession_(token, 'admin');
  if (['invoice', 'original', 'copy'].indexOf(kind) < 0) throw new Error('ประเภทเอกสารไม่ถูกต้อง');
  if (!invoiceIds || !invoiceIds.length) throw new Error('กรุณาเลือกห้อง');
  const s = getSettings_();
  const invs = fsMulti_(invoiceIds.map(function (id) { return { get: [COL.INVOICES, id] }; }))
    .filter(function (i) { return i && i.status !== 'cancelled'; })
    .sort(function (a, b) { return roomCmp_(a.roomId, b.roomId); });
  const out = [], nos = [];
  invs.forEach(function (inv) {
    let fileId;
    if (kind === 'invoice') {
      fileId = inv.pdfFileId;
    } else {
      if (!inv.receiptId) return;
      inv = ensureReceiptPair_(inv, s);
      fileId = kind === 'original' ? inv.receiptOrigId : inv.receiptPdfId;
      const field = kind === 'original' ? 'receiptOrigPrints' : 'receiptCopyPrints';
      inv[field] = (Number(inv[field]) || 0) + 1;
      const upd = {};
      upd[field] = inv[field];
      if (kind === 'original') upd.receiptOrigPrintedAt = new Date().toISOString();
      fsUpdate_(COL.INVOICES, inv.id, upd);
    }
    if (!fileId) return;
    const blob = DriveApp.getFileById(fileId).getBlob();
    out.push({
      invoiceId: inv.id, roomId: inv.roomId, mimeType: blob.getContentType(),
      data: Utilities.base64Encode(blob.getBytes()), origPrints: Number(inv.receiptOrigPrints) || 0,
    });
    nos.push(inv.roomId + (kind === 'invoice' ? '' : ' ' + (inv.receiptNo || '')) +
      (kind === 'original' && inv.receiptOrigPrints > 1 ? ' (ครั้งที่ ' + inv.receiptOrigPrints + ')' : ''));
  });
  if (!out.length) throw new Error('ไม่มีเอกสารให้พิมพ์');
  if (kind !== 'invoice') {
    audit_(me, kind === 'original' ? 'พิมพ์ใบเสร็จต้นฉบับ' : 'พิมพ์ใบเสร็จสำเนา', out.length + ' ใบ', nos.join(', '));
  }
  return out;
}

/** ยกเลิกใบเสร็จ (เก็บไว้เป็นประวัติ ไม่ลบ) และตัดการเชื่อมจากใบแจ้งหนี้ */
function voidReceipt_(invoiceId, reason) {
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv || !inv.receiptId) return;
  fsUpdate_(COL.RECEIPTS, inv.receiptId, { status: 'void', voidReason: reason || '', voidedAt: today_() });
  fsUpdate_(COL.INVOICES, invoiceId, { receiptId: '', receiptNo: '', receiptPdfId: '', receiptOrigId: '', receiptOrigPrints: 0, receiptCopyPrints: 0 });
}
