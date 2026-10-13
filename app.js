const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 60;
const THUMB_CACHE_LIMIT = 80;
const THUMB_CONCURRENCY = 2;
const numberFormat = new Intl.NumberFormat('zh-CN');

const state = {
  summary: null,
  ready: false,
  importing: false,
  rootId: null,
  folder: null,
  category: null,
  search: '',
  mediaType: 'all',
  sort: 'newest',
  items: [],
  total: 0,
  hasMore: false,
  loading: false,
  queryGeneration: 0,
  libraryGeneration: 0,
  detailGeneration: 0,
  detailUrls: new Set(),
  offlineReady: false,
  persistent: false,
};

let worker;
let requestId = 0;
const pendingRequests = new Map();
const thumbUrls = new Map();
const cards = new Map();
const visibleCards = new Set();
let thumbQueue = [];
let activeThumbs = 0;
let searchTimer;
let toastTimer;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function formatDuration(seconds) {
  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration < 0) return '';
  const whole = Math.floor(duration);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function basename(path) {
  const parts = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || String(path || '未命名来源');
}

function categoryName(value) {
  return Number(value) > 0 ? `类别 ${value}` : '未分类';
}

// A seed may exceed JavaScript's safe integer range. Only replace JSON number
// tokens, never digits inside quoted strings, before parsing the parameters.
function parseJsonPreservingIntegers(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    const safe = value.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, number) => {
      if (number && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number))) return JSON.stringify(number);
      return match;
    });
    return JSON.parse(safe);
  } catch {
    return fallback;
  }
}

function valueText(value) {
  if (value === null || value === undefined) return '—';
  if (value === true) return '是';
  if (value === false) return '否';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function errorText(error) {
  return error && error.message ? error.message : String(error || '发生未知错误');
}

function setImportEnabled(enabled) {
  $('import-button').disabled = !enabled;
  $('welcome-import').disabled = !enabled;
}

function request(type, payload = {}, timeout = 0) {
  if (!worker) return Promise.reject(new Error('本地数据库引擎尚未准备好，请刷新页面后重试。'));
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    if (timeout) {
      entry.timer = window.setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('本地查看器初始化超时。请检查网络、刷新页面，或使用最新版 Safari 重新打开。'));
      }, timeout);
    }
    pendingRequests.set(id, entry);
    try {
      worker.postMessage({ id, type, payload });
    } catch (error) {
      pendingRequests.delete(id);
      window.clearTimeout(entry.timer);
      reject(error);
    }
  });
}

function handleWorkerFailure(error) {
  const message = errorText(error);
  for (const entry of pendingRequests.values()) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pendingRequests.clear();
  state.ready = false;
  setImportEnabled(false);
  if (state.summary) {
    $('grid-error').textContent = `本地查看器停止运行：${message}。请刷新页面后重新打开。`;
    $('grid-error').hidden = false;
  } else {
    $('startup-status').hidden = true;
    $('welcome-error').textContent = message;
    $('welcome-error').hidden = false;
  }
}

function updateProgress(data) {
  if (!state.importing) return;
  const loaded = Number(data.loaded) || 0;
  const total = Number(data.total) || 0;
  const phase = String(data.phase || '');
  if (phase === 'validate') {
    $('import-progress').removeAttribute('value');
    $('import-progress-label').textContent = '复制完成，正在校验数据库并读取媒体信息…大库需要一些时间，请保持页面前台。';
    return;
  }
  if (total > 0) {
    const percentage = Math.min(100, Math.max(0, loaded / total * 100));
    $('import-progress').value = percentage;
    $('import-progress-label').textContent = `${Math.floor(percentage)}% · ${formatBytes(loaded)} / ${formatBytes(total)}`;
  } else {
    $('import-progress').removeAttribute('value');
    $('import-progress-label').textContent = /valid|check|open|index|summary/i.test(phase) ? '正在校验数据库并读取媒体信息…' : '正在准备本地副本…';
  }
}

async function initialize() {
  setupEvents();
  setupOffline();
  if (!window.isSecureContext) {
    handleWorkerFailure(new Error('请通过 HTTPS 网址打开查看器。直接打开 HTML 文件或通过普通 HTTP 访问，无法使用本地数据库存储。'));
    return;
  }
  if (!('Worker' in window) || !navigator.storage || !navigator.storage.getDirectory) {
    handleWorkerFailure(new Error('此浏览器不支持本地数据库存储。请使用 iPadOS 17 或更新版本的 Safari，并退出隐私浏览模式。'));
    return;
  }
  try {
    worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        updateProgress(data.data || {});
        return;
      }
      const entry = pendingRequests.get(data.id);
      if (!entry) return;
      pendingRequests.delete(data.id);
      window.clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.data);
      else entry.reject(new Error(typeof data.error === 'string' ? data.error : errorText(data.error)));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      handleWorkerFailure(new Error(event.message || '数据库程序未能加载。请确认网页文件完整，并刷新页面重试。'));
    };
    worker.onmessageerror = () => handleWorkerFailure(new Error('数据库通信失败，请刷新页面后重试。'));
    const result = await request('init', {}, 90000);
    state.ready = true;
    try { state.persistent = Boolean(navigator.storage.persisted && await navigator.storage.persisted()); } catch { state.persistent = false; }
    setImportEnabled(true);
    $('startup-status').hidden = true;
    updateStorageStatus();
    if (result.library) await showLibrary(result.library);
  } catch (error) {
    handleWorkerFailure(error);
  }
}

function updateStorageStatus() {
  $('storage-status').textContent = state.persistent
    ? '本浏览器已允许持久存储。仍建议保留原始数据库文件作为备份。'
    : '本地副本由浏览器管理。空间不足或清理网站数据时，可能需要重新导入；请保留原始数据库。';
}

function updateOfflineBadge() {
  const badge = $('offline-status');
  badge.classList.toggle('is-ready', state.offlineReady);
  if (state.offlineReady) badge.textContent = '可离线使用';
  else if (!navigator.onLine) badge.textContent = '当前离线';
  else badge.textContent = '离线缓存准备中';
}

async function setupOffline() {
  updateOfflineBadge();
  window.addEventListener('online', updateOfflineBadge);
  window.addEventListener('offline', updateOfflineBadge);
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offline-status').textContent = '需联网打开';
    return;
  }
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data && data.type === 'OFFLINE_READY') {
      state.offlineReady = true;
      updateOfflineBadge();
    }
  });
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
    const ping = () => {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'CHECK_OFFLINE' });
      else if (registration.active) registration.active.postMessage({ type: 'CHECK_OFFLINE' });
    };
    navigator.serviceWorker.addEventListener('controllerchange', ping);
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (installing) installing.addEventListener('statechange', () => { if (installing.state === 'activated') ping(); });
    });
    await navigator.serviceWorker.ready;
    ping();
  } catch {
    $('offline-status').textContent = '离线缓存未完成';
  }
}

function setupEvents() {
  for (const id of ['import-button', 'welcome-import']) $(id).addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importLibrary(file);
  });
  for (const id of ['help-button', 'welcome-help']) $(id).addEventListener('click', () => $('help-dialog').showModal());
  $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('help-dialog').addEventListener('click', (event) => { if (event.target === $('help-dialog')) $('help-dialog').close(); });
  $('import-dialog').addEventListener('cancel', (event) => event.preventDefault());
  $('root-select').addEventListener('change', () => {
    state.rootId = $('root-select').value === '' ? null : Number($('root-select').value);
    state.folder = null;
    renderFolders();
    updateTitle();
    loadPage(true);
  });
  $('reset-folder').addEventListener('click', () => { state.folder = null; renderFolders(); updateTitle(); loadPage(true); });
  $('search-input').addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    $('clear-search').hidden = !$('search-input').value;
    $('search-hint').hidden = !$('search-input').value;
    searchTimer = window.setTimeout(() => { state.search = $('search-input').value.trim(); loadPage(true); }, 280);
  });
  $('search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      window.clearTimeout(searchTimer);
      state.search = $('search-input').value.trim();
      $('search-input').blur();
      loadPage(true);
    }
  });
  $('clear-search').addEventListener('click', () => {
    window.clearTimeout(searchTimer);
    $('search-input').value = '';
    state.search = '';
    $('clear-search').hidden = true;
    $('search-hint').hidden = true;
    loadPage(true);
  });
  $('type-filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-type]');
    if (!button || button.dataset.type === state.mediaType) return;
    state.mediaType = button.dataset.type;
    renderTypeFilters();
    loadPage(true);
  });
  $('sort-select').addEventListener('change', () => { state.sort = $('sort-select').value; loadPage(true); });
  $('load-more').addEventListener('click', () => loadPage(false));
  $('clear-filters').addEventListener('click', resetFilters);
  $('filter-toggle').addEventListener('click', () => toggleSidebar(true));
  $('close-sidebar').addEventListener('click', () => toggleSidebar(false));
  $('sidebar-shade').addEventListener('click', () => toggleSidebar(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') toggleSidebar(false); });
  $('forget-button').addEventListener('click', forgetLibrary);
  $('close-detail').addEventListener('click', closeDetail);
  $('detail-dialog').addEventListener('close', () => { if (!$('detail-dialog').open) releaseDetail(); });
  $('detail-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDetail(); });
  $('detail-dialog').addEventListener('click', (event) => { if (event.target === $('detail-dialog')) closeDetail(); });
  window.addEventListener('pagehide', () => {
    releaseDetail();
    clearThumbCache();
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted && state.summary) loadPage(true); });
  setupZoom();
}

async function importLibrary(file) {
  if (!state.ready || state.importing) return;
  if (!file.size) { showToast('这个文件是空的，请重新选择数据库。'); return; }
  if (state.summary && !window.confirm('导入成功后会替换当前网页副本。原数据库文件不会被修改，是否继续？')) return;
  closeDetail();
  state.importing = true;
  state.queryGeneration += 1;
  state.libraryGeneration += 1;
  thumbQueue = [];
  setImportEnabled(false);
  $('welcome-error').hidden = true;
  $('import-name').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $('import-progress').removeAttribute('value');
  $('import-progress-label').textContent = '正在准备本地副本…';
  $('import-dialog').showModal();
  try {
    if (navigator.storage.persist) {
      try { state.persistent = await navigator.storage.persist(); } catch { /* Browser storage policy is informational. */ }
    }
    const summary = await request('import', { file });
    state.importing = false;
    await showLibrary(summary);
    updateStorageStatus();
    showToast('导入完成，媒体库已保存在本机。');
  } catch (error) {
    const message = `导入失败：${errorText(error)}`;
    if (state.summary) {
      state.importing = false;
      await loadPage(true);
      $('grid-error').textContent = message;
      $('grid-error').hidden = false;
    } else {
      $('welcome-error').textContent = message;
      $('welcome-error').hidden = false;
    }
  } finally {
    state.importing = false;
    $('import-dialog').close();
    setImportEnabled(state.ready);
    for (const card of visibleCards) enqueueThumb(card);
  }
}

async function showLibrary(summary) {
  clearThumbCache();
  state.summary = summary;
  state.libraryGeneration += 1;
  state.rootId = null;
  state.folder = null;
  state.category = null;
  state.search = '';
  state.mediaType = 'all';
  state.sort = 'newest';
  $('welcome').hidden = true;
  $('library').hidden = false;
  $('library-count').textContent = numberFormat.format(summary.count || 0);
  $('library-breakdown').textContent = `${numberFormat.format(summary.imageCount || 0)} 张图片 · ${numberFormat.format(summary.videoCount || 0)} 个视频`;
  const date = summary.importedAt ? new Date(summary.importedAt) : null;
  const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('zh-CN') : '';
  $('database-info').textContent = `${summary.name || 'media.db'} · ${formatBytes(summary.size)}${dateText ? `\n导入于 ${dateText}` : ''}`;
  $('search-input').value = '';
  $('clear-search').hidden = true;
  $('search-hint').hidden = true;
  $('sort-select').value = 'newest';
  renderRoots();
  renderFolders();
  renderCategories();
  renderTypeFilters();
  updateTitle();
  await loadPage(true);
}

function renderRoots() {
  const select = $('root-select');
  select.replaceChildren(element('option', '', '全部来源'));
  select.firstChild.value = '';
  for (const root of state.summary.roots || []) {
    const option = element('option', '', `${basename(root.path)} (${numberFormat.format(root.count || 0)})`);
    option.value = String(root.id);
    option.title = root.path || '';
    select.append(option);
  }
  select.value = state.rootId === null ? '' : String(state.rootId);
}

function renderFolders() {
  const tree = $('folder-tree');
  tree.replaceChildren();
  const roots = state.summary.roots || [];
  for (const root of roots) {
    if (state.rootId !== null && Number(root.id) !== state.rootId) continue;
    const group = element('details', 'folder-root');
    group.open = true;
    const heading = element('summary', '', basename(root.path));
    heading.title = root.path || '';
    group.append(heading);
    const topNode = { name: '全部文件夹', path: null, children: new Map(), count: root.count || 0 };
    const rootFolders = (state.summary.folders || []).filter((folder) => Number(folder.rootId) === Number(root.id));
    for (const folder of rootFolders) {
      const normalized = String(folder.path || '.').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!normalized || normalized === '.') continue;
      const parts = normalized.split('/').filter(Boolean);
      let node = topNode;
      const current = [];
      for (const part of parts) {
        current.push(part);
        if (!node.children.has(part)) node.children.set(part, { name: part, path: current.join('/'), children: new Map(), count: 0 });
        node = node.children.get(part);
        node.count += Number(folder.count) || 0;
      }
      node.path = folder.path;
    }
    const appendNode = (node, parent) => {
      const button = element('button', 'folder-button');
      button.type = 'button';
      button.dataset.folder = node.path === null ? '' : node.path;
      button.dataset.rootId = root.id;
      const selected = state.rootId === Number(root.id) && state.folder === node.path;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.title = node.path === null ? root.path || node.name : node.path;
      button.append(element('span', 'folder-icon', node.path === null ? '▱' : '▱'), element('span', 'folder-name', node.name), element('span', 'folder-count', numberFormat.format(node.count)));
      button.addEventListener('click', () => {
        state.rootId = Number(root.id);
        state.folder = node.path;
        $('root-select').value = String(root.id);
        renderFolders();
        updateTitle();
        loadPage(true);
        toggleSidebar(false);
      });
      parent.append(button);
      if (node.children.size) {
        const children = element('div', 'folder-children');
        const sorted = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
        for (const child of sorted) appendNode(child, children);
        parent.append(children);
      }
    };
    appendNode(topNode, group);
    tree.append(group);
  }
  if (!roots.length) tree.append(element('p', 'help-footnote', '没有来源目录信息'));
}

function renderCategories() {
  const container = $('category-filters');
  container.replaceChildren();
  const categories = [{ id: null, label: '全部', count: state.summary.count }, ...(state.summary.categories || []).map((category) => ({ ...category, label: categoryName(category.id) }))];
  for (const category of categories) {
    const button = element('button', 'category-button', category.label);
    const active = state.category === category.id;
    button.dataset.category = category.id === null ? '' : category.id;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.title = `${numberFormat.format(category.count || 0)} 项`;
    button.addEventListener('click', () => {
      state.category = category.id;
      renderCategories();
      loadPage(true);
      toggleSidebar(false);
    });
    container.append(button);
  }
}

function renderTypeFilters() {
  for (const button of $('type-filters').querySelectorAll('button')) {
    const active = button.dataset.type === state.mediaType;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function updateTitle() {
  const root = (state.summary.roots || []).find((item) => Number(item.id) === state.rootId);
  $('collection-title').textContent = state.folder === '.' ? '根目录' : state.folder ? basename(state.folder) : root ? basename(root.path) : '全部创作';
}

function resetFilters() {
  window.clearTimeout(searchTimer);
  state.rootId = null;
  state.folder = null;
  state.category = null;
  state.search = '';
  state.mediaType = 'all';
  $('root-select').value = '';
  $('search-input').value = '';
  $('clear-search').hidden = true;
  $('search-hint').hidden = true;
  renderFolders();
  renderCategories();
  renderTypeFilters();
  updateTitle();
  loadPage(true);
}

function toggleSidebar(open) {
  $('sidebar').classList.toggle('is-open', open);
  $('sidebar-shade').hidden = !open;
  $('filter-toggle').setAttribute('aria-expanded', String(open));
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const card = entry.target;
    if (entry.isIntersecting) {
      visibleCards.add(card);
      enqueueThumb(card);
    } else {
      visibleCards.delete(card);
    }
  }
}, { rootMargin: '180px 0px', threshold: 0.01 });

async function loadPage(reset) {
  if (!state.summary || !state.ready) return;
  if (!reset && (state.loading || !state.hasMore)) return;
  const generation = reset ? ++state.queryGeneration : state.queryGeneration;
  if (reset) {
    closeDetail();
    observer.disconnect();
    visibleCards.clear();
    cards.clear();
    thumbQueue = [];
    state.items = [];
    state.hasMore = false;
    $('media-grid').replaceChildren();
    $('empty-state').hidden = true;
    document.querySelector('.library-content').scrollTop = 0;
  }
  state.loading = true;
  $('grid-error').hidden = true;
  $('loading-results').hidden = false;
  $('load-more').hidden = true;
  $('grid-end').hidden = true;
  $('result-count').textContent = reset ? '正在读取…' : `${numberFormat.format(state.total)} 项`;
  try {
    const result = await request('query', {
      rootId: state.rootId,
      folder: state.folder,
      category: state.category,
      search: state.search,
      mediaType: state.mediaType,
      sort: state.sort,
      offset: state.items.length,
      limit: PAGE_SIZE,
    });
    if (generation !== state.queryGeneration) return;
    state.total = result.total;
    state.hasMore = Boolean(result.hasMore);
    const fragment = document.createDocumentFragment();
    for (const item of result.items) {
      state.items.push(item);
      const card = createCard(item, generation);
      cards.set(String(item.id), card);
      fragment.append(card);
    }
    $('media-grid').append(fragment);
    for (const item of result.items) observer.observe(cards.get(String(item.id)));
    $('result-count').textContent = `${numberFormat.format(result.total)} 项${state.items.length < result.total ? ` · 已加载 ${numberFormat.format(state.items.length)}` : ''}`;
    $('empty-state').hidden = result.total !== 0;
    if (!state.summary.count) {
      $('empty-state').querySelector('h2').textContent = '这个媒体库还没有创作';
      $('empty-state').querySelector('p').textContent = '在 Windows 中完成扫描后，再导入更新的数据库。';
      $('clear-filters').hidden = true;
    } else {
      $('empty-state').querySelector('h2').textContent = '没有找到匹配的创作';
      $('empty-state').querySelector('p').textContent = '试试其他关键词，或清除筛选条件。';
      $('clear-filters').hidden = false;
    }
  } catch (error) {
    if (generation !== state.queryGeneration) return;
    $('grid-error').textContent = `读取失败：${errorText(error)}`;
    $('grid-error').hidden = false;
    $('result-count').textContent = '读取失败';
  } finally {
    if (generation === state.queryGeneration) {
      state.loading = false;
      $('loading-results').hidden = true;
      $('load-more').hidden = !state.hasMore;
      $('grid-end').hidden = state.hasMore || state.total === 0 || !$('grid-error').hidden;
    }
  }
}

function createCard(item, generation) {
  const card = element('button', 'media-card');
  card.type = 'button';
  card.dataset.id = String(item.id);
  card.dataset.generation = String(generation);
  card.dataset.thumbState = 'idle';
  card.setAttribute('aria-label', `查看${item.file_type === 'video' ? '视频' : '图片'}：${item.file_name || ''}`);
  const imageWrap = element('span', 'card-image-wrap');
  const placeholder = element('span', 'card-placeholder', item.file_type === 'video' ? '▷' : '▧');
  placeholder.setAttribute('aria-hidden', 'true');
  const image = element('img', 'card-image');
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  image.addEventListener('load', () => { image.classList.add('is-loaded'); placeholder.hidden = true; });
  image.addEventListener('error', () => { image.classList.remove('is-loaded'); placeholder.hidden = false; });
  imageWrap.append(placeholder, image);
  if (item.file_type === 'video') imageWrap.append(element('span', 'video-tag', `▶ ${formatDuration(item.duration) || '视频'}`));
  card.append(imageWrap, element('span', 'card-name', item.file_name || '未命名文件'));
  const metadata = [item.width && item.height ? `${item.width} × ${item.height}` : '', item.model || ''].filter(Boolean).join(' · ');
  card.append(element('span', 'card-meta', metadata || (item.file_type === 'video' ? '视频预览' : '图片预览')));
  card.addEventListener('click', () => openDetail(item));
  return card;
}

function enqueueThumb(card) {
  const id = card.dataset.id;
  if (thumbUrls.has(id)) {
    const url = thumbUrls.get(id);
    thumbUrls.delete(id);
    thumbUrls.set(id, url);
    const image = card.querySelector('img');
    if (image.getAttribute('src') !== url) image.src = url;
    card.dataset.thumbState = 'loaded';
    return;
  }
  if (card.dataset.thumbState === 'empty' || card.dataset.thumbState === 'queued' || card.dataset.thumbState === 'loading') return;
  card.dataset.thumbState = 'queued';
  thumbQueue.push({ card, generation: state.queryGeneration, libraryGeneration: state.libraryGeneration });
  runThumbQueue();
}

function runThumbQueue() {
  while (activeThumbs < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    const { card, generation, libraryGeneration } = job;
    if (generation !== state.queryGeneration || libraryGeneration !== state.libraryGeneration || !card.isConnected || !visibleCards.has(card) || state.importing) {
      card.dataset.thumbState = 'idle';
      continue;
    }
    activeThumbs += 1;
    card.dataset.thumbState = 'loading';
    request('blob', { id: Number(card.dataset.id), kind: 'thumb' }).then((result) => {
      if (generation !== state.queryGeneration || libraryGeneration !== state.libraryGeneration || !card.isConnected) return;
      if (!result.buffer || !result.buffer.byteLength) { card.dataset.thumbState = 'empty'; return; }
      const url = URL.createObjectURL(new Blob([result.buffer], { type: result.mime || 'image/webp' }));
      thumbUrls.set(card.dataset.id, url);
      card.querySelector('img').src = url;
      card.dataset.thumbState = 'loaded';
      trimThumbCache();
    }).catch(() => {
      if (card.isConnected && generation === state.queryGeneration) card.dataset.thumbState = 'empty';
    }).finally(() => {
      activeThumbs -= 1;
      runThumbQueue();
    });
  }
}

function trimThumbCache() {
  while (thumbUrls.size > THUMB_CACHE_LIMIT) {
    let oldest;
    for (const [id] of thumbUrls) {
      const card = cards.get(id);
      if (!card || !visibleCards.has(card)) { oldest = id; break; }
    }
    if (oldest === undefined) oldest = thumbUrls.keys().next().value;
    URL.revokeObjectURL(thumbUrls.get(oldest));
    thumbUrls.delete(oldest);
    const card = cards.get(oldest);
    if (card && !visibleCards.has(card)) {
      const image = card.querySelector('img');
      image.removeAttribute('src');
      image.classList.remove('is-loaded');
      card.querySelector('.card-placeholder').hidden = false;
      card.dataset.thumbState = 'idle';
    }
  }
}

function clearThumbCache() {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  thumbQueue = [];
}

async function forgetLibrary() {
  if (!state.ready || state.importing) return;
  if (!window.confirm('清除这台设备上网页保存的数据库副本？原始 media.db 文件不会被删除。')) return;
  closeDetail();
  setImportEnabled(false);
  $('forget-button').disabled = true;
  state.queryGeneration += 1;
  state.libraryGeneration += 1;
  observer.disconnect();
  thumbQueue = [];
  try {
    await request('forget');
    clearThumbCache();
    cards.clear();
    visibleCards.clear();
    state.summary = null;
    state.items = [];
    $('media-grid').replaceChildren();
    $('library').hidden = true;
    $('welcome').hidden = false;
    $('welcome-error').hidden = true;
    toggleSidebar(false);
    showToast('网页副本已清除，原数据库文件不受影响。');
  } catch (error) {
    await loadPage(true);
    showToast(`清除失败：${errorText(error)}`);
  } finally {
    setImportEnabled(state.ready);
    $('forget-button').disabled = false;
  }
}

function releaseDetail() {
  state.detailGeneration += 1;
  const video = $('preview-container').querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  $('preview-container').replaceChildren();
  $('preview-container').classList.remove('is-image', 'is-zoomed');
  for (const url of state.detailUrls) URL.revokeObjectURL(url);
  state.detailUrls.clear();
  $('preview-status').textContent = '';
  $('preview-hint').textContent = '';
  $('zoom-controls').hidden = true;
  resetZoom();
}

function closeDetail() {
  releaseDetail();
  if ($('detail-dialog').open) $('detail-dialog').close();
}

async function openDetail(item) {
  releaseDetail();
  const generation = state.detailGeneration;
  $('detail-title').textContent = item.file_name || '媒体详情';
  $('detail-info').replaceChildren(element('p', 'detail-text is-muted', '正在读取生成参数…'));
  $('preview-status').textContent = '正在读取预览…';
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
  const isCurrent = () => generation === state.detailGeneration && $('detail-dialog').open;
  request('detail', { id: item.id }).then((detail) => {
    if (isCurrent()) renderDetailInfo(detail, item);
  }).catch((error) => {
    if (isCurrent()) $('detail-info').replaceChildren(element('p', 'detail-warning', `参数读取失败：${errorText(error)}`));
  });
  try {
    if (item.file_type === 'video') {
      const result = await request('blob', { id: item.id, kind: 'video' });
      if (!isCurrent()) return;
      if (result.buffer && result.buffer.byteLength) {
        const video = element('video', 'preview-video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        // Audio is deliberately neither muted nor autoplayed. Playback starts
        // with the user's native play control, as required by iPad Safari.
        video.setAttribute('playsinline', '');
        const url = URL.createObjectURL(new Blob([result.buffer], { type: result.mime || 'video/mp4' }));
        state.detailUrls.add(url);
        video.src = url;
        video.addEventListener('loadedmetadata', () => { if (isCurrent()) $('preview-status').textContent = ''; });
        video.addEventListener('error', () => {
          if (!isCurrent()) return;
          video.pause();
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(url);
          state.detailUrls.delete(url);
          showThumbPreview(item, generation, true);
        }, { once: true });
        $('preview-container').append(video);
        $('preview-status').textContent = '';
        return;
      }
      await showThumbPreview(item, generation, true);
    } else {
      await showThumbPreview(item, generation, false);
    }
  } catch (error) {
    if (isCurrent()) $('preview-status').textContent = `预览读取失败：${errorText(error)}`;
  }
}

async function showThumbPreview(item, generation, videoFallback) {
  try {
    const result = await request('blob', { id: item.id, kind: 'thumb' });
    if (generation !== state.detailGeneration || !$('detail-dialog').open) return;
    $('preview-container').replaceChildren();
    if (!result.buffer || !result.buffer.byteLength) {
      $('preview-status').textContent = '数据库中没有保存此文件的预览。';
      return;
    }
    const image = element('img', 'preview-image');
    image.alt = item.file_name || '媒体预览';
    image.draggable = false;
    const url = URL.createObjectURL(new Blob([result.buffer], { type: result.mime || 'image/webp' }));
    state.detailUrls.add(url);
    image.src = url;
    image.addEventListener('load', () => { if (generation === state.detailGeneration) $('preview-status').textContent = ''; });
    image.addEventListener('error', () => { if (generation === state.detailGeneration) $('preview-status').textContent = '此预览无法解码。请在 Windows 中更新预览后重新导入数据库。'; });
    $('preview-container').append(image);
    $('preview-container').classList.add('is-image');
    applyZoom();
    $('zoom-controls').hidden = false;
    $('preview-hint').textContent = videoFallback ? '当前为动画缩略预览，无音频与播放控制' : '双指缩放 · 双击放大 · 显示数据库中的缩略图';
    if (videoFallback) {
      const notice = element('p', 'detail-warning', '数据库未包含可播放的 MP4 预览，或当前浏览器无法解码。这里显示动画缩略预览；可在 Windows 中更新视频预览，再重新导入数据库。');
      notice.id = 'video-fallback-notice';
      if (!$('video-fallback-notice')) $('detail-info').append(notice);
    }
  } catch (error) {
    if (generation === state.detailGeneration) $('preview-status').textContent = `预览读取失败：${errorText(error)}`;
  }
}

const parameterLabels = {
  seed: 'Seed', steps: '采样步数', cfg: 'CFG', cfg_scale: 'CFG', sampler: '采样器', sampler_name: '采样器', scheduler: '调度器', denoise: '降噪强度', clip_skip: 'Clip skip', width: '宽度', height: '高度', batch_size: '批次大小', vae: 'VAE', model: '模型', checkpoint: '模型', face_detailer_steps: '面部修复 · 步数', face_detailer_cfg: '面部修复 · CFG', face_detailer_denoise: '面部修复 · 降噪', face_detailer_seed: '面部修复 · Seed',
};

function makeDetailSection(title, body, copyValue) {
  const section = element('section', 'detail-section');
  const heading = element('div', 'detail-section-heading');
  heading.append(element('h3', '', title));
  if (copyValue) {
    const copy = element('button', 'copy-button', '复制');
    copy.type = 'button';
    copy.setAttribute('aria-label', `复制${title}`);
    copy.addEventListener('click', () => copyText(copyValue, section));
    heading.append(copy);
  }
  section.append(heading, body);
  return section;
}

function renderDetailInfo(detail, item) {
  const content = $('detail-info');
  const previousNotice = $('video-fallback-notice');
  content.replaceChildren();
  const facts = element('div', 'detail-facts');
  const factValues = [item.file_type === 'video' ? '视频' : '图片', detail.width && detail.height ? `${detail.width} × ${detail.height}` : item.width && item.height ? `${item.width} × ${item.height}` : '', formatDuration(detail.duration || item.duration), categoryName(detail.category ?? item.category ?? 0)];
  for (const fact of factValues.filter(Boolean)) facts.append(element('span', 'fact-pill', fact));
  content.append(facts);
  const prompt = String(detail.prompt || '');
  const negative = String(detail.negative_prompt || '');
  content.append(makeDetailSection('正向提示词', element(prompt ? 'pre' : 'p', prompt ? 'prompt-text' : 'detail-text is-muted', prompt || '此记录没有提取到正向提示词'), prompt));
  if (negative) content.append(makeDetailSection('负向提示词', element('pre', 'prompt-text', negative), negative));
  if (detail.model || item.model) content.append(makeDetailSection('模型', element('p', 'detail-text', detail.model || item.model)));
  const loras = parseJsonPreservingIntegers(detail.loras, null);
  if (Array.isArray(loras) && loras.length) {
    const list = element('ul', 'lora-list');
    for (const lora of loras) {
      let text;
      if (typeof lora === 'string') text = lora;
      else if (lora && typeof lora === 'object') {
        const name = lora.name || lora.lora_name || lora.path || '';
        const remaining = Object.entries(lora).filter(([key]) => !['name', 'lora_name', 'path'].includes(key)).map(([key, value]) => `${key}: ${valueText(value)}`);
        text = [name, remaining.join(' · ')].filter(Boolean).join('\n');
      } else text = valueText(lora);
      list.append(element('li', '', text));
    }
    content.append(makeDetailSection('LoRA', list));
  } else if (detail.loras && detail.loras !== '[]') {
    content.append(makeDetailSection('LoRA', element('pre', 'prompt-text', String(detail.loras))));
  }
  const params = parseJsonPreservingIntegers(detail.params, null);
  if (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length) {
    const table = element('table', 'parameter-table');
    const body = element('tbody');
    for (const [key, value] of Object.entries(params)) {
      const row = element('tr');
      const label = element('th', '', parameterLabels[key] || key);
      label.scope = 'row';
      row.append(label, element('td', '', valueText(value)));
      body.append(row);
    }
    table.append(body);
    content.append(makeDetailSection('生成参数', table, typeof detail.params === 'string' ? detail.params : valueText(detail.params)));
  } else if (detail.params && detail.params !== '{}') {
    content.append(makeDetailSection('生成参数', element('pre', 'prompt-text', String(detail.params)), String(detail.params)));
  }
  const root = (state.summary.roots || []).find((source) => Number(source.id) === Number(item.root_id));
  const location = [root ? root.path : '', detail.rel_path || item.rel_path || item.file_name].filter(Boolean).join('\n');
  if (location) content.append(makeDetailSection('来源文件', element('p', 'detail-text is-muted', location)));
  if (previousNotice) content.append(previousNotice);
}

async function copyText(text, section) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(String(text));
      showToast('已复制');
      return;
    }
    throw new Error('Clipboard unavailable');
  } catch {
    const textarea = element('textarea', 'clipboard-fallback');
    textarea.value = String(text);
    textarea.readOnly = true;
    textarea.setAttribute('aria-label', '长按选择并复制文本');
    section.append(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Manual selection remains available. */ }
    if (copied) {
      textarea.remove();
      showToast('已复制');
    } else {
      textarea.scrollIntoView({ block: 'nearest' });
      showToast('请长按下方已选中的文本，选择“复制”。');
      textarea.addEventListener('blur', () => textarea.remove(), { once: true });
    }
  }
}

const zoom = { scale: 1, x: 0, y: 0, pointers: new Map(), gesture: null, lastTap: 0, lastTapX: 0, lastTapY: 0 };

function resetZoom() {
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  zoom.pointers.clear();
  zoom.gesture = null;
  zoom.lastTap = 0;
  applyZoom();
}

function applyZoom() {
  const container = $('preview-container');
  const image = container.querySelector('img');
  if (!image) return;
  const limitX = container.clientWidth * (zoom.scale - 1) / 2;
  const limitY = container.clientHeight * (zoom.scale - 1) / 2;
  zoom.x = Math.max(-limitX, Math.min(limitX, zoom.x));
  zoom.y = Math.max(-limitY, Math.min(limitY, zoom.y));
  image.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  container.classList.toggle('is-zoomed', zoom.scale > 1.01);
  $('zoom-reset').textContent = zoom.scale > 1.01 ? `${Math.round(zoom.scale * 100)}%` : '还原';
}

function zoomTo(scale) {
  zoom.scale = Math.max(1, Math.min(6, scale));
  if (zoom.scale === 1) { zoom.x = 0; zoom.y = 0; }
  applyZoom();
}

function beginGesture() {
  const points = Array.from(zoom.pointers.values());
  if (points.length >= 2) {
    const [a, b] = points;
    zoom.gesture = { type: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, centerX: (a.x + b.x) / 2, centerY: (a.y + b.y) / 2, scale: zoom.scale, x: zoom.x, y: zoom.y };
    zoom.lastTap = 0;
  } else if (points.length === 1) {
    zoom.gesture = { type: 'pan', startX: points[0].x, startY: points[0].y, x: zoom.x, y: zoom.y, moved: false };
  } else zoom.gesture = null;
}

function setupZoom() {
  const container = $('preview-container');
  container.addEventListener('pointerdown', (event) => {
    if (!container.classList.contains('is-image') || event.button > 0) return;
    container.setPointerCapture(event.pointerId);
    zoom.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture();
  });
  container.addEventListener('pointermove', (event) => {
    if (!zoom.pointers.has(event.pointerId)) return;
    zoom.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = zoom.gesture;
    if (!gesture) return;
    event.preventDefault();
    if (gesture.type === 'pinch') {
      const [a, b] = Array.from(zoom.pointers.values());
      if (!a || !b) return;
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      const rect = container.getBoundingClientRect();
      const originX = gesture.centerX - rect.left - rect.width / 2;
      const originY = gesture.centerY - rect.top - rect.height / 2;
      zoom.scale = Math.max(1, Math.min(6, gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
      const ratio = zoom.scale / gesture.scale;
      zoom.x = gesture.x + centerX - gesture.centerX + (originX - gesture.x) * (1 - ratio);
      zoom.y = gesture.y + centerY - gesture.centerY + (originY - gesture.y) * (1 - ratio);
      applyZoom();
    } else if (gesture.type === 'pan') {
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (Math.hypot(dx, dy) > 8) gesture.moved = true;
      if (zoom.scale > 1) { zoom.x = gesture.x + dx; zoom.y = gesture.y + dy; applyZoom(); }
    }
  });
  const endPointer = (event) => {
    if (!zoom.pointers.has(event.pointerId)) return;
    if (event.type === 'pointerup' && zoom.pointers.size === 1 && zoom.gesture?.type === 'pan' && !zoom.gesture.moved && event.pointerType !== 'mouse') {
      const now = performance.now();
      if (now - zoom.lastTap < 320 && Math.hypot(event.clientX - zoom.lastTapX, event.clientY - zoom.lastTapY) < 30) {
        zoomTo(zoom.scale > 1 ? 1 : 2.5);
        zoom.lastTap = 0;
      } else { zoom.lastTap = now; zoom.lastTapX = event.clientX; zoom.lastTapY = event.clientY; }
    }
    zoom.pointers.delete(event.pointerId);
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    beginGesture();
  };
  container.addEventListener('pointerup', endPointer);
  container.addEventListener('pointercancel', endPointer);
  container.addEventListener('dblclick', (event) => {
    if (container.classList.contains('is-image')) { event.preventDefault(); zoomTo(zoom.scale > 1 ? 1 : 2.5); }
  });
  container.addEventListener('wheel', (event) => {
    if (!container.classList.contains('is-image')) return;
    event.preventDefault();
    zoomTo(zoom.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  $('zoom-in').addEventListener('click', () => zoomTo(zoom.scale * 1.5));
  $('zoom-out').addEventListener('click', () => zoomTo(zoom.scale / 1.5));
  $('zoom-reset').addEventListener('click', () => zoomTo(1));
}

initialize();
