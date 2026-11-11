/**
 * บัญชีรายรับ-รายจ่าย
 *
 * รายรับค่าเช่า: มาจากใบแจ้งหนี้ที่สถานะ "ชำระแล้ว" อัตโนมัติ (นับตามเดือนของบิล)
 * รายรับอื่น / รายจ่าย: บันทึกเองใน ledger (แนบรูปใบเสร็จได้)
 */

const LEDGER_CATEGORIES = {
  income: ['เงินประกัน', 'ค่าปรับ', 'รายรับอื่น ๆ'],
  expense: ['ค่าไฟฟ้า (หลวง)', 'ค่าน้ำประปา (หลวง)', 'ค่าซ่อม/อะไหล่', 'ค่าจ้าง/เงินเดือน',
    'ค่าทำความสะอาด', 'คืนเงินประกัน', 'ภาษี/ค่าธรรมเนียม', 'รายจ่ายอื่น ๆ'],
};

/** สรุปเดือน: รายรับค่าเช่า + รายรับอื่น - รายจ่าย และยอดค้างรับ */
function apiAccountMonth(token, month) {
  requireSession_(token, 'admin');
  const r = fsMulti_([
    { where: [COL.INVOICES, { month: month }] },
    { where: [COL.LEDGER, { month: month }] },
  ]);
  const invoices = r[0].filter(function (i) { return i.status !== 'cancelled'; });
  const paid = invoices.filter(function (i) { return i.status === 'paid'; });
  const unpaid = invoices.filter(function (i) { return i.status !== 'paid'; });
  const entries = sortBy_(r[1], 'date', true);
  const sum = function (rows, f) { return round2_(rows.reduce(function (s, x) { return s + (Number(x[f || 'total']) || 0); }, 0)); };
  const otherIncome = sum(entries.filter(function (e) { return e.type === 'income'; }), 'amount');
  const expense = sum(entries.filter(function (e) { return e.type === 'expense'; }), 'amount');
  const rentIncome = sum(paid);
  return {
    month: month,
    rentIncome: rentIncome,
    otherIncome: otherIncome,
    income: round2_(rentIncome + otherIncome),
    expense: expense,
    net: round2_(rentIncome + otherIncome - expense),
    outstanding: sum(unpaid),
    paidInvoices: paid.map(function (i) { return { roomId: i.roomId, number: i.number, total: i.total, paidAt: i.paidAt || '' }; }),
    unpaidInvoices: unpaid.map(function (i) { return { roomId: i.roomId, number: i.number, total: i.total, status: i.status }; }),
    entries: entries,
    categories: LEDGER_CATEGORIES,
  };
}

/** สรุปทั้งปี (ค.ศ.) รายเดือน */
function apiAccountYear(token, year) {
  requireSession_(token, 'admin');
  const r = fsMulti_([{ list: COL.INVOICES }, { list: COL.LEDGER }]);
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = year + '-' + ('0' + m).slice(-2);
    const inv = r[0].filter(function (i) { return i.month === ym && i.status !== 'cancelled'; });
    const led = r[1].filter(function (e) { return e.month === ym; });
    const rent = inv.filter(function (i) { return i.status === 'paid'; }).reduce(function (s, i) { return s + (Number(i.total) || 0); }, 0);
    const other = led.filter(function (e) { return e.type === 'income'; }).reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
    const exp = led.filter(function (e) { return e.type === 'expense'; }).reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
    months.push({ month: ym, income: round2_(rent + other), expense: round2_(exp), net: round2_(rent + other - exp) });
  }
  return months;
}

/** บันทึกรายการ  entry: {id?, type, date, category, amount, note}  file: {name,mimeType,data} (ไม่บังคับ) */
function apiSaveEntry(token, entry, file) {
  requireSession_(token, 'admin');
  if (['income', 'expense'].indexOf(entry.type) < 0) throw new Error('ประเภทไม่ถูกต้อง');
  const amount = round2_(entry.amount);
  if (!(amount > 0)) throw new Error('กรุณาใส่จำนวนเงิน');
  const date = entry.date || today_();
  const old = entry.id ? fsGet_(COL.LEDGER, entry.id) : null;
  let fileId = old ? old.fileId || '' : '';
  if (file && file.data) fileId = saveUpload_(getSettings_().slipFolderId, file, 'ledger', 'receipt');
  return fsSet_(COL.LEDGER, entry.id || null, {
    type: entry.type, date: date, month: date.slice(0, 7), category: entry.category || '',
    amount: amount, note: entry.note || '', fileId: fileId, repairId: old ? old.repairId || '' : '',
  });
}

function apiDeleteEntry(token, id) {
  requireSession_(token, 'admin');
  fsDelete_(COL.LEDGER, id);
  return true;
}
