/**
 * fab-ui.js — 悬浮小圆钮 + 页内抽屉弹窗（ISOLATED world）
 *
 * 关键设计：
 *  - 圆钮 z-index 恒为最高（2147483647），且高于弹窗，弹窗打开后依然可点击 → 不会死循环
 *  - 圆钮可拖拽，位置持久化（chrome.storage.local），不再"固定死"在右下角
 *  - 关闭通道：iframe 内按钮 / 圆钮二次点击 / Esc / 工具栏图标，四条路都能关
 */
(() => {
  if (window.__omniFabInjected) return;
  window.__omniFabInjected = true;

  const POPUP_W = 430;      // 抽屉宽度
  const FAB_SIZE = 42;
  const EDGE = 16;          // 距视口边缘的默认间距
  const Z_FAB = 2147483647; // 圆钮永远在最上层
  const Z_POPUP = 2147483640;
  const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  let fabHost = null;
  let fabBtn = null;
  let popupHost = null;
  let popupWrap = null;
  let isOpen = false;
  let pos = null;           // { left, top } 视口坐标；null = 用默认右下角
  let backdropEl = null;

  const mountRoot = () => document.body || document.documentElement;

  function defaultPos() {
    return {
      left: Math.max(EDGE, window.innerWidth - FAB_SIZE - EDGE),
      top: Math.max(EDGE, window.innerHeight - FAB_SIZE - EDGE)
    };
  }

  function clampPos(p) {
    const maxL = Math.max(0, window.innerWidth - FAB_SIZE);
    const maxT = Math.max(0, window.innerHeight - FAB_SIZE);
    return {
      left: Math.min(Math.max(0, p.left), maxL),
      top: Math.min(Math.max(0, p.top), maxT)
    };
  }

  function applyPos() {
    if (!fabBtn) return;
    const p = clampPos(pos || defaultPos());
    fabBtn.style.left = p.left + 'px';
    fabBtn.style.top = p.top + 'px';
  }

  // ---- 悬浮圆钮（可拖拽） ----
  function ensureFab() {
    if (fabHost) return;
    fabHost = document.createElement('div');
    fabHost.style.cssText = `all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:${Z_FAB};`;
    const shadow = fabHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .fab {
        position: fixed;
        width: ${FAB_SIZE}px; height: ${FAB_SIZE}px;
        border-radius: 50%; border: none; padding: 0;
        cursor: grab; touch-action: none; user-select: none;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #6366f1, #06b6d4);
        color: #fff;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        transition: box-shadow 0.15s, opacity 0.15s;
        opacity: 0.95;
      }
      .fab:hover { box-shadow: 0 6px 22px rgba(99, 102, 241, 0.7); opacity: 1; }
      .fab.dragging { cursor: grabbing; transition: none; }
      .fab svg { width: 20px; height: 20px; pointer-events: none; }
    `;
    fabBtn = document.createElement('button');
    fabBtn.className = 'fab';
    fabBtn.title = 'OmniSnag（点击打开面板 / 可拖拽移动）';
    fabBtn.innerHTML = ICON_LINK;
    attachDragAndClick(fabBtn);
    shadow.appendChild(style);
    shadow.appendChild(fabBtn);
    applyPos();
    mountRoot().appendChild(fabHost);
    window.addEventListener('resize', applyPos);
    requestAnimationFrame(applyPos);
  }

  function attachDragAndClick(btn) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      const p = clampPos(pos || defaultPos());
      startLeft = p.left; startTop = p.top;
      startX = e.clientX; startY = e.clientY;
      btn.classList.add('dragging');
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    btn.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 抖动容差
      moved = true;
      pos = clampPos({ left: startLeft + dx, top: startTop + dy });
      applyPos();
    });

    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      btn.classList.remove('dragging');
      try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
      if (moved) persistPos();
      else toggle(); // 未移动 = 点击
    };
    btn.addEventListener('pointerup', finish);
    btn.addEventListener('pointercancel', () => { dragging = false; btn.classList.remove('dragging'); });
  }

  function persistPos() {
    try { chrome.storage.local.set({ fabPos: pos }); } catch (e) {}
  }

  function loadPos() {
    try {
      chrome.storage.local.get(['fabPos'], (res) => {
        if (res && res.fabPos && typeof res.fabPos.left === 'number') {
          pos = res.fabPos;
          applyPos();
        }
      });
    } catch (e) {}
  }

  // ---- 抽屉弹窗（iframe 承载扩展面板页） ----
  function ensurePopup() {
    if (popupHost) return;
    popupHost = document.createElement('div');
    popupHost.style.cssText = `all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:${Z_POPUP};`;
    const shadow = popupHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .backdrop {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.35);
        opacity: 0; pointer-events: none;
        transition: opacity 0.22s ease-out;
      }
      .backdrop.open { opacity: 1; pointer-events: auto; }
      .wrap {
        position: fixed; top: 0; right: 0;
        height: 100vh; width: ${POPUP_W}px; max-width: 96vw;
        background: #0b1120;
        border-left: 1px solid rgba(99, 102, 241, 0.35);
        box-shadow: -10px 0 36px rgba(0, 0, 0, 0.55);
        transform: translateX(103%);
        transition: transform 0.22s ease-out;
        pointer-events: none;
      }
      .wrap.open { transform: translateX(0); pointer-events: auto; }
      iframe { width: 100%; height: 100%; border: none; display: block; background: #0b1120; }
    `;
    backdropEl = document.createElement('div');
    backdropEl.className = 'backdrop';
    backdropEl.addEventListener('click', () => toggle(false));
    popupWrap = document.createElement('div');
    popupWrap.className = 'wrap';
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sidepanel/index.html');
    iframe.allow = 'clipboard-write';
    popupWrap.appendChild(iframe);
    shadow.appendChild(style);
    shadow.appendChild(backdropEl);
    shadow.appendChild(popupWrap);
    mountRoot().appendChild(popupHost);
  }

  function updateFabIcon() {
    if (!fabBtn) return;
    fabBtn.innerHTML = isOpen ? ICON_CLOSE : ICON_LINK;
    fabBtn.title = isOpen ? '关闭 OmniSnag 面板（Esc）' : 'OmniSnag（点击打开面板 / 可拖拽移动）';
  }

  function toggle(force) {
    const wantOpen = typeof force === 'boolean' ? force : !isOpen;
    if (wantOpen) {
      ensureFab();
      ensurePopup();
      // 弹窗滑入；圆钮层级高于弹窗（Z_FAB > Z_POPUP），打开后依然可点 → 不会死循环
      requestAnimationFrame(() => {
        if (popupWrap) popupWrap.classList.add('open');
        if (backdropEl) backdropEl.classList.add('open');
      });
      isOpen = true;
    } else {
      if (popupWrap) popupWrap.classList.remove('open');
      if (backdropEl) backdropEl.classList.remove('open');
      isOpen = false;
    }
    updateFabIcon();
  }

  // 关闭通道 1：iframe 内「关闭返回」按钮 / 面板内交互
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.__omniSnag === 'closePopup') toggle(false);
    if (d && d.__omniSnag === 'openPopup') toggle(true);
  });

  // 关闭通道 2：Esc 键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) toggle(false);
  }, true);

  // 关闭通道 3：工具栏图标 / 后台指令
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'TOGGLE_LINKS_POPUP') {
      toggle(typeof msg.open === 'boolean' ? msg.open : undefined);
      sendResponse({ ok: true, open: isOpen });
    } else if (msg.type === 'CLOSE_LINKS_POPUP') {
      toggle(false);
      sendResponse({ ok: true });
    } else if (msg.type === 'GET_POPUP_STATE') {
      sendResponse({ ok: true, open: isOpen });
    }
    return false;
  });

  // 关闭通道 4：点圆钮（见 attachDragAndClick）

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { ensureFab(); loadPos(); });
  } else {
    ensureFab();
    loadPos();
  }
})();
