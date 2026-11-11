/**
 * สลิปโอนเงิน: ผู้เช่าอัปโหลด -> แอดมินตรวจ -> อนุมัติ/ปฏิเสธ
 */

/** ผู้เช่าแนบสลิปให้บิล */
function apiUploadSlip(token, invoiceId, upload, amount) {
  const s = requireSession_(token, 'tenant');
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv || inv.roomId !== s.roomId) throw new Error('ไม่พบใบแจ้งหนี้');
  if (inv.status === 'paid') throw new Error('บิลนี้ชำระแล้ว');
  const settings = getSettings_();
  const fileId = saveUpload_(settings.slipFolderId, upload, s.roomId, 'slip_' + inv.month);
  const p = fsSet_(COL.PAYMENTS, null, {
    invoiceId: invoiceId, roomId: s.roomId, month: inv.month,
    amount: Number(amount) || inv.total, fileId: fileId,
    uploadedAt: new Date().toISOString(), status: 'pending', note: '',
  });
  fsUpdate_(COL.INVOICES, invoiceId, { status: 'pending' });
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
  requireSession_(token, 'admin');
  const p = fsGet_(COL.PAYMENTS, paymentId);
  if (!p) throw new Error('ไม่พบรายการ');
  fsUpdate_(COL.PAYMENTS, paymentId, { status: approve ? 'approved' : 'rejected', note: note || '' });
  fsUpdate_(COL.INVOICES, p.invoiceId, { status: approve ? 'paid' : 'unpaid', paidAt: approve ? today_() : '' });
  return true;
}
