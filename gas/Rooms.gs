/**
 * ห้อง / ผู้เช่า / ประวัติการเข้าพัก
 */

/** ข้อมูลเริ่มต้นของหน้าแอดมิน */
function apiAdminBootstrap(token) {
  requireSession_(token, 'admin');
  const settings = getSettings_();
  const r = fsMulti_([
    { list: COL.ROOMS },
    { where: [COL.TENANCIES, { status: 'active' }] },
    { where: [COL.PAYMENTS, { status: 'pending' }] },
    { list: COL.REPAIRS },
  ]);
  const rooms = r[0], tenancies = r[1];
  const byId = {};
  tenancies.forEach(function (t) { byId[t.id] = t; });
  rooms.forEach(function (r) {
    const t = byId[r.currentTenancyId];
    r.tenantName = t ? t.tenantName : '';
    r.moveIn = t ? t.moveIn : '';
  });
  rooms.sort(function (a, b) { return Number(a.number) - Number(b.number); });
  const pendingPayments = r[2].length;
  const openRepairs = r[3].filter(function (x) { return x.status !== 'done'; }).length;
  return { settings: settings, rooms: rooms, pendingPayments: pendingPayments, openRepairs: openRepairs };
}

function apiRoomDetail(token, roomId) {
  requireSession_(token, 'admin');
  const r = fsMulti_([
    { get: [COL.ROOMS, roomId] },
    { where: [COL.TENANCIES, { roomId: roomId }] },
    { where: [COL.REPAIRS, { roomId: roomId }] },
    { where: [COL.INVOICES, { roomId: roomId }] },
  ]);
  return {
    room: r[0],
    tenancies: sortBy_(r[1], 'moveIn', true),
    repairs: sortBy_(r[2], 'date', true),
    invoices: sortBy_(r[3], 'month', true),
  };
}

function apiSaveRoom(token, room) {
  requireSession_(token, 'admin');
  return fsUpdate_(COL.ROOMS, room.id, {
    rent: Number(room.rent) || 0,
    deposit: Number(room.deposit) || 0,
    note: room.note || '',
    status: room.status,
  });
}

/**
 * ย้ายเข้า
 * data: {roomId, moveIn, rent, deposit, water, electric,
 *        tenant:{name, phone, idCard, address}}
 * คืน PIN สำหรับให้ผู้เช่าเข้าระบบ (แสดงครั้งเดียว)
 */
function apiMoveIn(token, data) {
  requireSession_(token, 'admin');
  const room = fsGet_(COL.ROOMS, data.roomId);
  if (!room) throw new Error('ไม่พบห้อง');
  if (room.currentTenancyId) throw new Error('ห้องนี้มีผู้เช่าอยู่ กรุณาบันทึกย้ายออกก่อน');
  if (!data.tenant || !data.tenant.name) throw new Error('กรุณากรอกชื่อผู้เช่า');

  const tenant = fsSet_(COL.TENANTS, null, {
    name: data.tenant.name,
    phone: data.tenant.phone || '',
    idCard: data.tenant.idCard || '',
    address: data.tenant.address || '',
  });
  const pin = randomPin_();
  const tenancy = fsSet_(COL.TENANCIES, null, {
    roomId: room.id,
    tenantId: tenant.id,
    tenantName: tenant.name,
    moveIn: data.moveIn || today_(),
    moveOut: '',
    rent: Number(data.rent) || room.rent,
    deposit: Number(data.deposit) || room.deposit,
    startWater: Number(data.water) || 0,
    startElectric: Number(data.electric) || 0,
    pinHash: hash_(room.id + ':' + pin),
    status: 'active',
    contractFileId: '',
    note: '',
  });
  fsUpdate_(COL.ROOMS, room.id, { status: 'occupied', currentTenancyId: tenancy.id });
  return { tenancyId: tenancy.id, pin: pin };
}

/** ย้ายออก: data {roomId, moveOut, note} */
function apiMoveOut(token, data) {
  requireSession_(token, 'admin');
  const room = fsGet_(COL.ROOMS, data.roomId);
  if (!room || !room.currentTenancyId) throw new Error('ห้องนี้ไม่มีผู้เช่า');
  fsUpdate_(COL.TENANCIES, room.currentTenancyId, {
    moveOut: data.moveOut || today_(),
    status: 'ended',
    note: data.note || '',
    pinHash: '', // ปิดการเข้าระบบ
  });
  fsUpdate_(COL.ROOMS, room.id, { status: 'vacant', currentTenancyId: '' });
  return true;
}

function apiResetPin(token, roomId) {
  requireSession_(token, 'admin');
  const room = fsGet_(COL.ROOMS, roomId);
  if (!room || !room.currentTenancyId) throw new Error('ห้องนี้ไม่มีผู้เช่า');
  const pin = randomPin_();
  fsUpdate_(COL.TENANCIES, room.currentTenancyId, { pinHash: hash_(roomId + ':' + pin) });
  return { pin: pin };
}

function apiGetTenant(token, tenantId) {
  requireSession_(token, 'admin');
  return fsGet_(COL.TENANTS, tenantId);
}

function apiSaveSettings(token, s) {
  requireSession_(token, 'admin');
  const allowed = ['dormName', 'dormAddress', 'ownerName', 'phone', 'bankInfo', 'primaryColor',
    'waterRate', 'waterMinCharge', 'electricRate', 'electricMinCharge', 'dueDay', 'otherFees',
    'invoiceNotes', 'invoiceFooter'];
  const nums = ['waterRate', 'waterMinCharge', 'electricRate', 'electricMinCharge', 'dueDay'];
  const upd = {};
  allowed.forEach(function (k) {
    if (s[k] === undefined) return;
    upd[k] = nums.indexOf(k) >= 0 ? Number(s[k]) || 0 : s[k];
  });
  if (upd.otherFees) {
    upd.otherFees = upd.otherFees
      .filter(function (f) { return f && f.name; })
      .map(function (f) { return { name: String(f.name), amount: Number(f.amount) || 0 }; });
  }
  fsUpdate_(COL.SETTINGS, 'main', upd);
  clearSettingsCache_();
  return getSettings_();
}
