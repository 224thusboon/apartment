/**
 * Firestore REST client แบบเบา ๆ (ใช้ OAuth token ของเจ้าของสคริปต์)
 * GAS ต้องผูกกับ GCP project เดียวกับ Firestore (ดู README)
 */

function fsBase_() {
  const pid = prop_('FIRESTORE_PROJECT_ID');
  if (!pid) throw new Error('ยังไม่ได้ตั้ง Script Property FIRESTORE_PROJECT_ID');
  return 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents';
}

function fsFetch_(url, method, payload) {
  const opt = {
    method: method || 'get',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch(url, opt);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code === 404) return null;
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + text);
  return text ? JSON.parse(text) : {};
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

// ---------- CRUD ----------

function fsGet_(col, id) {
  return docToObj_(fsFetch_(fsBase_() + '/' + col + '/' + encodeURIComponent(id)));
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

/** อ่านทั้ง collection (ระบบมี 20 ห้อง ข้อมูลไม่เยอะ) */
function fsList_(col) {
  const out = [];
  let token = '';
  do {
    const url = fsBase_() + '/' + col + '?pageSize=300' + (token ? '&pageToken=' + token : '');
    const res = fsFetch_(url) || {};
    (res.documents || []).forEach(function (d) { out.push(docToObj_(d)); });
    token = res.nextPageToken || '';
  } while (token);
  return out;
}

/**
 * query แบบเงื่อนไขเท่ากับ (AND)  เช่น fsWhere_('invoices', {roomId:'101'})
 * orderBy (ไม่บังคับ): {field:'month', dir:'DESCENDING'}
 * หมายเหตุ: where + orderBy คนละฟิลด์ Firestore จะขอให้สร้าง composite index
 * จึงเรียงฝั่งสคริปต์แทน
 */
function fsWhere_(col, eq, orderBy) {
  const filters = Object.keys(eq).map(function (k) {
    return { fieldFilter: { field: { fieldPath: k }, op: 'EQUAL', value: toFs_(eq[k]) } };
  });
  const q = { from: [{ collectionId: col }] };
  if (filters.length === 1) q.where = filters[0];
  else if (filters.length > 1) q.where = { compositeFilter: { op: 'AND', filters: filters } };
  const res = fsFetch_(fsBase_() + ':runQuery', 'post', { structuredQuery: q }) || [];
  let rows = res.filter(function (r) { return r.document; }).map(function (r) { return docToObj_(r.document); });
  if (orderBy) {
    const dir = orderBy.dir === 'DESCENDING' ? -1 : 1;
    rows.sort(function (a, b) {
      const x = a[orderBy.field], y = b[orderBy.field];
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
  }
  return rows;
}
