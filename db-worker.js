/*
 * Read-only database worker for the iPad viewer.
 *
 * Only a 1 MiB slice of the source File is read at a time. The full database
 * lives in OPFS, not in a JavaScript ArrayBuffer or SQLite's in-memory VFS.
 * A separately named candidate is validated before an atomic IndexedDB
 * manifest update makes it current. Import failure never overwrites the
 * previously imported library (nor the user's original File).
 */
import sqlite3InitModule from './vendor/sqlite3.mjs';

const CHUNK_SIZE = 1024 * 1024;
const MAX_BLOB_SIZE = 128 * 1024 * 1024;
const MANIFEST_DB = 'comfyxviews-ipad-library-v1';
const LOCK_NAME = 'comfyxviews-ipad-library-v1';
const LIBRARY_PREFIX = '/library-';
const SQLITE_MAGIC = 'SQLite format 3\0';
const REQUIRED_COLUMNS = ['id', 'file_name', 'dir_path', 'file_type', 'thumb'];
const LIST_COLUMNS = [
  'id', 'rel_path', 'file_name', 'dir_path', 'file_type', 'ext', 'file_size',
  'mtime', 'model', 'category', 'thumb_w', 'thumb_h', 'width', 'height',
  'duration', 'created_at', 'imported_at', 'parse_version', 'thumb_version',
];
const DETAIL_COLUMNS = [...LIST_COLUMNS, 'md5', 'prompt', 'negative_prompt', 'loras', 'params'];

let sqlite3;
let pool;
let manifestDb;
let manifest = null;
let database = null;
let columns = new Set();
let library = null;
let initPromise;
let releaseOriginLock;
let requestQueue = Promise.resolve();

function fail(message) {
  throw new Error(message);
}

function progress(phase, loaded = 0, total = 0) {
  self.postMessage({type: 'progress', data: {phase, loaded, total}});
}

function rows(db, sql, bind = []) {
  return db.exec({sql, ...(bind.length ? {bind} : {}), rowMode: 'object', returnValue: 'resultRows'});
}

function value(db, sql, bind = []) {
  return bind.length ? db.selectValue(sql, bind) : db.selectValue(sql);
}

function integer(input, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
    fail(`${label}无效。`);
  }
  return input;
}

function optionalInteger(input, label, minimum = 0) {
  return input === null || input === undefined ? null : integer(input, label, minimum);
}

function text(input, label, maxLength) {
  if (typeof input !== 'string' || input.length > maxLength) fail(`${label}无效或过长。`);
  return input;
}

function likeEscape(input) {
  return input.replace(/[\\%_]/g, character => `\\${character}`);
}

function normalizeFolder(input) {
  if (input === null || input === undefined) return null;
  const path = text(input, '文件夹', 4096).replace(/\\/g, '/');
  return path === '' || path === '.' ? '.' : path.replace(/\/+$/g, '');
}

function rootExpression(schema = columns) {
  return schema.has('root_id') ? 'COALESCE(root_id, 1)' : '1';
}

function folderExpression() {
  return "CASE WHEN COALESCE(dir_path, '') IN ('', '.') THEN '.' ELSE REPLACE(dir_path, char(92), '/') END";
}

function projection(names, schema = columns) {
  return names.map(name => schema.has(name) ? `"${name}"` : `NULL AS "${name}"`).join(', ');
}

function decorate(row) {
  row.name = row.file_name || '';
  row.dir_path = normalizeFolder(row.dir_path || '.');
  row.category = Number(row.category || 0);
  return row;
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MANIFEST_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error || new Error('无法打开本地数据库信息。'));
    request.onblocked = () => reject(new Error('请关闭其他查看器标签页后重试。'));
    request.onsuccess = () => resolve(request.result);
  });
}

function manifestRead() {
  return new Promise((resolve, reject) => {
    const transaction = manifestDb.transaction('state', 'readonly');
    const request = transaction.objectStore('state').get('current');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error || new Error('读取本地数据库信息失败。'));
  });
}

function manifestWrite(next) {
  return new Promise((resolve, reject) => {
    const transaction = manifestDb.transaction('state', 'readwrite');
    const store = transaction.objectStore('state');
    if (next) store.put(next, 'current');
    else store.delete('current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('保存数据库信息失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('保存数据库信息失败。'));
  });
}

async function acquireOriginLock() {
  // Acquire before installing SAHPool: older SQLite releases may remove their
  // pool after an installation failure caused by a second tab's OPFS locks.
  if (!navigator.locks?.request) {
    fail('此浏览器不支持安全的本地数据库访问，请使用 iPadOS 16.4 或更新版本的 Safari。');
  }
  await new Promise((resolve, reject) => {
    navigator.locks.request(LOCK_NAME, {mode: 'exclusive', ifAvailable: true}, async lock => {
      if (!lock) {
        reject(new Error('查看器已在另一个标签页或主屏幕窗口中打开，请先关闭另一个窗口。'));
        return;
      }
      resolve();
      await new Promise(release => { releaseOriginLock = release; });
    }).catch(reject);
  });
}

function closeDatabase() {
  if (database) {
    database.close();
    database = null;
  }
  columns = new Set();
}

function openReadOnly(path) {
  const db = new pool.OpfsSAHPoolDb(path, 'r');
  try {
    const decoder = new TextDecoder();
    const collator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});
    const rc = sqlite3.capi.sqlite3_create_collation_v2(
      db.pointer, 'NATURAL_NAME', sqlite3.capi.SQLITE_UTF8, 0,
      (_context, lengthA, pointerA, lengthB, pointerB) => {
        const heap = sqlite3.wasm.heap8u();
        return collator.compare(
          decoder.decode(heap.subarray(pointerA, pointerA + lengthA)),
          decoder.decode(heap.subarray(pointerB, pointerB + lengthB)),
        );
      }, 0,
    );
    if (rc !== sqlite3.capi.SQLITE_OK) fail('无法初始化文件名排序。');
    db.exec(`
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA cache_size = -8192;
      PRAGMA mmap_size = 0;
      PRAGMA temp_store = MEMORY;
    `);
    const table = rows(db, "SELECT type, sql FROM sqlite_schema WHERE name = 'media'")[0];
    if (!table || table.type !== 'table' || /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql || '')) {
      fail('所选文件不是 ComfyXViews 数据库：缺少 media 数据表。');
    }
    const schema = new Set(rows(db, 'PRAGMA table_info(media)').map(row => row.name));
    if (!REQUIRED_COLUMNS.every(name => schema.has(name))) {
      fail('所选数据库缺少必要字段，请导入 Windows 软件生成的 media.db。');
    }
    return {db, schema};
  } catch (error) {
    db.close();
    throw error;
  }
}

function settingsFrom(db) {
  const found = value(db, "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'settings' AND type = 'table'");
  if (!found) return new Map();
  const names = new Set(rows(db, 'PRAGMA table_info(settings)').map(row => row.name));
  if (!names.has('key') || !names.has('value')) return new Map();
  return new Map(rows(db, "SELECT key, value FROM settings WHERE key IN ('roots', 'root_path')")
    .map(row => [row.key, row.value]));
}

function summarize(db, schema, metadata) {
  const root = rootExpression(schema);
  const stats = rows(db, `SELECT COUNT(*) AS count,
    COALESCE(SUM(CASE WHEN file_type = 'image' THEN 1 ELSE 0 END), 0) AS imageCount,
    COALESCE(SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END), 0) AS videoCount FROM media`)[0];
  const rootCounts = rows(db, `SELECT ${root} AS id, COUNT(*) AS count FROM media GROUP BY ${root} ORDER BY id`);
  const settings = settingsFrom(db);
  let declaredRoots = [];
  try {
    const parsed = JSON.parse(settings.get('roots') || '[]');
    if (Array.isArray(parsed)) declaredRoots = parsed.filter(item => item && Number.isSafeInteger(item.id) && typeof item.path === 'string');
  } catch (_) { /* Legacy databases can have an empty/invalid roots setting. */ }
  if (!declaredRoots.length && settings.get('root_path')) {
    declaredRoots = [{id: 1, path: settings.get('root_path')}];
  }
  const roots = new Map(declaredRoots.map(item => [item.id, {id: item.id, path: item.path, count: 0}]));
  for (const row of rootCounts) {
    const known = roots.get(row.id);
    roots.set(row.id, {id: row.id, path: known?.path || `图库 ${row.id}`, count: row.count});
  }
  const category = schema.has('category') ? 'COALESCE(category, 0)' : '0';
  const categories = rows(db, `SELECT ${category} AS id, COUNT(*) AS count FROM media GROUP BY ${category} ORDER BY id`);
  const folders = rows(db, `SELECT ${root} AS rootId, ${folderExpression()} AS path, COUNT(*) AS count
    FROM media GROUP BY ${root}, ${folderExpression()} ORDER BY rootId, path COLLATE NOCASE`);
  return {
    name: metadata.name,
    size: metadata.size,
    importedAt: metadata.importedAt,
    ...stats,
    roots: Array.from(roots.values()),
    categories,
    folders,
  };
}

function cleanupFiles(currentPath) {
  // Names belong to this dedicated pool. Never touch unrelated OPFS files.
  for (const path of pool.getFileNames()) {
    if (path.startsWith(LIBRARY_PREFIX) && path !== currentPath) {
      try { pool.unlink(path); } catch (error) { console.warn('Could not remove retired library copy:', error); }
    }
  }
}

async function initialize() {
  if (!self.isSecureContext || !navigator.storage?.getDirectory || typeof indexedDB === 'undefined') {
    fail('本地数据库需要安全网址和浏览器存储支持。请通过 HTTPS 打开，并使用 iPadOS 16.4 或更新版本的 Safari。');
  }
  progress('init');
  await acquireOriginLock();
  try {
    manifestDb = await idbOpen();
    sqlite3 = await sqlite3InitModule({
      locateFile: filename => new URL(`./vendor/${filename}`, import.meta.url).href,
      print: (...args) => console.debug(...args),
      printErr: (...args) => console.warn(...args),
    });
    pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'comfyxviews-ipad-sahpool-v1',
      directory: '/comfyxviews-ipad-sahpool-v1',
      initialCapacity: 6,
      clearOnInit: false,
      preserveOnInitFailure: true,
    });
    manifest = await manifestRead();
    if (manifest && !pool.getFileNames().includes(manifest.path)) {
      // The browser may evict OPFS independently of the tiny IDB manifest.
      await manifestWrite(null);
      manifest = null;
    }
    if (manifest) {
      const opened = openReadOnly(manifest.path);
      database = opened.db;
      columns = opened.schema;
      library = summarize(database, columns, manifest);
    }
    cleanupFiles(manifest?.path || null);
    return {library, capabilities: {persistent: true}};
  } catch (error) {
    // Keep the lock if a pool was installed. A clear/import request can still
    // recover a damaged current copy without a competing tab using the pool.
    if (!pool) {
      releaseOriginLock?.();
      releaseOriginLock = null;
    }
    throw error;
  }
}

function ensureInitialized() {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

async function validateFile(file) {
  if (!(file instanceof File) || !Number.isSafeInteger(file.size) || file.size < 512) {
    fail('请选择完整的 media.db 数据库文件。');
  }
  const header = new Uint8Array(await file.slice(0, 100).arrayBuffer());
  if (header.length < 100 || SQLITE_MAGIC.split('').some((character, index) => header[index] !== character.charCodeAt(0))) {
    fail('所选文件不是 SQLite 数据库，请选择 media.db，不能选择压缩包或下载链接文件。');
  }
  const encodedSize = (header[16] << 8) | header[17];
  const pageSize = encodedSize === 1 ? 65536 : encodedSize;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || file.size % pageSize !== 0) {
    fail('数据库文件大小或页头不完整，请等待网盘下载完成后重新导入。');
  }
  if (navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)
        && estimate.quota - estimate.usage < file.size + 16 * CHUNK_SIZE) {
      fail('浏览器存储空间不足。安全更新需要同时保留旧库和新库，请释放空间；也可先清除网页副本再导入。');
    }
  }
}

async function importLibrary(payload) {
  const file = payload?.file;
  await validateFile(file);
  const previousManifest = manifest;
  const previousLibrary = library;
  const path = `${LIBRARY_PREFIX}${Date.now()}-${crypto.randomUUID()}.db`;
  let candidate;
  let currentClosed = false;
  let committed = false;
  let loaded = 0;
  let reportedAt = 0;
  progress('import', 0, file.size);
  try {
    await pool.reserveMinimumCapacity(6);
    const written = await pool.importDb(path, async () => {
      if (loaded >= file.size) return undefined;
      const bytes = new Uint8Array(await file.slice(loaded, Math.min(loaded + CHUNK_SIZE, file.size)).arrayBuffer());
      if (!bytes.length) fail('读取导入文件失败，请重新下载数据库。');
      loaded += bytes.length;
      const now = performance.now();
      if (now - reportedAt >= 100 || loaded === file.size) {
        progress('import', loaded, file.size);
        reportedAt = now;
      }
      return bytes;
    });
    if (written !== file.size) fail('数据库导入不完整，请重新导入。');
    progress('validate', loaded, file.size);
    closeDatabase();
    currentClosed = true;
    candidate = openReadOnly(path);
    const check = value(candidate.db, 'PRAGMA quick_check(1)');
    if (check !== 'ok') fail('数据库完整性检查失败，请重新下载或从 Windows 导出数据库。');
    const nextManifest = {
      path,
      name: file.name || 'media.db',
      size: file.size,
      importedAt: new Date().toISOString(),
    };
    const nextLibrary = summarize(candidate.db, candidate.schema, nextManifest);
    await manifestWrite(nextManifest);
    committed = true;
    database = candidate.db;
    columns = candidate.schema;
    manifest = nextManifest;
    library = nextLibrary;
    candidate = null;
    cleanupFiles(path);
    progress('ready', file.size, file.size);
    return library;
  } catch (error) {
    if (candidate) candidate.db.close();
    if (!committed) {
      try { pool.unlink(path); } catch (_) { /* A failed import can remove its own candidate. */ }
      if (currentClosed && previousManifest) {
        const previous = openReadOnly(previousManifest.path);
        database = previous.db;
        columns = previous.schema;
      }
      manifest = previousManifest;
      library = previousLibrary;
    }
    if (error?.name === 'QuotaExceededError' || /quota|no space|disk full/i.test(error?.message || '')) {
      fail('导入时浏览器存储空间不足，原有网页副本已保留。请释放空间后重试。');
    }
    throw error;
  }
}

function requireLibrary() {
  if (!database) fail('请先导入 media.db 数据库。');
}

function queryLibrary(payload = {}) {
  requireLibrary();
  const rootId = optionalInteger(payload.rootId, '图库编号', 1);
  const category = optionalInteger(payload.category, '分类编号');
  const folder = normalizeFolder(payload.folder);
  const search = text(payload.search ?? '', '搜索内容', 2048).trim();
  const offset = integer(payload.offset ?? 0, '分页位置');
  const limit = integer(payload.limit ?? 60, '每页数量', 1, 120);
  const mediaType = payload.mediaType ?? 'all';
  const sort = payload.sort ?? 'newest';
  if (!['all', 'image', 'video'].includes(mediaType) || !['newest', 'name'].includes(sort)) {
    fail('筛选或排序方式无效。');
  }
  const conditions = [];
  const bind = [];
  if (rootId !== null) {
    conditions.push(`${rootExpression()} = ?`);
    bind.push(rootId);
  }
  if (category !== null) {
    conditions.push(`${columns.has('category') ? 'COALESCE(category, 0)' : '0'} = ?`);
    bind.push(category);
  }
  if (folder !== null && folder !== '.') {
    conditions.push(`(${folderExpression()} = ? OR ${folderExpression()} LIKE ? ESCAPE '\\')`);
    bind.push(folder, `${likeEscape(folder)}/%`);
  }
  if (mediaType !== 'all') {
    conditions.push('file_type = ?');
    bind.push(mediaType);
  }
  // Each whitespace-separated term must match some displayed text field.
  const searchable = ['file_name', 'dir_path', 'prompt', 'negative_prompt', 'model', 'loras', 'params']
    .filter(name => columns.has(name));
  for (const term of search.split(/\s+/).filter(Boolean).slice(0, 32)) {
    conditions.push(`(${searchable.map(name => `"${name}" LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < searchable.length; ++i) bind.push(`%${likeEscape(term)}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(value(database, `SELECT COUNT(*) FROM media ${where}`, bind));
  const order = sort === 'name'
    ? 'file_name COLLATE NATURAL_NAME ASC, id ASC'
    : `${columns.has('mtime') ? 'mtime DESC, ' : ''}id DESC`;
  const items = rows(database, `SELECT ${projection(LIST_COLUMNS)}, ${rootExpression()} AS root_id,
    CASE WHEN length(thumb) > 0 THEN 1 ELSE 0 END AS has_thumb,
    ${columns.has('video_preview') ? 'CASE WHEN length(video_preview) > 0 THEN 1 ELSE 0 END' : '0'} AS has_video
    FROM media ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...bind, limit, offset]).map(decorate);
  return {items, total, hasMore: offset + items.length < total};
}

function detail(payload = {}) {
  requireLibrary();
  const id = integer(payload.id, '媒体编号', 1);
  const row = rows(database, `SELECT ${projection(DETAIL_COLUMNS)}, ${rootExpression()} AS root_id,
    CASE WHEN length(thumb) > 0 THEN 1 ELSE 0 END AS has_thumb,
    ${columns.has('video_preview') ? 'CASE WHEN length(video_preview) > 0 THEN 1 ELSE 0 END' : '0'} AS has_video
    FROM media WHERE id = ? LIMIT 1`, [id])[0];
  if (!row) fail('未找到这条记录，请刷新列表。');
  return decorate(row);
}

function blobMime(bytes, kind) {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 8 && bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF') return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'video/mp4';
  return kind === 'video' ? 'video/mp4' : 'application/octet-stream';
}

function readBlob(payload = {}) {
  requireLibrary();
  const id = integer(payload.id, '媒体编号', 1);
  const kind = payload.kind;
  if (kind !== 'thumb' && kind !== 'video') fail('媒体类型无效。');
  const column = kind === 'video' ? 'video_preview' : 'thumb';
  if (!columns.has(column)) return {buffer: null, mime: ''};
  const length = Number(value(database, `SELECT length("${column}") FROM media WHERE id = ?`, [id]) || 0);
  if (!length) return {buffer: null, mime: ''};
  if (length > MAX_BLOB_SIZE) fail('这条预览超过 128 MiB，暂不在浏览器中加载。');
  const bytes = value(database, `SELECT "${column}" FROM media WHERE id = ?`, [id]);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) fail('读取媒体预览失败。');
  const mime = blobMime(bytes, kind);
  // oo1 normally returns an owned copy. Never transfer SQLite's WASM heap.
  const owned = bytes.buffer !== sqlite3.wasm.heap8u().buffer
    && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  return {buffer: owned.buffer, mime};
}

async function forgetLibrary() {
  // Commit deletion before unlinking. A failed IDB write preserves the old
  // usable library, and a later startup safely cleans an orphan after a crash.
  await manifestWrite(null);
  closeDatabase();
  manifest = null;
  library = null;
  cleanupFiles(null);
  // A damaged current copy can make initialize() reject after pool setup.
  initPromise = Promise.resolve({library: null, capabilities: {persistent: true}});
  return {library: null};
}

async function dispatch(type, payload) {
  if (type === 'forget' && pool && manifestDb) return forgetLibrary();
  await ensureInitialized();
  switch (type) {
    case 'init': return {library, capabilities: {persistent: true}};
    case 'import': return importLibrary(payload);
    case 'summary': return library;
    case 'query': return queryLibrary(payload);
    case 'detail': return detail(payload);
    case 'blob': return readBlob(payload);
    case 'forget': return forgetLibrary();
    default: fail('未知的查看器请求。');
  }
}

self.addEventListener('message', event => {
  const message = event.data;
  const id = message?.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || (typeof id === 'string' && id.length > 128)) return;
  // Serialize all operations, including asynchronous imports, so a query
  // cannot observe a half-imported file or race the manifest commit.
  requestQueue = requestQueue.then(async () => {
    try {
      const data = await dispatch(message.type, message.payload);
      const transfer = data?.buffer instanceof ArrayBuffer ? [data.buffer] : [];
      self.postMessage({id, ok: true, data}, transfer);
    } catch (error) {
      console.warn('Library worker request failed:', error);
      self.postMessage({id, ok: false, error: error?.message || '数据库操作失败，请刷新后重试。'});
    }
  });
});
