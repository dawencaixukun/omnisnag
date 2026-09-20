/**
 * OmniSnag - Page Link Collector & Event Bridge
 * Runs in ISOLATED world.
 * 1. Listens to MAIN-world media hook events and relays to Background Service Worker.
 * 2. Deep scans DOM, Shadow DOM, and Regex patterns for all links (Media, Cloud Drives, Magnets, Docs).
 */
(function () {
  'use strict';

  // 1. Bridge MAIN world hook events to background
  window.addEventListener('__OMNI_SNAG_DETECTED__', (e) => {
    if (e.detail && e.detail.url) {
      chrome.runtime.sendMessage({
        type: 'MEDIA_DETECTED',
        data: e.detail
      }).catch(() => {
        // Background might be inactive or reloading
      });
    }
  });

  // 2. Classify link category
  function classifyUrl(url, text = '') {
    const lowerUrl = url.toLowerCase();
    const lowerText = text.toLowerCase();

    if (/^(magnet:|ed2k:|thunder:)/i.test(url) || /\.torrent(\?.*)?$/i.test(lowerUrl)) {
      return 'p2p';
    }

    if (
      lowerUrl.includes('pan.baidu.com') ||
      lowerUrl.includes('pan.quark.cn') ||
      lowerUrl.includes('aliyundrive.com') ||
      lowerUrl.includes('alipan.com') ||
      lowerUrl.includes('123pan.com') ||
      lowerUrl.includes('mypikpak.com') ||
      /lanzou[a-z]?\.(com|org|net)/i.test(lowerUrl)
    ) {
      return 'cloud';
    }

    if (/\.(m3u8|mpd|mp4|ts|m4v|mkv|flv|webm|avi|mov|mp3|flac|wav|aac|m4a|ogg)(\?.*)?$/i.test(lowerUrl)) {
      return 'media';
    }

    if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|epub|mobi|zip|rar|7z|tar|gz|iso|apk|exe|dmg|pkg)(\?.*)?$/i.test(lowerUrl)) {
      return 'doc';
    }

    try {
      const u = new URL(url);
      if (u.origin === window.location.origin) {
        return 'internal';
      }
      return 'external';
    } catch (e) {
      return 'other';
    }
  }

  // Find extraction codes near cloud drive links in text
  function findExtractionCode(url, contextText) {
    if (!contextText) return '';
    // Look for patterns like: 提取码: abcd / 密码: 1234 / 访问码: abcd / code: 1234
    const codeRegex = /(?:提取码|提取密码|密码|访问码|code|pwd)[:：\s]*([a-zA-Z0-9]{4,8})\b/i;
    const match = contextText.match(codeRegex);
    return match ? match[1] : '';
  }

  // Deep collector
  function collectLinks() {
    const linkMap = new Map();

    function addLink(rawUrl, text = '', source = 'dom', context = '') {
      if (!rawUrl || typeof rawUrl !== 'string') return;
      const cleanUrl = rawUrl.trim();
      if (!cleanUrl || cleanUrl.startsWith('javascript:') || cleanUrl.startsWith('data:') || cleanUrl.startsWith('blob:')) {
        return;
      }

      let absoluteUrl = cleanUrl;
      try {
        if (!/^(https?|ftp|magnet|ed2k|thunder):/i.test(cleanUrl)) {
          absoluteUrl = new URL(cleanUrl, window.location.href).href;
        }
      } catch (e) {
        return;
      }

      if (linkMap.has(absoluteUrl)) {
        // Merge text if longer
        const existing = linkMap.get(absoluteUrl);
        if (!existing.text && text) {
          existing.text = text.trim();
        }
        return;
      }

      const category = classifyUrl(absoluteUrl, text);
      const code = (category === 'cloud') ? findExtractionCode(absoluteUrl, context || text) : '';

      linkMap.set(absoluteUrl, {
        url: absoluteUrl,
        text: (text || '').trim().replace(/\s+/g, ' ').slice(0, 150),
        category,
        code,
        source,
        domain: (function () {
          try { return new URL(absoluteUrl).hostname; } catch (e) { return ''; }
        })()
      });
    }

    // A. Query standard DOM elements
    const elements = document.querySelectorAll('a[href], area[href], video[src], audio[src], source[src], iframe[src], link[href]');
    elements.forEach((el) => {
      const tagName = el.tagName.toLowerCase();
      let href = el.getAttribute('href') || el.getAttribute('src');
      let text = el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '';
      let context = el.parentElement ? el.parentElement.innerText : '';
      addLink(href, text, tagName, context);
    });

    // B. Elements with data-href or data-url attributes
    const dataElements = document.querySelectorAll('[data-url], [data-href], [data-src], [data-link]');
    dataElements.forEach((el) => {
      const url = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-src') || el.getAttribute('data-link');
      const text = el.innerText || '';
      addLink(url, text, 'data-attr');
    });

    // C. Scan Shadow DOM
    function scanShadowRoots(root) {
      if (!root) return;
      const allEls = root.querySelectorAll('*');
      allEls.forEach((el) => {
        if (el.shadowRoot) {
          const shadowLinks = el.shadowRoot.querySelectorAll('a[href], video[src], audio[src], source[src]');
          shadowLinks.forEach(item => {
            const h = item.getAttribute('href') || item.getAttribute('src');
            addLink(h, item.innerText || '', 'shadow-dom');
          });
          scanShadowRoots(el.shadowRoot);
        }
      });
    }
    scanShadowRoots(document.body);

    // D. Text regex scan for hidden URLs, Cloud Drives & Magnets in page body
    const bodyText = document.body ? document.body.innerText : '';
    
    // Magnet
    const magnetMatches = bodyText.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s"'<>\u4e00-\u9fa5]*/gi) || [];
    magnetMatches.forEach(mag => addLink(mag, '磁力链接', 'regex-magnet'));

    // ED2K
    const ed2kMatches = bodyText.match(/ed2k:\/\/\|file\|[^\s"'<>\u4e00-\u9fa5]*/gi) || [];
    ed2kMatches.forEach(ed => addLink(ed, '电驴链接', 'regex-ed2k'));

    // Cloud drive regexes
    const cloudPatterns = [
      /(https?:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+)(?:[^\n\r]{0,40}(?:提取码|密码|pwd)[:：\s]*([a-zA-Z0-9]{4}))?/gi,
      /(https?:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+)/gi,
      /(https?:\/\/(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[a-zA-Z0-9]+)/gi,
      /(https?:\/\/(?:www\.)?123pan\.com\/s\/[a-zA-Z0-9]+)/gi,
      /(https?:\/\/(?:www\.)?mypikpak\.com\/s\/[a-zA-Z0-9]+)/gi,
      /(https?:\/\/[a-zA-Z0-9]+\.lanzou[a-z]?\.(?:com|org|net)\/[a-zA-Z0-9_-]+)/gi
    ];

    cloudPatterns.forEach(pattern => {
      let m;
      while ((m = pattern.exec(bodyText)) !== null) {
        const u = m[1];
        const code = m[2] || '';
        if (linkMap.has(u)) {
          if (code && !linkMap.get(u).code) linkMap.get(u).code = code;
        } else {
          addLink(u, '网盘分享链接', 'regex-cloud', m[0]);
        }
      }
    });

    return Array.from(linkMap.values());
  }

  // 3. Page summary extraction
  function getPageInfo() {
    return {
      title: document.title || '',
      url: window.location.href,
      metaDescription: (document.querySelector('meta[name="description"]') || {}).content || '',
      headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(h => h.innerText.trim()).filter(Boolean),
      sampleText: (document.body ? document.body.innerText : '').slice(0, 1500)
    };
  }

  // 4. Message listener from Extension UI
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'COLLECT_PAGE_LINKS') {
      try {
        const links = collectLinks();
        sendResponse({
          success: true,
          pageInfo: getPageInfo(),
          links
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (request.type === 'GET_PAGE_INFO') {
      sendResponse({ success: true, pageInfo: getPageInfo() });
      return true;
    }
  });

})();
