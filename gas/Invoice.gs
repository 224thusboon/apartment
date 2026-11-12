/**
 * ใบแจ้งหนี้ PDF จากแม่แบบ Google Sheets (รูปแบบเดียวกับใบ Excel เดิมของหอ)
 *
 * แม่แบบใช้ตัวแทน {{...}} ในเซลล์ แก้หน้าตา/ฟอนต์/เส้นได้อิสระใน Google Sheets
 * ตราบใดที่ตัวแทนยังอยู่ครบ
 *   ส่วนหัว:  {{addr1}} {{addr2}} {{phone}}
 *   ผู้เช่า:  {{tenantName}} {{tenantAddress}} {{invoiceNo}} {{invoiceDate}} {{periodStart}} {{periodEnd}} {{roomId}}
 *   รายการ:  {{1.no}} {{1.name}} {{1.qty}} {{1.price}} {{1.amount}} {{1.vat}} {{1.total}} ... ถึง {{8.*}}
 *   ข้อความ: {{note1}} ... {{note6}}  และ {{footer}}
 *   ยอดรวม:  {{total}}
 *
 * ใช้ Sheets REST API + สิทธิ์ drive ที่มีอยู่แล้ว (ไม่ต้องขอสิทธิ์ใหม่)
 */

const INV_MAX_ITEMS = 8;
const INV_MAX_NOTES = 6;

function gFetch_(url, method, payload) {
  const opt = {
    method: method || 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (payload !== undefined) {
    opt.contentType = 'application/json';
    opt.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(url, opt);
  if (res.getResponseCode() >= 300) throw new Error('Google API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return res;
}

// ---------- สร้างแม่แบบ ----------

function createInvoiceTemplate_(folder, kind) {
  const isRc = kind === 'receipt';
  // ความกว้างคอลัมน์ A-G (สัดส่วนใบเดิม รวม ~700px = พอดีกระดาษ A4 ไม่ถูกย่อ)
  const widths = [42, 228, 58, 100, 68, 86, 120];
  const R = {}; // R[row][col] = {v, bold, size, align, text}
  function put(r, c, v, f) { (R[r] = R[r] || {})[c] = Object.assign({ v: v }, f || {}); }
  const RIGHT = { align: 'RIGHT', text: true };
  const CENTER = { align: 'CENTER' };

  put(0, 4, isRc ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้', { bold: true, size: 16 });
  put(1, 0, '{{addr1}}');
  put(2, 0, '{{addr2}}');
  put(4, 0, 'โทร. {{phone}}');

  // กล่องผู้เช่า แถว 6-8
  put(6, 0, 'ชื่อ'); put(6, 1, 'คุณ  {{tenantName}}'); put(6, 4, 'เลขที่  {{invoiceNo}}');
  put(7, 0, 'ที่อยู่'); put(7, 1, '{{tenantAddress}}'); put(7, 4, 'วันที่  {{invoiceDate}}');
  put(8, 0, isRc
    ? 'อ้างอิงใบแจ้งหนี้เลขที่  {{refNo}}   ค่าบริการ  {{periodStart}} - {{periodEnd}}'
    : 'วันที่เริ่มคิดค่าบริการ  {{periodStart}} - {{periodEnd}}');
  put(8, 4, 'ห้อง  {{roomId}}');

  // หัวตาราง แถว 10
  ['ลำดับ', 'รายการ', 'จำนวน', 'ราคา', 'จำนวนเงิน', 'ภาษี', 'รวมเงิน'].forEach(function (h, c) { put(10, c, h, CENTER); });

  // รายการ แถว 11.. (8 แถว)
  const ITEM0 = 11;
  for (let i = 1; i <= INV_MAX_ITEMS; i++) {
    const r = ITEM0 + i - 1;
    put(r, 0, '{{' + i + '.no}}', RIGHT);
    put(r, 1, '{{' + i + '.name}}', { text: true });
    put(r, 2, '{{' + i + '.qty}}', RIGHT);
    put(r, 3, '{{' + i + '.price}}', RIGHT);
    put(r, 4, '{{' + i + '.amount}}', RIGHT);
    put(r, 5, '{{' + i + '.vat}}', RIGHT);
    put(r, 6, '{{' + i + '.total}}', RIGHT);
  }
  // ข้อความแจ้งผู้เช่า (ล้นข้ามคอลัมน์เหมือนใบเดิม)
  const NOTE0 = ITEM0 + INV_MAX_ITEMS + 1;
  for (let i = 1; i <= INV_MAX_NOTES; i++) put(NOTE0 + i - 1, 1, '{{note' + i + '}}');
  const BODY_END = NOTE0 + INV_MAX_NOTES + 1; // แถวสุดท้ายของกรอบรายการ (ไม่รวม)

  // ยอดรวม 4 แถว
  const TOT0 = BODY_END;
  put(TOT0, 3, 'มูลค่าสินค้าที่ยกเว้นภาษี');
  put(TOT0 + 1, 3, 'มูลค่าสินค้าที่รวมภาษี');
  put(TOT0 + 2, 3, 'ภาษีมูลค่าเพิ่ม 7 %');
  put(TOT0 + 3, 3, 'ยอดเงินสุทธิ');
  put(TOT0 + 3, 6, '{{total}}', RIGHT);
  const TOT_END = TOT0 + 4;

  put(TOT_END + 1, 1, 'ผู้รับเงิน _____________________', { bold: true });
  put(TOT_END + 1, 3, 'วันที่_______________', { bold: true });
  put(TOT_END + 3, 0, '{{footer}}', { bold: true });
  const ROWS = TOT_END + 5;

  // แปลงเป็น rowData
  const rowData = [];
  for (let r = 0; r < ROWS; r++) {
    const values = [];
    for (let c = 0; c < 7; c++) {
      const cell = (R[r] || {})[c];
      const fmt = {
        textFormat: { fontFamily: 'Sarabun', fontSize: cell && cell.size ? cell.size : 11, bold: !!(cell && cell.bold) },
        verticalAlignment: 'MIDDLE',
        wrapStrategy: 'OVERFLOW_CELL',
      };
      if (cell && cell.align) fmt.horizontalAlignment = cell.align;
      if (cell && cell.text) fmt.numberFormat = { type: 'TEXT' };
      const v = { userEnteredFormat: fmt };
      if (cell) v.userEnteredValue = { stringValue: cell.v };
      values.push(v);
    }
    rowData.push({ values: values });
  }

  const ss = JSON.parse(gFetch_('https://sheets.googleapis.com/v4/spreadsheets', 'post', {
    properties: { title: isRc ? 'แม่แบบ - ใบเสร็จรับเงิน' : 'แม่แบบ - ใบแจ้งหนี้', locale: 'th_TH' },
    sheets: [{
      properties: { sheetId: 0, title: isRc ? 'ใบเสร็จ' : 'ใบแจ้งหนี้', gridProperties: { rowCount: ROWS, columnCount: 7, hideGridlines: true } },
      data: [{ startRow: 0, startColumn: 0, rowData: rowData }],
    }],
  }).getContentText());
  const id = ss.spreadsheetId;

  const line = { style: 'SOLID', width: 1, color: { red: 0, green: 0, blue: 0 } };
  const rng = function (r1, r2, c1, c2) { return { sheetId: 0, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 }; };
  const reqs = [];
  widths.forEach(function (w, c) {
    reqs.push({ updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } });
  });
  function rowH(r1, r2, px) {
    reqs.push({ updateDimensionProperties: { range: { sheetId: 0, dimension: 'ROWS', startIndex: r1, endIndex: r2 }, properties: { pixelSize: px }, fields: 'pixelSize' } });
  }
  rowH(0, ROWS, 21);
  rowH(6, 9, 40);           // กล่องผู้เช่าสูงแบบใบเดิม
  rowH(ITEM0, BODY_END, 26);
  // กล่องผู้เช่า: กรอบนอก + เส้นแบ่งระหว่าง D|E
  reqs.push({ updateBorders: { range: rng(6, 9, 0, 7), top: line, bottom: line, left: line, right: line } });
  reqs.push({ updateBorders: { range: rng(6, 9, 4, 7), left: line } });
  // หัวตาราง: กรอบทุกช่อง
  reqs.push({ updateBorders: { range: rng(10, 11, 0, 7), top: line, bottom: line, left: line, right: line, innerVertical: line } });
  // เนื้อตาราง: เส้นแนวตั้งอย่างเดียว (ไม่มีเส้นแนวนอนระหว่างแถว)
  reqs.push({ updateBorders: { range: rng(11, BODY_END, 0, 7), left: line, right: line, innerVertical: line, bottom: line } });
  // ยอดรวม: กรอบนอก + เส้นซ้ายของ D และซ้ายของ G
  reqs.push({ updateBorders: { range: rng(TOT0, TOT_END, 0, 7), top: line, bottom: line, left: line, right: line } });
  reqs.push({ updateBorders: { range: rng(TOT0, TOT_END, 3, 6), left: line, right: line } });
  gFetch_('https://sheets.googleapis.com/v4/spreadsheets/' + id + ':batchUpdate', 'post', { requests: reqs });

  DriveApp.getFileById(id).moveTo(folder);
  return id;
}

/**
 * รันจาก editor: สร้างแม่แบบใบแจ้งหนี้ใหม่ (แม่แบบเก่าย้ายลงถังขยะ กู้คืนได้ 30 วัน)
 */
function rebuildInvoiceTemplate() {
  const s = getSettings_();
  const folder = DriveApp.getFolderById(s.rootFolderId);
  const id = createInvoiceTemplate_(folder, 'invoice');
  const rid = createInvoiceTemplate_(folder, 'receipt');
  [s.invoiceTemplateId, s.receiptTemplateId].forEach(function (old) {
    if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (e) { /* ไม่มีไฟล์เก่า */ } }
  });
  fsUpdate_(COL.SETTINGS, 'main', { invoiceTemplateId: id, receiptTemplateId: rid });
  clearSettingsCache_();
  Logger.log('แม่แบบใบแจ้งหนี้: https://docs.google.com/spreadsheets/d/' + id + '/edit');
  Logger.log('แม่แบบใบเสร็จ: https://docs.google.com/spreadsheets/d/' + rid + '/edit');
}

/** สร้างแม่แบบใบเสร็จครั้งแรกถ้ายังไม่มี */
function ensureReceiptTemplate_(s) {
  if (s.receiptTemplateId) return s.receiptTemplateId;
  const id = createInvoiceTemplate_(DriveApp.getFolderById(s.rootFolderId), 'receipt');
  fsUpdate_(COL.SETTINGS, 'main', { receiptTemplateId: id });
  clearSettingsCache_();
  s.receiptTemplateId = id;
  return id;
}

// ---------- เติมแม่แบบ -> PDF ----------

function fmtQty_(q) {
  const n = Number(q) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function renderInvoicePdf_(settings, inv) {
  if (!settings.invoiceTemplateId) throw new Error('ยังไม่มีแม่แบบใบแจ้งหนี้ (รัน rebuildInvoiceTemplate)');
  const map = docMap_(settings, inv, {
    docNo: inv.number, docDate: inv.issuedAt,
    notes: String(settings.invoiceNotes || '').split(/\r?\n/), footer: settings.invoiceFooter || '',
  });
  return renderSheetPdf_(settings, settings.invoiceTemplateId, 'ใบแจ้งหนี้ ' + inv.roomId + ' ' + inv.month, inv.roomId, map);
}

/**
 * ใบเสร็จ: รายการเดียวกับใบแจ้งหนี้ อ้างอิงเลขที่ใบแจ้งหนี้
 * label: 'ต้นฉบับ' หรือ 'สำเนา' พิมพ์เป็นกรอบมุมขวาบน
 */
function renderReceiptPdf_(settings, inv, rc, label) {
  const tid = ensureReceiptTemplate_(settings);
  const map = docMap_(settings, inv, {
    docNo: rc.number, docDate: rc.paidAt, refNo: inv.number || '-',
    notes: [
      'ได้รับเงินตามรายการข้างต้นเรียบร้อยแล้ว',
      'ชำระโดยโอนเงิน  ยืนยันการโอนวันที่ ' + shortDate_(rc.paidAt),
      'อ้างอิงใบแจ้งหนี้เลขที่ ' + (inv.number || '-'),
    ],
    footer: '',
  });
  return renderSheetPdf_(settings, tid, 'ใบเสร็จ ' + rc.number + ' ห้อง ' + inv.roomId + (label ? ' (' + label + ')' : ''),
    inv.roomId, map, label);
}

function docMap_(settings, inv, o) {
  const items = inv.items || [];
  if (items.length > INV_MAX_ITEMS) throw new Error('รายการเกิน ' + INV_MAX_ITEMS + ' บรรทัด');
  const addr = String(settings.dormAddress || '').split(/\r?\n/);
  const map = {
    addr1: addr[0] || '', addr2: addr.slice(1).join(' '), phone: settings.phone || '',
    tenantName: inv.tenantName || '', tenantAddress: inv.tenantAddress || '',
    invoiceNo: o.docNo || '', invoiceDate: shortDate_(o.docDate), refNo: o.refNo || '',
    periodStart: shortDate_(inv.periodStart), periodEnd: shortDate_(inv.periodEnd),
    roomId: inv.roomId, total: money_(inv.total), footer: o.footer || '',
  };
  for (let i = 1; i <= INV_MAX_NOTES; i++) map['note' + i] = o.notes[i - 1] || '';
  for (let i = 1; i <= INV_MAX_ITEMS; i++) {
    const it = items[i - 1];
    map[i + '.no'] = it ? String(i) : '';
    map[i + '.name'] = it ? it.name : '';
    map[i + '.qty'] = it ? fmtQty_(it.qty) : '';
    map[i + '.price'] = it ? money_(it.price) : '';
    map[i + '.amount'] = '';
    map[i + '.vat'] = '';
    map[i + '.total'] = it ? money_(it.amount) : '';
  }
  return map;
}

/** คัดลอกแม่แบบ Sheets -> แทนค่า -> export PDF -> ลบสำเนา */
function renderSheetPdf_(settings, templateId, name, roomId, map, label) {
  const folder = DriveApp.getFolderById(settings.pdfFolderId);
  const copy = DriveApp.getFileById(templateId).makeCopy(name, folder);
  try {
    const reqs = Object.keys(map).map(function (k) {
      return { findReplace: { find: '{{' + k + '}}', replacement: String(map[k]), allSheets: true, matchCase: true } };
    });
    if (label) {
      // กรอบ ต้นฉบับ/สำเนา ที่ช่อง G4 (แถวว่างใต้ชื่อเอกสาร)
      const line = { style: 'SOLID_MEDIUM', color: { red: 0, green: 0, blue: 0 } };
      const cell = { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 6, endColumnIndex: 7 };
      reqs.push({ updateCells: {
        range: cell, fields: 'userEnteredValue,userEnteredFormat',
        rows: [{ values: [{ userEnteredValue: { stringValue: label }, userEnteredFormat: {
          horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
          textFormat: { fontFamily: 'Sarabun', fontSize: 13, bold: true },
        } }] }],
      } });
      reqs.push({ updateBorders: { range: cell, top: line, bottom: line, left: line, right: line } });
    }
    gFetch_('https://sheets.googleapis.com/v4/spreadsheets/' + copy.getId() + ':batchUpdate', 'post', { requests: reqs });
    const url = 'https://docs.google.com/spreadsheets/d/' + copy.getId() + '/export?format=pdf&size=A4&portrait=true' +
      '&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&fzr=false' +
      '&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4&gid=0';
    const blob = gFetch_(url).getBlob().setName(name + '.pdf');
    const pdf = folder.createFile(blob);
    pdf.setDescription('room:' + roomId);
    return pdf.getId();
  } finally {
    copy.setTrashed(true);
  }
}
