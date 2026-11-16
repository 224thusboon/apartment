/**
 * ห้อง / ผู้เช่า / ประวัติการเข้าพัก
 */

/** tenantId -> ชื่อเล่น (ใช้แสดงบนหน้าจอเท่านั้น) */
function nickMap_(tenants) {
  const m = {};
  (tenants || []).forEach(function (x) { if (x.nickname) m[x.id] = x.nickname; });
  return m;
}

/** ข้อมูลเริ่มต้นของหน้าแอดมิน */
function apiAdminBootstrap(token) {
  requireSession_(token, 'admin');
  const settings = getSettings_();
  const r = fsMulti_([
    { list: COL.ROOMS },
    { where: [COL.TENANCIES, { status: 'active' }] },
    { where: [COL.PAYMENTS, { status: 'pending' }] },
    { list: COL.REPAIRS },
    { where: [COL.INVOICES, { status: 'unpaid' }] },
    { where: [COL.INVOICES, { status: 'pending' }] },
    { list: COL.TENANTS },
  ]);
  const rooms = r[0], tenancies = r[1];
  const nick = nickMap_(r[6]);
  const byId = {};
  tenancies.forEach(function (t) { byId[t.id] = t; });

  // ยอดค้างต่อห้อง: ค้างชำระ (unpaid) และ รอตรวจสลิป (pending)
  const today = today_();
  const due = {};
  r[4].concat(r[5]).forEach(function (i) {
    const d = due[i.roomId] = due[i.roomId] || { unpaid: 0, unpaidCount: 0, overdue: 0, overdueDays: 0, pending: 0 };
    if (i.status === 'pending') { d.pending += 1; return; }
    d.unpaid = round2_(d.unpaid + (Number(i.total) || 0));
    d.unpaidCount += 1;
    if (i.dueDate && i.dueDate < today) {
      d.overdue = round2_(d.overdue + (Number(i.total) || 0));
      const days = Math.floor((new Date(today) - new Date(i.dueDate)) / 864e5);
      d.overdueDays = Math.max(d.overdueDays, days);
    }
  });

  rooms.forEach(function (x) {
    const t = byId[x.currentTenancyId];
    x.tenantName = t ? t.tenantName : '';
    x.tenantNick = t ? t.tenantNick || nick[t.tenantId] || '' : '';
    x.moveIn = t ? t.moveIn : '';
    x.due = due[x.id] || null;
  });
  rooms.sort(function (a, b) { return roomCmp_(a.number, b.number); });
  const pendingPayments = r[2].length;
  const openRepairs = r[3].filter(function (x) { return x.status !== 'done'; }).length;
  const overdueRooms = rooms.filter(function (x) { return x.due && x.due.overdue > 0; });
  return {
    settings: settings, rooms: rooms, pendingPayments: pendingPayments, openRepairs: openRepairs,
    overdueRooms: overdueRooms.length,
    overdueTotal: round2_(overdueRooms.reduce(function (s, x) { return s + x.due.overdue; }, 0)),
  };
}

function apiRoomDetail(token, roomId) {
  requireSession_(token, 'admin');
  const r = fsMulti_([
    { get: [COL.ROOMS, roomId] },
    { where: [COL.TENANCIES, { roomId: roomId }] },
    { where: [COL.REPAIRS, { roomId: roomId }] },
    { where: [COL.INVOICES, { roomId: roomId }] },
    { where: [COL.CHARGES, { roomId: roomId }] },
    { list: COL.TENANTS },
  ]);
  const nick = nickMap_(r[5]);
  r[1].forEach(function (t) { if (!t.tenantNick) t.tenantNick = nick[t.tenantId] || ''; });
  return {
    room: r[0],
    tenancies: sortBy_(r[1], 'moveIn', true),
    repairs: sortBy_(r[2], 'date', true),
    invoices: sortBy_(r[3].filter(function (i) { return i.status !== 'cancelled'; }), 'month', true),
    charges: sortBy_(r[4], 'month', true),
  };
}

/** เรียงเลขห้องแบบตัวเลข (101 < 102 < 1001) รองรับเลขห้องที่มีตัวอักษร */
function roomCmp_(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

/**
 * เพิ่มห้องใหม่ (ทีละหลายห้องได้)
 * data: {ids: '501, 502, 503' หรือ '501-505', rent, deposit}
 */
function apiAddRooms(token, data) {
  const me = requireSession_(token, 'admin');
  const ids = parseRoomIds_(data.ids);
  if (!ids.length) throw new Error('กรุณาระบุเลขห้อง');
  if (ids.length > 100) throw new Error('เพิ่มได้ครั้งละไม่เกิน 100 ห้อง');
  const existing = fsMulti_(ids.map(function (id) { return { get: [COL.ROOMS, id] }; }));
  const dup = ids.filter(function (id, i) { return existing[i]; });
  if (dup.length) throw new Error('มีห้องนี้อยู่แล้ว: ' + dup.join(', '));
  const rent = Number(data.rent) || 0, deposit = Number(data.deposit) || 0;
  const docs = {};
  ids.forEach(function (id) {
    const n = Number(id);
    docs[id] = {
      number: id, floor: isNaN(n) ? '' : Math.floor(n / 100), rent: rent, deposit: deposit,
      status: 'vacant', currentTenancyId: '', note: '', createdAt: new Date(),
    };
  });
  fsSetMany_(COL.ROOMS, docs);
  audit_(me, 'เพิ่มห้อง', ids.length + ' ห้อง', ids.join(', ') + ' · ค่าเช่า ' + rent + ' ประกัน ' + deposit);
  return ids;
}

/** '501, 502' / '501-505' / '501 502' -> ['501','502',...] */
function parseRoomIds_(text) {
  const out = [];
  String(text || '').split(/[,\s]+/).forEach(function (p) {
    if (!p) return;
    const m = p.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b < a || b - a > 100) throw new Error('ช่วงเลขห้องไม่ถูกต้อง: ' + p);
      for (let i = a; i <= b; i++) out.push(String(i));
      return;
    }
    if (!/^[A-Za-z0-9ก-๙]{1,10}$/.test(p)) throw new Error('เลขห้องไม่ถูกต้อง: ' + p);
    out.push(p);
  });
  return out.filter(function (x, i) { return out.indexOf(x) === i; });
}

/** ลบห้องได้เฉพาะห้องที่ไม่เคยมีผู้เช่า/บิล/งานซ่อม (กันลบประวัติ) */
function apiDeleteRoom(token, roomId) {
  const me = requireSession_(token, 'admin');
  const r = fsMulti_([
    { get: [COL.ROOMS, roomId] },
    { where: [COL.TENANCIES, { roomId: roomId }] },
    { where: [COL.INVOICES, { roomId: roomId }] },
    { where: [COL.REPAIRS, { roomId: roomId }] },
  ]);
  if (!r[0]) throw new Error('ไม่พบห้อง');
  if (r[1].length || r[2].length || r[3].length) throw new Error('ห้องนี้มีประวัติแล้ว ลบไม่ได้ (เปลี่ยนสถานะเป็นปิดปรับปรุงแทนได้)');
  fsDelete_(COL.ROOMS, roomId);
  audit_(me, 'ลบห้อง', 'ห้อง ' + roomId, '');
  return true;
}

function apiSaveRoom(token, room) {
  const me = requireSession_(token, 'admin');
  const saved = fsUpdate_(COL.ROOMS, room.id, {
    rent: Number(room.rent) || 0,
    deposit: Number(room.deposit) || 0,
    note: room.note || '',
    status: room.status,
  });
  audit_(me, 'แก้ไขข้อมูลห้อง', 'ห้อง ' + room.id, 'ค่าเช่า ' + room.rent + ' ประกัน ' + room.deposit + ' สถานะ ' + room.status);
  return saved;
}

/**
 * ย้ายเข้า
 * data: {roomId, moveIn, rent, deposit, water, electric,
 *        tenant:{name, phone, idCard, address}}
 * คืน PIN สำหรับให้ผู้เช่าเข้าระบบ (แสดงครั้งเดียว)
 */
function apiMoveIn(token, data) {
  const me = requireSession_(token, 'admin');
  const room = fsGet_(COL.ROOMS, data.roomId);
  if (!room) throw new Error('ไม่พบห้อง');
  if (room.currentTenancyId) throw new Error('ห้องนี้มีผู้เช่าอยู่ กรุณาบันทึกย้ายออกก่อน');
  if (!data.tenant || !data.tenant.name) throw new Error('กรุณากรอกชื่อผู้เช่า');

  const tenant = fsSet_(COL.TENANTS, null, {
    name: data.tenant.name,
    nickname: data.tenant.nickname || '',
    phone: data.tenant.phone || '',
    idCard: data.tenant.idCard || '',
    address: data.tenant.address || '',
  });
  const pin = randomPin_();
  const tenancy = fsSet_(COL.TENANCIES, null, {
    roomId: room.id,
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantNick: tenant.nickname || '',
    moveIn: data.moveIn || today_(),
    moveOut: '',
    rent: Number(data.rent) || room.rent,
    deposit: Number(data.deposit) || room.deposit,
    startWater: (meterVal_(data.water) || { n: 0 }).n,
    startElectric: (meterVal_(data.electric) || { n: 0 }).n,
    startWaterText: (meterVal_(data.water) || { t: '0' }).t,
    startElectricText: (meterVal_(data.electric) || { t: '0' }).t,
    pinHash: hash_(room.id + ':' + pin),
    status: 'active',
    contractFileId: '',
    note: '',
  });
  fsUpdate_(COL.ROOMS, room.id, { status: 'occupied', currentTenancyId: tenancy.id });
  audit_(me, 'บันทึกย้ายเข้า', 'ห้อง ' + room.id, tenant.name + ' วันที่ ' + tenancy.moveIn);
  return { tenancyId: tenancy.id, pin: pin };
}

/** ย้ายออก: data {roomId, moveOut, note}  ตัดการเข้าระบบของผู้เช่าทุกเครื่องทันที */
function apiMoveOut(token, data) {
  const me = requireSession_(token, 'admin');
  const room = fsGet_(COL.ROOMS, data.roomId);
  if (!room || !room.currentTenancyId) throw new Error('ห้องนี้ไม่มีผู้เช่า');
  const tenancyId = room.currentTenancyId;
  const moveOut = data.moveOut || today_();
  const t = fsGet_(COL.TENANCIES, tenancyId) || {};
  // เริ่มนับระยะเวลาเก็บสัญญาและเอกสารประกอบ 10 ปีจากวันย้ายออก
  const until = retainUntil_(moveOut);
  const upd = {
    moveOut: moveOut,
    status: 'ended',
    note: data.note || '',
    pinHash: '', // ปิดการเข้าระบบ
    retainUntil: until,
    signedContracts: (t.signedContracts || []).map(function (c) { c.retainUntil = until; return c; }),
  };
  if (t.contractFileId) upd.contractRetainUntil = until;
  fsUpdate_(COL.TENANCIES, tenancyId, upd);
  fsUpdate_(COL.ROOMS, room.id, { status: 'vacant', currentTenancyId: '' });
  const n = revokeSessions_({ tenancyId: tenancyId });
  audit_(me, 'บันทึกย้ายออก', 'ห้อง ' + room.id, (data.note || '') + ' (ตัดการเข้าระบบ ' + n + ' เครื่อง)');
  return true;
}

/** ออก PIN ใหม่: PIN เดิมใช้ไม่ได้ และเครื่องที่ล็อกอินค้างอยู่ถูกตัดออก */
function apiResetPin(token, roomId) {
  const me = requireSession_(token, 'admin');
  const room = fsGet_(COL.ROOMS, roomId);
  if (!room || !room.currentTenancyId) throw new Error('ห้องนี้ไม่มีผู้เช่า');
  const pin = randomPin_();
  fsUpdate_(COL.TENANCIES, room.currentTenancyId, { pinHash: hash_(roomId + ':' + pin) });
  const n = revokeSessions_({ tenancyId: room.currentTenancyId });
  CacheService.getScriptCache().remove('lock_room_' + roomId);
  audit_(me, 'ออก PIN ใหม่', 'ห้อง ' + roomId, 'ตัดการเข้าระบบเดิม ' + n + ' เครื่อง');
  return { pin: pin };
}

/**
 * แก้ข้อมูลผู้เช่าของการเข้าพักครั้งนี้
 * data: {name, phone, idCard, address, rent, deposit, moveIn}
 */
function apiUpdateTenant(token, tenancyId, data) {
  const me = requireSession_(token, 'admin');
  const t = fsGet_(COL.TENANCIES, tenancyId);
  if (!t) throw new Error('ไม่พบข้อมูลการเข้าพัก');
  const name = String(data.name || '').trim();
  if (!name) throw new Error('กรุณากรอกชื่อผู้เช่า');
  const old = fsGet_(COL.TENANTS, t.tenantId) || {};
  fsUpdate_(COL.TENANTS, t.tenantId, {
    name: name, nickname: data.nickname || '', phone: data.phone || '', idCard: data.idCard || '', address: data.address || '',
  });
  const upd = { tenantName: name, tenantNick: data.nickname || '' };
  if (data.rent !== undefined && data.rent !== '') upd.rent = Number(data.rent) || 0;
  if (data.deposit !== undefined && data.deposit !== '') upd.deposit = Number(data.deposit) || 0;
  if (data.moveIn) upd.moveIn = data.moveIn;
  // มิเตอร์ตั้งต้นตอนย้ายเข้า (เก็บเลขตามที่จด รวม 0 ข้างหน้า)
  const sw = meterVal_(data.startWater), se = meterVal_(data.startElectric);
  if (sw) { upd.startWater = sw.n; upd.startWaterText = sw.t; }
  if (se) { upd.startElectric = se.n; upd.startElectricText = se.t; }
  fsUpdate_(COL.TENANCIES, tenancyId, upd);
  const changes = [];
  if (old.name !== name) changes.push('ชื่อ ' + (old.name || '-') + ' → ' + name);
  ['nickname', 'phone', 'idCard', 'address'].forEach(function (k) { if ((old[k] || '') !== (data[k] || '')) changes.push(k); });
  ['rent', 'deposit', 'moveIn', 'startWaterText', 'startElectricText'].forEach(function (k) { if (upd[k] !== undefined && String(upd[k]) !== String(t[k])) changes.push(k + ' ' + t[k] + ' → ' + upd[k]); });
  audit_(me, 'แก้ไขข้อมูลผู้เช่า', 'ห้อง ' + t.roomId, changes.join(' · ') || 'ไม่มีการเปลี่ยนแปลง');
  return true;
}

function apiGetTenant(token, tenantId) {
  requireSession_(token, 'admin');
  return fsGet_(COL.TENANTS, tenantId);
}

function apiSaveSettings(token, s) {
  const me = requireSession_(token, 'admin');
  const allowed = ['dormName', 'dormAddress', 'ownerName', 'phone', 'bankInfo', 'primaryColor',
    'waterRate', 'waterMinCharge', 'electricRate', 'electricMinCharge', 'dueDay', 'otherFees',
    'invoiceNotes', 'invoiceFooter', 'invoiceStyle'];
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
  audit_(me, 'แก้ไขการตั้งค่า', '', Object.keys(upd).join(', '));
  return getSettings_();
}
