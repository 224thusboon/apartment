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
    const rc = issueReceipt_(p.invoiceId, paidAt, paymentId);
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
function issueReceipt_(invoiceId, paidAt, paymentId) {
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
    paymentId: paymentId || '', pdfFileId: '',
  };
  rc.pdfFileId = renderReceiptPdf_(s, inv, rc);
  const saved = fsSet_(COL.RECEIPTS, null, rc);
  fsUpdate_(COL.INVOICES, invoiceId, { receiptId: saved.id, receiptNo: rc.number, receiptPdfId: rc.pdfFileId });
  return saved;
}

/** ยกเลิกใบเสร็จ (เก็บไว้เป็นประวัติ ไม่ลบ) และตัดการเชื่อมจากใบแจ้งหนี้ */
function voidReceipt_(invoiceId, reason) {
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv || !inv.receiptId) return;
  fsUpdate_(COL.RECEIPTS, inv.receiptId, { status: 'void', voidReason: reason || '', voidedAt: today_() });
  fsUpdate_(COL.INVOICES, invoiceId, { receiptId: '', receiptNo: '', receiptPdfId: '' });
}
