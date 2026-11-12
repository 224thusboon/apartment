/**
 * จดมิเตอร์ + คำนวณค่าน้ำค่าไฟ + ออกใบแจ้งหนี้ PDF
 *
 * readings/{roomId}_{YYYY-MM} = เลขมิเตอร์ "ณ สิ้นเดือน" นั้น
 * หน่วยที่ใช้ = เลขเดือนนี้ - เลขเดือนก่อน
 *   (ถ้าเพิ่งย้ายเข้า ใช้เลขมิเตอร์ตอนย้ายเข้าเป็นเลขก่อน)
 */

/** ตารางจดมิเตอร์ของเดือนที่เลือก — เฉพาะห้องที่มีผู้เช่า */
function apiGetMonthSheet(token, month) {
  requireSession_(token, 'admin');
  return monthSheet_(month).rows;
}

/** อ่านทุกอย่างที่ต้องใช้ของเดือนนั้นในรอบเดียว (ยิงพร้อมกัน) */
function monthSheet_(month) {
  const prev = prevMonth_(month);
  const r = fsMulti_([
    { where: [COL.ROOMS, { status: 'occupied' }] },
    { where: [COL.TENANCIES, { status: 'active' }] },
    { where: [COL.READINGS, { month: prev }] },
    { where: [COL.READINGS, { month: month }] },
    { where: [COL.INVOICES, { month: month }] },
    { where: [COL.CHARGES, { month: month }] },
  ]);
  const rooms = r[0];
  const charges = {};
  r[5].forEach(function (c) { (charges[c.roomId] = charges[c.roomId] || []).push(c); });
  const tenancies = {};
  r[1].forEach(function (t) { tenancies[t.id] = t; });
  const readings = {};
  r[2].concat(r[3]).forEach(function (x) { readings[x.id] = x; });
  const invoices = {};
  // ใบที่ใช้งานอยู่มาก่อนใบที่ยกเลิก (ห้องเดียวกันอาจมีใบยกเลิกหลายใบในเดือนเดียว)
  r[4].forEach(function (i) {
    const cur = invoices[i.roomId];
    if (!cur || (cur.status === 'cancelled' && i.status !== 'cancelled')) invoices[i.roomId] = i;
  });

  const rows = rooms.map(function (room) {
    const t = tenancies[room.currentTenancyId] || {};
    const p = readings[room.id + '_' + prev];
    const c = readings[room.id + '_' + month];
    const movedInThisMonth = t.moveIn && t.moveIn.slice(0, 7) >= month;
    const usePrev = p && p.water != null && !movedInThisMonth;
    const has = c && c.water != null;
    return {
      roomId: room.id,
      tenantName: t.tenantName || '',
      prevWater: usePrev ? p.water : (t.startWater || 0),
      prevElectric: usePrev ? p.electric : (t.startElectric || 0),
      // เลขตามที่จด (เก็บเลข 0 ข้างหน้าไว้)
      prevWaterText: usePrev ? (p.waterText || String(p.water)) : (t.startWaterText || String(t.startWater || 0)),
      prevElectricText: usePrev ? (p.electricText || String(p.electric)) : (t.startElectricText || String(t.startElectric || 0)),
      water: has ? c.water : '',
      electric: has ? c.electric : '',
      waterText: has ? (c.waterText || String(c.water)) : '',
      electricText: has ? (c.electricText || String(c.electric)) : '',
      change: (c && c.change) || {},
      invoiceStatus: invoices[room.id] ? invoices[room.id].status : '',
    };
  });
  rows.sort(function (a, b) { return Number(a.roomId) - Number(b.roomId); });
  const roomsById = {};
  rooms.forEach(function (x) { roomsById[x.id] = x; });
  return { rows: rows, rooms: roomsById, tenancies: tenancies, invoices: invoices, charges: charges };
}

/** '0012' -> {n: 12, t: '0012'} ; ว่าง -> null */
function meterVal_(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('เลขมิเตอร์ไม่ถูกต้อง: ' + t);
  return { n: Number(t), t: t };
}

/**
 * หน่วยที่ใช้
 * ch.type 'replace'  เปลี่ยนมิเตอร์: (เลขสุดท้ายตัวเก่า - เลขก่อน) + (เลขล่าสุด - เลขเริ่มตัวใหม่)
 * ch.type 'rollover' มิเตอร์วนรอบ: (10^จำนวนหลัก - เลขก่อน) + เลขล่าสุด
 */
function meterUnits_(prevN, prevT, curN, ch) {
  if (ch && ch.type === 'replace') return round2_((Number(ch.oldFinal) - prevN) + (curN - Number(ch.newStart)));
  if (ch && ch.type === 'rollover') {
    const d = Number(ch.digits) || String(prevT || prevN).split('.')[0].length;
    return round2_(Math.pow(10, d) - prevN + curN);
  }
  return round2_(curN - prevN);
}

/** rows: [{roomId, water, electric}] เก็บทั้งตัวเลขและข้อความตามที่จด */
function apiSaveReadings(token, month, rows) {
  const me = requireSession_(token, 'admin');
  const list = [];
  rows.forEach(function (r) {
    const w = meterVal_(r.water), e = meterVal_(r.electric);
    if (!w || !e) return;
    list.push({ id: r.roomId + '_' + month, roomId: r.roomId, w: w, e: e });
  });
  if (!list.length) return true;
  // คงข้อมูลการเปลี่ยนมิเตอร์ที่บันทึกไว้แล้ว
  const old = fsMulti_(list.map(function (x) { return { get: [COL.READINGS, x.id] }; }));
  const docs = {};
  list.forEach(function (x, i) {
    docs[x.id] = {
      roomId: x.roomId, month: month, water: x.w.n, electric: x.e.n, waterText: x.w.t, electricText: x.e.t,
      change: (old[i] && old[i].change) || {},
    };
  });
  fsSetMany_(COL.READINGS, docs);
  audit_(me, 'บันทึกเลขมิเตอร์', 'เดือน ' + month, Object.keys(docs).length + ' ห้อง');
  return true;
}

/** คำนวณรายการในบิล (ใช้ได้ทั้งพรีวิวและออกจริง) */
function calcInvoice_(settings, room, tenancy, prevR, curR, month, extra) {
  const ch = curR.change || {};
  const wUnits = meterUnits_(prevR.water, prevR.waterText, curR.water, ch.water);
  const eUnits = meterUnits_(prevR.electric, prevR.electricText, curR.electric, ch.electric);
  const hint = ' ถ้าเปลี่ยนมิเตอร์หรือมิเตอร์วนรอบ ให้กด "เปลี่ยนมิเตอร์" ที่ช่องนั้นก่อน';
  if (wUnits < 0) throw new Error('เลขมิเตอร์น้ำน้อยกว่าเดือนก่อน' + hint);
  if (eUnits < 0) throw new Error('เลขมิเตอร์ไฟน้อยกว่าเดือนก่อน' + hint);
  const line = function (kind, units, rate) {
    const c = ch[kind];
    const p = prevR[kind + 'Text'] || prevR[kind], n = curR[kind + 'Text'] || curR[kind];
    if (c && c.type === 'replace') {
      return 'เปลี่ยนมิเตอร์' + (c.date ? ' ' + shortDate_(c.date) : '') + ': ตัวเก่า ' + p + ' → ' + (c.oldFinalText || c.oldFinal) +
        ' + ตัวใหม่ ' + (c.newStartText || c.newStart) + ' → ' + n + ' = ' + units + ' หน่วย × ' + rate;
    }
    if (c && c.type === 'rollover') return p + ' → วนรอบ → ' + n + ' = ' + units + ' หน่วย × ' + rate;
    return p + ' → ' + n + ' = ' + units + ' หน่วย × ' + rate;
  };
  const wAmt = Math.max(wUnits * settings.waterRate, settings.waterMinCharge || 0);
  const eAmt = Math.max(eUnits * settings.electricRate, settings.electricMinCharge || 0);
  const rent = Number(tenancy.rent || room.rent);
  const per = monthPeriod_(month);
  const period = ' ' + shortDate_(per.start) + ' - ' + shortDate_(per.end);
  // qty/price ใช้แสดงในใบแจ้งหนี้ PDF, detail ใช้แสดงในแอป
  const items = [
    { name: 'ค่าห้อง' + period, qty: 1, price: rent, amount: rent, detail: '' },
    { name: 'ค่าไฟ' + period, qty: eUnits, price: settings.electricRate, amount: eAmt,
      detail: line('electric', eUnits, settings.electricRate) },
    { name: 'ค่าน้ำ' + period, qty: wUnits, price: settings.waterRate, amount: wAmt,
      detail: line('water', wUnits, settings.waterRate) },
  ];
  (settings.otherFees || []).forEach(function (f) {
    const a = Number(f.amount) || 0;
    items.push({ name: f.name, qty: 1, price: a, amount: a, detail: '' });
  });
  // รายการเรียกเก็บเพิ่มของห้องนี้ในเดือนนี้ (เช่น ค่าซ่อม)
  (extra || []).forEach(function (c) {
    const q = Number(c.qty) || 1, p = Number(c.price) || 0;
    items.push({ name: c.name, qty: q, price: p, amount: round2_(q * p), detail: c.note || '', chargeId: c.id });
  });
  const total = items.reduce(function (s, i) { return s + i.amount; }, 0);
  return { items: items, total: total, waterUnits: wUnits, electricUnits: eUnits };
}

/**
 * ออกใบแจ้งหนี้ทุกห้องที่จดมิเตอร์แล้ว (ข้ามห้องที่ชำระแล้ว)
 * คืน [{roomId, ok, total|error}]
 */
function apiGenerateInvoices(token, month, roomIds) {
  const me = requireSession_(token, 'admin');
  const settings = getSettings_();
  const ms = monthSheet_(month);
  // roomIds (ไม่บังคับ): ออกเฉพาะห้องที่ระบุ
  const sheet = roomIds && roomIds.length
    ? ms.rows.filter(function (r) { return roomIds.indexOf(r.roomId) >= 0; })
    : ms.rows;
  const p = month.split('-').map(Number);
  // วันครบกำหนด = วันที่ dueDay ของเดือนถัดไป
  const dueDate = new Date(p[0], p[1], settings.dueDay);
  const dueIso = Utilities.formatDate(dueDate, 'Asia/Bangkok', 'yyyy-MM-dd');
  const per = monthPeriod_(month);

  const signer = signer_(me);
  const tenants = {};
  fsList_(COL.TENANTS).forEach(function (t) { tenants[t.id] = t; });

  const results = sheet.map(function (row) {
    try {
      if (row.water === '' || row.electric === '') return { roomId: row.roomId, ok: false, error: 'ยังไม่จดมิเตอร์' };
      if (row.invoiceStatus === 'paid') return { roomId: row.roomId, ok: false, error: 'ชำระแล้ว ไม่ออกใหม่' };
      const room = ms.rooms[row.roomId];
      const tenancy = ms.tenancies[room.currentTenancyId];
      if (!tenancy) return { roomId: row.roomId, ok: false, error: 'ไม่พบข้อมูลผู้เช่า' };
      const calc = calcInvoice_(settings, room, tenancy,
        { water: row.prevWater, electric: row.prevElectric, waterText: row.prevWaterText, electricText: row.prevElectricText },
        { water: row.water, electric: row.electric, waterText: row.waterText, electricText: row.electricText, change: row.change },
        month, ms.charges[row.roomId]);
      const id = row.roomId + '_' + month;
      let old = ms.invoices[row.roomId];
      if (old && old.status === 'cancelled') old = null; // ใบที่ยกเลิกแล้ว ออกใบใหม่เลขใหม่
      if (old && old.pdfFileId) {
        try { DriveApp.getFileById(old.pdfFileId).setTrashed(true); } catch (e) { /* ไฟล์อาจถูกลบไปแล้ว */ }
      }
      const tenant = tenants[tenancy.tenantId] || {};
      const inv = {
        roomId: row.roomId, month: month, tenancyId: tenancy.id, tenantName: tenancy.tenantName,
        tenantAddress: tenant.address || '',
        number: old && old.number ? old.number : nextDocNo_('inv', per.end),
        periodStart: per.start, periodEnd: per.end,
        items: calc.items, total: calc.total, dueDate: dueIso,
        status: old && old.status === 'pending' ? 'pending' : 'unpaid',
        issuedAt: per.end, pdfFileId: '',
      };
      inv.issuedBy = signer ? signer.name : '';
      inv.pdfFileId = renderInvoicePdf_(settings, inv, null, signer);
      fsSet_(COL.INVOICES, id, inv);
      return { roomId: row.roomId, ok: true, total: calc.total };
    } catch (err) {
      return { roomId: row.roomId, ok: false, error: String(err.message || err) };
    }
  });
  const ok = results.filter(function (x) { return x.ok; });
  audit_(me, 'ออกใบแจ้งหนี้', 'เดือน ' + month, ok.length + ' ห้อง: ' + ok.map(function (x) { return x.roomId; }).join(', '));
  return results;
}

/**
 * บันทึก/ลบ การเปลี่ยนมิเตอร์ของห้องในเดือนนั้น
 * kind: 'water' | 'electric'
 * data: {type:'replace', date, oldFinal, newStart, note} | {type:'rollover', digits, note} | null (ลบ)
 */
function apiSaveMeterChange(token, month, roomId, kind, data) {
  const me = requireSession_(token, 'admin');
  if (['water', 'electric'].indexOf(kind) < 0) throw new Error('ประเภทมิเตอร์ไม่ถูกต้อง');
  const id = roomId + '_' + month;
  const doc = fsGet_(COL.READINGS, id) || { roomId: roomId, month: month };
  const change = Object.assign({}, doc.change || {});
  const label = kind === 'water' ? 'น้ำ' : 'ไฟ';
  let detail;
  if (!data) {
    delete change[kind];
    detail = 'ลบการเปลี่ยนมิเตอร์' + label;
  } else if (data.type === 'replace') {
    const o = meterVal_(data.oldFinal), s = meterVal_(data.newStart);
    if (!o || !s) throw new Error('กรุณากรอกเลขสุดท้ายของตัวเก่าและเลขเริ่มของตัวใหม่');
    change[kind] = {
      type: 'replace', date: data.date || today_(), oldFinal: o.n, oldFinalText: o.t, newStart: s.n, newStartText: s.t,
      note: data.note || '', by: me.email || me.name || '',
    };
    detail = 'เปลี่ยนมิเตอร์' + label + ' ตัวเก่าจบที่ ' + o.t + ' ตัวใหม่เริ่ม ' + s.t;
  } else if (data.type === 'rollover') {
    const d = Number(data.digits);
    if (!(d >= 1 && d <= 9)) throw new Error('จำนวนหลักไม่ถูกต้อง');
    change[kind] = { type: 'rollover', digits: d, note: data.note || '', by: me.email || me.name || '' };
    detail = 'มิเตอร์' + label + 'วนรอบ (' + d + ' หลัก)';
  } else {
    throw new Error('ข้อมูลไม่ถูกต้อง');
  }
  fsUpdate_(COL.READINGS, id, { roomId: roomId, month: month, change: change });
  audit_(me, 'เปลี่ยนมิเตอร์', 'ห้อง ' + roomId + ' เดือน ' + month, detail + (data && data.note ? ' · ' + data.note : ''));
  return change;
}

/** '2026-10-31' -> '25691031' (พ.ศ. เดือน วันที่) */
function beDateKey_(iso) {
  const p = String(iso).slice(0, 10).split('-');
  return (Number(p[0]) + 543) + p[1] + p[2];
}

/**
 * เลขที่เอกสาร = พ.ศ.เดือนวันที่-ลำดับของวันนั้น เช่น 25691031-001
 * kind: 'inv' ใบแจ้งหนี้ / 'rc' ใบเสร็จ (นับแยกกัน)
 */
function nextDocNo_(kind, iso) {
  const key = beDateKey_(iso);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const id = kind + '_' + key;
    const c = fsGet_(COL.COUNTERS, id);
    const n = (c ? Number(c.n) || 0 : 0) + 1;
    fsSet_(COL.COUNTERS, id, { n: n });
    return key + '-' + ('00' + n).slice(-3);
  } finally {
    lock.releaseLock();
  }
}

/** '2026-10' -> {start:'2026-10-01', end:'2026-10-31'} */
function monthPeriod_(ym) {
  const p = ym.split('-').map(Number);
  const last = new Date(p[0], p[1], 0).getDate();
  return { start: ym + '-01', end: ym + '-' + ('0' + last).slice(-2) };
}

/** '2026-10-31' -> '31/10/26' (แบบเดียวกับใบแจ้งหนี้เดิมของหอ) */
function shortDate_(iso) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return Number(p[2]) + '/' + Number(p[1]) + '/' + p[0].slice(-2);
}

function apiListInvoices(token, month) {
  requireSession_(token, 'admin');
  return fsWhere_(COL.INVOICES, { month: month }, { field: 'roomId' });
}

function apiSetInvoiceStatus(token, invoiceId, status) {
  const me = requireSession_(token, 'admin');
  if (['unpaid', 'pending', 'paid'].indexOf(status) < 0) throw new Error('สถานะไม่ถูกต้อง');
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv) throw new Error('ไม่พบใบแจ้งหนี้');
  if (status === 'paid') {
    const paidAt = inv.status === 'paid' && inv.paidAt ? inv.paidAt : today_();
    fsUpdate_(COL.INVOICES, invoiceId, { status: 'paid', paidAt: paidAt });
    issueReceipt_(invoiceId, paidAt, '', me);
  } else {
    fsUpdate_(COL.INVOICES, invoiceId, { status: status, paidAt: '' });
    if (inv.receiptId) voidReceipt_(invoiceId, 'เปลี่ยนสถานะใบแจ้งหนี้เป็น ' + status);
  }
  audit_(me, 'เปลี่ยนสถานะใบแจ้งหนี้', 'ใบแจ้งหนี้ ' + (inv.number || invoiceId) + ' ห้อง ' + inv.roomId,
    (STATUS_TH_[inv.status] || inv.status) + ' → ' + (STATUS_TH_[status] || status) + ' · ' + money_(inv.total) + ' บาท');
  return true;
}

const STATUS_TH_ = { unpaid: 'ค้างชำระ', pending: 'รอตรวจสลิป', paid: 'ชำระแล้ว', cancelled: 'ยกเลิก' };

function round2_(n) { return Math.round(Number(n) * 100) / 100; }

/**
 * แก้ใบแจ้งหนี้: เลขที่ และรายการ (ชื่อ/จำนวน/ราคา) แล้วออก PDF ใหม่
 * data: {number, items:[{name, qty, price}]}
 */
function apiUpdateInvoice(token, invoiceId, data) {
  const me = requireSession_(token, 'admin');
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv) throw new Error('ไม่พบใบแจ้งหนี้');
  if (inv.status === 'cancelled') throw new Error('ใบนี้ยกเลิกแล้ว แก้ไขไม่ได้');
  const number = String(data.number || '').trim();
  if (!number) throw new Error('กรุณาใส่เลขที่ใบแจ้งหนี้');
  if (number !== inv.number) {
    const dup = fsWhere_(COL.INVOICES, { number: number }).filter(function (x) { return x.id !== invoiceId && x.status !== 'cancelled'; });
    if (dup.length) throw new Error('เลขที่ ' + number + ' ซ้ำกับห้อง ' + dup[0].roomId + ' เดือน ' + dup[0].month);
  }
  const items = (data.items || []).filter(function (i) { return i && String(i.name || '').trim(); }).map(function (i) {
    const q = Number(i.qty) || 0, p = Number(i.price) || 0;
    return { name: String(i.name).trim(), qty: q, price: p, amount: round2_(q * p), detail: i.detail || '' };
  });
  if (!items.length) throw new Error('ต้องมีอย่างน้อย 1 รายการ');
  const settings = getSettings_();
  const upd = Object.assign({}, inv, { number: number, items: items, total: round2_(items.reduce(function (s, i) { return s + i.amount; }, 0)) });
  if (inv.pdfFileId) {
    try { DriveApp.getFileById(inv.pdfFileId).setTrashed(true); } catch (e) { /* ไม่มีไฟล์ */ }
  }
  const signer = signer_(me);
  upd.issuedBy = signer ? signer.name : (upd.issuedBy || '');
  upd.pdfFileId = renderInvoicePdf_(settings, upd, null, signer);
  delete upd.id;
  fsSet_(COL.INVOICES, invoiceId, upd);
  audit_(me, 'แก้ไขใบแจ้งหนี้', 'ใบแจ้งหนี้ ' + number + ' ห้อง ' + inv.roomId,
    (inv.number !== number ? 'เลขที่ ' + (inv.number || '-') + ' → ' + number + ' · ' : '') +
    'ยอด ' + money_(inv.total) + ' → ' + money_(upd.total));
  return true;
}

/**
 * ยกเลิกใบแจ้งหนี้: ย้ายไปเก็บเป็นประวัติ (id ใหม่) สถานะ cancelled
 * ห้องนั้นออกใบใหม่ของเดือนเดียวกันได้ (ได้เลขที่ใหม่)
 */
/**
 * ทำ PDF ใหม่ของใบแจ้งหนี้ (และใบเสร็จถ้ามี) ด้วยรูปแบบปัจจุบันและลายเซ็นของผู้กด
 * เลขที่ ยอดเงิน และจำนวนครั้งที่พิมพ์ไม่เปลี่ยน ไฟล์เดิมย้ายลงถังขยะ
 */
function apiRerenderDocs(token, invoiceId) {
  const me = requireSession_(token, 'admin');
  const signer = signer_(me);
  if (!signer) throw new Error('เข้าด้วยรหัส master จะไม่มีลายเซ็น กรุณาเข้าด้วยอีเมลของตัวเอง');
  const settings = getSettings_();
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv || inv.status === 'cancelled') throw new Error('ไม่พบใบแจ้งหนี้');
  const trash = function (id) { if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* ไม่มีไฟล์ */ } } };
  const upd = { issuedBy: signer.name };
  upd.pdfFileId = renderInvoicePdf_(settings, inv, null, signer);
  trash(inv.pdfFileId);
  let rcNo = '';
  if (inv.receiptId) {
    const rc = fsGet_(COL.RECEIPTS, inv.receiptId);
    if (rc && rc.status !== 'void') {
      const f = renderReceiptPair_(settings, inv, rc, signer);
      trash(inv.receiptPdfId); trash(inv.receiptOrigId);
      upd.receiptPdfId = f.copy; upd.receiptOrigId = f.orig;
      fsUpdate_(COL.RECEIPTS, rc.id, { pdfFileId: f.copy, origFileId: f.orig, issuedBy: signer.name, issuedById: me.adminId });
      rcNo = rc.number;
    }
  }
  fsUpdate_(COL.INVOICES, invoiceId, upd);
  audit_(me, 'ทำ PDF ใหม่', 'ห้อง ' + inv.roomId + ' ใบแจ้งหนี้ ' + (inv.number || ''), (rcNo ? 'รวมใบเสร็จ ' + rcNo + ' · ' : '') + 'ลงนามโดย ' + signer.name);
  return true;
}

function apiCancelInvoice(token, invoiceId, reason) {
  const me = requireSession_(token, 'admin');
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv) throw new Error('ไม่พบใบแจ้งหนี้');
  if (inv.status === 'paid') throw new Error('ใบนี้ชำระแล้ว ถ้าจะยกเลิกให้เปลี่ยนสถานะเป็นค้างชำระก่อน');
  const keep = Object.assign({}, inv, {
    status: 'cancelled', cancelReason: reason || '', cancelledAt: today_(), originalId: invoiceId,
  });
  delete keep.id;
  fsSet_(COL.INVOICES, invoiceId + '_x' + Date.now(), keep);
  fsDelete_(COL.INVOICES, invoiceId);
  audit_(me, 'ยกเลิกใบแจ้งหนี้', 'ใบแจ้งหนี้ ' + (inv.number || invoiceId) + ' ห้อง ' + inv.roomId,
    money_(inv.total) + ' บาท' + (reason ? ' · เหตุผล: ' + reason : ''));
  return true;
}

// ---------- รายการเรียกเก็บเพิ่มรายห้อง ----------

/** data: {roomId, month, name, qty, price, note} */
function apiAddCharge(token, data) {
  const me = requireSession_(token, 'admin');
  if (!data.roomId || !data.month || !String(data.name || '').trim()) throw new Error('กรุณาระบุห้อง เดือน และชื่อรายการ');
  const q = Number(data.qty) || 1, p = Number(data.price) || 0;
  const c = fsSet_(COL.CHARGES, null, {
    roomId: String(data.roomId), month: data.month, name: String(data.name).trim(),
    qty: q, price: p, amount: round2_(q * p), note: data.note || '', repairId: data.repairId || '',
    createdAt: today_(),
  });
  audit_(me, 'เพิ่มรายการเรียกเก็บ', 'ห้อง ' + c.roomId + ' บิล ' + c.month, c.name + ' ' + money_(c.amount) + ' บาท');
  return c;
}

function apiDeleteCharge(token, chargeId) {
  const me = requireSession_(token, 'admin');
  const c = fsGet_(COL.CHARGES, chargeId);
  fsDelete_(COL.CHARGES, chargeId);
  if (c) audit_(me, 'ลบรายการเรียกเก็บ', 'ห้อง ' + c.roomId + ' บิล ' + c.month, c.name + ' ' + money_(c.amount) + ' บาท');
  return true;
}

function apiListCharges(token, month) {
  requireSession_(token, 'admin');
  return sortBy_(fsWhere_(COL.CHARGES, { month: month }), 'roomId');
}
