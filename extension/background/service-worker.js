/**
 * OmniSnag - Background Service Worker (Manifest V3)
 * Manages media sniffing, auth/cookie capture, offscreen bridge, and CLI command generation.
 */

// Tab media storage: tabId -> Map(mediaUrl -> MediaItem)
const tabMediaStore = new Map();

// Cached request headers: URL -> { headers: Record<string, string>, timestamp: number }
const requestHeadersCache = new Map();

// Memory guard: cap sniffed items per tab (TS fragments from long videos accumulate unbounded otherwise)
const MAX_ITEMS_PER_TAB = 300;

// Throttled UI broadcast timers per tab (prevents hundreds of full re-renders while a video streams)
const broadcastTimers = new Map();

// ==================== 防盗链凭据注入（declarativeNetRequest 会话规则） ====================
// 为什么必须有它：fetch() 的 Headers 里设 'cookie' / 'referer' 会被浏览器静默丢弃
// （实测发出的请求既无 Cookie 也无 Referer），所以 webRequest 抓到的凭据必须靠 DNR
// 在请求出网前注入。规则是会话级的，用完必须撤下，且 urlFilter 只限定到媒体所在目录，
// 避免污染同站其它请求。
const HEADER_RULE_ID_BASE = 9200;
let headerRuleSeq = 0;
let headerRuleIds = new Set();

// 只注入浏览器真发过的头，不伪造
function headerRuleRequestHeaders(item) {
  const h = (item && item.headers) || {};
  const out = [];
  const referer = h.referer || h.Referer || (item && item.pageUrl) || '';
  const cookie = h.cookie || h.Cookie || '';
  if (referer) out.push({ header: 'Referer', operation: 'set', value: referer });
  if (cookie) out.push({ header: 'Cookie', operation: 'set', value: cookie });
  return out;
}

function headerRuleUrlFilter(url) {
  try {
    const u = new URL(url);
    // 去掉文件名保留目录：分片与播放列表通常同目录
    return (u.origin + u.pathname.replace(/[^/]*$/, '')).replace(/[|^]/g, (c) => '\\' + c);
  } catch (e) {
    return null;
  }
}

// 装规则前先撤掉上一批（同一时刻只需要一组有效规则，避免多站点互相污染）
async function clearPreviewRules() {
  if (!headerRuleIds.size) return;
  const ids = Array.from(headerRuleIds);
  headerRuleIds = new Set();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch (e) {}
}

async function installHeaderRule(item) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return [];
  await clearPreviewRules();
  const requestHeaders = headerRuleRequestHeaders(item);
  if (!requestHeaders.length) return [];
  const urlFilter = headerRuleUrlFilter(item.url);
  if (!urlFilter) return [];

  const id = HEADER_RULE_ID_BASE + (headerRuleSeq++);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { urlFilter, resourceTypes: ['xmlhttprequest', 'media', 'other'] }
    }]
  });
  headerRuleIds.add(id);
  return requestHeaders.map(r => r.header);
}

// 嗅探列表持久化：列表只在内存里，SW 被回收/浏览器关闭就丢
// （实测：强杀 SW 后 GET_SNIFFED_MEDIA 返回空数组，而历史存档仍在）。
//
// 关键设计：快照按「页面 URL」而不是标签页 ID 存。
// chrome 的 tabId 在同一次浏览器会话内稳定（足以覆盖 SW 被回收），但关掉浏览器再开就全部变化，
// 若按 tabId 存，重启后永远对不上号 —— 所以以 pageUrl 为键，重启后回到同一个播放页仍能恢复。
const SNIFF_LIST_KEY = 'sniffListCache';
const SNIFF_LIST_MAX_PAGES = 40;
const SNIFF_LIST_TTL_MS = 6 * 60 * 60 * 1000;   // 6 小时未再出现的页面快照丢弃

let sniffPersistTimer = null;

function persistSniffListDebounced() {
  if (sniffPersistTimer) return;
  sniffPersistTimer = setTimeout(() => {
    sniffPersistTimer = null;
    persistSniffListNow();
  }, 500);
}

// 把当前内存态整体写盘（按页面 URL 归并；同一页面只保留最新一份）
function persistSniffListNow() {
  try {
    const byPage = {};
    const now = Date.now();
    for (const map of tabMediaStore.values()) {
      if (!map || map.size === 0) continue;
      const items = Array.from(map.values());
      // 同一标签页里的条目同源，取第一条的 pageUrl 作为该页的键
      const pageUrl = (items.find(i => i.pageUrl) || {}).pageUrl || '';
      if (!pageUrl) continue;
      byPage[pageUrl] = { at: now, pageTitle: (items[0] || {}).pageTitle || '', items };
    }
    // 与上一次的快照合并，避免「当前标签页清空后」把其他页面的存档一起抹掉
    chrome.storage.local.get([SNIFF_LIST_KEY], (res) => {
      const prev = (res && res[SNIFF_LIST_KEY]) || {};
      const merged = Object.assign({}, prev);
      for (const [k, v] of Object.entries(byPage)) merged[k] = v;
      // TTL + 数量上限裁剪：按最近一次出现时间保留最新的 N 个页面
      const entries = Object.entries(merged)
        .filter(([, v]) => v && Array.isArray(v.items) && now - (v.at || 0) <= SNIFF_LIST_TTL_MS)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, SNIFF_LIST_MAX_PAGES);
      chrome.storage.local.set({ [SNIFF_LIST_KEY]: Object.fromEntries(entries) }).catch(() => {});
    });
  } catch (e) {}
}

// 清空/删除时同步收紧快照，否则「清空列表」后刷新又会把旧条目灌回来
function dropSniffSnapshotFor(pageUrl) {
  if (!pageUrl) return;
  chrome.storage.local.get([SNIFF_LIST_KEY], (res) => {
    const store = (res && res[SNIFF_LIST_KEY]) || null;
    if (!store || !store[pageUrl]) return;
    delete store[pageUrl];
    chrome.storage.local.set({ [SNIFF_LIST_KEY]: store }).catch(() => {});
  });
}

// 内存里没有该标签页的数据时，按页面 URL 从存档恢复（覆盖 SW 被回收与浏览器重启两种情况）
function hydrateSniffListForTab(tabId, callback) {
  chrome.storage.local.get([SNIFF_LIST_KEY], (res) => {
    const store = (res && res[SNIFF_LIST_KEY]) || {};
    chrome.tabs.get(tabId, (tab) => {
      const url = (tab && tab.url) || '';
      const entry = url ? store[url] : null;
      if (entry && Array.isArray(entry.items) && Date.now() - (entry.at || 0) <= SNIFF_LIST_TTL_MS) {
        if (!tabMediaStore.has(tabId)) tabMediaStore.set(tabId, new Map());
        const m = tabMediaStore.get(tabId);
        for (const it of entry.items) {
          if (it && it.dedupeKey) m.set(it.dedupeKey, it);
        }
        updateBadge(tabId);
      }
      callback();
    });
  });
}


// (1) Content script asks which tab it runs in — the drawer iframe pins itself to that tab.
// (2) The drawer iframe cannot reach the host tab's content script directly, so it asks the
//     service worker to relay close/open commands there.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === 'GET_MY_TAB_ID') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return false;
  }
  // Relay from the embedded drawer iframe back to the host tab's content script.
  if (message.type === 'RELAY_TO_HOST_TAB' && sender.tab && sender.tab.id != null) {
    chrome.tabs.sendMessage(sender.tab.id, message.payload || {}, () => void chrome.runtime.lastError);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
// Initialize: badge color only — action click is handled by chrome.action.onClicked (popup, not side panel)
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setOptions) {
    // Side panel stays available from Chrome's own panel menu, but no longer opens on icon click.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

// Toolbar icon click → toggle in-page overlay panel on the active tab.
// Any failure (restricted page, missing content script) falls back to the side panel.
chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab && tab.id;
  const fallbackToSidePanel = () => {
    if (chrome.sidePanel && chrome.sidePanel.open && tabId != null) {
      chrome.sidePanel.open({ tabId }).catch(() => {});
    }
  };
  if (tabId == null) return fallbackToSidePanel();

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_LINKS_POPUP' });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/fab-ui.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_LINKS_POPUP' });
    } catch (err2) {
      fallbackToSidePanel();
    }
  }
});

// ---- 历史记录：按来源域名隔离 + 写入时压缩 ----
// 为什么必须压缩：一个视频站一次播放就可能产生上千条 m3u8/TS 请求。
// 若逐条入库，几个站点之后 chrome.storage 与 Service Worker 内存都会爆掉。
// 压缩全部发生在「写入时」（不依赖渲染层，换 UI 也不会失效）：
//   1) TS/M4S 分片不单独占条，折叠进所属 m3u8 / 切片组（tsCount / tsBytes）
//   2) URL 归一化判重：只有易变签名参数不同 → 视为同一条，仅更新直链
//   3) 单域名条数上限 + 域名词条上限，超出淘汰最旧的
//   4) cookie / authorization 截断，避免长凭据把存储撑爆
//
// 历史按「来源网页域名」分桶：切换站点只看到该站历史，互不串台。
let historyStore = {};                 // { [domain]: Item[] }
let historyPersistTimer = null;
const HISTORY_MAX_PER_DOMAIN = 200;    // 单域名保留条数
const HISTORY_MAX_DOMAINS = 120;       // 最多保留多少个域名的历史
const HISTORY_MAX_CRED = 512;          // cookie / authorization 截断长度

// 易变的查询参数：同一视频每次刷新/重签都会变，判重时应忽略其「值」
const HISTORY_VOLATILE_QS = new Set([
  'sign', 'signature', 'sig', 'token', 't', 'ts', '_t', 'timestamp',
  'expire', 'expires', 'e', 'auth', 'auth_key', 'authkey', 'nonce',
  'key', 'hmac', 'wssecret', 'wstoken', 'ott', 'stime', 'playauth'
]);

// 历史归属域名：用「来源网页」域名而非媒体 CDN 域名，
// 这样同一网站下不同 CDN 的资源仍聚在同一个站点里。
function historyDomainOf(rec) {
  const raw = (rec && rec.pageUrl) || '';
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host || '(未知来源)';
  } catch (e) {
    return raw ? '(无法解析来源)' : '(未知来源)';
  }
}

// 取 URL 所在目录（用于把 TS 分片折叠到同目录的 m3u8 下）
function historyDirOf(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    const i = u.pathname.lastIndexOf('/');
    return u.origin + u.pathname.slice(0, i + 1);
  } catch (e) {
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i + 1) : s;
  }
}

// 归一化 URL：剔除易变签名参数，其余参数保留并排序，
// 用于判断两条记录是否「本质上是同一个资源」。
function historyUrlKey(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (HISTORY_VOLATILE_QS.has(k.toLowerCase())) continue;
      keep.push(k + '=' + v);
    }
    keep.sort();
    return u.origin.toLowerCase() + u.pathname + (keep.length ? '?' + keep.join('&') : '');
  } catch (e) {
    return s;
  }
}

function historyTrimCred(v) {
  const s = String(v || '');
  return s.length > HISTORY_MAX_CRED ? s.slice(0, HISTORY_MAX_CRED) : s;
}

function historyBuildRecord(record, domain) {
  const h = record.headers || {};
  return {
    url: record.url,
    key: mediaDedupeKey(record.url),
    type: record.type,
    contentType: record.contentType || '',
    contentLength: record.contentLength || 0,
    formattedSize: record.formattedSize || '',
    pageTitle: record.pageTitle || '',
    pageUrl: record.pageUrl || '',
    domain,
    time: record.time || Date.now(),
    lastSeen: Date.now(),
    seenCount: 1,
    tsCount: 0,      // 折叠进来的分片数
    tsBytes: 0,      // 折叠进来的分片总字节
    dir: historyDirOf(record.url),
    assetRoot: mediaAssetRootOf(record.url),   // 同一作品（master/变体/分片）共享，用于归并
    track: mediaTrackOf(urlPathname(record.url)),   // 'video' | 'audio' | ''：单独一条轨不能当成品
    playable: isPlayableMediaType(record.type),
    headers: {
      referer: h.referer || '',
      origin: h.origin || '',
      'user-agent': h['user-agent'] || '',
      cookie: historyTrimCred(h.cookie),
      authorization: historyTrimCred(h.authorization)
    }
  };
}

function historyPruneDomain(domain) {
  const bucket = historyStore[domain];
  if (bucket && bucket.length > HISTORY_MAX_PER_DOMAIN) {
    bucket.length = HISTORY_MAX_PER_DOMAIN;   // 保留最新的（新记录 unshift 在前）
  }
}

// 域名过多时淘汰最久未更新的域名，避免无限增长
function historyPruneDomains() {
  const domains = Object.keys(historyStore);
  if (domains.length <= HISTORY_MAX_DOMAINS) return;
  const byAge = domains.map(d => ({
    d,
    last: (historyStore[d] || []).reduce((m, x) => Math.max(m, x.lastSeen || x.time || 0), 0)
  })).sort((a, b) => a.last - b.last);
  for (const item of byAge.slice(0, domains.length - HISTORY_MAX_DOMAINS)) {
    delete historyStore[item.d];
  }
}

function persistHistory() {
  if (historyPersistTimer) return;
  historyPersistTimer = setTimeout(() => {
    historyPersistTimer = null;
    chrome.storage.local.set({ sniffHistory: historyStore }).catch(() => {});
  }, 800);
}

// 折叠一个分片到父条目。
// 幂等性很关键：同一个视频播放 5 次会重复上报同一批分片（每次 URL 的签名/tag 都不同），
// 若无条件累加，tsCount 会虚增成 5 倍 —— 用户看到的就是「分片数一直在涨」。
// 去重表存在父条目自身（segKeys），这样 Service Worker 重启、从存储恢复后依然有效。
const HISTORY_MAX_SEG_KEYS = 2000;   // 去重表上限，防止超长视频把存储撑爆
function foldSegment(parent, record, type) {
  const key = mediaDedupeKey(record.url);
  if (!Array.isArray(parent.segKeys)) parent.segKeys = [];
  const already = parent.segKeys.includes(key);
  if (!already) {
    if (parent.segKeys.length < HISTORY_MAX_SEG_KEYS) parent.segKeys.push(key);
    parent.tsCount = (parent.tsCount || 0) + 1;
    parent.tsBytes = (parent.tsBytes || 0) + (record.contentLength || 0);
  }
  parent.lastSeen = Date.now();
  return !already;
}

// 写入一条历史（含压缩）。opts.silent 用于迁移时避免逐条落盘。
function addToHistory(record, opts) {
  if (!record || !record.url) return;
  // 标记写入：若启动加载尚未回调，其快照已过期，不能覆盖当前内存状态
  historyMutatedSinceLoad = true;
  const quiet = !!(opts && opts.silent);
  const domain = historyDomainOf(record);
  if (!historyStore[domain]) historyStore[domain] = [];
  const bucket = historyStore[domain];
  const type = record.type || 'other';

  // —— 压缩 1：分片（TS / M4S / fMP4 初始化段）不单独占条，折叠进所属播放列表 ——
  // 关键：用「资源根目录」（mediaAssetRootOf）而不是同目录比对。
  // X/Twitter 的播放列表在 .../pu/pl/*.m3u8，分片却在 .../pu/vid/avc1/0/3000/*.m4s，
  // 只比对同目录永远匹配不上，于是每个分片都新建一条 —— 这正是「同一帖子反复添加」。
  if (isSegmentType(type)) {
    const segRoot = mediaAssetRootOf(record.url);
    let parent = bucket.find(h =>
      (h.type === 'm3u8' || h.type === 'mpd') && h.assetRoot === segRoot);
    if (!parent) {
      parent = bucket.find(h =>
        (h.type === 'm3u8' || h.type === 'mpd') && h.assetRoot && record.url.startsWith(h.assetRoot));
    }
    if (parent) {
      if (foldSegment(parent, record, type)) {
        if (type === 'init') parent.hasInit = true;
        if (!quiet) persistHistory();
      }
      return;
    }
    // 没有父播放列表：整组聚成一条「分片组」，仍然只占一条
    const group = bucket.find(h => h.type === 'ts-group' && h.assetRoot === segRoot);
    if (group) {
      if (foldSegment(group, record, type)) {
        if (type === 'init') group.hasInit = true;
        if (!quiet) persistHistory();
      }
      return;
    }
    const g = historyBuildRecord(record, domain);
    g.type = 'ts-group';
    g.assetRoot = segRoot;
    g.dir = segRoot;
    g.tsCount = 1;
    g.tsBytes = record.contentLength || 0;
    g.segKeys = [mediaDedupeKey(record.url)];
    g.hasInit = type === 'init';
    bucket.unshift(g);
    historyPruneDomain(domain);
    if (!quiet) persistHistory();
    return;
  }

  // —— 压缩 2：按归一化 URL 判重（仅签名/标签不同视为同一条，更新直链即可）——
  // 必须与 historyBuildRecord 存进去的 key 用同一个函数，否则判重根本不生效。
  // 旧记录可能只有 historyUrlKey 生成的 key，所以两个都试一遍以兼容历史数据。
  const key = mediaDedupeKey(record.url);
  const legacyKey = historyUrlKey(record.url);
  const existing = bucket.find(h =>
    h.key === key ||
    (h.key && h.key === legacyKey) ||
    mediaDedupeKey(h.url) === key);
  if (existing) {
    existing.url = record.url;            // 采用最新直链（签名通常以最新有效）
    existing.key = key;
    existing.lastSeen = Date.now();
    existing.seenCount = (existing.seenCount || 1) + 1;
    if (record.contentLength && !existing.contentLength) {
      existing.contentLength = record.contentLength;
      existing.formattedSize = formatBytes(record.contentLength);
    }
    if (record.pageTitle) existing.pageTitle = record.pageTitle;
    if (!quiet) persistHistory();
    return;
  }

  bucket.unshift(historyBuildRecord(record, domain));
  historyPruneDomain(domain);
  historyPruneDomains();
  if (!quiet) persistHistory();
}

// ---- 嗅探黑名单：命中的域名不再嗅探媒体资源 ----
// 语义（与侧边栏说明保持一致）：
//   1. 条目按「根域」匹配：example.com 命中自身及全部子域；
//   2. 媒体资源域名 或 来源页面域名 任一命中 → 跳过该条嗅探；
//   3. 只对「之后」的嗅探生效，已捕获的列表条目不受影响（可手动清空列表）。
// 数据存 chrome.storage.local 的 sniffBlacklist（string[]，已归一化域名），
// 由侧边栏直接读写；后台通过 storage.onChanged 同步进内存 Set。
let sniffBlacklist = new Set();

function normalizeBlacklistEntry(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  // 完整 URL / 协议相对 URL：取 hostname（同时剥掉端口、路径、查询）
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s) || s.startsWith('//')) {
    try { s = new URL(s.includes('://') ? s : 'http:' + s).hostname; } catch (e) { /* 走后续兜底 */ }
  } else if (s.includes('/')) {
    // 形如 host/path：补协议解析，失败则取「/」前段
    try { s = new URL('http://' + s).hostname; } catch (e) { s = s.split('/')[0]; }
  }
  s = s.replace(/^\*\./, '').replace(/\.+$/, '').trim();
  if (!s || s.length > 253) return '';
  // 残留这些字符说明不是可用的主机名
  if (/[\s@:/?#]/.test(s)) return '';
  return s;
}

function sniffBlacklistFromArray(arr) {
  const out = new Set();
  if (Array.isArray(arr)) {
    for (const v of arr) {
      const n = normalizeBlacklistEntry(v);
      if (n) out.add(n);
    }
  }
  return out;
}

function applySniffBlacklistValue(arr) {
  sniffBlacklist = sniffBlacklistFromArray(arr);
}

function loadSniffBlacklist() {
  try {
    chrome.storage.local.get(['sniffBlacklist'], (res) => {
      if (chrome.runtime.lastError) return;
      applySniffBlacklistValue(res && res.sniffBlacklist);
    });
  } catch (e) {}
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes && changes.sniffBlacklist) {
    applySniffBlacklistValue(changes.sniffBlacklist.newValue);
  }
});
loadSniffBlacklist();

function hostOfUrl(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return ''; }
}

// host 是否命中黑名单（根域语义：条目命中自身及全部子域）
//
// 实现走「逐级父域 Set 查找」而不是遍历黑名单逐条 endsWith：
// 对 host 每一级后缀（a.b.c.com → a.b.c.com / b.c.com / c.com / com）各做一次
// Set.has，复杂度 O(域名深度 ≈ 4~6)，与黑名单条数完全无关。语义与
// 「host === e || host.endsWith('.' + e)」逐条判定完全等价——e 命中 host
// 当且仅当 e 是 host 的某个点分后缀。
function isBlacklistedHost(host) {
  if (!host || !sniffBlacklist.size) return false;
  let h = host;
  for (;;) {
    if (sniffBlacklist.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot === -1) return false;
    h = h.slice(dot + 1);
  }
}

// 媒体域名 或 来源页面域名 任一命中即视为命中
function matchBlacklist(mediaUrl, pageUrl) {
  if (!sniffBlacklist.size) return false;
  return isBlacklistedHost(hostOfUrl(mediaUrl)) || isBlacklistedHost(hostOfUrl(pageUrl));
}

// 加载已存数据（兼容旧版扁平数组 → 自动迁移并按新规则压缩一次）
//
// 注意竞态：chrome.storage.local.get 是异步的，而 MV3 的 Service Worker 会频繁休眠/唤醒，
// 因此「清空历史」很可能发生在本次 get 回调之前。若此处无条件用回调里的（清空前的）快照
// 填充 historyStore，就会把用户刚清掉的数据重新灌回来 —— 表现为「点了清空没反应」。
// 对策：get 期间若发生过清空/新增写入，则以内存中的 historyStore 为准，丢弃这次快照。
let historyMutatedSinceLoad = false;

chrome.storage.local.get(['sniffHistory'], (res) => {
  if (historyMutatedSinceLoad) return;   // 期间已有更新，快照过期，忽略
  const saved = res && res.sniffHistory;
  if (!saved) return;
  if (Array.isArray(saved)) {
    for (const item of saved) {
      try { addToHistory(item, { silent: true }); } catch (e) {}
    }
    persistHistory();
  } else if (typeof saved === 'object') {
    // 已是新结构：整表替换（而不是逐域名浅合并），否则被清掉的域会残留
    historyStore = {};
    for (const d of Object.keys(saved)) {
      if (Array.isArray(saved[d])) historyStore[d] = saved[d];
    }
  }
});


// Helper: Format bytes to human-readable string
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

// 分片类：这些类型不单独占条目，会被折叠进所属播放列表。
const SEGMENT_TYPES = new Set(['ts', 'm4s', 'init']);
function isSegmentType(t) {
  return SEGMENT_TYPES.has(t);
}

// 哪些类型是「可以直接播放/下载的完整资源」。
// 分片（ts/m4s）不是：它们是切片；初始化段（init）也不是：只有 moov 元数据。
function isPlayableMediaType(type) {
  return type === 'mp4' || type === 'webm' || type === 'flv' || type === 'audio' ||
    type === 'm3u8' || type === 'mpd' || type === 'video';
}

// ---- 媒体类型判定：只看 pathname，不看查询串 ----
// 为什么必须按 pathname：很多 CDN 在查询串里带 `?tag=…`、`?ts=…`、`?t=…&sign=…`，
// 用整串 URL 做 includes() 匹配会把它们误判（例如 `clip.mp4?ts=123` 被当成 TS 分片）。

function urlPathname(url) {
  const s = String(url || '');
  try { return new URL(s).pathname.toLowerCase(); } catch (e) { return s.split('?')[0].toLowerCase(); }
}

// fMP4 初始化分片：EXT-X-MAP 指向的 .mp4，只含 moov（编解码/时间轴）元数据。
// X/Twitter 形如 /ext_tw_video/{id}/pu/vid/avc1/0/0/1920x1080/{file}.mp4
// 这类文件单独下载或播放都是空的，必须识别出来，不能当成成品 MP4。
function isInitSegmentPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  if (/\/0\/0\/[^/]*\.(mp4|m4s)$/.test(p)) return true;
  if (/\/init[^/]*\.(mp4|m4s)$/.test(p)) return true;
  return false;
}

// HLS/CMAF 时间片：路径里带「起始/结束」毫秒目录对 + 分辨率目录，如
// /avc1/3000/6000/960x540/seg2.mp4。这类 .mp4 是被切开的流片段，不是完整文件。
// 刻意要求「分辨率目录」这一环：否则 /videos/202304/23/movie.mp4 这种正常
// 路径里恰好有两个纯数字目录的成品 MP4 会被误判成分片。
function isTimeRangeSegmentPath(pathname) {
  return /\/\d+\/\d+\/\d+x\d+\/[^/]+\.(mp4|m4s)$/.test(String(pathname || '').toLowerCase());
}

// 轨道判定：同一视频的 master 会派生出多条仅视频或仅音频的轨道。
// 单独下载任一条都只有画面没声音（或反之），必须让界面标注清楚。
function mediaTrackOf(pathname) {
  const p = String(pathname || '').toLowerCase();
  if (/\/(mp4a|audio|aac)(\/|\.)/.test(p)) return 'audio';
  if (/\/(avc1|h26[45]|hev1|vp0?9|av01)(\/|\.)/.test(p)) return 'video';
  return '';
}

// 同一「作品」的资源根目录：用于把 master / 各变体 / 初始化段 / 分片归到一个条目下。
// X/Twitter：…/ext_tw_video/{media_id}/… 与 …/amplify_video/{media_id}/…
// 注意它的播放列表在 pu/pl/*，分片在 pu/vid/*，只比对同目录会完全对不上，
// 于是同一个帖子被拆成一堆条目 —— 这就是「一个帖子反复添加」的根源。
function mediaAssetRootOf(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.findIndex(seg => /^(ext_tw_video|amplify_video|ext_tw_card)/i.test(seg));
    if (i >= 0 && parts[i + 1]) {
      return u.origin.toLowerCase() + '/' + parts.slice(0, i + 2).join('/') + '/';
    }
    return u.origin.toLowerCase() + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  } catch (e) {
    const i = s.lastIndexOf('/');
    return i > 0 ? s.slice(0, i + 1) : s;
  }
}

// 去重键：同一资源常常因签名/标签参数不同而「看起来」是新 URL。
// 用 pathname + 稳定查询参数做键，避免同一文件反复入库。
const DEDUPE_VOLATILE_QS = new Set([
  ...HISTORY_VOLATILE_QS, 'tag', 'cid', 'request_id', 'reqid', 'cb', 'cachebuster',
  'session', 'sid', 'rand', 'r', '_', 'ttl', 'policy', 'key-pair-id', 'x-amz-signature'
]);
function mediaDedupeKey(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (DEDUPE_VOLATILE_QS.has(k.toLowerCase())) continue;
      keep.push(k + '=' + v);
    }
    keep.sort();
    return u.origin.toLowerCase() + u.pathname + (keep.length ? '?' + keep.join('&') : '');
  } catch (e) {
    return s;
  }
}

// Helper: Determine media format from URL and Content-Type
function detectMediaType(url, contentType = '') {
  const p = urlPathname(url);
  const full = String(url || '').toLowerCase();
  const c = (contentType || '').toLowerCase();

  if (p.includes('.m3u8') || c.includes('mpegurl') || c.includes('application/x-mpegurl')) {
    return 'm3u8';
  }
  if (p.includes('.mpd') || c.includes('dash+xml')) {
    return 'mpd';
  }
  // 顺序关键：初始化段必须先于普通 mp4 判定，否则会被当成可播放成品。
  if (isInitSegmentPath(p)) {
    return 'init';
  }
  if (p.includes('.m4s') || (/\.mp4$/.test(p) && isTimeRangeSegmentPath(p))) {
    return 'm4s';
  }
  if (p.includes('.ts') || c.includes('video/mp2t')) {
    return 'ts';
  }
  if (p.includes('.mp4') || c.includes('video/mp4')) {
    return 'mp4';
  }
  if (p.includes('.flv') || c.includes('video/x-flv')) {
    return 'flv';
  }
  if (p.includes('.webm') || c.includes('video/webm')) {
    return 'webm';
  }
  if (c.startsWith('audio/')) {
    return 'audio';
  }
  if (c.startsWith('video/')) {
    return 'video';
  }
  // 兜底：扩展名紧跟在「?」或字符串末尾（避免 `?ts=123` 这类误判）
  if (/\.(m3u8|mp4|m4s|mpd|flv|webm|aac|m4a|mp3)(\?|$)/.test(full)) {
    return detectMediaType(full.split('?')[0], contentType);
  }
  return null;
}

// NOTE: We deliberately do NOT scrape all same-domain cookies via chrome.cookies.
// Only cookies actually sent with the media request are captured. Injecting unrelated
// site cookies into a download command makes it dirty and can even break playback
// (servers that do not expect them may reject), while most CDNs only need Referer/UA.

// 1. Intercept Request Headers (Captures Referer, Origin, User-Agent, Cookie, Auth)
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = {};
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        headers[h.name.toLowerCase()] = h.value;
      }
    }
    // Clean URL without search query for prefix matching
    requestHeadersCache.set(details.url, {
      headers,
      timestamp: Date.now()
    });

    // Clean old cache entries if map exceeds 2000
    if (requestHeadersCache.size > 2000) {
      const keys = Array.from(requestHeadersCache.keys());
      for (let i = 0; i < 500; i++) {
        requestHeadersCache.delete(keys[i]);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// 2. Intercept Response Headers & Detect Media
chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    // Only track valid browser tab requests
    if (details.tabId < 0) return;

    let contentType = '';
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'content-type') {
          contentType = h.value;
        } else if (name === 'content-length') {
          contentLength = parseInt(h.value, 10) || 0;
        }
      }
    }

    const mediaType = detectMediaType(details.url, contentType);
    if (!mediaType) return;

    // 黑名单挡板（网络层）：媒体资源域名命中 → 直接跳过，不产生嗅探条目。
    // 放在 detectMediaType 之后：非媒体请求不查黑名单，避免给全量响应增加开销。
    if (sniffBlacklist.size && isBlacklistedHost(hostOfUrl(details.url))) return;
    // Filter tiny slices / ads if needed (e.g. ts segments less than 1KB)
    if (mediaType === 'ts' && contentLength > 0 && contentLength < 1024) {
      return;
    }

    await registerMediaItem(details.tabId, {
      url: details.url,
      initiator: details.initiator || 'network',
      type: mediaType,
      contentType,
      contentLength,
      statusCode: details.statusCode
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

// Register a media item in tab store
async function registerMediaItem(tabId, itemData) {
  if (!tabMediaStore.has(tabId)) {
    tabMediaStore.set(tabId, new Map());
  }
  const mediaMap = tabMediaStore.get(tabId);

  // 去重：用归一化键（忽略 tag/sign/ts 等易变参数）判断是否同一条资源。
  // 旧实现以「原始 URL」为键，同一文件只要签名/标签变了就会被当成新条目反复入库
  // —— 这正是「一个帖子反复添加」的另一半原因。
  let dedupeKey = itemData.dedupeKey || mediaDedupeKey(itemData.url);
  let slotKey = null;
  for (const [k, v] of mediaMap) {
    if (v.dedupeKey === dedupeKey) { slotKey = k; break; }
  }
  if (!slotKey && mediaMap.has(itemData.url)) slotKey = itemData.url;

  if (slotKey !== null) {
    const existing = mediaMap.get(slotKey);
    if (itemData.contentLength && !existing.contentLength) {
      existing.contentLength = itemData.contentLength;
      existing.formattedSize = formatBytes(itemData.contentLength);
    }
    // 同一资源的签名会过期，保留最新直链（下载时更可能仍然有效）
    if (itemData.url && itemData.url !== existing.url) existing.url = itemData.url;
    existing.lastSeen = Date.now();
    existing.seenCount = (existing.seenCount || 1) + 1;
    return existing;
  }

  // Retrieve captured request headers
  const cached = requestHeadersCache.get(itemData.url) || {};
  const reqHeaders = cached.headers || itemData.headers || {};

  // Capture ONLY the Cookie actually sent with this media request (no site-wide scraping)
  const cookieStr = reqHeaders['cookie'] || '';

  // Get active tab info
  let pageTitle = itemData.pageTitle || '';
  let pageUrl = itemData.pageUrl || '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab) {
      pageTitle = tab.title || pageTitle;
      pageUrl = tab.url || pageUrl;
    }
  } catch (e) {}

  // 黑名单兜底（来源页面维度）：来源页域名命中 → 不入库、不进历史、不记 badge。
  // 网络层挡板只查媒体域名；这里补上「来源页面域名命中即整站不嗅探」的语义。
  if (sniffBlacklist.size && matchBlacklist(itemData.url, pageUrl)) return null;

  const mediaItem = {
    id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tabId,
    url: itemData.url,
    dedupeKey,
    type: itemData.type || detectMediaType(itemData.url, itemData.contentType) || 'other',
    contentType: itemData.contentType || '',
    contentLength: itemData.contentLength || 0,
    formattedSize: formatBytes(itemData.contentLength),
    // 播放能力标注：让界面能区分「成品」与「拼不出完整视频的片段」
    playable: isPlayableMediaType(itemData.type || detectMediaType(itemData.url, itemData.contentType)),
    track: mediaTrackOf(urlPathname(itemData.url)),
    assetRoot: mediaAssetRootOf(itemData.url),
    pageTitle,
    pageUrl,
    initiator: itemData.initiator || 'unknown',
    seenCount: 1,
    timestamp: Date.now(),
    headers: {
      referer: reqHeaders['referer'] || pageUrl || '',
      origin: reqHeaders['origin'] || '',
      'user-agent': reqHeaders['user-agent'] || navigator.userAgent,
      cookie: cookieStr,
      authorization: reqHeaders['authorization'] || ''
    }
  };

  mediaMap.set(dedupeKey, mediaItem);
  enforceTabCap(tabId);
  addToHistory(mediaItem);
  updateBadge(tabId);
  persistSniffListDebounced();

  // Notify side panel (throttled: at most once per 600ms per tab)
  scheduleBroadcast(tabId);

  return mediaItem;
}

// Update extension icon badge
function updateBadge(tabId) {
  const count = tabMediaStore.has(tabId) ? tabMediaStore.get(tabId).size : 0;
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4F46E5' }).catch(() => {});
}

// Enforce per-tab memory cap: evict oldest TS/M4S fragments first, then oldest overall
function enforceTabCap(tabId) {
  const m = tabMediaStore.get(tabId);
  if (!m || m.size <= MAX_ITEMS_PER_TAB) return;
  // 淘汰顺序：先丢分片（ts/m4s/init），它们对用户价值最低且数量最多
  const evictable = Array.from(m.entries())
    .filter(([, v]) => isSegmentType(v.type))
    .sort((a, b) => a[1].timestamp - b[1].timestamp);
  let toRemove = m.size - MAX_ITEMS_PER_TAB;
  for (const [k] of evictable) {
    if (toRemove-- <= 0) break;
    m.delete(k);
  }

  if (m.size > MAX_ITEMS_PER_TAB) {
    const all = Array.from(m.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const [k] of all) {
      if (m.size <= MAX_ITEMS_PER_TAB) break;
      m.delete(k);
    }
  }
}

// Throttled UI broadcast: coalesce bursts of segment detections into one refresh
function scheduleBroadcast(tabId) {
  if (broadcastTimers.has(tabId)) return;
  broadcastTimers.set(tabId, setTimeout(() => {
    broadcastTimers.delete(tabId);
    const count = tabMediaStore.has(tabId) ? tabMediaStore.get(tabId).size : 0;
    chrome.runtime.sendMessage({
      type: 'MEDIA_LIST_UPDATED',
      tabId,
      count
    }).catch(() => {});
  }, 600));
}

// Generate command line strings for external tools
function generateCliCommands(mediaItem) {
  const url = mediaItem.url;
  const h = mediaItem.headers || {};
  // Only include Referer/Cookie when actually captured. Falling back to the page URL or a
  // generic User-Agent would inject headers the real request never sent (misleading + can break).
  const referer = h.referer || '';
  const cookie = h.cookie || '';
  const userAgent = h['user-agent'] || '';
  const authorization = h.authorization || '';

  // Clean filename suggestion
  let safeName = (mediaItem.pageTitle || 'video')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  if (!safeName) safeName = 'video';

  // 1. N_m3u8DL-RE Command
  let nCommand = `N_m3u8DL-RE "${url}"`;
  if (referer) nCommand += ` --header "Referer: ${referer}"`;
  if (cookie) nCommand += ` --header "Cookie: ${cookie}"`;
  if (userAgent) nCommand += ` --header "User-Agent: ${userAgent}"`;
  if (authorization) nCommand += ` --header "Authorization: ${authorization}"`;
  nCommand += ` -M format=mp4 --save-name "${safeName}"`;

  // 2. FFmpeg Command
  let ffmpegHeaders = '';
  if (referer) ffmpegHeaders += `Referer: ${referer}\\r\\n`;
  if (cookie) ffmpegHeaders += `Cookie: ${cookie}\\r\\n`;
  if (userAgent) ffmpegHeaders += `User-Agent: ${userAgent}\\r\\n`;
  if (authorization) ffmpegHeaders += `Authorization: ${authorization}\\r\\n`;

  let ffmpegCommand = `ffmpeg`;
  if (ffmpegHeaders) {
    ffmpegCommand += ` -headers "${ffmpegHeaders}"`;
  }
  ffmpegCommand += ` -i "${url}" -c copy "${safeName}.mp4"`;

  // 3. cURL Command (matches the shape users expect: curl -L "<url>" -H ... -o "<name>")
  let curlCommand = `curl -L "${url}"`;
  if (referer) curlCommand += ` -H "Referer: ${referer}"`;
  if (userAgent) curlCommand += ` -H "User-Agent: ${userAgent}"`;
  if (cookie) curlCommand += ` -H "Cookie: ${cookie}"`;
  if (authorization) curlCommand += ` -H "Authorization: ${authorization}"`;
  curlCommand += ` -o "${safeName}.${mediaItem.type === 'm3u8' ? 'm3u8' : 'mp4'}"`;

  // 4. Aria2 Command
  let ariaCommand = `aria2c -x 16 -s 16 "${url}"`;
  if (referer) ariaCommand += ` --header="Referer: ${referer}"`;
  if (userAgent) ariaCommand += ` --header="User-Agent: ${userAgent}"`;
  if (cookie) ariaCommand += ` --header="Cookie: ${cookie}"`;
  if (authorization) ariaCommand += ` --header="Authorization: ${authorization}"`;
  ariaCommand += ` -o "${safeName}.${mediaItem.type === 'm3u8' ? 'm3u8' : 'mp4'}"`;

  // Describe what was actually injected so the UI never overstates what was captured
  const injected = [];
  if (referer) injected.push('Referer');
  if (userAgent) injected.push('User-Agent');
  if (cookie) injected.push('Cookie');
  if (authorization) injected.push('Authorization');

  return {
    n_m3u8dl: nCommand,
    ffmpeg: ffmpegCommand,
    curl: curlCommand,
    aria2: ariaCommand,
    safeName,
    injectedHeaders: injected,
    hasCookie: !!cookie,
    hasAuth: !!(cookie || authorization),
    headersJson: JSON.stringify(h, null, 2)
  };
}

// Ensure Offscreen Document exists for browser-side TS transmuxing & downloading
let creatingOffscreenPromise = null;
async function ensureOffscreenDocument() {
  const path = 'offscreen/offscreen.html';
  if (await hasOffscreenDocument(path)) {
    return;
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: path,
    reasons: ['BLOBS'],
    justification: 'In-browser m3u8 parsing, parallel slice downloading, and MP4 transmuxing.'
  });

  await creatingOffscreenPromise;
  creatingOffscreenPromise = null;
}

async function hasOffscreenDocument(path) {
  if (!chrome.offscreen || !chrome.offscreen.hasDocument) {
    return false;
  }
  return await chrome.offscreen.hasDocument();
}

// Handle tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaStore.delete(tabId);
});

// Clear tab store on page navigation: the old page's media list is stale,
// and keeping it alive across navigations is the main unbounded-growth leak.
//
// 但这里必须区分「真的换了页面」和「同一页面的状态变更」：
// 单页应用（SPA）与播放器会用 history.pushState 改 URL，此时 status 也是 'loading'，
// 旧实现会把刚嗅到的列表连同来源页一起清掉 —— 用户表现为「点了一下选集，列表空了」。
// 因此：只有「页面来源变了（host/路径都不同）」才清；同页面的 URL 微调不动列表。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' || !changeInfo.url) return;
  if (!tabMediaStore.has(tabId) || tabMediaStore.get(tabId).size === 0) return;

  const items = Array.from(tabMediaStore.get(tabId).values());
  const prevPageUrl = (items.find(i => i.pageUrl) || {}).pageUrl || '';
  const samePage = (() => {
    if (!prevPageUrl) return false;
    try {
      const a = new URL(prevPageUrl);
      const b = new URL(changeInfo.url);
      // 同 host + 同 path 视为同一页面（只是 hash/query 变化），保留已嗅到的条目
      return a.host === b.host && a.pathname === b.pathname;
    } catch (e) {
      return false;
    }
  })();

  if (samePage) return;

  tabMediaStore.get(tabId).clear();
  updateBadge(tabId);
  persistSniffListDebounced();
});

// ==================== VPS 远程下载桥接（M3U8 下载桥接服务） ====================
// 接口契约已固定，端点前缀 /api/ext/m3u8/：
//   POST {BASE}/api/ext/m3u8/resolve   探测播放列表 → master(变体列表) | media(可直接下)
//   POST {BASE}/api/ext/m3u8/submit    提交下载 → { task_id, duplicate }
//   GET  {BASE}/api/ext/m3u8/tasks     任务列表（进行中优先）
//   POST {BASE}/api/ext/m3u8/cancel    取消任务
//   POST {BASE}/api/ext/m3u8/retry     重试任务（续传已下分片）
// 鉴权：所有请求携带 X-Ext-Token 头，请求体 application/json。
// 请求由 Service Worker 发出，因此不受页面 CORS / 混合内容限制。

const VPS_API_PREFIX = '/api/ext/m3u8';

const VPS_DEFAULTS = {
  // 与 sidepanel 侧默认值保持一致：本项目主导路径是「放到 VPS 下载」，默认开启
  enabled: true,
  baseUrl: '',
  token: '',
  timeout: 20000,
  autoPush: false,
  pollMs: 2000   // 任务看板轮询间隔（仅在 queued/running 时轮询）
};

// 读取 VPS 配置（与其它设置同域存储，便于设置页一次性保存）
async function getVpsConfig() {
  try {
    const data = await chrome.storage.local.get(['snifferSettings']);
    const s = (data && data.snifferSettings) || {};
    return Object.assign({}, VPS_DEFAULTS, s.vps || {});
  } catch (e) {
    return Object.assign({}, VPS_DEFAULTS);
  }
}

// 规整服务器地址：校验协议，并容忍用户把端点路径一起粘进来
function vpsNormalizeBase(raw) {
  const base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置服务器地址（设置 → VPS 远程下载推送）');
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('服务器地址必须以 http:// 或 https:// 开头（当前：' + base + '）');
  }
  return base.replace(/\/api\/ext\/m3u8.*$/i, '');
}

function vpsClampTimeout(v) {
  let t = parseInt(v, 10) || VPS_DEFAULTS.timeout;
  if (t < 1000) t *= 1000;   // 兼容早期把「秒」直接存进 storage 的配置
  return Math.min(120000, Math.max(3000, t));
}

// 服务端只透传 referer 与 user_agent（注意是 snake_case），用于分片请求破防盗链
function vpsPayloadHeaders(item) {
  const h = (item && item.headers) || {};
  const out = {};
  const referer = h.referer || h.Referer || (item && item.pageUrl) || '';
  const ua = h['user-agent'] || h['User-Agent'] || '';
  if (referer) out.referer = referer;
  if (ua) out.user_agent = ua;
  return out;
}

// 把状态码翻译成「用户接下来该做什么」，而不是只回显数字
function vpsErrorInfo(status, data) {
  const serverMsg = (data && (data.message || data.error || data.detail)) || '';
  const suffix = serverMsg ? ' 服务端：' + serverMsg : '';
  switch (status) {
    case 401:
      return { kind: 'auth',
        message: 'Token 无效或缺失。请到「设置 → VPS 远程下载推送」核对服务端 .ext_token 里的值。' + suffix };
    case 429:
      return { kind: 'rate',
        message: '触发服务端限流（60 秒 / 120 次）或并发任务已达上限，请稍后再试。' + suffix };
    case 400:
      return { kind: 'badrequest',
        message: serverMsg || '参数错误，或目标地址被服务端 SSRF 护栏拦截（禁止私网/环回/保留地址）。' };
    case 404:
      return { kind: 'notfound', message: serverMsg || '任务不存在，或当前状态不允许该操作。' };
    case 502:
      return { kind: 'upstream', message: serverMsg || '服务端探测上游失败。' };
    default:
      return { kind: 'http', message: serverMsg || ('HTTP ' + status) };
  }
}

// 核心请求器：统一注入鉴权头、超时、错误翻译。永远 resolve（不 throw）。
async function vpsApi(cfg, path, opts) {
  const options = opts || {};
  const method = String(options.method || 'POST').toUpperCase();
  const started = Date.now();

  let url;
  try {
    url = vpsNormalizeBase(cfg.baseUrl) + VPS_API_PREFIX + path;
  } catch (err) {
    return { ok: false, errorKind: 'config', error: err.message, elapsed: 0 };
  }

  const token = String(cfg.token || '').trim();
  if (!token) {
    return { ok: false, errorKind: 'config',
      error: '未配置 Token。请到「设置 → VPS 远程下载推送」填写服务端的插件 Token。', elapsed: 0 };
  }

  const init = { method, headers: { 'Content-Type': 'application/json', 'X-Ext-Token': token } };
  if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined) {
    init.body = JSON.stringify(options.body || {});
  }

  const timeout = vpsClampTimeout(cfg.timeout);
  const controller = new AbortController();
  init.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}

    if (res.ok && data && data.ok === false) {
      // 非 2xx 会带回 { ok:false, message }；2xx 但 ok:false 同样按失败处理
      return { ok: false, status: res.status, data, errorKind: 'server',
        error: data.message || '服务端返回 ok:false', elapsed: Date.now() - started };
    }
    if (!res.ok) {
      const info = vpsErrorInfo(res.status, data);
      return { ok: false, status: res.status, data, errorKind: info.kind,
        error: info.message, elapsed: Date.now() - started };
    }
    if (!data) {
      return { ok: false, status: res.status, errorKind: 'parse',
        error: '服务端响应不是合法 JSON：' + (text || '').split('\n')[0].slice(0, 160),
        elapsed: Date.now() - started };
    }
    return { ok: true, status: res.status, data, elapsed: Date.now() - started };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      errorKind: aborted ? 'timeout' : 'network',
      error: aborted
        ? ('请求超时（' + timeout + 'ms）。若服务端在处理大播放列表，可在设置里调大超时。')
        : ('无法连接服务端：' + ((err && err.message) || String(err)) +
           '。请检查地址、服务是否在运行、以及是否被浏览器拦混合内容。'),
      elapsed: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 五个契约端点的薄封装 ----
function vpsResolve(cfg, item) {
  return vpsApi(cfg, '/resolve', {
    method: 'POST',
    body: { url: item.url, headers: vpsPayloadHeaders(item) }
  });
}

function vpsSubmit(cfg, item) {
  const body = { url: item.url, headers: vpsPayloadHeaders(item) };
  const title = item.title || item.pageTitle || '';
  if (title) body.title = title;
  return vpsApi(cfg, '/submit', { method: 'POST', body });
}

function vpsTasks(cfg, limit) {
  const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  return vpsApi(cfg, '/tasks?limit=' + n, { method: 'GET' });
}

function vpsCancel(cfg, taskId) {
  return vpsApi(cfg, '/cancel', { method: 'POST', body: { task_id: taskId } });
}

function vpsRetry(cfg, taskId) {
  return vpsApi(cfg, '/retry', { method: 'POST', body: { task_id: taskId } });
}


// Message listener from SidePanel / Content Scripts / Offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From Content Script: Main world hook detected media
  if (message.type === 'MEDIA_DETECTED') {
    const tabId = sender.tab ? sender.tab.id : -1;
    if (tabId > 0 && message.data) {
      // 黑名单前置挡板：媒体域名或来源页域名命中 → 跳过，不进入嗅探存储。
      // sender.tab.url 由 tabs 权限提供，无需再 tabs.get。
      if (sniffBlacklist.size) {
        const pageUrl0 = (sender.tab && sender.tab.url) || '';
        if (matchBlacklist(message.data.url, pageUrl0)) {
          sendResponse({ success: true, skipped: true });
          return false;
        }
      }
      registerMediaItem(tabId, message.data).then(item => {
        sendResponse({ success: true, item });
      });
      return true;
    }
  }

  // Get sniffed media list for current tab
  if (message.type === 'GET_SNIFFED_MEDIA') {
    const tabId = message.tabId;
    const present = tabMediaStore.has(tabId) ? Array.from(tabMediaStore.get(tabId).values()) : [];
    if (present.length > 0 || tabId == null || tabId < 0) {
      // 注意：items 必须是原始（未归一化）对象，下载流程依赖 dedupeKey 等字段
      sendResponse({ success: true, items: present });
      return true;
    }
    // 内存为空 → 尝试按页面 URL 从持久化快照恢复（SW 被回收 / 浏览器重启后的第一次查询）
    hydrateSniffListForTab(tabId, () => {
      const items = tabMediaStore.has(tabId) ? Array.from(tabMediaStore.get(tabId).values()) : [];
      sendResponse({ success: true, items, hydrated: items.length > 0 });
    });
    return true;
  }

  // Clear sniffed media for tab
  if (message.type === 'CLEAR_SNIFFED_MEDIA') {
    const tabId = message.tabId;
    if (tabMediaStore.has(tabId)) {
      tabMediaStore.get(tabId).clear();
      updateBadge(tabId);
    }
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.url) dropSniffSnapshotFor(tab.url);
    });
    sendResponse({ success: true });
    return true;
  }

  // Generate CLI commands
  if (message.type === 'GENERATE_COMMANDS') {
    const commands = generateCliCommands(message.mediaItem);
    sendResponse({ success: true, commands });
    return true;
  }

  // Persistent history
  // 历史记录：按域名取用。不传 domain 时返回「全部域名」的汇总（用于总览/导出）。
  if (message.type === 'GET_HISTORY') {
    if (message.domain) {
      const list = historyStore[message.domain] || [];
      sendResponse({ success: true, domain: message.domain, items: list, domains: Object.keys(historyStore) });
      return true;
    }
    // 汇总：按「最近出现」从新到旧返回，便于导出/兼容旧调用
    const all = [];
    for (const d of Object.keys(historyStore)) {
      for (const it of (historyStore[d] || [])) all.push(it);
    }
    all.sort((a, b) => (b.lastSeen || b.time || 0) - (a.lastSeen || a.time || 0));
    sendResponse({ success: true, items: all, domains: Object.keys(historyStore) });
    return true;
  }

  // 安装/撤下「防盗链头注入」规则。三处调用：
  //   PREVIEW_RULES ← 侧边栏预览弹窗
  //   DNR_INSTALL   ← 离屏文档的下载流程（离屏只能访问 chrome.runtime，规则必须由后台装）
  //   DNR_CLEAR     ← 任务结束/关闭弹窗
  // 侧边栏与离屏都是扩展页面，直接把受保护直链塞进 <video> / fetch 会 403
  // （预览实测 code=4 DEMUXER_ERROR_COULD_NOT_PARSE），只能靠会话级 DNR 规则注入 Referer/Cookie。
  if (message.type === 'PREVIEW_RULES' || message.type === 'DNR_INSTALL' || message.type === 'DNR_CLEAR') {
    (async () => {
      try {
        if (message.type === 'DNR_CLEAR' || message.action === 'clear') {
          await clearPreviewRules();
          sendResponse({ success: true, cleared: true });
          return;
        }
        const injected = await installHeaderRule(message.mediaItem || {});
        sendResponse({ success: true, injected });
      } catch (e) {
        sendResponse({ success: false, error: e && e.message });
      }
    })();
    return true;
  }

  // 清空历史：可按域名清空（当前站点），不传则全部清空
  if (message.type === 'CLEAR_HISTORY') {
    historyMutatedSinceLoad = true;      // 标记：未完成的启动加载其快照已过期
    if (message.domain) {
      delete historyStore[message.domain];
    } else {
      historyStore = {};
    }
    // 立即落盘（不走 800ms 防抖），避免 SW 在防抖窗口内被回收导致清空丢失
    if (historyPersistTimer) { clearTimeout(historyPersistTimer); historyPersistTimer = null; }
    chrome.storage.local.set({ sniffHistory: historyStore }).catch(() => {});
    sendResponse({ success: true, domains: Object.keys(historyStore) });
    return true;
  }

  // Trigger in-browser download via Offscreen Document
  if (message.type === 'START_BROWSER_DOWNLOAD') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const taskId = (message.mediaItem && message.mediaItem.id) || `task_${Date.now()}`;
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'START_M3U8_DOWNLOAD',
          mediaItem: Object.assign({}, message.mediaItem, { id: taskId }),
          options: message.options || {}
        });
        sendResponse({ success: true, taskId, message: '下载任务已提交至后台处理引擎' });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Trigger multi-TS merge download via Offscreen Document
  if (message.type === 'START_MERGE_TS_DOWNLOAD') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const taskId = `merge_${Date.now()}`;
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'START_MERGE_TS_DOWNLOAD',
          items: message.items,
          options: message.options || {},
          taskId
        });
        sendResponse({ success: true, taskId, message: '多切片合并任务已提交至后台处理引擎' });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Cancel a running download: route it to the offscreen engine that owns the AbortControllers
  if (message.type === 'CANCEL_DOWNLOAD') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'CANCEL_DOWNLOAD',
          taskId: message.taskId
        }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ success: true, result: res || {} });
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // ---- VPS 远程下载桥接：契约化的 6 个动作 ----
  // VPS_RESOLVE  探测播放列表（master 返回变体列表；media 返回可直接下的信息）
  // VPS_SUBMIT   提交下载任务（可带 batch：批量提交多条）
  // VPS_TASKS    拉取任务列表
  // VPS_CANCEL   取消任务
  // VPS_RETRY    重试任务
  // VPS_TEST     连通性测试（用 /tasks 验证 Token 与地址，不会真的下载）
  if (message.type && message.type.startsWith('VPS_')) {
    (async () => {
      // 兜底：任何未预期异常也要 sendResponse，否则前端回调永不触发、UI 永久卡住
      try {
        const cfg = Object.assign({}, await getVpsConfig(), message.config || {});

        if (message.type === 'VPS_RESOLVE') {
          const it = message.item || {};
          if (!it.url) { sendResponse({ success: false, error: '缺少 m3u8 地址' }); return; }
          const r = await vpsResolve(cfg, it);
          sendResponse({ success: r.ok, result: r, data: r.data || null, error: r.error || '' });
          return;
        }

        if (message.type === 'VPS_SUBMIT') {
          const list = Array.isArray(message.items) ? message.items : [message.item || {}];
          const valid = list.filter(it => it && it.url &&
            it.url !== '(未捕获)' && it.url !== '(未提取到)');
          if (!valid.length) {
            sendResponse({ success: false, error: '没有可提交的有效链接', results: [] });
            return;
          }
          const results = [];
          let okCount = 0;
          for (let i = 0; i < valid.length; i++) {
            const it = valid[i];
            const r = await vpsSubmit(cfg, it);
            if (r.ok) okCount++;
            results.push({
              url: it.url,
              title: it.title || it.pageTitle || '',
              episode: it.episode || '',
              ok: r.ok,
              status: r.status || 0,
              error: r.error || '',
              errorKind: r.errorKind || '',
              taskId: (r.data && r.data.task_id) || '',
              duplicate: !!(r.data && r.data.duplicate),
              state: (r.data && r.data.state) || '',
              message: (r.data && r.data.message) || ''
            });
            // 遵守手动限速，避免高频被服务端 429 限流
            const gap = Math.max(0, Number(message.rateLimit ?? 0) || 0);
            if (gap > 0 && i < valid.length - 1) {
              await new Promise(res => setTimeout(res, gap));
            }
          }
          sendResponse({ success: okCount > 0, okCount, total: valid.length, results });
          return;
        }

        if (message.type === 'VPS_TASKS') {
          const r = await vpsTasks(cfg, message.limit);
          sendResponse({
            success: r.ok,
            error: r.error || '',
            errorKind: r.errorKind || '',
            active: (r.data && r.data.active) || 0,
            tasks: (r.data && r.data.tasks) || []
          });
          return;
        }

        if (message.type === 'VPS_CANCEL' || message.type === 'VPS_RETRY') {
          const taskId = message.taskId;
          if (!taskId) { sendResponse({ success: false, error: '缺少 task_id' }); return; }
          const r = message.type === 'VPS_CANCEL'
            ? await vpsCancel(cfg, taskId)
            : await vpsRetry(cfg, taskId);
          sendResponse({
            success: r.ok,
            error: r.error || '',
            errorKind: r.errorKind || '',
            message: (r.data && r.data.message) || ''
          });
          return;
        }

        if (message.type === 'VPS_TEST') {
          // 用 /tasks 做探测：既验证地址可达、又验证 X-Ext-Token 是否正确，
          // 且不会真的触发一次下载（避免污染任务队列）。
          const r = await vpsTasks(cfg, 1);
          let requestUrl = '';
          try { requestUrl = vpsNormalizeBase(cfg.baseUrl) + VPS_API_PREFIX + '/tasks'; } catch (e) {}
          sendResponse({
            success: r.ok,
            error: r.error || '',
            errorKind: r.errorKind || '',
            status: r.status || 0,
            elapsed: r.elapsed || 0,
            active: (r.data && r.data.active) || 0,
            taskCount: (r.data && r.data.tasks) ? r.data.tasks.length : 0,
            requestUrl
          });
          return;
        }

        sendResponse({ success: false, error: '未知的 VPS 动作：' + message.type });
      } catch (err) {
        sendResponse({ success: false, error: (err && err.message) || String(err) });
      }
    })();
    return true;
  }


  // Forward offscreen download progress to sidepanel
  if (message.target === 'sidepanel' && message.type === 'DOWNLOAD_PROGRESS') {
    // Broadcast to UI
    chrome.runtime.sendMessage(message).catch(() => {});
  }
});
