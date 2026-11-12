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

/** รูปแบบเอกสาร: 'classic' แบบเดิม (ตามใบ Excel ของหอ) | 'modern' แบบใหม่ */
const DOC_STYLES = ['classic', 'modern'];
function docStyle_(settings, style) {
  style = style || settings.invoiceStyle || 'classic';
  return DOC_STYLES.indexOf(style) >= 0 ? style : 'classic';
}
/** ช่องที่พิมพ์กรอบ ต้นฉบับ/สำเนา ของแต่ละรูปแบบ (แถว/คอลัมน์ เริ่ม 0) */
const LABEL_CELL = { classic: { r: 3, c: 6 }, modern: { r: 3, c: 4 } };

/** id แม่แบบของ (ใบแจ้งหนี้|ใบเสร็จ) x (รูปแบบ) สร้างให้อัตโนมัติถ้ายังไม่มี */
function templateFor_(settings, kind, style) {
  if (style === 'classic') {
    if (kind === 'receipt') return ensureReceiptTemplate_(settings);
    if (!settings.invoiceTemplateId) throw new Error('ยังไม่มีแม่แบบใบแจ้งหนี้ (รัน rebuildInvoiceTemplate)');
    return settings.invoiceTemplateId;
  }
  const key = kind + 'TemplateModernId';
  if (settings[key]) return settings[key];
  const id = createModernTemplate_(DriveApp.getFolderById(settings.rootFolderId), kind);
  const upd = {};
  upd[key] = id;
  fsUpdate_(COL.SETTINGS, 'main', upd);
  clearSettingsCache_();
  settings[key] = id;
  return id;
}

function renderInvoicePdf_(settings, inv, style, signer) {
  style = docStyle_(settings, style);
  const map = docMap_(settings, inv, {
    docNo: inv.number, docDate: inv.issuedAt,
    notes: String(settings.invoiceNotes || '').split(/\r?\n/), footer: settings.invoiceFooter || '',
  });
  return renderSheetPdf_(settings, templateFor_(settings, 'invoice', style), 'ใบแจ้งหนี้ ' + inv.roomId + ' ' + inv.month, inv.roomId, map,
    null, null, { signer: signer, pos: SIGN_POS[style], date: shortDate_(inv.issuedAt) });
}

/**
 * ใบเสร็จ: รายการเดียวกับใบแจ้งหนี้ อ้างอิงเลขที่ใบแจ้งหนี้
 * label: 'ต้นฉบับ' หรือ 'สำเนา' พิมพ์เป็นกรอบมุมขวาบน
 */
function renderReceiptPdf_(settings, inv, rc, label, style, signer) {
  style = docStyle_(settings, style);
  const tid = templateFor_(settings, 'receipt', style);
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
    inv.roomId, map, label, LABEL_CELL[style], { signer: signer, pos: SIGN_POS[style], date: shortDate_(rc.paidAt) });
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
    dormName: settings.dormName || '', dueDate: shortDate_(inv.dueDate), totalText: bahtText_(inv.total),
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

/**
 * ตำแหน่งลายเซ็นของแต่ละรูปแบบ
 * img: แถว/คอลัมน์ (เริ่ม 1) ที่วางรูป + ระยะเลื่อน (px) ; name/date: ช่อง (เริ่ม 0) ที่เขียนชื่อและวันที่
 */
const SIGN_POS = {
  classic: { img: { row: 32, col: 2, x: 72, y: 2, h: 38 }, name: { r: 33, c: 1 }, date: { r: 32, c: 3, label: 'วันที่ ' } },
  modern: { img: { row: 29, col: 2, x: 92, y: 0, h: 42 }, name: { r: 30, c: 1 }, date: { r: 29, c: 3, label: 'วันที่  ' } },
};

/** ผู้ลงนามจาก session แอดมิน: {name, fileId, w, h} หรือ null */
function signer_(me) {
  if (!me || !me.adminId) return null;
  const a = fsGet_(COL.ADMINS, me.adminId);
  if (!a) return null;
  return { name: a.name || me.name || '', fileId: a.signatureFileId || '', w: Number(a.signatureW) || 0, h: Number(a.signatureH) || 0 };
}

/** คัดลอกแม่แบบ Sheets -> แทนค่า -> (ลายเซ็น) -> export PDF -> ลบสำเนา */
function renderSheetPdf_(settings, templateId, name, roomId, map, label, labelCell, sign) {
  const folder = DriveApp.getFolderById(settings.pdfFolderId);
  const copy = DriveApp.getFileById(templateId).makeCopy(name, folder);
  try {
    const reqs = Object.keys(map).map(function (k) {
      return { findReplace: { find: '{{' + k + '}}', replacement: String(map[k]), allSheets: true, matchCase: true } };
    });
    if (label) {
      // กรอบ ต้นฉบับ/สำเนา ที่ช่อง G4 (แถวว่างใต้ชื่อเอกสาร)
      const line = { style: 'SOLID_MEDIUM', color: { red: 0, green: 0, blue: 0 } };
      const lc = labelCell || LABEL_CELL.classic;
      const cell = { sheetId: 0, startRowIndex: lc.r, endRowIndex: lc.r + 1, startColumnIndex: lc.c, endColumnIndex: lc.c + 1 };
      reqs.push({ updateCells: {
        range: cell, fields: 'userEnteredValue,userEnteredFormat',
        rows: [{ values: [{ userEnteredValue: { stringValue: label }, userEnteredFormat: {
          horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
          textFormat: { fontFamily: 'Sarabun', fontSize: 13, bold: true },
        } }] }],
      } });
      reqs.push({ updateBorders: { range: cell, top: line, bottom: line, left: line, right: line } });
    }
    const sg = sign && sign.signer && sign.pos ? sign.signer : null;
    if (sg && sg.name) {
      // ชื่อผู้ออกเอกสารใต้ลายเซ็น และวันที่
      const txt = function (pos, text, align) {
        return { updateCells: {
          range: { sheetId: 0, startRowIndex: pos.r, endRowIndex: pos.r + 1, startColumnIndex: pos.c, endColumnIndex: pos.c + 1 },
          fields: 'userEnteredValue,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment',
          rows: [{ values: [{ userEnteredValue: { stringValue: text }, userEnteredFormat: {
            horizontalAlignment: align || 'CENTER', textFormat: { fontFamily: 'Sarabun', fontSize: 10 } } }] }],
        } };
      };
      reqs.push(txt(sign.pos.name, '( ' + sg.name + ' )'));
      if (sign.date) reqs.push(txt(sign.pos.date, sign.pos.date.label + sign.date, 'LEFT'));
    }
    gFetch_('https://sheets.googleapis.com/v4/spreadsheets/' + copy.getId() + ':batchUpdate', 'post', { requests: reqs });
    if (sg && sg.fileId) {
      // วางรูปลายเซ็นเหนือเส้นลงชื่อ
      try {
        const p = sign.pos.img;
        const blob = DriveApp.getFileById(sg.fileId).getBlob();
        const sh = SpreadsheetApp.openById(copy.getId()).getSheets()[0];
        const im = sh.insertImage(blob, p.col, p.row, p.x, p.y);
        const ratio = sg.w && sg.h ? sg.w / sg.h : 3;
        im.setHeight(p.h).setWidth(Math.min(200, Math.round(p.h * ratio)));
        SpreadsheetApp.flush();
      } catch (e) { Logger.log('ใส่ลายเซ็นไม่ได้: ' + e); }
    }
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

// ---------- จำนวนเงินเป็นตัวหนังสือ ----------

/** 3934.5 -> 'สามพันเก้าร้อยสามสิบสี่บาทห้าสิบสตางค์' */
function bahtText_(amount) {
  let n = Math.round((Number(amount) || 0) * 100) / 100;
  if (n === 0) return 'ศูนย์บาทถ้วน';
  const neg = n < 0;
  n = Math.abs(n);
  const baht = Math.floor(n);
  const satang = Math.round((n - baht) * 100);
  return (neg ? 'ลบ' : '') + (baht ? thaiNum_(baht) + 'บาท' : '') + (satang ? thaiNum_(satang) + 'สตางค์' : 'ถ้วน');
}
function thaiNum_(n, tail) {
  if (n >= 1000000) {
    const rest = n % 1000000;
    return thaiNum_(Math.floor(n / 1000000)) + 'ล้าน' + (rest ? thaiNum_(rest, true) : '');
  }
  if (tail && n === 1) return 'เอ็ด';
  const D = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const P = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]), p = s.length - i - 1;
    if (!d) continue;
    if (p === 1 && d === 1) out += 'สิบ';
    else if (p === 1 && d === 2) out += 'ยี่สิบ';
    else if (p === 0 && d === 1 && s.length > 1) out += 'เอ็ด';
    else out += D[d] + P[p];
  }
  return out;
}

// ---------- แม่แบบแบบใหม่ ----------

/**
 * แม่แบบแบบใหม่ (5 คอลัมน์ หัวกระดาษสีกรมท่า ตารางหัวสีเขียวอมฟ้า ยอดรวมเด่น มีจำนวนเงินตัวหนังสือ)
 * ใช้ตัวแทนชุดเดียวกับแบบเดิม + {{dormName}} {{dueDate}} {{totalText}}
 */
function createModernTemplate_(folder, kind) {
  const isRc = kind === 'receipt';
  const NAVY = { red: 0.059, green: 0.153, blue: 0.278 };
  const TEAL = { red: 0.102, green: 0.580, blue: 0.494 };
  const SOFT = { red: 0.953, green: 0.965, blue: 0.976 };
  const LINE = { red: 0.85, green: 0.88, blue: 0.91 };
  const WHITE = { red: 1, green: 1, blue: 1 };
  const MUTED = { red: 0.39, green: 0.45, blue: 0.53 };
  const MINT = { red: 0.70, green: 0.92, blue: 0.87 };
  const widths = [46, 330, 80, 110, 128];
  const C = 5;
  const R = {}, merges = [], heights = {}, bgRows = {};
  function put(r, c, v, f) { (R[r] = R[r] || {})[c] = Object.assign({ v: v }, f || {}); }
  function merge(r, c1, c2) { merges.push({ r: r, c1: c1, c2: c2 }); }
  function band(r, color) { bgRows[r] = color; }

  // หัวกระดาษ
  [0, 1, 2].forEach(function (r) { band(r, NAVY); });
  put(0, 0, '{{dormName}}', { b: true, size: 18, color: WHITE }); merge(0, 0, 2);
  put(0, 3, isRc ? 'ใบเสร็จรับเงิน' : 'ใบแจ้งหนี้', { b: true, size: 18, color: WHITE, align: 'RIGHT' }); merge(0, 3, 4);
  put(1, 0, '{{addr1}} {{addr2}}', { size: 10, color: WHITE }); merge(1, 0, 2);
  put(1, 3, isRc ? 'RECEIPT' : 'INVOICE', { size: 10, color: MINT, b: true, align: 'RIGHT' }); merge(1, 3, 4);
  put(2, 0, 'โทร. {{phone}}', { size: 10, color: WHITE }); merge(2, 0, 2);
  heights[0] = 46; heights[1] = 20; heights[2] = 24; heights[3] = 30;

  // ข้อมูลผู้เช่า / เอกสาร
  put(4, 0, isRc ? 'ได้รับเงินจาก' : 'เรียกเก็บจาก', { size: 9, b: true, color: MUTED }); merge(4, 0, 1);
  put(5, 0, 'คุณ {{tenantName}}', { size: 13, b: true }); merge(5, 0, 1);
  put(6, 0, '{{tenantAddress}}', { size: 10 }); merge(6, 0, 1);
  put(7, 0, 'ค่าบริการ {{periodStart}} - {{periodEnd}}', { size: 10, color: MUTED }); merge(7, 0, 1);
  put(4, 3, 'เลขที่', { size: 10, color: MUTED, align: 'RIGHT' }); put(4, 4, '{{invoiceNo}}', { b: true, align: 'RIGHT', text: true });
  put(5, 3, 'วันที่', { size: 10, color: MUTED, align: 'RIGHT' }); put(5, 4, '{{invoiceDate}}', { align: 'RIGHT', text: true });
  put(6, 3, 'ห้อง', { size: 10, color: MUTED, align: 'RIGHT' }); put(6, 4, '{{roomId}}', { b: true, size: 13, align: 'RIGHT', text: true });
  if (isRc) { put(7, 3, 'อ้างอิงใบแจ้งหนี้', { size: 10, color: MUTED, align: 'RIGHT' }); put(7, 4, '{{refNo}}', { align: 'RIGHT', text: true }); }
  else { put(7, 3, 'ครบกำหนดชำระ', { size: 10, color: MUTED, align: 'RIGHT' }); put(7, 4, '{{dueDate}}', { b: true, align: 'RIGHT', text: true }); }
  [4, 5, 6, 7].forEach(function (r) { heights[r] = 24; });
  heights[8] = 12;

  // ตารางรายการ
  const H = 9;
  ['#', 'รายการ', 'จำนวน', 'ราคาต่อหน่วย', 'จำนวนเงิน'].forEach(function (h, c) {
    put(H, c, h, { b: true, color: WHITE, align: c === 1 ? 'LEFT' : c === 0 ? 'CENTER' : 'RIGHT' });
  });
  band(H, TEAL); heights[H] = 30;
  for (let i = 1; i <= INV_MAX_ITEMS; i++) {
    const r = H + i;
    put(r, 0, '{{' + i + '.no}}', { align: 'CENTER', text: true, color: MUTED });
    put(r, 1, '{{' + i + '.name}}', { text: true });
    put(r, 2, '{{' + i + '.qty}}', { align: 'RIGHT', text: true });
    put(r, 3, '{{' + i + '.price}}', { align: 'RIGHT', text: true });
    put(r, 4, '{{' + i + '.total}}', { align: 'RIGHT', text: true, b: true });
    if (i % 2 === 0) band(r, SOFT);
    heights[r] = 26;
  }
  const END = H + INV_MAX_ITEMS; // แถวรายการสุดท้าย
  heights[END + 1] = 10;

  // ยอดรวม
  const T = END + 2;
  put(T, 0, '({{totalText}})', { size: 10, color: MUTED }); merge(T, 0, 2);
  put(T, 3, isRc ? 'รับชำระแล้ว' : 'ยอดชำระทั้งสิ้น', { b: true, color: WHITE, align: 'RIGHT' });
  put(T, 4, '{{total}}', { b: true, size: 15, color: WHITE, align: 'RIGHT', text: true });
  heights[T] = 38;

  // หมายเหตุ
  const N = T + 2;
  put(N, 0, isRc ? 'หมายเหตุ' : 'หมายเหตุ / ช่องทางชำระ', { size: 9, b: true, color: MUTED }); merge(N, 0, 4);
  for (let i = 1; i <= INV_MAX_NOTES; i++) { put(N + i, 0, '{{note' + i + '}}', { size: 10 }); merge(N + i, 0, 4); heights[N + i] = 20; }
  heights[T + 1] = 14;

  // ลงชื่อ / ท้ายกระดาษ
  const S = N + INV_MAX_NOTES + 2;
  heights[S - 1] = 30;
  put(S, 1, (isRc ? 'ผู้รับเงิน' : 'ผู้ออกเอกสาร') + '  ______________________________', { size: 10 });
  put(S, 3, 'วันที่  ____________________', { size: 10 }); merge(S, 3, 4);
  heights[S] = 30;
  put(S + 2, 0, '{{footer}}', { size: 9, color: MUTED, align: 'CENTER' }); merge(S + 2, 0, 4);
  const ROWS = S + 3;

  // rowData
  const rowData = [];
  for (let r = 0; r < ROWS; r++) {
    const values = [];
    for (let c = 0; c < C; c++) {
      const cell = (R[r] || {})[c];
      const fmt = {
        textFormat: { fontFamily: 'Sarabun', fontSize: cell && cell.size ? cell.size : 11, bold: !!(cell && cell.b) },
        verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP',
        padding: { left: 6, right: 6 },
      };
      if (cell && cell.color) fmt.textFormat.foregroundColor = cell.color;
      if (cell && cell.align) fmt.horizontalAlignment = cell.align;
      if (cell && cell.text) fmt.numberFormat = { type: 'TEXT' };
      if (bgRows[r]) fmt.backgroundColor = bgRows[r];
      if (r === T && c >= 3) fmt.backgroundColor = TEAL;
      if (r === T && c < 3) fmt.backgroundColor = SOFT;
      const v = { userEnteredFormat: fmt };
      if (cell) v.userEnteredValue = { stringValue: cell.v };
      values.push(v);
    }
    rowData.push({ values: values });
  }

  const ss = JSON.parse(gFetch_('https://sheets.googleapis.com/v4/spreadsheets', 'post', {
    properties: { title: isRc ? 'แม่แบบ - ใบเสร็จรับเงิน (แบบใหม่)' : 'แม่แบบ - ใบแจ้งหนี้ (แบบใหม่)', locale: 'th_TH' },
    sheets: [{
      properties: { sheetId: 0, title: isRc ? 'ใบเสร็จ' : 'ใบแจ้งหนี้', gridProperties: { rowCount: ROWS, columnCount: C, hideGridlines: true } },
      data: [{ startRow: 0, startColumn: 0, rowData: rowData }],
    }],
  }).getContentText());
  const id = ss.spreadsheetId;

  const reqs = [];
  widths.forEach(function (w, c) {
    reqs.push({ updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } });
  });
  for (let r = 0; r < ROWS; r++) {
    reqs.push({ updateDimensionProperties: { range: { sheetId: 0, dimension: 'ROWS', startIndex: r, endIndex: r + 1 }, properties: { pixelSize: heights[r] || 21 }, fields: 'pixelSize' } });
  }
  merges.forEach(function (m) {
    reqs.push({ mergeCells: { range: { sheetId: 0, startRowIndex: m.r, endRowIndex: m.r + 1, startColumnIndex: m.c1, endColumnIndex: m.c2 + 1 }, mergeType: 'MERGE_ALL' } });
  });
  const thin = { style: 'SOLID', width: 1, color: LINE };
  // เส้นคั่นแถวรายการ + เส้นล่างตาราง
  reqs.push({ updateBorders: { range: { sheetId: 0, startRowIndex: H + 1, endRowIndex: END + 1, startColumnIndex: 0, endColumnIndex: C }, innerHorizontal: thin, bottom: { style: 'SOLID_MEDIUM', color: TEAL } } });
  // เส้นใต้ส่วนข้อมูลผู้เช่า
  reqs.push({ updateBorders: { range: { sheetId: 0, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: C }, bottom: thin } });
  // ข้อความหมายเหตุตัดบรรทัดได้
  reqs.push({ repeatCell: { range: { sheetId: 0, startRowIndex: N + 1, endRowIndex: N + 1 + INV_MAX_NOTES, startColumnIndex: 0, endColumnIndex: C },
    cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } });
  gFetch_('https://sheets.googleapis.com/v4/spreadsheets/' + id + ':batchUpdate', 'post', { requests: reqs });

  DriveApp.getFileById(id).moveTo(folder);
  return id;
}

/**
 * ตัวอย่างเอกสารของแต่ละรูปแบบ (ใช้ใบแจ้งหนี้ล่าสุดเป็นข้อมูลตัวอย่าง ไม่บันทึกอะไร)
 * kind: 'invoice' | 'receipt' ; style: 'classic' | 'modern'
 */
function apiPreviewDoc(token, kind, style) {
  const me = requireSession_(token, 'admin');
  const signer = signer_(me);
  const settings = getSettings_();
  style = docStyle_(settings, style);
  const all = fsList_(COL.INVOICES).filter(function (i) { return i.status !== 'cancelled' && (i.items || []).length; });
  all.sort(function (a, b) { return String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')); });
  const inv = all[0] || {
    roomId: '101', month: thisMonthIso_(), number: '25690000-001', tenantName: 'ตัวอย่าง ผู้เช่า', tenantAddress: '',
    periodStart: monthPeriod_(thisMonthIso_()).start, periodEnd: monthPeriod_(thisMonthIso_()).end,
    issuedAt: today_(), dueDate: today_(), total: 3500,
    items: [{ name: 'ค่าห้อง', qty: 1, price: 3000, amount: 3000 }, { name: 'ค่าไฟ', qty: 50, price: 8, amount: 400 }, { name: 'ค่าน้ำ', qty: 5, price: 20, amount: 100 }],
  };
  const fileId = kind === 'receipt'
    ? renderReceiptPdf_(settings, inv, { number: 'ตัวอย่าง', paidAt: today_() }, 'ต้นฉบับ', style, signer)
    : renderInvoicePdf_(settings, inv, style, signer);
  const f = DriveApp.getFileById(fileId);
  const blob = f.getBlob();
  f.setTrashed(true);
  return { name: 'ตัวอย่าง.pdf', mimeType: 'application/pdf', data: Utilities.base64Encode(blob.getBytes()) };
}
function thisMonthIso_() { return today_().slice(0, 7); }
