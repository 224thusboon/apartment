/**
 * บัญชีรายรับ-รายจ่าย (นับตามวันที่เงินเข้า/ออกจริง)
 *
 * รวม 3 แหล่ง:
 *   1) รายรับค่าเช่า   = ใบแจ้งหนี้ที่ยืนยันการโอนแล้ว (สถานะ "ชำระแล้ว") นับตามวันที่ยืนยัน (paidAt)
 *   2) รายจ่ายค่าซ่อม  = งานซ่อมที่ใส่ค่าใช้จ่าย นับตามวันที่ของงานซ่อม
 *   3) รายรับ/รายจ่ายอื่น ที่บันทึกเองใน ledger (แนบรูปใบเสร็จได้)
 * แหล่ง 1-2 ดึงอัตโนมัติ แก้ที่ต้นทาง (ใบแจ้งหนี้ / งานซ่อม)
 */

const LEDGER_CATEGORIES = {
  income: ['เงินประกัน', 'ค่าปรับ', 'รายรับอื่น ๆ'],
  expense: ['ค่าไฟฟ้า (หลวง)', 'ค่าน้ำประปา (หลวง)', 'ค่าซ่อม/อะไหล่', 'ค่าจ้าง/เงินเดือน',
    'ค่าทำความสะอาด', 'คืนเงินประกัน', 'ภาษี/ค่าธรรมเนียม', 'รายจ่ายอื่น ๆ'],
};

/** รวมทุกแหล่งเป็นรายการบัญชีเดียว */
function allEntries_(invoices, repairs, ledger) {
  const rows = [];
  invoices.forEach(function (i) {
    if (i.status !== 'paid') return;
    const date = i.paidAt || monthPeriod_(i.month).end;
    rows.push({
      id: 'inv_' + i.id, source: 'invoice', type: 'income', date: date, month: date.slice(0, 7),
      category: 'ค่าเช่า', amount: Number(i.total) || 0,
      note: 'ห้อง ' + i.roomId + ' · บิล ' + thaiMonth_(i.month),
      invoiceNo: i.number || '', receiptNo: i.receiptNo || '',
      invoiceFileId: i.pdfFileId || '', fileId: i.receiptPdfId || '',
      invoiceId: i.id, origPrints: Number(i.receiptOrigPrints) || 0,
    });
  });
  repairs.forEach(function (r) {
    const cost = Number(r.cost) || 0;
    if (cost <= 0) return;
    rows.push({
      id: 'rep_' + r.id, source: 'repair', type: 'expense', date: r.date, month: String(r.date).slice(0, 7),
      category: 'ค่าซ่อม/อะไหล่', amount: cost,
      note: 'ห้อง ' + r.roomId + ' · ' + (r.title || '') + (r.parts ? ' (' + r.parts + ')' : ''),
    });
  });
  ledger.forEach(function (e) {
    if (e.repairId) return; // รายการเก่าที่สร้างจากงานซ่อม นับจากงานซ่อมแทนแล้ว
    rows.push(Object.assign({}, e, { source: 'manual' }));
  });
  return rows;
}

function sumOf_(rows, type) {
  return round2_(rows.filter(function (e) { return e.type === type; })
    .reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0));
}

/** สรุปเดือน */
function apiAccountMonth(token, month) {
  requireSession_(token, 'admin');
  const r = fsMulti_([{ list: COL.INVOICES }, { list: COL.REPAIRS }, { list: COL.LEDGER }]);
  const all = allEntries_(r[0], r[1], r[2]);
  const entries = sortBy_(all.filter(function (e) { return e.month === month; }), 'date', true);
  const income = sumOf_(entries, 'income');
  const expense = sumOf_(entries, 'expense');
  const rent = round2_(entries.filter(function (e) { return e.source === 'invoice'; })
    .reduce(function (s, e) { return s + e.amount; }, 0));
  // ค้างรับ = ใบแจ้งหนี้ทุกเดือนที่ยังไม่ยืนยันการโอน (ไม่รวมใบที่ยกเลิก)
  const unpaid = r[0].filter(function (i) { return i.status !== 'paid' && i.status !== 'cancelled'; });
  return {
    month: month,
    income: income,
    rentIncome: rent,
    otherIncome: round2_(income - rent),
    expense: expense,
    net: round2_(income - expense),
    outstanding: round2_(unpaid.reduce(function (s, i) { return s + (Number(i.total) || 0); }, 0)),
    unpaidInvoices: sortBy_(unpaid, 'month').map(function (i) {
      return { roomId: i.roomId, number: i.number, total: i.total, status: i.status, month: i.month };
    }),
    entries: entries,
    categories: LEDGER_CATEGORIES,
  };
}

/** สรุปทั้งปี (ค.ศ.) รายเดือน */
function apiAccountYear(token, year) {
  requireSession_(token, 'admin');
  const r = fsMulti_([{ list: COL.INVOICES }, { list: COL.REPAIRS }, { list: COL.LEDGER }]);
  const all = allEntries_(r[0], r[1], r[2]);
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = year + '-' + ('0' + m).slice(-2);
    const rows = all.filter(function (e) { return e.month === ym; });
    const inc = sumOf_(rows, 'income'), exp = sumOf_(rows, 'expense');
    months.push({ month: ym, income: inc, expense: exp, net: round2_(inc - exp) });
  }
  return months;
}

/** บันทึกรายการเอง  entry: {id?, type, date, category, amount, note}  file: {name,mimeType,data} (ไม่บังคับ) */
function apiSaveEntry(token, entry, file) {
  const me = requireSession_(token, 'admin');
  if (['income', 'expense'].indexOf(entry.type) < 0) throw new Error('ประเภทไม่ถูกต้อง');
  const amount = round2_(entry.amount);
  if (!(amount > 0)) throw new Error('กรุณาใส่จำนวนเงิน');
  const date = entry.date || today_();
  const old = entry.id ? fsGet_(COL.LEDGER, entry.id) : null;
  let fileId = old ? old.fileId || '' : '';
  if (file && file.data) fileId = saveUpload_(getSettings_().slipFolderId, file, 'ledger', 'receipt');
  const saved = fsSet_(COL.LEDGER, entry.id || null, {
    type: entry.type, date: date, month: date.slice(0, 7), category: entry.category || '',
    amount: amount, note: entry.note || '', fileId: fileId,
    createdBy: old ? old.createdBy || '' : (me.email || me.name || ''),
  });
  audit_(me, (old ? 'แก้ไข' : 'บันทึก') + (entry.type === 'income' ? 'รายรับ' : 'รายจ่าย'), entry.category || '',
    money_(amount) + ' บาท' + (old && Number(old.amount) !== amount ? ' (เดิม ' + money_(old.amount) + ')' : '') +
    ' · ' + date + (entry.note ? ' · ' + entry.note : ''));
  return saved;
}

function apiDeleteEntry(token, id) {
  const me = requireSession_(token, 'admin');
  const e = fsGet_(COL.LEDGER, id);
  fsDelete_(COL.LEDGER, id);
  if (e) audit_(me, 'ลบ' + (e.type === 'income' ? 'รายรับ' : 'รายจ่าย'), e.category || '',
    money_(e.amount) + ' บาท · ' + e.date + (e.note ? ' · ' + e.note : ''));
  return true;
}
