/**
 * Firestore REST client แบบเบา ๆ (ใช้ OAuth token ของเจ้าของสคริปต์)
 * GAS ต้องผูกกับ GCP project เดียวกับ Firestore (ดู README)
 *
 * ความเร็ว: แต่ละคำขอไป Firestore ใช้เวลา ~0.2-0.5 วินาที
 * ถ้าต้องอ่านหลายอย่าง ให้ใช้ fsMulti_ ซึ่งยิงทุกคำขอพร้อมกัน (UrlFetchApp.fetchAll)
 */

let FS_BASE_ = '';
function fsBase_() {
  if (FS_BASE_) return FS_BASE_;
  const pid = prop_('FIRESTORE_PROJECT_ID');
  if (!pid) throw new Error('ยังไม่ได้ตั้ง Script Property FIRESTORE_PROJECT_ID');
  FS_BASE_ = 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents';
  return FS_BASE_;
}

/** สร้างคำขอ (ยังไม่ส่ง) */
function fsReq_(url, method, payload) {
  const r = {
    url: url,
    method: method || 'get',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (payload !== undefined) r.payload = JSON.stringify(payload);
  return r;
}

function fsParse_(res) {
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code === 404) return null;
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + text);
  return text ? JSON.parse(text) : {};
}

function fsFetch_(url, method, payload) {
  const r = fsReq_(url, method, payload);
  const url2 = r.url;
  delete r.url;
  return fsParse_(UrlFetchApp.fetch(url2, r));
}

// ---------- แปลงค่า JS <-> Firestore Value ----------

function toFs_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs_) } };
  if (typeof v === 'object') return { mapValue: { fields: toFsFields_(v) } };
  return { stringValue: String(v) };
}

function toFsFields_(obj) {
  const f = {};
  Object.keys(obj).forEach(function (k) {
    if (obj[k] !== undefined) f[k] = toFs_(obj[k]);
  });
  return f;
}

function fromFs_(val) {
  if (!val) return null;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue; // เก็บเป็น ISO string
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fromFs_);
  if ('mapValue' in val) return fromFsFields_(val.mapValue.fields || {});
  return null;
}

function fromFsFields_(fields) {
  const o = {};
  Object.keys(fields || {}).forEach(function (k) { o[k] = fromFs_(fields[k]); });
  return o;
}

function docToObj_(doc) {
  if (!doc || !doc.name) return null;
  const o = fromFsFields_(doc.fields);
  o.id = doc.name.split('/').pop();
  return o;
}

// ---------- อ่านหลายอย่างพร้อมกัน ----------

/** structuredQuery แบบเงื่อนไขเท่ากับ (AND) — eq ว่าง = ทั้ง collection */
function fsQuery_(col, eq) {
  eq = eq || {};
  const filters = Object.keys(eq).map(function (k) {
    return { fieldFilter: { field: { fieldPath: k }, op: 'EQUAL', value: toFs_(eq[k]) } };
  });
  const q = { from: [{ collectionId: col }] };
  if (filters.length === 1) q.where = filters[0];
  else if (filters.length > 1) q.where = { compositeFilter: { op: 'AND', filters: filters } };
  return { structuredQuery: q };
}

/**
 * specs: [{get:[col,id]} | {where:[col,{field:value}]} | {list:col}]
 * คืนผลลำดับเดียวกับ specs (get -> object|null, where/list -> array)
 */
function fsMulti_(specs) {
  const base = fsBase_();
  const reqs = specs.map(function (s) {
    if (s.get) return fsReq_(base + '/' + s.get[0] + '/' + encodeURIComponent(s.get[1]));
    const col = s.where ? s.where[0] : s.list;
    const eq = s.where ? s.where[1] : {};
    return fsReq_(base + ':runQuery', 'post', fsQuery_(col, eq));
  });
  let res;
  if (reqs.length === 1) {
    const p = Object.assign({}, reqs[0]);
    delete p.url;
    res = [UrlFetchApp.fetch(reqs[0].url, p)];
  } else {
    res = UrlFetchApp.fetchAll(reqs);
  }
  return res.map(function (r, i) {
    const j = fsParse_(r);
    if (specs[i].get) return docToObj_(j);
    return (j || []).filter(function (x) { return x.document; }).map(function (x) { return docToObj_(x.document); });
  });
}

function sortBy_(rows, field, desc) {
  const dir = desc ? -1 : 1;
  return rows.sort(function (a, b) {
    const x = a[field], y = b[field];
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
}

// ---------- CRUD ----------

function fsGet_(col, id) {
  return fsMulti_([{ get: [col, id] }])[0];
}

/** สร้าง/เขียนทับทั้งเอกสาร ถ้าไม่ระบุ id จะสุ่มให้ */
function fsSet_(col, id, data) {
  const clean = Object.assign({}, data);
  delete clean.id;
  clean.updatedAt = new Date();
  if (!id) id = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  fsFetch_(fsBase_() + '/' + col + '/' + encodeURIComponent(id), 'patch', { fields: toFsFields_(clean) });
  clean.id = id;
  return clean;
}

/** เขียนหลายเอกสารพร้อมกัน  docs: {id: data} */
function fsSetMany_(col, docs) {
  const base = fsBase_();
  const ids = Object.keys(docs);
  if (!ids.length) return;
  const now = new Date();
  const reqs = ids.map(function (id) {
    const clean = Object.assign({}, docs[id], { updatedAt: now });
    delete clean.id;
    return fsReq_(base + '/' + col + '/' + encodeURIComponent(id), 'patch', { fields: toFsFields_(clean) });
  });
  UrlFetchApp.fetchAll(reqs).forEach(fsParse_);
}

/** อัปเดตเฉพาะบางฟิลด์ */
function fsUpdate_(col, id, data) {
  const clean = Object.assign({}, data);
  delete clean.id;
  clean.updatedAt = new Date();
  const mask = Object.keys(clean).map(function (k) {
    return 'updateMask.fieldPaths=' + encodeURIComponent(k);
  }).join('&');
  const doc = fsFetch_(fsBase_() + '/' + col + '/' + encodeURIComponent(id) + '?' + mask,
    'patch', { fields: toFsFields_(clean) });
  return docToObj_(doc);
}

function fsDelete_(col, id) {
  fsFetch_(fsBase_() + '/' + col + '/' + encodeURIComponent(id), 'delete');
}

/** อ่านทั้ง collection */
function fsList_(col) {
  return fsMulti_([{ list: col }])[0];
}

/**
 * query แบบเงื่อนไขเท่ากับ (AND)  เช่น fsWhere_('invoices', {roomId:'101'})
 * orderBy (ไม่บังคับ): {field:'month', dir:'DESCENDING'} — เรียงฝั่งสคริปต์
 */
function fsWhere_(col, eq, orderBy) {
  const rows = fsMulti_([{ where: [col, eq] }])[0];
  return orderBy ? sortBy_(rows, orderBy.field, orderBy.dir === 'DESCENDING') : rows;
}
