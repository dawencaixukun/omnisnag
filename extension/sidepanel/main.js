/**
 * OmniSnag - SidePanel Main Logic
 * Manages UI tabs, media list rendering, link filtering/exporting, batch collection, and settings.
 */

// Application State
const state = {
  activeTabId: null,
  batchRunning: false,
  embeddedTabId: null,
  activeTabUrl: '',
  activeTabTitle: '',
  mediaItems: [],
  foldTs: true,
  expandedTsGroups: new Set(),
  historyItems: [],
  historyQuery: '',
  historyDomain: '',        // 当前展示的历史域名
  historyDomains: [],       // 后台已有历史的全部域名（仅用于统计提示）
  // 侧边栏自己成为「当前活动标签页」时（域名变成扩展 ID），用它记住上一个真实站点，
  // 否则历史面板会拿扩展 ID 去查历史，永远显示「暂无记录」。
  lastSiteDomain: '',
  lastSiteUrl: '',
  historyShowAllLimit: 80,  // 单次最多渲染条数，防止一次铺开几百条
  historyClearedAt: null,   // { domain, at }：清空后的墓碑，避免轮询把旧数据拉回
  _uiDialogResolve: null,   // 面板内弹窗的 Promise 结算函数
  activeCliTool: 'n_m3u8dl',
  // 当前下载任务：taskId 用于取消（离屏引擎按 taskId 索引 AbortController）
  currentTaskId: null,
  cancelRequested: false,
  // 正在推送 VPS：用于重入保护，避免重复点击把整批再发一遍
  vpsPushing: false,
  // 下载任务看板
  vpsTasks: [],
  vpsTasksError: '',
  vpsActive: 0,
  vpsPollTimer: null,
  // 待用户选择清晰度的探测结果（master 时使用）
  vpsPendingPick: null,
  settings: {
    concurrency: 6,
    retries: 3,
    rateLimit: 1000,
    // VPS 远程下载桥接（接口契约已定稿：/api/ext/m3u8/* + X-Ext-Token）
    // 本项目主导路径是「放到 VPS 下载」，因此默认开启；浏览器内下载为备用。
    vps: {
      enabled: true,
      baseUrl: '',
      token: '',
      timeout: 20000,
      autoPush: false,
      pollMs: 2000
    }
  }
};


// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  // Register ALL real-time listeners FIRST (before any await) so they can never be skipped
  registerRealtimeListeners();

  // 页内抽屉弹窗（iframe）模式：向后台确认本 iframe 归属的标签，避免解析错目标
  const embedded = window.self !== window.top;
  if (embedded) {
    document.body.classList.add('embedded');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_MY_TAB_ID' });
      if (res && res.tabId != null) state.embeddedTabId = res.tabId;
    } catch (e) {}
  }

  await loadSettings();
  initNavigation();
  initSettingsEvents();
  initMediaEvents();
  initModals();
  initHistoryEvents();
  initBatchEvents();
  initVpsEvents();
  initUiDialog();
  initBlacklistEvents();

  // Get active tab and load media
  await refreshActiveTab();
  loadHistory();
});

// ---- Real-time layer: events + bulletproof signature polling ----
function registerRealtimeListeners() {
  // Broadcast from background: new media captured
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'MEDIA_LIST_UPDATED' && message.tabId === state.activeTabId) {
      scheduleMediaRefresh(); // debounced: coalesce burst segment events into one refresh
    }
    if (message.type === 'DOWNLOAD_PROGRESS' && message.target === 'sidepanel') {
      handleDownloadProgress(message);
    }
  });

  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      if (activeInfo.tabId !== state.activeTabId) {
        state.activeTabId = activeInfo.tabId;
        await refreshActiveTab();
      }
    });
  }

  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      if (tabId === state.activeTabId && (changeInfo.url || changeInfo.title)) {
        await refreshActiveTab();
      }
    });
  }

  if (chrome.windows && chrome.windows.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(async (winId) => {
      if (winId !== chrome.windows.WINDOW_ID_NONE) {
        await refreshActiveTab();
      }
    });
  }

  // Bulletproof poll every 1.5s: diff a cheap signature of the media list and
  // re-render ONLY when something changed. Guarantees live updates even if
  // runtime messages or tab events are ever missed.
  setInterval(async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) {
        const cur = tabs[0];
        if (cur.id !== state.activeTabId || cur.url !== state.activeTabUrl) {
          await refreshActiveTab();
        } else {
          chrome.runtime.sendMessage({ type: 'GET_SNIFFED_MEDIA', tabId: cur.id }, (res) => {
            if (res && res.success) {
              const items = res.items || [];
              if (mediaSignature(items) !== mediaSignature(state.mediaItems)) {
                state.mediaItems = items;
                renderMediaList();
              }
            }
          });
        }
      }
      if (isHistoryPanelActive()) {
        refreshHistorySilently();
      }
    } catch (e) {}
  }, 1500);
}

function mediaSignature(items) {
  let len = 0;
  for (const it of items) len += (it.url || '').length;
  return `${items.length}_${len}`;
}

// Debounced media refresh (memory & CPU friendly during long video streaming)
let mediaRefreshTimer = null;
function scheduleMediaRefresh() {
  if (mediaRefreshTimer) return;
  mediaRefreshTimer = setTimeout(() => {
    mediaRefreshTimer = null;
    loadMediaForActiveTab();
  }, 500);
}

// ---- 历史记录视图（只看「当前网页域名」）----
// 设计取舍：历史按来源域名隔离，本面板只展示当前标签页所属域名的那一份，
// 切到别的网站就展示那个网站的，互不串台；也不做跨域名的合并列表。
function isHistoryPanelActive() {
  const p = document.getElementById('panel-history');
  return !!(p && p.classList.contains('active'));
}

// 当前视图对应的历史域名（与后台 historyDomainOf 的口径保持一致）
function currentHistoryDomain() {
  const raw = state.activeTabUrl || '';
  try {
    const host = new URL(raw).hostname.toLowerCase();
    // 侧边栏/页内面板自身作为活动标签时，这里会解析出扩展 ID（或空 host），
    // 那不是用户在看视频的站点；退回上一次记录的真实站点域名。
    if (!host || raw.startsWith('chrome-extension://')) {
      return state.lastSiteDomain || '(未知来源)';
    }
    return host || '(未知来源)';
  } catch (e) {
    if (raw.startsWith('chrome-extension://')) return state.lastSiteDomain || '(未知来源)';
    return raw ? '(无法解析来源)' : (state.lastSiteDomain || '(未知来源)');
  }
}

function loadHistory() {
  const domain = currentHistoryDomain();
  chrome.runtime.sendMessage({ type: 'GET_HISTORY', domain }, (res) => {
    if (!res || !res.success) return;
    // 域名可能在等待响应期间又切换了，丢弃过期结果
    if (domain !== currentHistoryDomain()) return;
    applyHistoryItems(res.items || [], domain, res.domains || []);
  });
}

function refreshHistorySilently() {
  const domain = currentHistoryDomain();
  // 刚清空过的域名在短时间内不再接受轮询回填：清空消息与轮询是两条独立通道，
  // 若允许回填，用户会看到「已清空」提示与旧列表同时存在（甚至又冒出来）。
  if (state.historyClearedAt && state.historyClearedAt.domain === domain &&
      Date.now() - state.historyClearedAt.at < 15000) {
    return;
  }
  chrome.runtime.sendMessage({ type: 'GET_HISTORY', domain }, (res) => {
    if (!res || !res.success) return;
    if (domain !== currentHistoryDomain()) return;
    // 响应回来时若刚好清空过该域名，同样丢弃这次结果
    if (state.historyClearedAt && state.historyClearedAt.domain === domain &&
        Date.now() - state.historyClearedAt.at < 15000) {
      return;
    }
    const items = res.items || [];
    if (mediaSignature(items) !== mediaSignature(state.historyItems)) {
      applyHistoryItems(items, domain, res.domains || []);
    }
  });
}

function applyHistoryItems(items, domain, domains) {
  state.historyItems = items;
  state.historyDomain = domain || currentHistoryDomain();
  if (Array.isArray(domains)) state.historyDomains = domains;
  const badge = document.getElementById('historyCountBadge');
  const summary = document.getElementById('historyTotalSummary');
  if (badge) badge.textContent = items.length;
  if (summary) {
    summary.textContent = items.length
      ? `${state.historyDomain} · 共 ${items.length} 条`
      : `${state.historyDomain} · 暂无记录`;
  }
  renderHistoryList();
}


function getFilteredHistory() {
  const q = (state.historyQuery || '').toLowerCase().trim();
  if (!q) return state.historyItems;
  return state.historyItems.filter(i =>
    (i.pageTitle || '').toLowerCase().includes(q) ||
    (i.url || '').toLowerCase().includes(q) ||
    (i.pageUrl || '').toLowerCase().includes(q)
  );
}

// container.innerHTML = '' 会连同容器内的 .empty-state 一起移除。节点一旦脱离 DOM，
// document.getElementById 就再也找不到它，渲染函数随即在入口 return，列表会冻结在
// 上一帧 —— 典型症状就是「顶部已显示暂无记录，卡片却还挂在那里」。
// 因此首次拿到节点后缓存起来，之后每轮渲染重新挂回，不再依赖即时 DOM 查询。
const emptyStateNodes = new Map();
function ensureEmptyState(container, id) {
  let el = emptyStateNodes.get(id);
  if (!el) {
    el = document.getElementById(id);
    if (!el) {
      // 兜底：正常路径下 index.html 已提供完整结构（图标+标题+说明），
      // 这里只在节点意外缺失时造一个等价的最小结构，避免出现空白框。
      // 文案保持中性，因为它对历史/媒体两个容器都可能被调用。
      el = document.createElement('div');
      el.id = id;
      el.className = 'empty-state';
      const icon = document.createElement('div');
      icon.className = 'empty-icon';
      icon.textContent = '📭';
      const title = document.createElement('p');
      title.className = 'empty-title';
      title.textContent = '暂无数据';
      const desc = document.createElement('p');
      desc.className = 'empty-desc';
      desc.textContent = '';
      el.appendChild(icon);
      el.appendChild(title);
      el.appendChild(desc);
    }
    emptyStateNodes.set(id, el);
  }
  if (el.parentNode !== container) container.appendChild(el);
  return el;
}

function renderHistoryList() {
  const container = document.getElementById('historyList');
  if (!container) return;
  // 顺序很重要：必须在 container.innerHTML = '' 之前先取到并缓存空状态节点，
  // 否则它会被一起清掉，下一轮渲染直接中断（列表永远停在上一次的结果）。
  const empty = ensureEmptyState(container, 'historyEmptyState');
  const items = getFilteredHistory();
  container.innerHTML = '';
  if (items.length === 0) {
    empty.style.display = 'flex';
    // 提示当前看的是哪个域名的历史，避免误以为「记录丢了」
    const desc = empty.querySelector('.empty-desc');
    if (desc) {
      const total = state.historyItems.length;
      desc.textContent = state.historyQuery && total
        ? `当前域名 ${state.historyDomain} 有 ${total} 条记录，但没有匹配「${state.historyQuery}」的。`
        : `当前域名 ${state.historyDomain} 还没有记录。历史按域名隔离保存，切换到其他网站会显示那个网站的历史。`;
    }
    container.appendChild(empty);
    return;
  }
  empty.style.display = 'none';

  // 头部：当前域名 + 条数 + 折叠/展开全部（多时便于快速浏览）
  const bar = document.createElement('div');
  bar.className = 'history-bar';
  const overLimit = items.length > state.historyShowAllLimit;
  const shown = overLimit ? items.slice(0, state.historyShowAllLimit) : items;
  bar.innerHTML = `<span>${escapeHtml(state.historyDomain)} ｜ ${items.length} 条</span>`;
  if (overLimit) {
    const more = document.createElement('button');
    more.className = 'btn btn-sm btn-outline';
    more.textContent = `显示全部（还有 ${items.length - shown.length} 条）`;
    more.addEventListener('click', () => {
      state.historyShowAllLimit = items.length;
      renderHistoryList();
    });
    bar.appendChild(more);
  }
  container.appendChild(bar);

  groupMediaItems(shown).forEach(group => container.appendChild(buildGroupCard(group)));

  // 超出上限时只渲染前 N 条，避免一次创建上千个 DOM 节点
  if (overLimit) {
    const foot = document.createElement('div');
    foot.className = 'history-more-hint';
    foot.textContent = `为流畅显示，仅渲染前 ${shown.length} 条；点上方按钮展开全部。`;
    container.appendChild(foot);
  }
}

function initHistoryEvents() {
  const clearBtn = document.getElementById('btnClearHistory');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const domain = currentHistoryDomain();
      const okClear = await uiConfirm(
        `确定清空「${domain}」的历史记录？\n只影响这个网站，其他域名的历史会保留。`,
        { danger: true, title: '清空本站历史', okText: '清空' }
      );
      if (!okClear) return;
      // 打上墓碑：短时间内拒绝轮询回填该域名，避免旧数据被拉回来
      state.historyClearedAt = { domain, at: Date.now() };
      // 本地立刻清空（不等后台回调），UI 即时反馈
      applyHistoryItems([], domain);
      chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY', domain }, (res) => {
        if (!res || !res.success) {
          uiToast('清空失败，请重试', 'error');
          return;
        }
        uiToast(`已清空「${domain}」的历史`, 'success');
        // 用后台最终状态校正一次（防止内存与存储不一致时计数错位）
        loadHistory();
      });
    });
  }
  const copyBtn = document.getElementById('btnCopyAllHistory');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (state.historyItems.length === 0) { uiToast(`「${state.historyDomain}」暂无历史记录`, 'warn'); return; }
      copyText(state.historyItems.map(i => i.url).join('\n'),
        `已复制「${state.historyDomain}」的 ${state.historyItems.length} 条直链`);
    });
  }
  const search = document.getElementById('historySearchInput');
  if (search) {
    search.addEventListener('input', (e) => {
      state.historyQuery = e.target.value;
      renderHistoryList();
    });
  }
}


// 1. Tab Management
async function refreshActiveTab() {
  try {
    let tab = null;
    // 嵌入模式（页内抽屉弹窗）：iframe 的「当前窗口活动标签」不可靠，改为按宿主标签 ID 精确定位
    if (state.embeddedTabId != null) {
      try { tab = await chrome.tabs.get(state.embeddedTabId); } catch (e) { tab = null; }
    }
    if (!tab) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) tab = tabs[0];
    }
    if (tab) {
      state.activeTabId = tab.id;
      state.activeTabUrl = tab.url || '';
      state.activeTabTitle = tab.title || '';

      // 只在「真实站点」上更新站点记忆；侧边栏自身/扩展页不覆盖，
      // 这样历史面板在侧边栏获得焦点时仍能显示用户真正在看的那个站点的历史。
      if (tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
        try {
          state.lastSiteDomain = new URL(tab.url).hostname.toLowerCase() || state.lastSiteDomain;
          state.lastSiteUrl = tab.url;
        } catch (e) {}
      }

      const domainEl = document.getElementById('activeTabDomain');
      try {
        const u = new URL(tab.url);
        domainEl.textContent = `${u.hostname} - ${tab.title || '无标题'}`;
      } catch (e) {
        domainEl.textContent = tab.url || '当前标签页';
      }

      await loadMediaForActiveTab();
      // 域名变了就重取该域名的历史（历史按域名隔离，切站点必须换一份）
      if (currentHistoryDomain() !== state.historyDomain) {
        loadHistory();
      }
    }
  } catch (err) {
    console.error('Failed to get active tab:', err);
  }
}

// 2. Navigation Tabs
function initNavigation() {
  // 嵌入模式（页内抽屉弹窗）：关闭按钮三重通道通知宿主收起抽屉
  if (window.self !== window.top) {
    const requestClose = () => {
      // 通道 A：postMessage 直达宿主内容脚本（最可靠）
      try { window.parent.postMessage({ __omniSnag: 'closePopup' }, '*'); } catch (e) {}
      // 通道 B：经后台转发到宿主标签的内容脚本（兜底）
      try { chrome.runtime.sendMessage({ type: 'RELAY_TO_HOST_TAB', payload: { type: 'CLOSE_LINKS_POPUP' } }); } catch (e) {}
      // 通道 C：直接给内容脚本发消息（侧边栏等非 iframe 场景可用）
      try { chrome.runtime.sendMessage({ type: 'CLOSE_LINKS_POPUP' }); } catch (e) {}
    };

    const closeBtn = document.getElementById('btnCloseEmbedded');
    if (closeBtn) {
      closeBtn.style.display = 'flex';
      closeBtn.addEventListener('click', requestClose);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') requestClose();
    });
  }
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }
      if (targetId === 'panel-history') {
        loadHistory();
      }
      // 回到媒体页时刷新一次任务看板（按需，未启用 VPS 时是空操作）
      if (targetId === 'panel-media') {
        initVpsTaskBoard();
      }
    });
  });

  document.getElementById('btnRefreshTab').addEventListener('click', async () => {
    await refreshActiveTab();
  });
}

// 3. Settings Module
async function loadSettings() {
  try {
    const data = await chrome.storage.local.get(['snifferSettings']);
    if (data.snifferSettings) {
      const stored = data.snifferSettings;
      // vps 需深合并：只存了部分字段时不能丢掉其余默认值
      const storedVps = stored.vps || {};
      const mergedVps = Object.assign({}, state.settings.vps, storedVps);
      Object.assign(state.settings, stored);
      state.settings.vps = mergedVps;
    }
  } catch (e) {}

  // Apply to UI
  document.getElementById('settingConcurrency').value = state.settings.concurrency || 6;
  document.getElementById('valConcurrency').textContent = state.settings.concurrency || 6;
  document.getElementById('settingRetries').value = state.settings.retries || 3;
  document.getElementById('valRetries').textContent = state.settings.retries || 3;

  const rateLimit = Number.isFinite(state.settings.rateLimit) ? state.settings.rateLimit : 1000;
  document.getElementById('settingRateLimit').value = rateLimit;
  document.getElementById('valRateLimit').textContent = rateLimit;

  applyVpsSettingsToUi();
  updateVpsButtonsVisibility();
}

// 把 state.settings.vps 回填到 VPS 设置表单
function applyVpsSettingsToUi() {
  const v = state.settings.vps || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = (val === undefined || val === null) ? '' : val;
  };
  set('vpsEnabled', v.enabled);
  set('vpsBaseUrl', v.baseUrl);
  set('vpsToken', v.token);
  // 存储统一用毫秒（与后端 vpsClampTimeout 一致）；UI 滑块用秒。
  // 兼容早期把「秒」直接存进 storage 的值：小于 1000 视为秒。
  let timeoutMs = parseInt(v.timeout, 10) || 20000;
  if (timeoutMs < 1000) timeoutMs *= 1000;
  timeoutMs = Math.min(120000, Math.max(5000, timeoutMs));
  const timeoutSec = Math.round(timeoutMs / 1000);
  set('vpsTimeout', timeoutSec);
  const timeoutLbl = document.getElementById('valVpsTimeout');
  if (timeoutLbl) timeoutLbl.textContent = timeoutSec;
  set('vpsAutoPush', v.autoPush);
  const pollEl = document.getElementById('vpsAutoPoll');
  if (pollEl) pollEl.checked = !!v.autoPoll;
}

// 从 VPS 设置表单收集为配置对象（供保存与连通性测试共用）
function collectVpsSettingsFromUi() {
  const $ = (id) => document.getElementById(id);
  // baseUrl 允许用户粘贴含 /api/ext/m3u8 的完整地址，这里顺带裁掉
  const baseUrl = ($('vpsBaseUrl') ? $('vpsBaseUrl').value : '')
    .trim().replace(/\/+$/, '').replace(/\/api\/ext\/m3u8.*$/i, '');
  return {
    enabled: $('vpsEnabled') ? $('vpsEnabled').checked : false,
    baseUrl,
    token: ($('vpsToken') ? $('vpsToken').value : '').trim(),
    // 存毫秒，与后端 vpsClampTimeout 的超时单位保持一致
    timeout: Math.min(120000, Math.max(5000,
      (parseInt($('vpsTimeout') ? $('vpsTimeout').value : '20', 10) || 20) * 1000)),
    autoPush: $('vpsAutoPush') ? $('vpsAutoPush').checked : false,
    autoPoll: $('vpsAutoPoll') ? $('vpsAutoPoll').checked : true,
    pollMs: 2000
  };
}

// ---- 嗅探黑名单（设置面板）----
// 数据存 chrome.storage.local 的 sniffBlacklist（string[]，已归一化域名），
// 侧边栏直接读写；后台通过 storage.onChanged 同步进内存并拦截嗅探。
// 与后台 normalizeBlacklistEntry 保持同一套归一化规则。
function normalizeBlacklistEntry(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s) || s.startsWith('//')) {
    try { s = new URL(s.includes('://') ? s : 'http:' + s).hostname; } catch (e) { /* 兜底 */ }
  } else if (s.includes('/')) {
    try { s = new URL('http://' + s).hostname; } catch (e) { s = s.split('/')[0]; }
  }
  s = s.replace(/^\*\./, '').replace(/\.+$/, '').trim();
  if (!s || s.length > 253) return '';
  if (/[\s@:/?#]/.test(s)) return '';
  return s;
}

async function loadBlacklist() {
  try {
    const res = await chrome.storage.local.get(['sniffBlacklist']);
    const arr = res && res.sniffBlacklist;
    state.blacklist = Array.isArray(arr)
      ? [...new Set(arr.map(normalizeBlacklistEntry).filter(Boolean))]
      : [];
  } catch (e) {
    state.blacklist = [];
  }
  renderBlacklist();
}

function persistBlacklist() {
  try {
    chrome.storage.local.set({ sniffBlacklist: state.blacklist }).catch(() => {});
  } catch (e) {}
}

// 大列表保护：黑名单可能有几千上万条（storage.local 10MB 配额完全装得下），
// 但每次增删都全量重建上万个 DOM 节点会把侧边栏卡死。因此：
//   * 默认只渲染前 BL_RENDER_CAP 条，其余收进「显示全部」按钮；
//   * 搜索框即时过滤，命中的条目按同一上限渲染；
//   * 行构建用 DocumentFragment 一次性挂载。
const BL_RENDER_CAP = 300;
let blShowAll = false;

function renderBlacklist() {
  const listEl = document.getElementById('blList');
  const countEl = document.getElementById('blCount');
  const matchEl = document.getElementById('blMatchInfo');
  const searchEl = document.getElementById('blSearchInput');
  const items = state.blacklist || [];
  if (countEl) countEl.textContent = String(items.length);
  if (!listEl) return;
  const kw = String((searchEl && searchEl.value) || '').trim().toLowerCase();
  const matched = kw ? items.filter(e => e.indexOf(kw) !== -1) : items;
  if (matchEl) matchEl.textContent = kw ? `（筛选命中 ${matched.length} 条）` : '';
  listEl.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bl-empty';
    empty.textContent = '黑名单为空。所有网站的媒体资源都会正常嗅探。';
    listEl.appendChild(empty);
    return;
  }
  if (kw && matched.length === 0) {
    const nomatch = document.createElement('div');
    nomatch.className = 'bl-empty';
    nomatch.textContent = '没有匹配「' + kw + '」的条目。';
    listEl.appendChild(nomatch);
    return;
  }
  const cap = blShowAll ? matched.length : BL_RENDER_CAP;
  const frag = document.createDocumentFragment();
  matched.slice(0, cap).forEach(entry => {
    const row = document.createElement('div');
    row.className = 'bl-item';
    const name = document.createElement('span');
    name.className = 'bl-item-host';
    name.textContent = entry;
    name.title = '匹配 ' + entry + ' 及其全部子域';
    const del = document.createElement('button');
    del.className = 'bl-item-del';
    del.textContent = '✕';
    del.title = '从黑名单移除 ' + entry;
    del.addEventListener('click', () => removeBlacklistEntry(entry));
    row.appendChild(name);
    row.appendChild(del);
    frag.appendChild(row);
  });
  if (matched.length > cap) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'bl-more';
    more.textContent = `显示全部 ${matched.length} 条（当前仅渲染前 ${cap} 条）`;
    more.addEventListener('click', () => { blShowAll = true; renderBlacklist(); });
    frag.appendChild(more);
  }
  listEl.appendChild(frag);
}

// 手动添加：接受域名或 URL（URL 自动提取域名）
function addBlacklistEntry(raw) {
  const entry = normalizeBlacklistEntry(raw);
  if (!entry) {
    uiToast('无法识别域名：' + String(raw || '').trim().slice(0, 40), 'error');
    return false;
  }
  if ((state.blacklist || []).includes(entry)) {
    uiToast('已在黑名单中：' + entry, 'warn');
    return false;
  }
  state.blacklist.push(entry);
  persistBlacklist();
  renderBlacklist();
  uiToast('已加入黑名单：' + entry, 'success');
  return true;
}

// 从 URL 导入：每行一条（URL 或域名均可），自动提取域名并去重。
// 返回统计 { added, dup, invalid }，供汇总提示。
function importBlacklistFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    uiToast('请先在文本框中粘贴要导入的 URL 或域名（每行一条）', 'warn');
    return null;
  }
  // 去重用 Set：导入是 O(新增+已有)，不能对每行做 includes 线性扫描
  //（1 万已有 × 1 万导入 = 1 亿次比较，会明显卡顿）。
  const existing = new Set(state.blacklist || []);
  const added = [], dup = [], invalid = [];
  const seen = new Set();
  for (const line of lines) {
    const entry = normalizeBlacklistEntry(line);
    if (!entry) { invalid.push(line.slice(0, 60)); continue; }
    if (existing.has(entry) || seen.has(entry)) { dup.push(entry); continue; }
    seen.add(entry);
    added.push(entry);
  }
  if (added.length) {
    state.blacklist.push(...added);
    persistBlacklist();
    renderBlacklist();
  }
  return { added, dup, invalid };
}

function removeBlacklistEntry(entry) {
  state.blacklist = (state.blacklist || []).filter(e => e !== entry);
  persistBlacklist();
  renderBlacklist();
}

function initBlacklistEvents() {
  const addBtn = document.getElementById('blAddBtn');
  const input = document.getElementById('blManualInput');
  const importBtn = document.getElementById('blImportBtn');
  const importText = document.getElementById('blImportText');
  const clearBtn = document.getElementById('blClearAllBtn');

  const doAdd = () => {
    const v = input ? input.value : '';
    if (!String(v).trim()) { uiToast('请输入要屏蔽的域名或 URL', 'warn'); return; }
    if (addBlacklistEntry(v) && input) input.value = '';
  };

  // 搜索框：即时过滤列表（输入即渲染），切换关键词时收起「显示全部」状态
  const searchEl = document.getElementById('blSearchInput');
  if (searchEl) {
    searchEl.addEventListener('input', () => { blShowAll = false; renderBlacklist(); });
  }
  if (addBtn) addBtn.addEventListener('click', doAdd);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
    });
  }

  if (importBtn) {
    importBtn.addEventListener('click', () => {
      const stat = importBlacklistFromText(importText ? importText.value : '');
      if (!stat) return;
      if (importText) importText.value = '';
      const lines = [];
      lines.push(`导入完成：新增 ${stat.added.length} 条`);
      if (stat.dup.length) lines.push(`忽略重复 ${stat.dup.length} 条`);
      if (stat.invalid.length) lines.push(`无法识别 ${stat.invalid.length} 条`);
      uiAlert(lines.join('\n'), { title: '黑名单导入' });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const n = (state.blacklist || []).length;
      if (!n) { uiToast('黑名单已经是空的', 'warn'); return; }
      const ok = await uiConfirm(`确定清空全部 ${n} 条黑名单？\n清空后这些域名的媒体资源将恢复嗅探。`,
        { danger: true, title: '清空黑名单', okText: '清空' });
      if (!ok) return;
      state.blacklist = [];
      persistBlacklist();
      renderBlacklist();
      uiToast('黑名单已清空', 'success');
    });
  }

  loadBlacklist();
}


function initSettingsEvents() {

  const concurrencyInput = document.getElementById('settingConcurrency');
  concurrencyInput.addEventListener('input', (e) => {
    document.getElementById('valConcurrency').textContent = e.target.value;
  });

  const retriesInput = document.getElementById('settingRetries');
  retriesInput.addEventListener('input', (e) => {
    document.getElementById('valRetries').textContent = e.target.value;
  });

  const rateLimitInput = document.getElementById('settingRateLimit');
  rateLimitInput.addEventListener('input', (e) => {
    document.getElementById('valRateLimit').textContent = e.target.value;
  });

  const vpsTimeoutInput = document.getElementById('vpsTimeout');
  if (vpsTimeoutInput) {
    vpsTimeoutInput.addEventListener('input', (e) => {
      document.getElementById('valVpsTimeout').textContent = e.target.value;
    });
  }

  // VPS 连通性测试：用表单当前值（可能尚未保存）打一次 /tasks，
  // 既验证地址可达，又验证 X-Ext-Token 是否正确，且不会真的触发下载。
  const testVpsBtn = document.getElementById('btnTestVps');
  if (testVpsBtn) {
    testVpsBtn.addEventListener('click', () => {
      const out = document.getElementById('vpsTestResult');
      const cfg = collectVpsSettingsFromUi();
      if (!cfg.baseUrl) {
        out.style.display = 'block';
        out.style.color = 'var(--danger)';
        out.textContent = '✗ 请先填写服务器地址';
        return;
      }
      if (!cfg.token) {
        out.style.display = 'block';
        out.style.color = 'var(--danger)';
        out.textContent = '✗ 请先填写插件 Token（服务端 .ext_token 文件里的值）';
        return;
      }
      testVpsBtn.disabled = true;
      out.style.display = 'block';
      out.style.color = 'var(--text-secondary)';
      out.textContent = `⏳ 正在请求 ${cfg.baseUrl}/api/ext/m3u8/tasks ...`;

      chrome.runtime.sendMessage({ type: 'VPS_TEST', config: cfg }, (res) => {
        testVpsBtn.disabled = false;
        if (chrome.runtime.lastError) {
          out.style.color = 'var(--danger)';
          out.textContent = `✗ 消息通道错误：${chrome.runtime.lastError.message}`;
          return;
        }
        if (res && res.success) {
          out.style.color = 'var(--success)';
          out.textContent =
            `✓ 连通成功 — 地址与 Token 均有效（HTTP ${res.status}，${res.elapsed}ms）\n` +
            `当前进行中任务 ${res.active} 个，本次返回任务 ${res.taskCount} 条。`;
        } else {
          out.style.color = 'var(--danger)';
          const kind = res && res.errorKind ? res.errorKind : '';
          const hint = kind === 'auth' ? '\n👉 请核对服务端 .ext_token 与这里填写的 Token 是否一致。'
                     : kind === 'network' ? '\n👉 请确认服务已启动、地址端口正确，且 https 页面不能被 http 接口拦混合内容。'
                     : kind === 'timeout' ? '\n👉 可在上方调大请求超时后重试。'
                     : '';
          out.textContent = `✗ 连通失败：${(res && res.error) || '未知错误'}${hint}` +
            (res && res.requestUrl ? `\n请求地址：${res.requestUrl}` : '');
        }
      });
    });
  }

  // 任务看板：手动刷新 + 轮询开关
  const refreshBtn = document.getElementById('btnVpsRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => fetchVpsTasks(true));
  const pollBtn = document.getElementById('btnVpsTogglePoll');
  if (pollBtn) {
    pollBtn.addEventListener('click', () => {
      const on = pollBtn.getAttribute('data-on') === '1';
      setVpsPolling(!on);
    });
  }

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    state.settings.concurrency = parseInt(document.getElementById('settingConcurrency').value, 10);
    state.settings.retries = parseInt(document.getElementById('settingRetries').value, 10);
    const rlVal = parseInt(document.getElementById('settingRateLimit').value, 10);
    state.settings.rateLimit = Number.isFinite(rlVal) && rlVal >= 0 ? rlVal : 1000;
    state.settings.vps = collectVpsSettingsFromUi();

    await chrome.storage.local.set({ snifferSettings: state.settings });

    applyVpsSettingsToUi();
    updateVpsButtonsVisibility();
    // 启用状态可能刚变化，重渲染卡片让「探测并推送」按钮立即出现/消失
    renderMediaList();
    // 若本次保存后开着轮询，按新配置重启轮询；否则停表
    setVpsPolling(!!state.settings.vps.autoPoll && !!state.settings.vps.enabled);

    const toast = document.getElementById('saveStatusToast');
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 2000);
  });
}


// 4. Media Sniffer (Panel 1)
async function loadMediaForActiveTab() {
  if (!state.activeTabId) return;

  chrome.runtime.sendMessage({
    type: 'GET_SNIFFED_MEDIA',
    tabId: state.activeTabId
  }, (response) => {
    if (response && response.success) {
      state.mediaItems = response.items || [];
      renderMediaList();
    }
  });
}

// URL directory helper (strip last path segment)
function tsDirOf(url) {
  try {
    const u = new URL(url);
    const idx = u.pathname.lastIndexOf('/');
    return u.origin + u.pathname.slice(0, idx + 1);
  } catch (e) {
    return url;
  }
}

// Short display for TS segments (last path segment)
function shortUrlOf(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').pop() || u.pathname;
    return seg.slice(0, 40);
  } catch (e) {
    return String(url).slice(0, 40);
  }
}

function fmtBytesTotal(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

// 分片类：这些类型的资源不能单独播放，必须折叠进所属播放列表或聚成一组。
const SEGMENT_TYPES = new Set(['ts', 'm4s', 'init']);
function isSegmentType(t) {
  return SEGMENT_TYPES.has(t);
}

// 与后台 mediaAssetRootOf 保持同一口径，确保前后端归组结果一致。
// X/Twitter：…/ext_tw_video/{media_id}/… —— 播放列表在 pu/pl、分片在 pu/vid，
// 若只比对同目录，一个帖子的分片会散成一堆独立卡片（即「反复添加」的观感）。
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

// 该条目能不能直接播放/保存成完整视频。
// 分片（ts/m4s）与初始化段（init）都不行：前者是切片，后者只有 moov 元数据。
function isPlayableItem(item) {
  if (!item) return false;
  if (typeof item.playable === 'boolean') return item.playable;
  return !isSegmentType(item.type);
}

// 归组：把分片挂到「同一个作品」的主播放列表下。
// 先按资源根目录精确匹配，其次按祖先目录匹配，最后才退化到同主机。
// 顺序非常关键 —— 用同主机兜底会把别的视频的分片误吸进来，宁可不匹配。
function groupMediaItems(items) {
  const groups = [];
  const usedTs = new Set();

  const masters = items.filter(i => i.type === 'm3u8' || i.type === 'mpd');
  const tsItems = items.filter(i => isSegmentType(i.type));
  const otherItems = items.filter(i => !isSegmentType(i.type) && i.type !== 'm3u8' && i.type !== 'mpd');

  masters.forEach(m => {
    const mRoot = mediaAssetRootOf(m.url);
    let matched = tsItems.filter(t => !usedTs.has(t.url) && mediaAssetRootOf(t.url) === mRoot);
    // 退化：分片 URL 落在某个播放列表的目录之下（X 的 pl/ 与 vid/ 不共享目录）
    if (matched.length === 0) {
      matched = tsItems.filter(t => !usedTs.has(t.url) && String(t.url).startsWith(mRoot));
    }
    matched.forEach(t => usedTs.add(t.url));
    groups.push({ kind: 'm3u8', main: m, tsList: matched });
  });

  // 剩余的孤儿分片：按资源根目录聚成一组，而不是每个分片一张卡片
  const rootMap = new Map();
  tsItems.filter(t => !usedTs.has(t.url)).forEach(t => {
    const r = mediaAssetRootOf(t.url);
    if (!rootMap.has(r)) rootMap.set(r, []);
    rootMap.get(r).push(t);
  });
  rootMap.forEach(list => {
    groups.push({ kind: 'ts-group', main: list[0], tsList: list });
  });

  otherItems.forEach(o => groups.push({ kind: 'single', main: o, tsList: [] }));

  // 排序：可直接播放的成品排在前面，不可单独播放的分片组沉底。
  // 这样用户第一眼看到的就是「能用的」，片段不再淹没列表。
  groups.sort((a, b) => {
    const pa = a.kind === 'ts-group' ? 1 : 0;
    const pb = b.kind === 'ts-group' ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return (b.main.timestamp || 0) - (a.main.timestamp || 0);
  });

  return groups;
}

function renderMediaList() {
  const container = document.getElementById('mediaList');
  if (!container) return;
  // 同 renderHistoryList：空状态节点是容器的子节点，会被 innerHTML = '' 一并删除，
  // 因此必须先缓存并在每轮渲染重新挂回，否则第二轮就取不到节点、渲染中途抛错。
  const emptyState = ensureEmptyState(container, 'mediaEmptyState');
  const countBadge = document.getElementById('mediaCountBadge');
  const summaryEl = document.getElementById('mediaTotalSummary');

  const count = state.mediaItems.length;
  if (countBadge) countBadge.textContent = count;
  if (summaryEl) summaryEl.textContent = `共 ${count} 个流媒体资源`;

  if (count === 0) {
    emptyState.style.display = 'flex';
    container.innerHTML = '';
    container.appendChild(emptyState);
    return;
  }

  emptyState.style.display = 'none';
  container.innerHTML = '';

  const groups = groupMediaItems(state.mediaItems);
  groups.forEach(group => {
    container.appendChild(buildGroupCard(group));
  });
}

function buildGroupCard(group) {
  const item = group.main;
  const tsList = group.tsList || [];
  const card = document.createElement('div');
  card.className = 'media-card';

  // 绿色标签只在真实捕获到 Cookie 或 Authorization 时显示；仅有 Referer/UA 属常规请求头，不算鉴权
  const h = item.headers || {};
  const hasCredential = !!(h.cookie || h.authorization);
  const hasReferer = !!h.referer;
  const isM3u8 = group.kind === 'm3u8';
  const isTsGroup = group.kind === 'ts-group';
  const showFold = state.foldTs && tsList.length > 0;
  // 折叠状态以「资源根目录」为键，与归组口径一致（切换域名/作品不会串台）
  const groupKey = mediaAssetRootOf(item.url);
  const isGroupOpen = state.expandedTsGroups.has(groupKey);
  const totalTsBytes = tsList.reduce((s, t) => s + (t.contentLength || 0), 0);

  // 分片组的真实构成：可能混着 .ts / .m4s / 初始化段
  const segTypes = new Set(tsList.map(t => t.type));
  const hasInit = segTypes.has('init');
  const allM4s = tsList.length > 0 && tsList.every(t => t.type === 'm4s' || t.type === 'init');
  const badgeType = isTsGroup ? (allM4s ? 'm4s' : 'ts') : item.type;
  const track = item.track || '';
  const playable = isPlayableItem(item);

  // 标题要说清「这是什么」。分片组不是一个能直接用的文件，必须讲明白。
  let displayTitle;
  if (isTsGroup) {
    const kindLabel = allM4s ? 'fMP4 分片组' : 'TS 分片组';
    displayTitle = `${kindLabel}（${tsList.length} 个分片，需合并）`;
  } else {
    displayTitle = item.pageTitle || '流媒体资源';
  }

  const foldedBoxHtml = showFold ? `
      <div class="ts-folded-box">
        <div class="ts-folded-header">
          <span>📦 已关联 ${tsList.length} 个切片 ${totalTsBytes ? `(共 ${fmtBytesTotal(totalTsBytes)})` : ''}</span>
          <button class="btn-toggle-ts btn-ts-toggle">${isGroupOpen ? '收起列表' : '展开列表'}</button>
        </div>
        <div class="ts-folded-list" style="${isGroupOpen ? 'display: flex;' : 'display: none;'}">
          ${tsList.map(t => `<div class="ts-folded-item"><span title="${escapeHtml(t.url)}">${escapeHtml(shortUrlOf(t.url))}</span><span>${t.formattedSize || ''}</span></div>`).join('')}
        </div>
      </div>` : '';

  let actionsHtml;
  if (isTsGroup) {
    actionsHtml = `
      <div class="card-actions">
        <button class="btn btn-sm btn-primary btn-merge-ts">🧩 合并${tsList.length}片为MP4</button>
        <button class="btn btn-sm btn-outline btn-cli" data-id="${item.id}">⚡ 传参导出(CLI)</button>
        <button class="btn btn-sm btn-outline btn-copy-group">📋 复制全部切片</button>
      </div>`;
  } else if (isM3u8) {
    actionsHtml = `
      <div class="card-actions">
        <button class="btn btn-sm btn-outline btn-preview" data-id="${item.id}">🎬 预览</button>
        ${vpsButtonHtml()}
        ${tsList.length ? `<button class="btn btn-sm btn-outline btn-merge-ts">🧩 合并${tsList.length}片为MP4</button>` : ''}
        ${browserDownloadButtonHtml('btn-download')}
        <button class="btn btn-sm btn-outline btn-cli" data-id="${item.id}">⚡ 传参导出(CLI)</button>
        <button class="btn btn-sm btn-outline btn-copy-url" data-id="${item.id}">📋 复制直链</button>
      </div>`;
  } else {
    actionsHtml = `
      <div class="card-actions">
        <button class="btn btn-sm btn-outline btn-preview" data-id="${item.id}">🎬 预览</button>
        ${vpsButtonHtml()}
        ${browserDownloadButtonHtml('btn-download')}
        <button class="btn btn-sm btn-outline btn-cli" data-id="${item.id}">⚡ 传参导出(CLI)</button>
        <button class="btn btn-sm btn-outline btn-copy-url" data-id="${item.id}">📋 复制直链</button>
      </div>`;
  }

  card.innerHTML = `
      <div class="card-header">
        <span class="format-badge badge-${badgeType}">${badgeType}</span>
        <span class="card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</span>
        <span class="card-size">${item.formattedSize || ''}</span>
      </div>
      <div class="card-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
      <div class="card-tags">
        ${hasCredential
          ? `<span class="tag-pill tag-auth">✓ 已捕获鉴权凭据（${[h.cookie ? 'Cookie' : '', h.authorization ? 'Authorization' : ''].filter(Boolean).join(' + ')}）</span>`
          : (hasReferer
              ? '<span class="tag-pill tag-referer">↪ 仅 Referer 防盗链（无 Cookie/Token）</span>'
              : '<span class="tag-pill">无特殊防盗链</span>')}
        ${isM3u8 ? '<span class="tag-pill tag-key">⚡ 支持自适应切片与 AES 解密</span>' : ''}
        ${isTsGroup ? '<span class="tag-pill tag-highlight">🧩 支持多切片合并为单个完整视频</span>' : ''}
        ${hasInit ? '<span class="tag-pill tag-warn">⛔ 含初始化段（仅 moov 元数据，不能单独播放）</span>' : ''}
        ${(track === 'video' || track === 'audio')
          ? `<span class="tag-pill tag-warn">${track === 'video'
              ? '⚠️ 仅视频轨（此流无声音，需搭配同作品的音频轨）'
              : '⚠️ 仅音频轨（此流无画面）'}</span>`
          : ''}
        ${(!isTsGroup && !playable)
          ? '<span class="tag-pill tag-warn">⛔ 这是流片段，不能单独播放或另存为完整视频</span>'
          : ''}
        ${item.tsCount ? `<span class="tag-pill tag-highlight">📦 已折叠 ${item.tsCount} 个切片${item.tsBytes ? `（${fmtBytesTotal(item.tsBytes)}）` : ''}</span>` : ''}
        ${item.seenCount > 1 ? `<span class="tag-pill">🔁 出现 ${item.seenCount} 次</span>` : ''}
        ${item.contentType ? `<span class="tag-pill">${escapeHtml(item.contentType)}</span>` : ''}
      </div>
      ${foldedBoxHtml}
      ${actionsHtml}
  `;

  // TS fold toggle
  const toggleBtn = card.querySelector('.btn-ts-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const list = card.querySelector('.ts-folded-list');
      if (list) {
        const isOpen = list.style.display !== 'none';
        list.style.display = isOpen ? 'none' : 'flex';
        toggleBtn.textContent = isOpen ? '展开列表' : '收起列表';
        if (isOpen) state.expandedTsGroups.delete(groupKey);
        else state.expandedTsGroups.add(groupKey);
      }
    });
  }

  // Merge TS -> single MP4
  const mergeBtn = card.querySelector('.btn-merge-ts');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', () => triggerMergeTsDownload(tsList));
  }

  // Common buttons (skip for ts-group which has no single main item actions)
  const previewBtn = card.querySelector('.btn-preview');
  if (previewBtn) previewBtn.addEventListener('click', () => openPreviewModal(item));
  const downloadBtn = card.querySelector('.btn-download');
  if (downloadBtn) downloadBtn.addEventListener('click', () => triggerBrowserDownload(item));
  const cliBtn = card.querySelector('.btn-cli');
  if (cliBtn) cliBtn.addEventListener('click', () => openCliModal(isTsGroup ? item : item));
  const pushVpsBtn = card.querySelector('.btn-push-vps');
  if (pushVpsBtn) {
    pushVpsBtn.addEventListener('click', () => {
      // 单条走「探测 → (master 弹清晰度选择 / media 弹摘要) → 提交」
      pushVpsBtn.disabled = true;
      pushVpsBtn.textContent = '☁️ 探测中...';
      probeThenSubmit(item, {}).finally(() => {
        pushVpsBtn.disabled = false;
        pushVpsBtn.textContent = '☁️ 推送下载(主)';
      });
    });
  }
  const copyBtn = card.querySelector('.btn-copy-url');
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(item.url, '媒体直链已复制'));
  const copyGroupBtn = card.querySelector('.btn-copy-group');
  if (copyGroupBtn) {
    copyGroupBtn.addEventListener('click', () => {
      copyText(tsList.map(t => t.url).join('\n'), `已复制 ${tsList.length} 条切片直链`);
    });
  }

  return card;
}

// Merge TS segments into one MP4 via Offscreen engine
function triggerMergeTsDownload(tsList) {
  if (!tsList || tsList.length === 0) {
    uiToast('没有可合并的切片', 'warn');
    return;
  }
  // 必须把 type 一起传下去：离屏引擎据此判断走 fMP4 直接拼接还是 TS 转封装。
  // 同时把初始化段（moov）排到最前 —— fMP4 拼接要求它必须是第一个盒子，
  // 否则播放器读不到编解码信息，产出的文件打不开。
  const ordered = tsList.slice().sort((a, b) => {
    const rank = (t) => (t.type === 'init' ? 0 : 1);
    return rank(a) - rank(b);
  });
  const items = ordered.map(t => ({
    url: t.url,
    type: t.type || '',
    headers: t.headers || {},
    pageTitle: t.pageTitle || ''
  }));
  chrome.runtime.sendMessage({
    type: 'START_MERGE_TS_DOWNLOAD',
    items,
    options: {
      concurrency: state.settings.concurrency,
      retries: state.settings.retries,
      rateLimit: state.settings.rateLimit
    }
  }, (res) => {
    if (res && res.success) {
      state.currentTaskId = res.taskId || null;
      state.cancelRequested = false;
      const btn = document.getElementById('btnCancelDownload');
      if (btn) btn.disabled = false;
      const container = document.getElementById('downloadProgressContainer');
      container.style.display = 'block';
      document.getElementById('bannerTitle').textContent = `已启动 ${tsList.length} 片合并任务...`;
      document.getElementById('bannerProgressBar').style.width = '2%';
    } else {
      uiAlert(`启动合并失败: ${res ? res.error : '未知错误'}`, { kind: 'error', title: '合并失败' });
    }
  });
}

function initMediaEvents() {
  document.getElementById('btnClearMedia').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'CLEAR_SNIFFED_MEDIA',
      tabId: state.activeTabId
    }, () => {
      state.mediaItems = [];
      renderMediaList();
    });
  });

  document.getElementById('btnCopyAllMediaUrls').addEventListener('click', () => {
    if (state.mediaItems.length === 0) {
      uiToast('当前没有已嗅探的媒体', 'warn');
      return;
    }
    const allUrls = state.mediaItems.map(m => m.url).join('\n');
    copyText(allUrls, `已复制全部 ${state.mediaItems.length} 条直链`);
  });

  document.getElementById('btnCancelDownload').addEventListener('click', () => {
    const taskId = state.currentTaskId;
    if (!taskId) {
      // 没有在途任务，直接收起横幅
      document.getElementById('downloadProgressContainer').style.display = 'none';
      return;
    }
    state.cancelRequested = true;

    // 取消必须携带 taskId：离屏引擎按 taskId 查找 AbortController 并 abort()
    chrome.runtime.sendMessage({
      type: 'CANCEL_DOWNLOAD',
      taskId
    });

    // 给出即时反馈，但不隐藏横幅（等待引擎回传 aborted 状态）
    const title = document.getElementById('bannerTitle');
    const text = document.getElementById('bannerProgressText');
    const btn = document.getElementById('btnCancelDownload');
    if (title) title.textContent = '正在取消下载...';
    if (text) text.textContent = '等待引擎中止当前任务';
    if (btn) btn.disabled = true;
  });

  // TS folding toggle
  const chkFoldTs = document.getElementById('chkFoldTs');
  if (chkFoldTs) {
    chkFoldTs.addEventListener('change', (e) => {
      state.foldTs = e.target.checked;
      renderMediaList();
    });
  }
}

function handleDownloadProgress(msg) {
  const container = document.getElementById('downloadProgressContainer');
  const title = document.getElementById('bannerTitle');
  const speed = document.getElementById('bannerSpeed');
  const bar = document.getElementById('bannerProgressBar');
  const text = document.getElementById('bannerProgressText');
  const btn = document.getElementById('btnCancelDownload');

  // 记录/清理当前任务 id，供「取消」按钮使用
  if (msg.taskId) state.currentTaskId = msg.taskId;
  const finished = ['completed', 'error', 'aborted'].includes(msg.status);

  container.style.display = 'block';
  bar.style.width = `${msg.percent || 0}%`;
  title.textContent = msg.message || '正在处理...';
  speed.textContent = msg.speed || '';
  text.textContent = `进度: ${msg.percent || 0}% ${msg.downloaded ? `(${msg.downloaded}/${msg.total})` : ''}`;

  if (finished) {
    state.currentTaskId = null;
    state.cancelRequested = false;
    if (btn) btn.disabled = false;
    setTimeout(() => {
      container.style.display = 'none';
    }, 4000);
  } else if (btn) {
    // 任务进行中：确保取消按钮可点
    btn.disabled = false;
  }
}

function triggerBrowserDownload(item) {
  chrome.runtime.sendMessage({
    type: 'START_BROWSER_DOWNLOAD',
    mediaItem: item,
    options: {
      concurrency: state.settings.concurrency,
      retries: state.settings.retries,
      rateLimit: state.settings.rateLimit
    }
  }, (res) => {
    if (res && res.success) {
      // 离屏引擎以 mediaItem.id 作为 taskId
      state.currentTaskId = item.id || null;
      state.cancelRequested = false;
      const btn = document.getElementById('btnCancelDownload');
      if (btn) btn.disabled = false;
      const container = document.getElementById('downloadProgressContainer');
      container.style.display = 'block';
      document.getElementById('bannerTitle').textContent = '已启动后台下载任务...';
      document.getElementById('bannerProgressBar').style.width = '2%';
    } else {
      uiAlert(`启动下载失败: ${res ? res.error : '未知错误'}`, { kind: 'error', title: '下载失败' });
    }
  });
}

// 7. Modals: CLI Export & Video Preview
function initModals() {
  // CLI Modal
  document.getElementById('btnCloseCliModal').addEventListener('click', () => {
    document.getElementById('cliModal').style.display = 'none';
  });

  const cliTabs = document.querySelectorAll('.cli-tab');
  cliTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      cliTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeCliTool = tab.getAttribute('data-tool');
      updateCliOutput();
    });
  });

  document.getElementById('btnCopyCliCommand').addEventListener('click', () => {
    const code = document.getElementById('cliCodeOutput').value;
    copyText(code, '命令已复制到剪贴板');
  });

  // Video Preview Modal
  document.getElementById('btnClosePreviewModal').addEventListener('click', () => {
    const video = document.getElementById('previewVideoPlayer');
    video.pause();
    video.src = '';
    document.getElementById('previewModal').style.display = 'none';
    // 撤下预览用的头注入规则，避免离开弹窗后仍影响其他请求
    chrome.runtime.sendMessage({ type: 'PREVIEW_RULES', action: 'clear' }, () => void chrome.runtime.lastError);
  });
}

function openCliModal(mediaItem) {
  chrome.runtime.sendMessage({
    type: 'GENERATE_COMMANDS',
    mediaItem
  }, (res) => {
    if (res && res.success) {
      state.currentCliCommands = res.commands;
      updateCliOutput();
      document.getElementById('cliModal').style.display = 'flex';
    }
  });
}

function updateCliOutput() {
  if (!state.currentCliCommands) return;
  const tool = state.activeCliTool;
  const output = document.getElementById('cliCodeOutput');

  if (tool === 'n_m3u8dl') {
    output.value = state.currentCliCommands.n_m3u8dl;
  } else if (tool === 'ffmpeg') {
    output.value = state.currentCliCommands.ffmpeg;
  } else if (tool === 'curl') {
    output.value = state.currentCliCommands.curl;
  } else if (tool === 'aria2') {
    output.value = state.currentCliCommands.aria2;
  } else if (tool === 'headers') {
    output.value = state.currentCliCommands.headersJson;
  }
}

function openPreviewModal(mediaItem) {
  const modal = document.getElementById('previewModal');
  const video = document.getElementById('previewVideoPlayer');
  const title = document.getElementById('previewModalTitle');
  const urlEl = document.getElementById('previewModalUrl');

  title.textContent = `媒体预览: ${mediaItem.pageTitle || mediaItem.type}`;
  urlEl.textContent = mediaItem.url;
  video.src = mediaItem.url;
  modal.style.display = 'flex';

  // 受防盗链保护的直链在扩展页面里直接播放会 403（表现为 code=4 DEMUXER_ERROR_COULD_NOT_PARSE，
  // 播放器全黑且没有任何提示）。先让后台按嗅探到的 Referer/Cookie 注入规则再加载。
  video.addEventListener('error', function onErr() {
    if (video.error && video.error.code === 4) {
      uiToast('预览失败：该直链需要 Referer/Cookie 校验，已在尝试注入凭据后重试', 'warn');
    }
  }, { once: true });

  chrome.runtime.sendMessage({ type: 'PREVIEW_RULES', mediaItem }, (res) => {
    void chrome.runtime.lastError;
    // 规则装好后重新指向同一个地址，让请求带上凭据
    if (res && res.success && (res.injected || []).length) {
      const src = mediaItem.url;
      video.src = '';
      video.load();
      video.src = src;
      video.load();
      const playPromise = video.play();
      if (playPromise && playPromise.catch) playPromise.catch(() => {});
    }
  });
}

// ==================== 面板内弹窗 / 轻提示（替代原生 confirm / alert） ====================
// 原生 confirm/alert 由浏览器渲染：会挂在扩展面板之外、样式与暗色主题不符、
// 且 alert 会阻塞整个面板的 JS 执行。这里统一换成面板内的实现。

// 关闭当前确认弹窗并结算（resolve true/false）。重复调用安全。
function closeUiDialog(result) {
  const overlay = document.getElementById('uiDialog');
  if (overlay) overlay.style.display = 'none';
  const resolve = state._uiDialogResolve;
  state._uiDialogResolve = null;
  if (typeof resolve === 'function') resolve(!!result);
}

// 面板内确认框。返回 Promise<boolean>，调用处用 await 取值。
// opts: { title, icon, danger, okText, cancelText }
function uiConfirm(message, opts) {
  const o = opts || {};
  const overlay = document.getElementById('uiDialog');
  if (!overlay) return Promise.resolve(false);   // 面板结构缺失时保守返回「取消」

  // 若上一个弹窗还没结算，先按取消处理，避免其 Promise 永远悬空
  if (state._uiDialogResolve) closeUiDialog(false);

  const card = overlay.querySelector('.ui-dialog-card');
  const titleEl = document.getElementById('uiDialogTitle');
  const iconEl = document.getElementById('uiDialogIcon');
  const bodyEl = document.getElementById('uiDialogBody');
  const okBtn = document.getElementById('uiDialogOk');
  const cancelBtn = document.getElementById('uiDialogCancel');

  if (titleEl) titleEl.textContent = o.title || '请确认';
  if (iconEl) iconEl.textContent = o.icon || (o.danger ? '⚠️' : '❓');
  if (bodyEl) bodyEl.textContent = String(message == null ? '' : message);
  if (okBtn) okBtn.textContent = o.okText || '确定';
  if (cancelBtn) { cancelBtn.textContent = o.cancelText || '取消'; cancelBtn.style.display = ''; }
  if (card) card.classList.toggle('danger', !!o.danger);

  overlay.style.display = 'flex';
  setTimeout(() => { try { okBtn && okBtn.focus(); } catch (e) {} }, 0);

  return new Promise((resolve) => { state._uiDialogResolve = resolve; });
}

function copyText(text, successMsg = '已复制') {
  navigator.clipboard.writeText(text).then(() => {
    uiToast(successMsg, 'success');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    uiToast(successMsg, 'success');
  });
}

// 面板内提示框（仅一个「确定」）。返回 Promise，关闭后 resolve。
// opts: { title, icon, okText, danger, kind }
function uiAlert(message, opts) {
  const o = opts || {};
  const overlay = document.getElementById('uiDialog');
  if (!overlay) return Promise.resolve();
  if (state._uiDialogResolve) closeUiDialog(false);

  const card = overlay.querySelector('.ui-dialog-card');
  const titleEl = document.getElementById('uiDialogTitle');
  const iconEl = document.getElementById('uiDialogIcon');
  const bodyEl = document.getElementById('uiDialogBody');
  const okBtn = document.getElementById('uiDialogOk');
  const cancelBtn = document.getElementById('uiDialogCancel');

  if (titleEl) titleEl.textContent = o.title || '提示';
  if (iconEl) iconEl.textContent = o.icon || (o.kind === 'error' ? '✗' : o.kind === 'success' ? '✓' : 'ℹ️');
  if (bodyEl) bodyEl.textContent = String(message == null ? '' : message);
  if (okBtn) okBtn.textContent = o.okText || '知道了';
  if (cancelBtn) cancelBtn.style.display = 'none';   // 单按钮
  if (card) card.classList.toggle('danger', !!o.danger || o.kind === 'error');

  overlay.style.display = 'flex';
  setTimeout(() => { try { okBtn && okBtn.focus(); } catch (e) {} }, 0);

  return new Promise((resolve) => { state._uiDialogResolve = resolve; });
}

// 轻量提示条：不打断操作，自动消失。用于复制成功之类的高频反馈。
function uiToast(message, kind, ms) {
  const box = document.getElementById('uiToastBox');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'ui-toast' + (kind ? ' ' + kind : '');
  el.textContent = String(message == null ? '' : message);
  box.appendChild(el);
  const life = Math.max(1200, parseInt(ms, 10) || (kind === 'error' ? 4200 : 2200));
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 240);
  }, life);
}

// 绑定弹窗按钮：确定/取消/遮罩点击/Esc 都可关闭
function initUiDialog() {
  const overlay = document.getElementById('uiDialog');
  if (!overlay) return;
  const okBtn = document.getElementById('uiDialogOk');
  const cancelBtn = document.getElementById('uiDialogCancel');
  if (okBtn) okBtn.addEventListener('click', () => closeUiDialog(true));
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeUiDialog(false));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeUiDialog(false);   // 点遮罩 = 取消
  });
  // Esc 关闭（放在捕获阶段，优先于其他 Esc 处理，避免同时关掉别的面板）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (overlay.style.display !== 'flex') return;
    e.stopPropagation();
    closeUiDialog(false);
  }, true);
}


// Helpers
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


function copyText(text, successMsg = '已复制') {
  navigator.clipboard.writeText(text).then(() => {
    uiToast(successMsg, 'success');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    uiToast(successMsg, 'success');
  });
}

// ==================== VPS 远程下载推送 ====================
// 后端接口尚未定稿：地址 / 路径 / 方法 / Token / 请求头 / 请求体模板全部在设置里可配置，
// 实际请求由 Service Worker 发出（不受页面 CORS 限制）。接口定稿后无需改代码。

// ==================== VPS 远程下载桥接 ====================
// 契约：POST /api/ext/m3u8/resolve | /submit | /cancel | /retry，GET /api/ext/m3u8/tasks
// 所有请求带 X-Ext-Token 头。实际请求由 Service Worker 发出。

// ---- 格式化工具 ----
function formatSpeed(bps) {
  const n = Number(bps) || 0;
  if (n <= 0) return '—';
  if (n < 1024) return `${n.toFixed(0)} B/s`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB/s`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB/s`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, val = v;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDuration(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// state 取值 → 中文（queued|running|done|failed|cancelled）
const VPS_STATE_LABEL = {
  queued: '排队', running: '下载中', done: '已完成',
  failed: '失败', cancelled: '已取消'
};

function vpsStateLabel(st) {
  return VPS_STATE_LABEL[st] || st || '未知';
}

// 媒体卡片上的「探测并推送」按钮；未启用 VPS 时返回空串，按钮不渲染
function vpsButtonHtml() {
  const v = state.settings.vps || {};
  if (!v.enabled) return '';
  return '<button class="btn btn-sm btn-primary btn-push-vps" title="主路径：先探测播放列表（master 会弹出清晰度选择），再提交服务端下载">☁️ 推送下载(主)</button>';
}

// 浏览器内下载：已降级为次要路径（mux.js 在扩展里转封装，受内存与功耗限制）。
// 仍保留可用，但文案与样式上明确标为备用，避免误当成默认手段。
function browserDownloadButtonHtml(extraClass) {
  return `<button class="btn btn-sm btn-outline ${extraClass || ''}" title="备用路径：在浏览器内下载并用 mux.js 转封装为 MP4（大文件占内存）">⬇️ 浏览器下载</button>`;
}

// 批量面板按钮与任务看板的显隐
function updateVpsButtonsVisibility() {
  const v = state.settings.vps || {};
  const batchBtn = document.getElementById('btnPushBatchVps');
  if (batchBtn) batchBtn.style.display = v.enabled ? '' : 'none';
  const card = document.getElementById('vpsTasksCard');
  if (card) card.style.display = v.enabled ? '' : 'none';
  if (!v.enabled) setVpsPolling(false);
}

// 统一的「发消息给后台」封装：带看门狗，避免 SW 被回收时 Promise 永久悬空
function vpsSend(type, payload) {
  const cfg = state.settings.vps || {};
  let guardMs = (parseInt(cfg.timeout, 10) || 20000) + 5000;
  if (guardMs < 10000) guardMs = 10000;
  return Promise.race([
    new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, errorKind: 'channel',
                    error: '消息通道错误：' + chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { success: false, errorKind: 'empty', error: '后台无响应' });
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve({
      success: false, errorKind: 'timeout',
      error: `后台无响应（超过 ${Math.round(guardMs / 1000)} 秒，扩展可能已被重载）`
    }), guardMs))
  ]);
}

// 把失败结果转成可读提示（引导用户下一步动作）
function vpsErrorHint(res) {
  const kind = (res && res.errorKind) || '';
  if (kind === 'auth') return '（请到设置里核对 Token）';
  if (kind === 'rate') return '（服务端限流，稍后再试）';
  if (kind === 'config') return '（请先到设置里补全地址与 Token）';
  return '';
}

// ---- 探测 → 提交 ----
// master：手动时弹清晰度选择；自动时取最高码率。
// media：手动时弹信息摘要；自动时直接提交。
async function probeThenSubmit(item, opts) {
  const options = opts || {};
  const v = state.settings.vps || {};
  if (!String(v.baseUrl || '').trim()) {
    if (!options.silent) uiAlert('尚未填写服务器地址。\n请到「设置 → VPS 远程下载桥接」填写。', { kind: 'error', title: '未配置服务器' });
    return { ok: false, error: '未配置服务器地址' };
  }
  if (!String(v.token || '').trim()) {
    if (!options.silent) uiAlert('尚未填写插件 Token。\n请到「设置 → VPS 远程下载桥接」填写服务端 .ext_token 里的值。', { kind: 'error', title: '未配置 Token' });
    return { ok: false, error: '未配置 Token' };
  }

  const probe = await vpsSend('VPS_RESOLVE', { item });
  if (!probe.success) {
    const msg = (probe.error || '探测失败') + vpsErrorHint(probe);
    if (options.silent) console.warn('[OmniSnag] VPS 探测失败:', item.url, msg);
    else uiAlert(msg, { kind: 'error', title: '探测失败' });
    return { ok: false, error: msg, errorKind: probe.errorKind };
  }

  const d = probe.data || {};

  if (d.kind === 'master') {
    const variants = Array.isArray(d.variants) ? d.variants : [];
    if (!variants.length) {
      const msg = '服务端判定为主播放列表，但没有返回任何清晰度变体。';
      if (!options.silent) uiAlert(msg, { kind: 'error', title: '探测失败' });
      return { ok: false, error: msg };
    }
    if (options.autoPickHighest) {
      const best = variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      console.log('[OmniSnag] VPS 自动选最高清晰度:', best.name || best.resolution || best.url);
      return submitVariant(item, best, options);
    }
    openVariantPicker(variants, item);
    return { ok: true, pending: true };
  }

  if (d.kind === 'media') {
    if (options.silent) return submitVariant(item, null, options, d);
    openVpsInfoModal(d, item);
    return { ok: true, pending: true };
  }

  const msg = `服务端返回了未知的 kind：「${d.kind || '(空)'}」`;
  if (!options.silent) uiAlert(msg, { kind: 'error', title: '探测失败' });
  return { ok: false, error: msg };
}

// 提交单条（variant 为 null 表示直接用探测出的 media 列表地址）
async function submitVariant(item, variant, opts, mediaInfo) {
  const options = opts || {};
  const target = Object.assign({}, item,
    (variant && variant.url) ? { url: variant.url } : {});
  const res = await vpsSend('VPS_SUBMIT', { item: target });
  const r = (res && res.results && res.results[0]) || null;

  if (!res.success || !r || !r.ok) {
    const msg = (r && r.error) || res.error || '提交失败';
    if (options.silent) console.warn('[OmniSnag] VPS 提交失败:', target.url, msg);
    else uiAlert(msg + vpsErrorHint(r || res), { kind: 'error', title: '提交失败' });
    return { ok: false, error: msg };
  }

  const bits = [];
  if (r.duplicate) bits.push('服务端已有相同任务（未重复下载）');
  if (mediaInfo) {
    if (mediaInfo.segments) bits.push(`${mediaInfo.segments} 个分片`);
    if (mediaInfo.duration_secs) bits.push(`时长 ${formatDuration(mediaInfo.duration_secs)}`);
    if (mediaInfo.encrypted) bits.push('AES-128 加密（服务端自动解密）');
    if (mediaInfo.init_segment) bits.push('含 init 段（fMP4）');
  }

  if (!options.silent) {
    const title = target.title || target.pageTitle || '任务';
    uiAlert(`已提交：${title}\n任务 ID：${r.taskId || '(未返回)'}\n状态：${vpsStateLabel(r.state)}` +
            (bits.length ? `\n${bits.join(' ｜ ')}` : '') +
            (r.message ? `\n服务端：${r.message}` : ''), { kind: 'success', title: '提交成功' });
  }

  // 提交成功后立刻刷新看板并（按需）开启轮询
  fetchVpsTasks(true);
  return { ok: true, taskId: r.taskId, duplicate: r.duplicate };
}

// 批量：逐条探测→提交（自动取最高码率），串行并遵守限速
async function pushToVps(items, opts) {
  const silent = !!(opts && opts.silent);
  // 重入保护：推送是「多条串行 + 限速」，期间重复点击会把整批再发一遍
  if (state.vpsPushing) {
    if (!silent) uiToast('上一批推送还在进行中，请稍候…', 'warn');
    return;
  }
  const v = state.settings.vps || {};
  if (!v.enabled) {
    uiAlert('VPS 远程下载未启用。\n请到「设置 → VPS 远程下载桥接」开启并填写地址与 Token。', { kind: 'error', title: '未启用' });
    return;
  }
  const valid = (items || []).filter(it => it && it.url &&
    it.url !== '(未捕获)' && it.url !== '(未提取到)');
  if (!valid.length) {
    uiToast('没有可推送的有效链接', 'warn');
    return;
  }

  // 先占坑再弹确认：确认框是 await，若把占坑放到之后，双击会绕过重入检查开两批
  state.vpsPushing = true;
  if (!silent && valid.length > 1) {
    const okPush = await uiConfirm(
      `将把 ${valid.length} 条链接依次「探测 → 提交」到服务端下载：\n${v.baseUrl}\n\n` +
      `主播放列表会自动选最高清晰度，不逐条询问。`,
      { title: '推送到 VPS', okText: '开始推送' }
    );
    if (!okPush) {
      state.vpsPushing = false;   // 用户取消：释放占坑
      return;
    }
  }

  const progressEl = document.getElementById('batchProgress');
  const results = [];
  const rateLimitMs = Math.max(0, Number(state.settings.rateLimit ?? 0) || 0);

  const paint = (done) => {
    if (!progressEl || valid.length <= 1) return;
    progressEl.style.display = 'block';
    progressEl.innerHTML =
      `☁️ 探测并提交 ${done}/${valid.length} ｜ ✅ 成功 ${results.filter(r => r.ok).length}` +
      (results.length && results[results.length - 1].episode
        ? ` ｜ ${escapeHtml(results[results.length - 1].episode)}` : '');
  };
  paint(0);

  (async () => {
    try {
      for (let i = 0; i < valid.length; i++) {
        if (progressEl && valid.length > 1) {
          progressEl.style.display = 'block';
          progressEl.innerHTML =
            `☁️ 探测并提交 ${i + 1}/${valid.length} ｜ ✅ 成功 ${results.filter(r => r.ok).length}` +
            ` ｜ ${escapeHtml(valid[i].episode || valid[i].title || valid[i].pageTitle || '')}`;
        }
        const r = await probeThenSubmit(valid[i], { silent: true, autoPickHighest: true });
        results.push({
          url: valid[i].url,
          episode: valid[i].episode || '',
          title: valid[i].title || valid[i].pageTitle || '',
          ok: !!r.ok && !r.pending,
          pending: !!r.pending,
          taskId: r.taskId || '',
          duplicate: !!r.duplicate,
          error: r.error || ''
        });
        if (i < valid.length - 1 && rateLimitMs > 0) {
          await new Promise((res) => setTimeout(res, rateLimitMs));
        }
      }
      renderVpsPushReport({
        okCount: results.filter(r => r.ok).length,
        total: valid.length,
        results
      });
    } finally {
      state.vpsPushing = false;
      fetchVpsTasks(true);
    }
  })();
}

// 展示批量推送结果：逐条成功/失败原因
function renderVpsPushReport(res) {
  const progressEl = document.getElementById('batchProgress');
  const list = res.results || [];
  const failed = list.filter(r => !r.ok);

  if (list.length === 1) {
    const r = list[0];
    if (!r.ok) uiAlert((r.error || '未知错误') + vpsErrorHint(r), { kind: 'error', title: '推送失败' });
    return;
  }
  if (!progressEl) {
    if (failed.length) {
      uiAlert(`推送完成：${res.okCount}/${res.total} 成功\n\n失败示例：\n` +
          failed.slice(0, 5).map(f => '✗ ' + (f.error || f.url)).join('\n'), { kind: 'error', title: '推送完成' });
    }
    return;
  }
  progressEl.style.display = 'block';
  progressEl.innerHTML = (failed.length === 0
    ? `✅ 已全部提交：${res.okCount}/${res.total} 成功`
    : `⚠️ 推送完成：${res.okCount}/${res.total} 成功，${failed.length} 条失败`)
    + (failed.length
        ? '<div style="margin-top:6px;font-size:11px;line-height:1.6;">' +
          failed.slice(0, 8).map(f =>
            `✗ ${escapeHtml(f.episode || f.title || f.url.slice(0, 46))} — ${escapeHtml(f.error || '失败')}`
          ).join('<br>') +
          (failed.length > 8 ? `<br>… 其余 ${failed.length - 8} 条见控制台` : '') +
          '</div>'
        : '');
  if (failed.length) console.warn('[OmniSnag] VPS 推送失败明细:', failed);
}

// 批量面板：把当前采集结果全部探测并提交
function pushBatchResultsToVps(opts) {
  const items = (state.batchResults || [])
    .filter(r => r.url && r.url !== '(未捕获)' && r.url !== '(未提取到)')
    .map(r => ({
      url: r.url,
      type: 'm3u8',
      pageTitle: r.pageTitle || '',
      title: r.pageTitle || '',
      episode: r.episode || '',
      headers: r.headers || {},
      pageUrl: r.pageUrl || r.pageTitle || ''
    }));
  pushToVps(items, opts);
}

// 批量采集结束后的自动推送（开关在设置里，默认关闭）
function maybeAutoPushToVps() {
  const v = state.settings.vps || {};
  if (!v.enabled || !v.autoPush) return;
  if (!String(v.baseUrl || '').trim() || !String(v.token || '').trim()) return;
  const has = (state.batchResults || []).some(r =>
    r.url && r.url !== '(未捕获)' && r.url !== '(未提取到)');
  if (!has) return;
  // silent：自动推送不弹确认框，否则会被弹窗阻塞
  pushBatchResultsToVps({ silent: true });
}

// 初始化 VPS 相关 UI 事件（清晰度弹窗 / 探测结果弹窗 / 任务看板）
function initVpsEvents() {
  // 清晰度选择弹窗
  const closeVariant = document.getElementById('btnCloseVariantModal');
  if (closeVariant) closeVariant.addEventListener('click', closeVpsVariantModal);
  const cancelVariant = document.getElementById('btnCancelVariant');
  if (cancelVariant) cancelVariant.addEventListener('click', closeVpsVariantModal);
  const variantModal = document.getElementById('vpsVariantModal');
  if (variantModal) {
    variantModal.addEventListener('click', (e) => {
      if (e.target === variantModal) closeVpsVariantModal();
    });
  }

  // 探测结果弹窗（media）
  const closeInfo = document.getElementById('btnCloseVpsInfo');
  if (closeInfo) closeInfo.addEventListener('click', closeVpsInfoModal);
  const infoClose = document.getElementById('btnVpsInfoClose');
  if (infoClose) infoClose.addEventListener('click', closeVpsInfoModal);
  const infoModal = document.getElementById('vpsInfoModal');
  if (infoModal) {
    infoModal.addEventListener('click', (e) => {
      if (e.target === infoModal) closeVpsInfoModal();
    });
  }
  const infoSubmit = document.getElementById('btnVpsInfoSubmit');
  if (infoSubmit) {
    infoSubmit.addEventListener('click', () => {
      const pending = _vpsInfoPending;
      closeVpsInfoModal();
      if (pending) submitVariant(pending.item, null, {}, pending.info);
    });
  }

  // Esc 关闭两个弹窗（与既有 CLI/预览弹窗行为一致）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const vm = document.getElementById('vpsVariantModal');
    const im = document.getElementById('vpsInfoModal');
    if (vm && vm.style.display === 'flex') closeVpsVariantModal();
    else if (im && im.style.display === 'flex') closeVpsInfoModal();
  });

  // 打开面板时拉一次任务列表；关闭/隐藏面板时停止轮询，避免后台空转
  initVpsTaskBoard();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setVpsPolling(false);
    } else {
      initVpsTaskBoard();
    }
  });
}


// ---- 清晰度选择弹窗（master） ----
function openVariantPicker(variants, item) {
  state.vpsPendingPick = { item, variants };
  const listEl = document.getElementById('vpsVariantList');
  if (!listEl) return;
  // 按码率从高到低排，方便直接选第一个
  const sorted = variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  listEl.innerHTML = sorted.map((vt, i) => {
    const name = vt.name || vt.resolution || `变体 ${i + 1}`;
    const bw = vt.bandwidth ? formatSpeed(vt.bandwidth / 8) : '';
    const meta = [vt.resolution || '', bw].filter(Boolean).join(' · ');
    return `<button class="vps-variant-btn" data-idx="${i}">
        <span class="vps-variant-name">${escapeHtml(name)}</span>
        <span class="vps-variant-meta">${escapeHtml(meta || '—')}</span>
      </button>`;
  }).join('');
  listEl.querySelectorAll('.vps-variant-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const vt = sorted[parseInt(btn.getAttribute('data-idx'), 10)];
      closeVpsVariantModal();
      if (vt) submitVariant(item, vt, {});
    });
  });
  const desc = document.getElementById('vpsVariantDesc');
  if (desc) {
    desc.textContent = `服务端探测到这是主播放列表（master），共 ${sorted.length} 个清晰度，请选择要下载的：`;
  }
  document.getElementById('vpsVariantModal').style.display = 'flex';
}

function closeVpsVariantModal() {
  const m = document.getElementById('vpsVariantModal');
  if (m) m.style.display = 'none';
  state.vpsPendingPick = null;
}

// ---- media 类型探测结果弹窗 ----
let _vpsInfoPending = null;

function openVpsInfoModal(info, item) {
  _vpsInfoPending = { info, item };
  const body = document.getElementById('vpsInfoBody');
  const title = document.getElementById('vpsInfoTitle');
  if (title) title.textContent = info.encrypted ? '探测结果（AES-128 加密流）' : '探测结果';
  if (body) {
    const rows = [
      ['类型', '可直接下载（media 列表）'],
      ['分片数', info.segments != null ? String(info.segments) : '—'],
      ['时长', formatDuration(info.duration_secs)],
      ['加密', info.encrypted ? 'AES-128（服务端自动取密钥解密）' : '无'],
      ['init 段', info.init_segment ? '有（fMP4，会自动前置拼接）' : '无']
    ];
    if (info.message) rows.push(['服务端提示', info.message]);
    body.innerHTML = rows.map(([k, v]) =>
      `<div class="vps-info-row"><span class="vps-info-k">${escapeHtml(k)}</span>` +
      `<span class="vps-info-v">${escapeHtml(String(v))}</span></div>`
    ).join('');
  }
  document.getElementById('vpsInfoModal').style.display = 'flex';
}

function closeVpsInfoModal() {
  const m = document.getElementById('vpsInfoModal');
  if (m) m.style.display = 'none';
  _vpsInfoPending = null;
}

// ---- 下载任务看板 ----
function fetchVpsTasks(manual) {
  const v = state.settings.vps || {};
  if (!v.enabled) return Promise.resolve();
  const hint = document.getElementById('vpsTasksHint');
  if (manual && hint) hint.textContent = '正在拉取任务列表...';
  return vpsSend('VPS_TASKS', { limit: 50 }).then((res) => {
    if (!res.success) {
      state.vpsTasksError = res.error || '拉取失败';
      state.vpsTasks = [];
      state.vpsActive = 0;
      if (hint) hint.textContent = '✗ ' + state.vpsTasksError + vpsErrorHint(res);
      renderVpsTasks();
      // 认证/配置类错误继续轮询没意义，停表避免刷屏
      if (res.errorKind === 'auth' || res.errorKind === 'config' ||
          res.errorKind === 'channel') setVpsPolling(false);
      return;
    }
    state.vpsTasksError = '';
    state.vpsTasks = Array.isArray(res.tasks) ? res.tasks : [];
    state.vpsActive = Number(res.active) || 0;
    if (hint) {
      hint.textContent = state.vpsTasks.length
        ? `共 ${state.vpsTasks.length} 个任务` +
          (state.vpsActive ? `，其中 ${state.vpsActive} 个进行中` : '') + '（进行中优先）。'
        : '暂无任务。提交一次下载后这里会出现进度。';
    }
    renderVpsTasks();
    syncVpsPolling();
  });
}

function renderVpsTasks() {
  const listEl = document.getElementById('vpsTasksList');
  const badge = document.getElementById('vpsActiveBadge');
  if (badge) {
    badge.textContent = String(state.vpsActive || 0);
    badge.setAttribute('data-zero', state.vpsActive > 0 ? '0' : '1');
  }
  if (!listEl) return;

  if (!state.vpsTasks.length) {
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = state.vpsTasks.map(t => {
    const total = Number(t.total_segments) || 0;
    const done = Number(t.done_segments) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const indeterminate = total <= 0;
    const st = t.state || '';
    const canCancel = st === 'queued' || st === 'running';
    const canRetry = st === 'failed' || st === 'cancelled';
    const name = t.filename || (t.id ? `任务 ${String(t.id).slice(0, 10)}` : '未命名任务');

    const meta = [];
    meta.push(total > 0 ? `分片 ${done}/${total}` : '分片解析中');
    if (st === 'running') meta.push(`速度 ${formatSpeed(t.speed_bps)}`);
    if (t.downloaded_bytes) meta.push(`已下载 ${formatBytes(t.downloaded_bytes)}`);
    if (t.duration_secs) meta.push(`时长 ${formatDuration(t.duration_secs)}`);
    if (t.encrypted) meta.push('AES-128');
    if (t.output_size) meta.push(`成品 ${formatBytes(t.output_size)}`);

    return `
      <div class="vps-task-item" data-task-id="${escapeHtml(t.id || '')}">
        <div class="vps-task-top">
          <span class="vps-task-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="vps-state vps-state-${escapeHtml(st || 'queued')}">${escapeHtml(vpsStateLabel(st))}</span>
        </div>
        <div class="vps-progress-bg">
          <div class="vps-progress-fill${indeterminate ? ' indeterminate' : ''}"
               style="width: ${indeterminate ? 40 : pct}%;"></div>
        </div>
        <div class="vps-task-meta">
          ${meta.map(m => `<span>${escapeHtml(m)}</span>`).join('')}
        </div>
        ${t.error ? `<div class="vps-task-error">${escapeHtml(t.error)}</div>` : ''}
        <div class="vps-task-actions">
          ${canCancel ? '<button class="btn btn-sm btn-outline vps-btn-cancel">取消</button>' : ''}
          ${canRetry ? '<button class="btn btn-sm btn-outline vps-btn-retry">重试</button>' : ''}
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.vps-task-item').forEach(row => {
    const taskId = row.getAttribute('data-task-id');
    const cancelBtn = row.querySelector('.vps-btn-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        cancelBtn.disabled = true;
        vpsSend('VPS_CANCEL', { taskId }).then((res) => {
          cancelBtn.disabled = false;
          if (!res.success) uiToast('取消失败：' + ((res.error || '未知错误') + vpsErrorHint(res)), 'error');
          fetchVpsTasks(true);
        });
      });
    }
    const retryBtn = row.querySelector('.vps-btn-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        retryBtn.disabled = true;
        vpsSend('VPS_RETRY', { taskId }).then((res) => {
          retryBtn.disabled = false;
          if (!res.success) uiToast('重试失败：' + ((res.error || '未知错误') + vpsErrorHint(res)), 'error');
          fetchVpsTasks(true);
        });
      });
    }
  });
}

// 仅在「存在排队/下载中任务」时轮询；空闲即停表
function syncVpsPolling() {
  const v = state.settings.vps || {};
  const wantPoll = !!v.enabled && v.autoPoll !== false;
  const hasActive = (state.vpsTasks || []).some(t =>
    t.state === 'queued' || t.state === 'running');
  setVpsPolling(wantPoll && hasActive);
}

function setVpsPolling(on) {
  const btn = document.getElementById('btnVpsTogglePoll');
  if (state.vpsPollTimer) {
    clearInterval(state.vpsPollTimer);
    state.vpsPollTimer = null;
  }
  if (on) {
    const interval = Math.max(1000, parseInt((state.settings.vps || {}).pollMs, 10) || 2000);
    state.vpsPollTimer = setInterval(() => fetchVpsTasks(false), interval);
  }
  if (btn) {
    const userOn = (state.settings.vps || {}).autoPoll !== false;
    btn.setAttribute('data-on', on ? '1' : '0');
    btn.textContent = on ? '轮询: 开' : (userOn ? '轮询: 关' : '轮询: 已停');
    btn.title = on
      ? '正在每 2 秒轮询任务进度；无活跃任务时自动停表'
      : (userOn
          ? '当前无排队/下载中任务，已自动停表。点击可强制开启'
          : '轮询已关闭（设置里「打开面板时轮询下载任务」未勾选）');
  }
  return on;
}

// 打开面板时初始化看板：拉一次，并按有无活跃任务决定是否开表
function initVpsTaskBoard() {
  const v = state.settings.vps || {};
  if (!v.enabled) return;
  fetchVpsTasks(true);
}



// ==================== Batch Episode Collector (auto click V1..V99) ====================

// Standalone page-injected function: collect episode button labels (serializable, no closures)
function batchCollectCandidates(pattern) {
  try {
    const re = new RegExp(pattern);
    const out = [];
    const seen = new Set();
    const els = document.querySelectorAll('a, button, li, dd, dt, div, span, p');
    for (const el of els) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, '');
      if (!t || t.length > 12 || !re.test(t)) continue;
      if (seen.has(t)) continue;
      if (el.querySelectorAll('*').length > 3) continue;
      seen.add(t);
      out.push(t);
    }
    out.sort((a, b) => {
      const na = a.match(/\d+/), nb = b.match(/\d+/);
      return (na ? +na[0] : 0) - (nb ? +nb[0] : 0);
    });
    return out;
  } catch (e) {
    return [];
  }
}

// Standalone page-injected function: click one episode by its exact label
function batchClickEpisode(label) {
  try {
    const els = document.querySelectorAll('a, button, li, dd, dt, div, span, p');
    let target = null;
    for (const el of els) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, '');
      if (t !== label) continue;
      if (el.querySelectorAll('*').length > 3) continue;
      if (!target || el.querySelectorAll('*').length < target.querySelectorAll('*').length) target = el;
    }
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.click();
    return true;
  } catch (e) {
    return false;
  }
}

function initBatchEvents() {
  state.batchStop = false;
  state.batchResults = state.batchResults || [];
  const $ = (id) => document.getElementById(id);

  $('btnToggleBatch').addEventListener('click', () => {
    const p = $('batchPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  $('batchMode').addEventListener('change', (e) => {
    const api = e.target.value === 'api';
    $('batchListUrlRow').style.display = api ? 'flex' : 'none';
    $('batchPatternRow').style.display = api ? 'none' : 'flex';
    $('batchWaitRow').style.display = api ? 'none' : 'flex';
  });
  // 合并按钮：空闲时「▶ 开始自动采集」，运行中变「⏹ 停止采集」，点击即切换
  $('btnStartBatch').addEventListener('click', () => {
    if (state.batchRunning) {
      state.batchStop = true;
      $('btnStartBatch').disabled = true;
      $('btnStartBatch').textContent = '⏹ 正在停止...';
      return;
    }
    if ($('batchMode') && $('batchMode').value === 'api') runApiCollect();
    else runBatchCollect();
  });
  $('btnCopyBatch').addEventListener('click', () => {
    const ok = (state.batchResults || []).filter(r => r.url && r.url !== '(未捕获)');
    if (!ok.length) { uiToast('暂无已捕获链接', 'warn'); return; }
    copyText(ok.map(r => `${r.episode}$${r.url}`).join('\n'), `已复制 ${ok.length} 条链接`);
  });
  $('btnExportBatch').addEventListener('click', () => {
    const ok = (state.batchResults || []).filter(r => r.url && r.url !== '(未捕获)');
    if (!ok.length) { uiToast('暂无已捕获链接', 'warn'); return; }
    const content = ok.map(r => `${r.episode}\t${r.url}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `batch_m3u8_${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  $('btnQueueBatch').addEventListener('click', () => queueBatchDownloads());
  $('btnPushBatchVps').addEventListener('click', () => pushBatchResultsToVps());

  chrome.storage.local.get(['batchResults'], (res) => {
    if (res && Array.isArray(res.batchResults) && res.batchResults.length) {
      state.batchResults = res.batchResults;
      renderBatchResults();
      resetBatchButtons();
    }
  });
}

function execOnTab(func, args) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId: state.activeTabId }, func, args }, (res) => {
      resolve(chrome.runtime.lastError ? null : (res && res[0] ? res[0].result : null));
    });
  });
}

function fetchTabMediaOnce() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SNIFFED_MEDIA', tabId: state.activeTabId }, (res) => {
      resolve(res && res.success ? (res.items || []) : []);
    });
  });
}

const batchSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ============ 接口模式：不点击、不播放，直接抓源码解析 m3u8 ============

// 侧边栏版限速闸门（与 offscreen rateGate 同规则：任意两次请求至少间隔 rateLimit 毫秒）
let _apiLastReqAt = 0;
async function apiRateGate(intervalMs) {
  if (!intervalMs || intervalMs <= 0) return;
  const waitMs = _apiLastReqAt + intervalMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  _apiLastReqAt = Date.now();
}

async function apiFetchText(url) {
  await apiRateGate(Math.max(0, Number(state.settings.rateLimit ?? 1000) || 0));
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 从列表页 HTML 按特征打分提取选集链接（第N集 / EP N / 纯数字 / V1 / play|vod 路径 / 同域加分）
function extractEpisodeLinks(html, baseUrl) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return []; }
  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname; } catch (e) {}
  const seen = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const raw = a.getAttribute('href') || '';
    if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, baseUrl); } catch (e) { continue; }
    if (!/^https?:$/i.test(abs.protocol)) continue;
    abs.hash = '';
    const clean = abs.href;
    if (/\.(jpg|jpeg|png|gif|webp|css|js|ico|pdf|zip|rar|mp4|mp3)(\?|$)/i.test(clean)) continue;

    let score = 0, epNum = null, m;
    if ((m = text.match(/第\s*(\d{1,4})\s*[集话話期]/))) { score += 6; epNum = parseInt(m[1], 10); }
    else if ((m = text.match(/^EP?0*(\d{1,4})$/i))) { score += 5; epNum = parseInt(m[1], 10); }
    else if ((m = text.match(/^V?0*(\d{1,4})$/))) { score += 4; epNum = parseInt(m[1], 10); }
    if (/预告|花絮|特辑|幕后|广告/.test(text)) score -= 4;
    if (!text || text.length > 30) score -= 2;
    if (/(play|vod|episode|video|juqing|dianshi|ep[-_/]?\d)/i.test(clean)) score += 2;
    if (abs.hostname === baseHost) score += 2;
    if (epNum == null) {
      const mh = clean.match(/0*(\d{1,4})\.s?html?(?:[?#]|$)/i) || clean.match(/\/0*(\d{1,4})(?:\/|$)/);
      if (mh) { epNum = parseInt(mh[1], 10); score += 1; }
    }
    const prev = seen.get(clean);
    if (!prev || score > prev.score) seen.set(clean, { href: clean, text: text || clean, score, epNum });
  }
  let list = [...seen.values()].filter(x => x.epNum != null && x.score >= 5);
  if (!list.length) list = [...seen.values()].filter(x => x.epNum != null && x.score >= 4);
  list.sort((a, b) => a.epNum - b.epNum);
  return list;
}

// 从播放页 HTML 正则提取 m3u8（还原 JSON \/ 与 \u002F 转义、相对路径、百分号编码；带 sign/token 参数的优先）
function extractM3u8FromHtml(html, baseUrl) {
  const found = new Set();
  const norm = (s) => s.replace(/\\u002f/gi, '/').replace(/\\/g, '/');
  const add = (raw) => {
    if (!raw) return;
    let u = norm(raw.trim());
    if (/%3a|%2f/i.test(u)) { try { u = decodeURIComponent(u); } catch (e) {} }
    try {
      const abs = new URL(u, baseUrl).href;
      if (/\.m3u8([?#]|$)/i.test(abs)) found.add(abs);
    } catch (e) {}
  };
  // 单遍扫描原始 HTML，所有捕获值在 add() 内统一反转义（\/ 与 \u002F → /，残留反斜杠按 WHATWG 规则等价 /）
  let m;
  const reAbs = /https?:\/\/[^\s"'`<>\\]+?\.m3u8(?:\?[^\s"'`<>]*)?/gi;
  while ((m = reAbs.exec(html))) add(m[0]);
  const reQuoted = /["'`]([^"'`\n]*?\.m3u8(?:\?[^"'`\n]*)?)["'`]/gi;
  while ((m = reQuoted.exec(html))) add(m[1]);
  const list = [...found];
  list.sort((a, b) => {
    const signed = (u) => (/[?&](sign|token|auth_key|auth|key|st|expiry|expire)=/i.test(u) ? 0 : 1);
    if (signed(a) !== signed(b)) return signed(a) - signed(b);
    return a.length - b.length;
  });
  return list;
}

// 接口模式主流程：fetch 列表页 → 打分提取选集链接 → 5 并发抓播放页 → 正则提取 m3u8 → 表格展示
async function runApiCollect() {
  const $ = (id) => document.getElementById(id);
  const progressEl = $('batchProgress');
  const startIdx = Math.max(1, parseInt($('batchStartIdx').value, 10) || 1);
  const endIdx = parseInt($('batchEndIdx').value, 10) || 0;

  state.batchStop = false;
  setBatchRunning(true);
  progressEl.style.display = 'block';
  // 本轮采集是否真的产出了新结果。只有 true 才允许触发自动推送，
  // 否则「列表页抓取失败」这类早退会把上一批结果当成新采集又推一遍。
  let collected = false;

  try {
    let listUrl = ($('batchListUrl').value || '').trim();
    if (!listUrl) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      listUrl = tabs && tabs[0] ? (tabs[0].url || '') : '';
    }
    if (!/^https?:/i.test(listUrl)) throw new Error('列表页地址无效，请在「列表页URL」中手动填写');

    progressEl.innerHTML = '⏳ 正在抓取列表页源码...';
    const listHtml = await apiFetchText(listUrl);
    let episodes = extractEpisodeLinks(listHtml, listUrl);
    if (!episodes.length) throw new Error('未从列表页识别出选集链接，请确认该页面包含 第N集/EP/数字 等选集入口');
    episodes = endIdx > 0 ? episodes.slice(startIdx - 1, endIdx) : episodes.slice(startIdx - 1);

    // 解析阶段确定成功后才清空旧结果：早退时保留上一批供用户查看
    state.batchResults = [];
    let okCount = 0, done = 0;
    const queue = episodes.map((ep, idx) => ({ ...ep, idx }));
    const results = new Array(episodes.length).fill(null);

    async function apiWorker() {
      while (queue.length > 0 && !state.batchStop) {
        const job = queue.shift();
        let m3u8 = null;
        try {
          const pageHtml = await apiFetchText(job.href);
          const urls = extractM3u8FromHtml(pageHtml, job.href);
          if (urls.length) m3u8 = urls[0];
        } catch (e) {}
        results[job.idx] = {
          episode: job.text,
          url: m3u8 || '(未提取到)',
          pageTitle: job.href,
          headers: m3u8 ? { Referer: job.href } : null
        };
        if (m3u8) okCount++;
        done++;
        progressEl.innerHTML = `⏳ 接口解析 ${done}/${episodes.length} ｜ ✅ 已提取 ${okCount} 集 ｜ ${escapeHtml(job.text)}`;
        if (m3u8) renderBatchResults();
      }
    }
    const workers = [];
    for (let w = 0; w < 5; w++) workers.push(apiWorker());
    await Promise.all(workers);

    state.batchResults = results.filter(Boolean);
    collected = true;
    await chrome.storage.local.set({ batchResults: state.batchResults, batchResultsTime: Date.now() });
    renderBatchResults();
    progressEl.innerHTML = state.batchStop
      ? `⏹ 已停止。共处理 ${done} 集，成功提取 ${okCount} 集。`
      : `🎉 接口解析完成！共 ${episodes.length} 集，成功提取 ${okCount} 集 m3u8。可复制 / 导出 / 加入下载队列。`;
  } catch (err) {
    progressEl.innerHTML = `❌ ${escapeHtml(err.message || String(err))}（本次未产生新结果，不会触发自动推送）`;
  }
  resetBatchButtons();
  if (collected) maybeAutoPushToVps();
}

async function runBatchCollect() {
  const $ = (id) => document.getElementById(id);
  const pattern = $('batchPattern').value.trim() || '^V\\d+$';
  const waitSec = Math.max(2, parseInt($('batchWaitSec').value, 10) || 6);
  const startIdx = Math.max(1, parseInt($('batchStartIdx').value, 10) || 1);
  const endIdx = parseInt($('batchEndIdx').value, 10) || 0;
  const rateLimitMs = Math.max(0, Number(state.settings.rateLimit ?? 1000) || 0);

  state.batchStop = false;
  setBatchRunning(true);
  const progressEl = $('batchProgress');
  progressEl.style.display = 'block';

  let labels = await execOnTab(batchCollectCandidates, [pattern]);
  if (!labels || !labels.length) {
    uiAlert('未在页面找到匹配的集数按钮。\n请调整匹配正则（默认 ^V\\d+$，也可尝试 第\\d+集 或 ^\\d+$）。', { kind: 'error', title: '未找到集数按钮' });
    resetBatchButtons();
    return;
  }
  labels = endIdx > 0 ? labels.slice(startIdx - 1, endIdx) : labels.slice(startIdx - 1);

  const known = new Set((await fetchTabMediaOnce()).filter(i => i.type === 'm3u8').map(i => i.url));
  state.batchResults = [];
  let okCount = 0;

  for (let i = 0; i < labels.length; i++) {
    if (state.batchStop) break;
    const label = labels[i];
    progressEl.innerHTML = `⏳ 采集中 (${i + 1}/${labels.length})：<b>${escapeHtml(label)}</b> — 正在点击并等待 m3u8...`;

    let clicked = false;
    for (let retry = 0; retry < 5 && !state.batchStop; retry++) {
      clicked = await execOnTab(batchClickEpisode, [label]);
      if (clicked) break;
      await batchSleep(1000);
    }

    let captured = null;
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline && !state.batchStop) {
      await batchSleep(600);
      const items = await fetchTabMediaOnce();
      const fresh = items.filter(x => x.type === 'm3u8' && !known.has(x.url));
      if (fresh.length) {
        captured = fresh[0];
        fresh.forEach(f => known.add(f.url));
        break;
      }
    }

    if (captured) okCount++;
    state.batchResults.push({
      episode: label,
      url: captured ? captured.url : '(未捕获)',
      pageTitle: captured ? captured.pageTitle : '',
      headers: captured ? captured.headers : null
    });
    progressEl.innerHTML = `进度 ${i + 1}/${labels.length} ｜ ✅ 已捕获 ${okCount} 集` +
      (captured ? ` ｜ <span style="color:#38bdf8">${escapeHtml((captured.url || '').slice(0, 70))}…</span>` : ' ｜ ⚠️ 本集未捕获（可能超时）');
    renderBatchResults();
    if (i < labels.length - 1 && !state.batchStop) {
      // 手动限速：每集之间等待指定毫秒，防止频繁点击/请求导致 IP 被封
      await batchSleep(rateLimitMs);
    }
  }

  await chrome.storage.local.set({ batchResults: state.batchResults, batchResultsTime: Date.now() });
  progressEl.innerHTML = state.batchStop
    ? `⏹ 已停止。共处理 ${state.batchResults.length} 集，成功捕获 ${okCount} 集。`
    : `🎉 采集完成！共 ${labels.length} 集，成功捕获 ${okCount} 集。可复制 / 导出 / 加入下载队列。`;
  resetBatchButtons();
  resetBatchButtons();
  maybeAutoPushToVps();
}
// 合并按钮状态：运行中显示「⏹ 停止采集」，空闲显示「▶ 开始自动采集」
function setBatchRunning(running) {
  state.batchRunning = !!running;
  const btn = document.getElementById('btnStartBatch');
  if (!btn) return;
  btn.disabled = false; // 运行中也要可点（用于停止）
  if (running) {
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
    btn.textContent = '⏹ 停止采集';
    btn.title = '点击停止采集';
  } else {
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
    btn.textContent = '▶ 开始自动采集';
    btn.title = '自动逐集采集 / 接口批量解析';
  }
}
function resetBatchButtons() {
  setBatchRunning(false);
  const has = (state.batchResults || []).some(r =>
    r.url && r.url !== '(未捕获)' && r.url !== '(未提取到)');
  document.getElementById('btnCopyBatch').disabled = !has;
  document.getElementById('btnExportBatch').disabled = !has;
  document.getElementById('btnQueueBatch').disabled = !has;
  const vpsBtn = document.getElementById('btnPushBatchVps');
  if (vpsBtn) {
    vpsBtn.disabled = !has;
    updateVpsButtonsVisibility();
  }
}

function renderBatchResults() {
  const box = document.getElementById('batchResults');
  if (!box) return;
  box.innerHTML = (state.batchResults || []).map(r => `
    <div class="batch-result-item">
      <span class="batch-ep">${escapeHtml(r.episode)}</span>
      <span class="batch-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</span>
      <button class="btn btn-sm btn-outline btn-copy-batch-item" data-url="${escapeHtml(r.url)}">复制</button>
    </div>`).join('');
  box.querySelectorAll('.btn-copy-batch-item').forEach(b => {
    b.addEventListener('click', () => copyText(b.getAttribute('data-url'), '已复制'));
  });
}

// Sequentially download & merge every captured episode (one at a time)
async function queueBatchDownloads() {
  const ok = (state.batchResults || []).filter(r => r.url && r.url !== '(未捕获)' && r.headers);
  const rateLimitMs = Math.max(0, Number(state.settings.rateLimit ?? 1000) || 0);
  if (!ok.length) { uiToast('没有可下载的已捕获链接', 'warn'); return; }
  const okQueue = await uiConfirm(
    `将依次自动下载并合并 ${ok.length} 集（每集完成后自动开始下一集）。\n期间请保持浏览器开启。`,
    { title: '批量下载队列', okText: '开始下载' }
  );
  if (!okQueue) return;

  for (const r of ok) {
    if (state.batchStop) break;
    await new Promise((resolve) => {
      const itemId = `batch_${r.episode}_${Date.now()}`;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        chrome.runtime.onMessage.removeListener(handler);
        setTimeout(resolve, Math.max(800, rateLimitMs));
      };
      const handler = (msg) => {
        if (msg.type === 'DOWNLOAD_PROGRESS' && msg.taskId === itemId &&
            ['completed', 'error', 'aborted'].includes(msg.status)) {
          finish();
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      setTimeout(finish, 30 * 60 * 1000);
      triggerBrowserDownload({
        id: itemId,
        url: r.url,
        type: 'm3u8',
        headers: r.headers || {},
        pageTitle: `${r.episode} ${r.pageTitle || ''}`.trim()
      });
    });
  }
  uiToast('批量下载队列已结束！', 'success');
}
