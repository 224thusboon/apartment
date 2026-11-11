/**
 * ประวัติซ่อม / เปลี่ยนอะไหล่ ต่อห้อง
 * สถานะ: reported (แจ้ง) -> in_progress (กำลังซ่อม) -> done (เสร็จ)
 */

/** แอดมินบันทึก/แก้ไขงานซ่อม  photos: [{name,mimeType,data}] */
function apiSaveRepair(token, repair, photos) {
  requireSession_(token, 'admin');
  const settings = getSettings_();
  const old = repair.id ? fsGet_(COL.REPAIRS, repair.id) : null;
  const photoIds = (old && old.photoIds) || [];
  (photos || []).forEach(function (p) {
    photoIds.push(saveUpload_(settings.photoFolderId, p, repair.roomId, 'repair'));
  });
  return fsSet_(COL.REPAIRS, repair.id || null, {
    roomId: repair.roomId,
    date: repair.date || today_(),
    title: repair.title || '',
    detail: repair.detail || '',
    parts: repair.parts || '',     // อะไหล่ที่เปลี่ยน
    cost: Number(repair.cost) || 0,
    status: repair.status || 'done',
    reportedBy: (old && old.reportedBy) || 'admin',
    photoIds: photoIds,
  });
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
  return fsSet_(COL.REPAIRS, null, {
    roomId: s.roomId, date: today_(), title: data.title, detail: data.detail || '',
    parts: '', cost: 0, status: 'reported', reportedBy: 'tenant', photoIds: photoIds,
  });
}

/** หน้าหลักผู้เช่า */
function apiTenantHome(token) {
  const s = requireSession_(token, 'tenant');
  const room = fsGet_(COL.ROOMS, s.roomId);
  const t = room && room.currentTenancyId ? fsGet_(COL.TENANCIES, room.currentTenancyId) : null;
  if (!t || t.tenantId !== s.tenantId) throw new Error('AUTH: สิทธิ์การเข้าพักสิ้นสุดแล้ว');
  const invoices = fsWhere_(COL.INVOICES, { tenancyId: t.id }, { field: 'month', dir: 'DESCENDING' });
  const payments = fsWhere_(COL.PAYMENTS, { roomId: s.roomId })
    .filter(function (p) { return invoices.some(function (i) { return i.id === p.invoiceId; }); });
  const repairs = fsWhere_(COL.REPAIRS, { roomId: s.roomId }, { field: 'date', dir: 'DESCENDING' })
    .filter(function (r) { return r.date >= t.moveIn; })
    .map(function (r) { return { id: r.id, date: r.date, title: r.title, status: r.status }; });
  return {
    settings: publicSettings_(getSettings_()),
    roomId: s.roomId,
    tenancy: { tenantName: t.tenantName, moveIn: t.moveIn, rent: t.rent, contractFileId: t.contractFileId || '' },
    invoices: invoices,
    payments: payments,
    repairs: repairs,
  };
}
