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
  r[4].forEach(function (i) { invoices[i.roomId] = i; });

  const rows = rooms.map(function (room) {
    const t = tenancies[room.currentTenancyId] || {};
    const p = readings[room.id + '_' + prev];
    const c = readings[room.id + '_' + month];
    const movedInThisMonth = t.moveIn && t.moveIn.slice(0, 7) >= month;
    return {
      roomId: room.id,
      tenantName: t.tenantName || '',
      prevWater: p && !movedInThisMonth ? p.water : (t.startWater || 0),
      prevElectric: p && !movedInThisMonth ? p.electric : (t.startElectric || 0),
      water: c ? c.water : '',
      electric: c ? c.electric : '',
      invoiceStatus: invoices[room.id] ? invoices[room.id].status : '',
    };
  });
  rows.sort(function (a, b) { return Number(a.roomId) - Number(b.roomId); });
  const roomsById = {};
  rooms.forEach(function (x) { roomsById[x.id] = x; });
  return { rows: rows, rooms: roomsById, tenancies: tenancies, invoices: invoices, charges: charges };
}

/** rows: [{roomId, water, electric}] */
function apiSaveReadings(token, month, rows) {
  requireSession_(token, 'admin');
  const docs = {};
  rows.forEach(function (r) {
    if (r.water === '' || r.electric === '' || r.water == null || r.electric == null) return;
    docs[r.roomId + '_' + month] = {
      roomId: r.roomId, month: month, water: Number(r.water), electric: Number(r.electric),
    };
  });
  fsSetMany_(COL.READINGS, docs);
  return true;
}

/** คำนวณรายการในบิล (ใช้ได้ทั้งพรีวิวและออกจริง) */
function calcInvoice_(settings, room, tenancy, prevR, curR, month, extra) {
  const wUnits = Math.max(0, curR.water - prevR.water);
  const eUnits = Math.max(0, curR.electric - prevR.electric);
  const wAmt = Math.max(wUnits * settings.waterRate, settings.waterMinCharge || 0);
  const eAmt = Math.max(eUnits * settings.electricRate, settings.electricMinCharge || 0);
  const rent = Number(tenancy.rent || room.rent);
  const per = monthPeriod_(month);
  const period = ' ' + shortDate_(per.start) + ' - ' + shortDate_(per.end);
  // qty/price ใช้แสดงในใบแจ้งหนี้ PDF, detail ใช้แสดงในแอป
  const items = [
    { name: 'ค่าห้อง' + period, qty: 1, price: rent, amount: rent, detail: '' },
    { name: 'ค่าไฟ' + period, qty: eUnits, price: settings.electricRate, amount: eAmt,
      detail: prevR.electric + ' → ' + curR.electric + ' = ' + eUnits + ' หน่วย × ' + settings.electricRate },
    { name: 'ค่าน้ำ' + period, qty: wUnits, price: settings.waterRate, amount: wAmt,
      detail: prevR.water + ' → ' + curR.water + ' = ' + wUnits + ' หน่วย × ' + settings.waterRate },
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
function apiGenerateInvoices(token, month) {
  requireSession_(token, 'admin');
  const settings = getSettings_();
  const ms = monthSheet_(month);
  const sheet = ms.rows;
  const p = month.split('-').map(Number);
  // วันครบกำหนด = วันที่ dueDay ของเดือนถัดไป
  const dueDate = new Date(p[0], p[1], settings.dueDay);
  const dueIso = Utilities.formatDate(dueDate, 'Asia/Bangkok', 'yyyy-MM-dd');
  const per = monthPeriod_(month);

  // เลขที่ใบแจ้งหนี้รันต่อเนื่อง (อ่านค่าล่าสุดจาก Firestore ตรง ๆ ไม่ใช้แคช)
  const r = fsMulti_([{ get: [COL.SETTINGS, 'main'] }, { list: COL.TENANTS }]);
  let seq = Number((r[0] || {}).invoiceSeq) || 0;
  const tenants = {};
  r[1].forEach(function (t) { tenants[t.id] = t; });

  const results = sheet.map(function (row) {
    try {
      if (row.water === '' || row.electric === '') return { roomId: row.roomId, ok: false, error: 'ยังไม่จดมิเตอร์' };
      if (row.invoiceStatus === 'paid') return { roomId: row.roomId, ok: false, error: 'ชำระแล้ว ไม่ออกใหม่' };
      const room = ms.rooms[row.roomId];
      const tenancy = ms.tenancies[room.currentTenancyId];
      if (!tenancy) return { roomId: row.roomId, ok: false, error: 'ไม่พบข้อมูลผู้เช่า' };
      const calc = calcInvoice_(settings, room, tenancy,
        { water: row.prevWater, electric: row.prevElectric },
        { water: row.water, electric: row.electric }, month, ms.charges[row.roomId]);
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
        number: old && old.number ? old.number : ('00' + (++seq)).slice(-3),
        periodStart: per.start, periodEnd: per.end,
        items: calc.items, total: calc.total, dueDate: dueIso,
        status: old && old.status === 'pending' ? 'pending' : 'unpaid',
        issuedAt: per.end, pdfFileId: '',
      };
      inv.pdfFileId = renderInvoicePdf_(settings, inv);
      fsSet_(COL.INVOICES, id, inv);
      return { roomId: row.roomId, ok: true, total: calc.total };
    } catch (err) {
      return { roomId: row.roomId, ok: false, error: String(err.message || err) };
    }
  });
  fsUpdate_(COL.SETTINGS, 'main', { invoiceSeq: seq });
  clearSettingsCache_();
  return results;
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
  requireSession_(token, 'admin');
  if (['unpaid', 'pending', 'paid'].indexOf(status) < 0) throw new Error('สถานะไม่ถูกต้อง');
  return fsUpdate_(COL.INVOICES, invoiceId, { status: status, paidAt: status === 'paid' ? today_() : '' });
}

function round2_(n) { return Math.round(Number(n) * 100) / 100; }

/**
 * แก้ใบแจ้งหนี้: เลขที่ และรายการ (ชื่อ/จำนวน/ราคา) แล้วออก PDF ใหม่
 * data: {number, items:[{name, qty, price}]}
 */
function apiUpdateInvoice(token, invoiceId, data) {
  requireSession_(token, 'admin');
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
  upd.pdfFileId = renderInvoicePdf_(settings, upd);
  delete upd.id;
  fsSet_(COL.INVOICES, invoiceId, upd);
  return true;
}

/**
 * ยกเลิกใบแจ้งหนี้: ย้ายไปเก็บเป็นประวัติ (id ใหม่) สถานะ cancelled
 * ห้องนั้นออกใบใหม่ของเดือนเดียวกันได้ (ได้เลขที่ใหม่)
 */
function apiCancelInvoice(token, invoiceId, reason) {
  requireSession_(token, 'admin');
  const inv = fsGet_(COL.INVOICES, invoiceId);
  if (!inv) throw new Error('ไม่พบใบแจ้งหนี้');
  if (inv.status === 'paid') throw new Error('ใบนี้ชำระแล้ว ถ้าจะยกเลิกให้เปลี่ยนสถานะเป็นค้างชำระก่อน');
  const keep = Object.assign({}, inv, {
    status: 'cancelled', cancelReason: reason || '', cancelledAt: today_(), originalId: invoiceId,
  });
  delete keep.id;
  fsSet_(COL.INVOICES, invoiceId + '_x' + Date.now(), keep);
  fsDelete_(COL.INVOICES, invoiceId);
  return true;
}

// ---------- รายการเรียกเก็บเพิ่มรายห้อง ----------

/** data: {roomId, month, name, qty, price, note} */
function apiAddCharge(token, data) {
  requireSession_(token, 'admin');
  if (!data.roomId || !data.month || !String(data.name || '').trim()) throw new Error('กรุณาระบุห้อง เดือน และชื่อรายการ');
  const q = Number(data.qty) || 1, p = Number(data.price) || 0;
  return fsSet_(COL.CHARGES, null, {
    roomId: String(data.roomId), month: data.month, name: String(data.name).trim(),
    qty: q, price: p, amount: round2_(q * p), note: data.note || '', repairId: data.repairId || '',
    createdAt: today_(),
  });
}

function apiDeleteCharge(token, chargeId) {
  requireSession_(token, 'admin');
  fsDelete_(COL.CHARGES, chargeId);
  return true;
}

function apiListCharges(token, month) {
  requireSession_(token, 'admin');
  return sortBy_(fsWhere_(COL.CHARGES, { month: month }), 'roomId');
}
