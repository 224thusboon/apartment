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
  const prev = prevMonth_(month);
  const rooms = fsWhere_(COL.ROOMS, { status: 'occupied' });
  const readings = {};
  fsList_(COL.READINGS).forEach(function (r) { readings[r.id] = r; });
  const invoices = {};
  fsWhere_(COL.INVOICES, { month: month }).forEach(function (i) { invoices[i.roomId] = i; });

  const rows = rooms.map(function (room) {
    const t = fsGet_(COL.TENANCIES, room.currentTenancyId) || {};
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
  return rows;
}

/** rows: [{roomId, water, electric}] */
function apiSaveReadings(token, month, rows) {
  requireSession_(token, 'admin');
  rows.forEach(function (r) {
    if (r.water === '' || r.electric === '' || r.water == null || r.electric == null) return;
    fsSet_(COL.READINGS, r.roomId + '_' + month, {
      roomId: r.roomId, month: month, water: Number(r.water), electric: Number(r.electric),
    });
  });
  return true;
}

/** คำนวณรายการในบิล (ใช้ได้ทั้งพรีวิวและออกจริง) */
function calcInvoice_(settings, room, tenancy, prevR, curR, month) {
  const wUnits = Math.max(0, curR.water - prevR.water);
  const eUnits = Math.max(0, curR.electric - prevR.electric);
  const wAmt = Math.max(wUnits * settings.waterRate, settings.waterMinCharge || 0);
  const eAmt = Math.max(eUnits * settings.electricRate, settings.electricMinCharge || 0);
  const items = [
    { name: 'ค่าเช่าห้อง ' + thaiMonth_(month), detail: '', amount: Number(tenancy.rent || room.rent) },
    { name: 'ค่าน้ำ', detail: prevR.water + ' → ' + curR.water + ' = ' + wUnits + ' หน่วย × ' + settings.waterRate, amount: wAmt },
    { name: 'ค่าไฟ', detail: prevR.electric + ' → ' + curR.electric + ' = ' + eUnits + ' หน่วย × ' + settings.electricRate, amount: eAmt },
  ];
  (settings.otherFees || []).forEach(function (f) {
    items.push({ name: f.name, detail: '', amount: Number(f.amount) || 0 });
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
  const sheet = apiGetMonthSheet(token, month);
  const p = month.split('-').map(Number);
  // วันครบกำหนด = วันที่ dueDay ของเดือนถัดไป
  const dueDate = new Date(p[0], p[1], settings.dueDay);
  const dueIso = Utilities.formatDate(dueDate, 'Asia/Bangkok', 'yyyy-MM-dd');

  return sheet.map(function (row) {
    try {
      if (row.water === '' || row.electric === '') return { roomId: row.roomId, ok: false, error: 'ยังไม่จดมิเตอร์' };
      if (row.invoiceStatus === 'paid') return { roomId: row.roomId, ok: false, error: 'ชำระแล้ว ไม่ออกใหม่' };
      const room = fsGet_(COL.ROOMS, row.roomId);
      const tenancy = fsGet_(COL.TENANCIES, room.currentTenancyId);
      const calc = calcInvoice_(settings, room, tenancy,
        { water: row.prevWater, electric: row.prevElectric },
        { water: row.water, electric: row.electric }, month);
      const id = row.roomId + '_' + month;
      const old = fsGet_(COL.INVOICES, id);
      if (old && old.pdfFileId) {
        try { DriveApp.getFileById(old.pdfFileId).setTrashed(true); } catch (e) { /* ไฟล์อาจถูกลบไปแล้ว */ }
      }
      const inv = {
        roomId: row.roomId, month: month, tenancyId: tenancy.id, tenantName: tenancy.tenantName,
        items: calc.items, total: calc.total, dueDate: dueIso,
        status: old && old.status === 'pending' ? 'pending' : 'unpaid',
        issuedAt: today_(), pdfFileId: '',
      };
      inv.pdfFileId = renderInvoicePdf_(settings, inv);
      fsSet_(COL.INVOICES, id, inv);
      return { roomId: row.roomId, ok: true, total: calc.total };
    } catch (err) {
      return { roomId: row.roomId, ok: false, error: String(err.message || err) };
    }
  });
}

function apiListInvoices(token, month) {
  requireSession_(token, 'admin');
  return fsWhere_(COL.INVOICES, { month: month }, { field: 'roomId' });
}

function apiSetInvoiceStatus(token, invoiceId, status) {
  requireSession_(token, 'admin');
  if (['unpaid', 'pending', 'paid'].indexOf(status) < 0) throw new Error('สถานะไม่ถูกต้อง');
  return fsUpdate_(COL.INVOICES, invoiceId, { status: status });
}
