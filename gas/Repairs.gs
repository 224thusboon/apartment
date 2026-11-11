/**
 * ประวัติซ่อม / เปลี่ยนอะไหล่ ต่อห้อง
 * สถานะ: reported (แจ้ง) -> in_progress (กำลังซ่อม) -> done (เสร็จ)
 */

/** แอดมินบันทึก/แก้ไขงานซ่อม  photos: [{name,mimeType,data}] */
function apiSaveRepair(token, repair, photos) {
  const me = requireSession_(token, 'admin');
  const settings = getSettings_();
  const old = repair.id ? fsGet_(COL.REPAIRS, repair.id) : null;
  const photoIds = (old && old.photoIds) || [];
  (photos || []).forEach(function (p) {
    photoIds.push(saveUpload_(settings.photoFolderId, p, repair.roomId, 'repair'));
  });
  const cost = Number(repair.cost) || 0;
  const date = repair.date || today_();
  const saved = fsSet_(COL.REPAIRS, repair.id || null, {
    roomId: repair.roomId,
    date: date,
    title: repair.title || '',
    detail: repair.detail || '',
    parts: repair.parts || '',     // อะไหล่ที่เปลี่ยน
    cost: cost,
    status: repair.status || 'done',
    reportedBy: (old && old.reportedBy) || 'admin',
    photoIds: photoIds,
    chargeId: (old && old.chargeId) || '',
    expenseId: (old && old.expenseId) || '',
  });

  // เรียกเก็บจากผู้เช่า -> รายการเรียกเก็บเพิ่ม เข้าบิลเดือนที่เลือก
  const chargeAmt = Number(repair.chargeAmount) || 0;
  if (repair.chargeTenant && chargeAmt > 0 && !saved.chargeId) {
    const c = apiAddCharge(token, {
      roomId: repair.roomId, month: repair.chargeMonth || date.slice(0, 7),
      name: 'ค่าซ่อม ' + (repair.title || ''), qty: 1, price: chargeAmt, note: repair.parts || '', repairId: saved.id,
    });
    fsUpdate_(COL.REPAIRS, saved.id, { chargeId: c.id });
    saved.chargeId = c.id;
  }
  // ค่าใช้จ่ายงานซ่อมเข้าบัญชีรายจ่ายอัตโนมัติ (ดู Accounts.gs) ไม่ต้องบันทึกซ้ำ
  audit_(me, old ? 'แก้ไขงานซ่อม' : 'บันทึกงานซ่อม', 'ห้อง ' + repair.roomId + ' · ' + (repair.title || ''),
    'ค่าใช้จ่าย ' + money_(cost) + (old && Number(old.cost) !== cost ? ' (เดิม ' + money_(old.cost) + ')' : '') + ' · สถานะ ' + saved.status);
  return saved;
}

function apiListRepairs(token, onlyOpen) {
  requireSession_(token, 'admin');
  let rows = fsList_(COL.REPAIRS);
  if (onlyOpen) rows = rows.filter(function (r) { return r.status !== 'done'; });
  rows.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return rows;
}

/** ผู้เช่าแจ้งซ่อม */
function apiReportRepair(token, data, photos) {
  const s = requireSession_(token, 'tenant');
  if (!data.title) throw new Error('กรุณาระบุเรื่องที่แจ้ง');
  const settings = getSettings_();
  const photoIds = (photos || []).slice(0, 3).map(function (p) {
    return saveUpload_(settings.photoFolderId, p, s.roomId, 'repair');
  });
  const saved = fsSet_(COL.REPAIRS, null, {
    roomId: s.roomId, date: today_(), title: data.title, detail: data.detail || '',
    parts: '', cost: 0, status: 'reported', reportedBy: 'tenant', photoIds: photoIds,
  });
  audit_(s, 'ผู้เช่าแจ้งซ่อม', 'ห้อง ' + s.roomId, data.title);
  return saved;
}

/** หน้าหลักผู้เช่า */
function apiTenantHome(token) {
  const s = requireSession_(token, 'tenant');
  // อ่านทุกอย่างของห้องนี้พร้อมกันในรอบเดียว
  const r = fsMulti_([
    { where: [COL.TENANCIES, { roomId: s.roomId, status: 'active' }] },
    { where: [COL.INVOICES, { roomId: s.roomId }] },
    { where: [COL.PAYMENTS, { roomId: s.roomId }] },
    { where: [COL.REPAIRS, { roomId: s.roomId }] },
  ]);
  const t = r[0].filter(function (x) { return x.id === s.tenancyId; })[0];
  if (!t) throw new Error('AUTH: สิทธิ์การเข้าพักสิ้นสุดแล้ว');
  const invoices = sortBy_(r[1].filter(function (i) { return i.tenancyId === t.id && i.status !== 'cancelled'; }), 'month', true);
  const payments = r[2]
    .filter(function (p) { return invoices.some(function (i) { return i.id === p.invoiceId; }); });
  const repairs = sortBy_(r[3], 'date', true)
    .filter(function (x) { return x.date >= t.moveIn; })
    .map(function (r) { return { id: r.id, date: r.date, title: r.title, status: r.status }; });
  return {
    settings: publicSettings_(getSettings_()),
    roomId: s.roomId,
    tenancy: {
      tenantName: t.tenantName, moveIn: t.moveIn, rent: t.rent, contractFileId: t.contractFileId || '',
      signedContracts: (t.signedContracts || []).map(function (c) { return { fileId: c.fileId, name: c.name, uploadedAt: c.uploadedAt }; }),
    },
    invoices: invoices,
    payments: payments,
    repairs: repairs,
  };
}
