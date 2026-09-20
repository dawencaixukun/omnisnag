/**
 * OmniSnag - Main World Hook
 * Runs in window's MAIN world at document_start.
 * Intercepts fetch, XMLHttpRequest, URL.createObjectURL and HTMLMediaElement to capture dynamic media streams.
 */
(function () {
  'use strict';

  // Prevent duplicate injection
  if (window.__OMNI_SNAG_HOOKED__) return;
  window.__OMNI_SNAG_HOOKED__ = true;

  const MEDIA_REGEX = /\.(m3u8|mpd|mp4|ts|flv|m4s|webm|f4v|aac|m4a)(\?.*)?$/i;
  const MEDIA_KEYWORD_REGEX = /(m3u8|manifest\.mpd|\.mp4\?|\.ts\?|\/playlist\b|\.f4v\?|\.m4s\?)/i;

  function isMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:') || url.startsWith('data:')) return false;
    return MEDIA_REGEX.test(url) || MEDIA_KEYWORD_REGEX.test(url);
  }

  function dispatchMediaEvent(mediaData) {
    try {
      const event = new CustomEvent('__OMNI_SNAG_DETECTED__', {
        detail: {
          url: mediaData.url,
          method: mediaData.method || 'GET',
          initiator: mediaData.initiator || 'hook',
          headers: mediaData.headers || {},
          timestamp: Date.now(),
          pageTitle: document.title || '',
          pageUrl: window.location.href
        }
      });
      window.dispatchEvent(event);
    } catch (e) {
      console.warn('[OmniSnag Hook] Dispatch error:', e);
    }
  }

  // 1. Hook window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    let url = '';
    let method = 'GET';
    const capturedHeaders = {};

    try {
      const input = args[0];
      const init = args[1] || {};

      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof Request) {
        url = input.url;
        method = input.method || 'GET';
        if (input.headers) {
          input.headers.forEach((val, key) => {
            capturedHeaders[key] = val;
          });
        }
      } else if (input && input.href) {
        url = input.href;
      }

      if (init.method) method = init.method;
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((val, key) => {
            capturedHeaders[key] = val;
          });
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([k, v]) => {
            capturedHeaders[k] = v;
          });
        } else if (typeof init.headers === 'object') {
          Object.assign(capturedHeaders, init.headers);
        }
      }

      if (isMediaUrl(url)) {
        dispatchMediaEvent({
          url: new URL(url, window.location.href).href,
          method,
          initiator: 'fetch',
          headers: capturedHeaders
        });
      }
    } catch (err) {
      // Ignore hook inspection errors
    }

    return originalFetch.apply(this, args);
  };

  // 2. Hook XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__omni_url = url;
    this.__omni_method = method;
    this.__omni_headers = {};
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (!this.__omni_headers) this.__omni_headers = {};
    this.__omni_headers[header] = value;
    return originalSetRequestHeader.apply(this, [header, value]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__omni_url;
      if (isMediaUrl(url)) {
        dispatchMediaEvent({
          url: new URL(url, window.location.href).href,
          method: this.__omni_method || 'GET',
          initiator: 'xhr',
          headers: this.__omni_headers || {}
        });
      }
    } catch (err) {
      // Ignore hook inspection errors
    }
    return originalSend.apply(this, args);
  };

  // 3. Hook HTMLMediaElement (Video / Audio play & src)
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      const src = this.currentSrc || this.src;
      if (src && isMediaUrl(src)) {
        dispatchMediaEvent({
          url: new URL(src, window.location.href).href,
          initiator: 'video_play'
        });
      }
    } catch (e) {}
    return originalPlay.apply(this, args);
  };

  // 4. Hook URL.createObjectURL for MSE & Blobs
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    try {
      if (object instanceof MediaSource) {
        // MediaSource attached - player is using MSE
      } else if (object instanceof Blob && (object.type.includes('video') || object.type.includes('mpegurl') || object.type.includes('mp4'))) {
        // Blob media detected
      }
    } catch (e) {}
    return originalCreateObjectURL.apply(this, arguments);
  };

  console.log('[OmniSnag] In-page media sniffer hook activated.');
})();
