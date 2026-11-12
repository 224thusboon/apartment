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

// ---------- ส่งออก Excel ----------

/**
 * ส่งออกรายงานบัญชี
 * period: 'YYYY-MM' (รายเดือน) หรือ 'YYYY' (ทั้งปี ค.ศ.)
 * format: 'xlsx' (Excel) | 'pdf' | 'sheet' (Google Sheets เก็บไว้ในโฟลเดอร์ "รายงานบัญชี" ใน Drive)
 * xlsx/pdf คืน {name, mimeType, data(base64)} ; sheet คืน {name, url}
 */
function apiExportAccounts(token, period, format) {
  const me = requireSession_(token, 'admin');
  format = format || 'xlsx';
  if (['xlsx', 'pdf', 'sheet'].indexOf(format) < 0) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
  period = String(period || '');
  const isYear = /^\d{4}$/.test(period);
  if (!isYear && !/^\d{4}-\d{2}$/.test(period)) throw new Error('ช่วงเวลาไม่ถูกต้อง');
  const settings = getSettings_();
  const r = fsMulti_([{ list: COL.INVOICES }, { list: COL.REPAIRS }, { list: COL.LEDGER }]);
  const all = allEntries_(r[0], r[1], r[2]);
  const inPeriod = function (e) { return isYear ? e.month.slice(0, 4) === period : e.month === period; };
  const entries = sortBy_(all.filter(inPeriod), 'date', false);
  const be = isYear ? String(Number(period) + 543) : String(Number(period.slice(0, 4)) + 543) + '-' + period.slice(5);
  const label = isYear ? 'ปี ' + (Number(period) + 543) : thaiMonth_(period);
  const title = 'รายงานบัญชีรายรับ-รายจ่าย ' + label;

  const income = sumOf_(entries, 'income'), expense = sumOf_(entries, 'expense');
  const rent = round2_(entries.filter(function (e) { return e.source === 'invoice'; })
    .reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0));
  const SRC = { invoice: 'ใบแจ้งหนี้ (ยืนยันการโอน)', repair: 'งานซ่อม', manual: 'บันทึกเอง' };
  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');

  // ---- แผ่นที่ 1: สรุป ----
  const sum = [];
  sum.push([{ v: settings.dormName || '', b: true, size: 14 }]);
  sum.push([{ v: title, b: true, size: 12 }]);
  sum.push(['ส่งออกเมื่อ ' + beDate_(now.slice(0, 10)) + ' ' + now.slice(11) + ' โดย ' + (me.email || me.name || '')]);
  sum.push([]);
  sum.push([{ v: 'รายการ', h: true }, { v: 'จำนวนเงิน (บาท)', h: true }]);
  sum.push(['รายรับค่าเช่า (ยืนยันการโอนแล้ว)', { n: rent }]);
  sum.push(['รายรับอื่น ๆ', { n: round2_(income - rent) }]);
  sum.push([{ v: 'รวมรายรับ', b: true }, { n: income, b: true }]);
  sum.push([{ v: 'รวมรายจ่าย', b: true }, { n: expense, b: true }]);
  sum.push([{ v: 'คงเหลือ', b: true }, { n: round2_(income - expense), b: true }]);
  const unpaid = sortBy_(r[0].filter(function (i) { return i.status !== 'paid' && i.status !== 'cancelled'; }), 'month');
  sum.push(['ค้างรับ ณ วันที่ส่งออก (ทุกเดือน)', { n: round2_(unpaid.reduce(function (s, i) { return s + (Number(i.total) || 0); }, 0)) }]);
  if (isYear) {
    sum.push([]);
    sum.push([{ v: 'เดือน', h: true }, { v: 'รายรับ', h: true }, { v: 'รายจ่าย', h: true }, { v: 'คงเหลือ', h: true }]);
    const first = sum.length + 1;
    for (let m = 1; m <= 12; m++) {
      const ym = period + '-' + ('0' + m).slice(-2);
      const rows = all.filter(function (e) { return e.month === ym; });
      const i = sumOf_(rows, 'income'), x = sumOf_(rows, 'expense');
      sum.push([thaiMonth_(ym), { n: i }, { n: x }, { n: round2_(i - x) }]);
    }
    const last = sum.length;
    sum.push([{ v: 'รวมทั้งปี', b: true }, { f: '=SUM(B' + first + ':B' + last + ')', b: true },
      { f: '=SUM(C' + first + ':C' + last + ')', b: true }, { f: '=SUM(D' + first + ':D' + last + ')', b: true }]);
  }
  sum.push([]);
  sum.push([{ v: 'ประเภท', h: true }, { v: 'หมวด', h: true }, { v: 'จำนวนรายการ', h: true }, { v: 'จำนวนเงิน (บาท)', h: true }]);
  ['income', 'expense'].forEach(function (type) {
    const cats = {};
    entries.filter(function (e) { return e.type === type; }).forEach(function (e) {
      const c = cats[e.category || '-'] = cats[e.category || '-'] || { n: 0, amt: 0 };
      c.n += 1; c.amt = round2_(c.amt + (Number(e.amount) || 0));
    });
    Object.keys(cats).sort().forEach(function (k) {
      sum.push([type === 'income' ? 'รายรับ' : 'รายจ่าย', k, { n: cats[k].n, int: true }, { n: cats[k].amt }]);
    });
  });

  // ---- แผ่นที่ 2: รายการ ----
  const det = [[
    { v: 'วันที่', h: true }, { v: 'ประเภท', h: true }, { v: 'หมวด', h: true }, { v: 'รายละเอียด', h: true },
    { v: 'ที่มา', h: true }, { v: 'เลขที่ใบแจ้งหนี้', h: true }, { v: 'เลขที่ใบเสร็จ', h: true },
    { v: 'รายรับ', h: true }, { v: 'รายจ่าย', h: true },
  ]];
  entries.forEach(function (e) {
    const amt = Number(e.amount) || 0;
    det.push([
      beDate_(e.date), e.type === 'income' ? 'รายรับ' : 'รายจ่าย', e.category || '', e.note || '', SRC[e.source] || '',
      e.invoiceNo || '', e.receiptNo || '',
      e.type === 'income' ? { n: amt } : '', e.type === 'expense' ? { n: amt } : '',
    ]);
  });
  const dl = det.length;
  det.push([{ v: 'รวม', b: true }, '', '', '', '', '', '',
    { f: '=SUM(H2:H' + dl + ')', b: true }, { f: '=SUM(I2:I' + dl + ')', b: true }]);

  const sheets = [
    { title: 'สรุป', rows: sum, freeze: 0 },
    { title: 'รายการ', rows: det, freeze: 1 },
  ];
  if (!isYear) {
    const un = [[{ v: 'ห้อง', h: true }, { v: 'บิลเดือน', h: true }, { v: 'เลขที่', h: true }, { v: 'สถานะ', h: true },
      { v: 'ครบกำหนด', h: true }, { v: 'จำนวนเงิน (บาท)', h: true }]];
    unpaid.forEach(function (i) {
      un.push([i.roomId, thaiMonth_(i.month), i.number || '', STATUS_TH_[i.status] || i.status, beDate_(i.dueDate), { n: Number(i.total) || 0 }]);
    });
    sheets.push({ title: 'ค้างรับ', rows: un, freeze: 1 });
  }

  const base = 'บัญชี_' + (settings.dormName || 'หอพัก') + '_' + be;
  const id = buildSheets_(base, sheets);
  const FMT_TH = { xlsx: 'Excel', pdf: 'PDF', sheet: 'Google Sheets' };
  audit_(me, 'ส่งออกบัญชี ' + FMT_TH[format], label, entries.length + ' รายการ');
  if (format === 'sheet') {
    // เก็บไว้ในโฟลเดอร์รายงานบัญชี (ส่งออกซ้ำจะได้ไฟล์ใหม่ ไฟล์เดิมยังอยู่)
    DriveApp.getFileById(id).moveTo(DriveApp.getFolderById(reportFolder_()));
    return { name: base, url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
  }
  try {
    const url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=' + format +
      (format === 'pdf' ? '&size=A4&portrait=true&fitw=true&gridlines=false&printtitle=false&sheetnames=true&pagenum=CENTER&fzr=true' +
        '&top_margin=0.5&bottom_margin=0.5&left_margin=0.5&right_margin=0.5' : '');
    const blob = gFetch_(url).getBlob();
    return {
      name: base + '.' + format,
      mimeType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Utilities.base64Encode(blob.getBytes()),
    };
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { Logger.log('ลบไฟล์ชั่วคราวไม่ได้: ' + e); }
  }
}

/** โฟลเดอร์ "รายงานบัญชี" ใน Drive ของหอ (สร้างครั้งแรก) */
function reportFolder_() {
  const s = getSettings_();
  if (s.reportFolderId) return s.reportFolderId;
  const id = DriveApp.getFolderById(s.rootFolderId).createFolder('รายงานบัญชี').getId();
  fsUpdate_(COL.SETTINGS, 'main', { reportFolderId: id });
  clearSettingsCache_();
  return id;
}

/** '2026-11-12' -> '12/11/2569' */
function beDate_(iso) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return Number(p[2]) + '/' + Number(p[1]) + '/' + (Number(p[0]) + 543);
}

/**
 * sheets: [{title, rows:[[cell]], freeze}]
 * cell: 'ข้อความ' | {v:'ข้อความ', b, h, size} | {n:ตัวเลข, b, int} | {f:'=สูตร', b}
 */
function buildSheets_(name, sheets) {
  const HEAD_BG = { red: 0.89, green: 0.93, blue: 0.97 };
  const body = {
    properties: { title: name, locale: 'th_TH' },
    sheets: sheets.map(function (sh, si) {
      const width = sh.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
      return {
        properties: { sheetId: si, title: sh.title, gridProperties: {
          rowCount: Math.max(sh.rows.length + 5, 20), columnCount: Math.max(width, 4), frozenRowCount: sh.freeze || 0 } },
        data: [{ startRow: 0, startColumn: 0, rowData: sh.rows.map(function (row) {
          return { values: row.map(function (c) {
            if (c === '' || c == null) return {};
            if (typeof c !== 'object') c = { v: c };
            const fmt = { textFormat: { fontFamily: 'Sarabun', fontSize: c.size || 11, bold: !!(c.b || c.h) }, verticalAlignment: 'MIDDLE' };
            const out = { userEnteredFormat: fmt };
            if (c.h) { fmt.backgroundColor = HEAD_BG; fmt.horizontalAlignment = 'CENTER'; }
            if (c.n !== undefined) {
              out.userEnteredValue = { numberValue: Number(c.n) || 0 };
              fmt.numberFormat = { type: 'NUMBER', pattern: c.int ? '#,##0' : '#,##0.00' };
            } else if (c.f) {
              out.userEnteredValue = { formulaValue: c.f };
              fmt.numberFormat = { type: 'NUMBER', pattern: '#,##0.00' };
            } else {
              out.userEnteredValue = { stringValue: String(c.v) };
            }
            return out;
          }) };
        }) }],
      };
    }),
  };
  const ss = JSON.parse(gFetch_('https://sheets.googleapis.com/v4/spreadsheets', 'post', body).getContentText());
  const id = ss.spreadsheetId;
  const reqs = sheets.map(function (sh, si) {
    return { autoResizeDimensions: { dimensions: { sheetId: si, dimension: 'COLUMNS', startIndex: 0, endIndex: 12 } } };
  });
  gFetch_('https://sheets.googleapis.com/v4/spreadsheets/' + id + ':batchUpdate', 'post', { requests: reqs });
  return id;
}
