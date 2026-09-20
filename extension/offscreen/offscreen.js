/**
 * OmniSnag - Offscreen Worker Engine
 * Handles HLS/M3U8 parsing, AES-128 decryption, parallel TS segment fetching, and mux.js MP4 transmuxing.
 */

// Active download tasks: taskId -> AbortController
const activeTasks = new Map();

// Helper: Custom fetch with auth headers and timeout
async function fetchWithHeaders(url, headers = {}, options = {}) {
  const reqHeaders = new Headers();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v && typeof v === 'string') {
        try {
          reqHeaders.set(k, v);
        } catch (e) {
          // Some forbidden header names in browser fetch
        }
      }
    }
  }

  const timeout = options.timeout || 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: reqHeaders,
      signal: options.signal ? options.signal : controller.signal,
      credentials: 'omit'
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
// 全局限速闸门：保证任意两次 HTTP 请求之间至少间隔 intervalMs 毫秒（防止高频请求触发站点风控/封 IP）
let _lastReqAt = 0;
async function rateGate(intervalMs) {
  if (!intervalMs || intervalMs <= 0) return;
  const waitMs = _lastReqAt + intervalMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  _lastReqAt = Date.now();
}
// Parse M3U8 content
function parseM3u8(content, baseUrl) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.some(l => l.startsWith('#EXTM3U'))) {
    throw new Error('Not a valid M3U8 file (missing #EXTM3U)');
  }

  // Check if Master Playlist
  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const info = lines[i];
        const resMatch = info.match(/RESOLUTION=(\d+x\d+)/i);
        const bwMatch = info.match(/BANDWIDTH=(\d+)/i);
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          variants.push({
            resolution: resMatch ? resMatch[1] : 'Unknown',
            bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
            url: new URL(nextLine, baseUrl).href
          });
        }
      }
    }
    return { isMaster: true, variants };
  }

  // Media Playlist
  let keyInfo = null;
  const segments = [];
  let currentDuration = 0;
  let segmentIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/i);
      const uriMatch = line.match(/URI="([^"]+)"/i);
      const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);

      if (methodMatch && methodMatch[1] !== 'NONE') {
        keyInfo = {
          method: methodMatch[1],
          uri: uriMatch ? new URL(uriMatch[1], baseUrl).href : '',
          ivHex: ivMatch ? ivMatch[1] : null
        };
      }
    } else if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      currentDuration = match ? parseFloat(match[1]) : 0;
    } else if (!line.startsWith('#')) {
      segments.push({
        index: segmentIndex++,
        url: new URL(line, baseUrl).href,
        duration: currentDuration,
        key: keyInfo ? { ...keyInfo } : null
      });
      currentDuration = 0;
    }
  }

  return { isMaster: false, segments, keyInfo };
}

// Convert sequence number to 16-byte Uint8Array IV
function seqToIv(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, seq, false); // Big-endian
  return iv;
}

// Convert hex string to Uint8Array
function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

// AES-128 Decryptor
async function decryptSegment(encryptedBuffer, rawKeyBuffer, iv) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKeyBuffer,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
  return await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    encryptedBuffer
  );
}

// Main M3U8 Downloader Pipeline
async function startM3u8Download(mediaItem, options = {}) {
  const taskId = mediaItem.id;
  const abortController = new AbortController();
  activeTasks.set(taskId, abortController);

  const concurrency = options.concurrency || 6;
  const maxRetries = options.retries || 3;
  const rateLimitMs = Math.max(0, Number(options.rateLimit ?? 1000) || 0);
  const headers = mediaItem.headers || {};

  function sendProgress(data) {
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      type: 'DOWNLOAD_PROGRESS',
      taskId,
      ...data
    }).catch(() => {});
  }

  try {
    sendProgress({ status: 'fetching_m3u8', message: '正在拉取与解析 M3U8 索引文件...', percent: 0 });

    // 1. Fetch M3U8
    await rateGate(rateLimitMs);
    const m3u8Res = await fetchWithHeaders(mediaItem.url, headers, { signal: abortController.signal });
    const m3u8Text = await m3u8Res.text();
    let parsed = parseM3u8(m3u8Text, mediaItem.url);

    // If Master Playlist, pick highest bandwidth
    if (parsed.isMaster && parsed.variants && parsed.variants.length > 0) {
      parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const chosenVariant = parsed.variants[0];
      sendProgress({ status: 'fetching_variant', message: `解析到多分辨率自适应流，选择最高画质: ${chosenVariant.resolution}...`, percent: 2 });
        await rateGate(rateLimitMs);
        const subRes = await fetchWithHeaders(chosenVariant.url, headers, { signal: abortController.signal });
      const subText = await subRes.text();
      parsed = parseM3u8(subText, chosenVariant.url);
    }

    const segments = parsed.segments;
    if (!segments || segments.length === 0) {
      throw new Error('M3U8 未包含有效的切片列表');
    }

    sendProgress({
      status: 'downloading',
      message: `开始多线程下载，共 ${segments.length} 个切片`,
      total: segments.length,
      downloaded: 0,
      percent: 5
    });

    // 2. Fetch Decryption Key if needed
    const keyCache = new Map();
    for (const seg of segments) {
      if (seg.key && seg.key.method === 'AES-128' && seg.key.uri) {
        if (!keyCache.has(seg.key.uri)) {
          sendProgress({ status: 'fetching_key', message: '检测到 AES-128 加密切片，正在使用防盗链鉴权拉取秘钥...' });
          await rateGate(rateLimitMs);
          const keyRes = await fetchWithHeaders(seg.key.uri, headers, { signal: abortController.signal });
          const keyBuf = await keyRes.arrayBuffer();
          keyCache.set(seg.key.uri, keyBuf);
        }
      }
    }

    // 3. Concurrently download TS slices
    const downloadedBuffers = new Array(segments.length);
    let completedCount = 0;
    let totalBytes = 0;
    const startTime = Date.now();

    async function downloadWorker(queue) {
      while (queue.length > 0) {
        if (abortController.signal.aborted) break;
        const index = queue.shift();
        const seg = segments[index];
        let attempt = 0;
        let success = false;

        while (attempt < maxRetries && !success && !abortController.signal.aborted) {
          attempt++;
          try {
            await rateGate(rateLimitMs);
            const res = await fetchWithHeaders(seg.url, headers, { signal: abortController.signal });
            let buf = await res.arrayBuffer();

            // Decrypt if AES-128
            if (seg.key && seg.key.method === 'AES-128') {
              const rawKey = keyCache.get(seg.key.uri);
              if (rawKey) {
                const iv = seg.key.ivHex ? hexToBytes(seg.key.ivHex) : seqToIv(seg.index);
                buf = await decryptSegment(buf, rawKey, iv);
              }
            }

            downloadedBuffers[index] = buf;
            totalBytes += buf.byteLength;
            completedCount++;
            success = true;

            const elapsedSec = (Date.now() - startTime) / 1000;
            const speedBytes = elapsedSec > 0 ? totalBytes / elapsedSec : 0;
            const speedMB = (speedBytes / (1024 * 1024)).toFixed(2);
            const percent = Math.min(95, Math.round(5 + (completedCount / segments.length) * 85));

            sendProgress({
              status: 'downloading',
              message: `已下载 ${completedCount}/${segments.length} 切片 (${speedMB} MB/s)`,
              total: segments.length,
              downloaded: completedCount,
              percent,
              speed: `${speedMB} MB/s`
            });
          } catch (err) {
            if (attempt >= maxRetries) {
              console.error(`切片 #${index} 下载失败超过重试上限:`, err);
            }
          }
        }
      }
    }

    // Run parallel workers
    const taskQueue = segments.map((_, i) => i);
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(downloadWorker(taskQueue));
    }
    await Promise.all(workers);

    if (abortController.signal.aborted) {
      sendProgress({ status: 'aborted', message: '下载任务已取消' });
      return;
    }

    // 4. Transmux TS -> MP4 using mux.js
    sendProgress({ status: 'transmuxing', message: '正在无损转封装为标准 MP4 格式...', percent: 92 });

    const mp4Blob = await transmuxToMp4(downloadedBuffers);
    downloadedBuffers.length = 0; // release TS buffers promptly (large videos can hold GBs)

    // 5. Trigger download save
    sendProgress({ status: 'saving', message: '转封装完成，正在保存至浏览器下载...', percent: 99 });

    const safeName = (mediaItem.pageTitle || 'video')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'video';
    const filename = `${safeName}.mp4`;

    const blobUrl = URL.createObjectURL(mp4Blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      a.remove();
    }, 60000);

    sendProgress({
      status: 'completed',
      message: `下载与转码完成：${filename} (${(mp4Blob.size / (1024 * 1024)).toFixed(2)} MB)`,
      percent: 100,
      filename
    });
  } catch (err) {
    console.error('[Offscreen Download Error]:', err);
    sendProgress({
      status: 'error',
      message: `下载失败: ${err.message || err}`,
      error: err.message
    });
  } finally {
    activeTasks.delete(taskId);
  }
}
async function startMergeTsDownload(tsItems, options = {}, taskIdOverride) {
  const taskId = taskIdOverride || `merge_${Date.now()}`;
  const abortController = new AbortController();
  activeTasks.set(taskId, abortController);
  const concurrency = options.concurrency || 6;
  const maxRetries = options.retries || 3;
  const rateLimitMs = Math.max(0, Number(options.rateLimit ?? 1000) || 0);

  function sendProgress(data) {
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      type: 'DOWNLOAD_PROGRESS',
      taskId,
      ...data
    }).catch(() => {});
  }

  try {
    sendProgress({
      status: 'downloading',
      message: `开始多线程拉取 ${tsItems.length} 个 TS 切片并准备合并...`,
      total: tsItems.length,
      downloaded: 0,
      percent: 5
    });

    const downloadedBuffers = new Array(tsItems.length);
    let completedCount = 0;
    let totalBytes = 0;
    const startTime = Date.now();
    const queue = tsItems.map((_, i) => i);

    async function worker() {
      while (queue.length > 0) {
        if (abortController.signal.aborted) break;
        const idx = queue.shift();
        const item = tsItems[idx];
        let attempt = 0;
        let success = false;

        while (attempt < maxRetries && !success && !abortController.signal.aborted) {
          attempt++;
          try {
            await rateGate(rateLimitMs);
            const res = await fetchWithHeaders(item.url, item.headers || {}, { signal: abortController.signal });
            const buf = await res.arrayBuffer();
            downloadedBuffers[idx] = buf;
            totalBytes += buf.byteLength;
            completedCount++;
            success = true;

            const elapsedSec = (Date.now() - startTime) / 1000;
            const speedMB = elapsedSec > 0 ? (totalBytes / elapsedSec / (1024 * 1024)).toFixed(2) : '0';
            const percent = Math.min(92, Math.round(5 + (completedCount / tsItems.length) * 85));

            sendProgress({
              status: 'downloading',
              message: `已下载 ${completedCount}/${tsItems.length} 个切片 (${speedMB} MB/s)`,
              total: tsItems.length,
              downloaded: completedCount,
              percent,
              speed: `${speedMB} MB/s`
            });
          } catch (e) {}
        }
      }
    }

    const workers = [];
    for (let w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);

    if (abortController.signal.aborted) {
      sendProgress({ status: 'aborted', message: '切片合并任务已取消' });
      return;
    }

    // fMP4/CMAF 分片（.m4s、带时间段的 .mp4）本身已是 MP4 盒子，直接拼接即可；
    // 只有 MPEG-TS 才需要经 mux.js 转封装。走错分支会产出 0 字节/损坏文件。
    const useFmp4 = isFmp4Segments(tsItems);
    sendProgress({
      status: 'transmuxing',
      message: useFmp4
        ? '正在按 fMP4 规范拼接初始化段与全部分片...'
        : '正在将全部 TS 切片合并封装为单个 MP4 视频...',
      percent: 95
    });
    const mp4Blob = useFmp4
      ? concatFmp4Segments(downloadedBuffers)
      : await transmuxToMp4(downloadedBuffers);
    downloadedBuffers.length = 0; // release TS buffers promptly (large videos can hold GBs)
    const safeTitle = (tsItems[0]?.pageTitle || 'merged_video')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 50) || 'merged_video';
    const filename = `${safeTitle}.mp4`;

    const blobUrl = URL.createObjectURL(mp4Blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      a.remove();
    }, 60000);

    sendProgress({
      status: 'completed',
      message: `合并完成！已保存为单个完整文件：${filename} (${(mp4Blob.size / (1024 * 1024)).toFixed(2)} MB)`,
      percent: 100,
      filename
    });
  } catch (err) {
    sendProgress({
      status: 'error',
      message: `合并下载失败: ${err.message || err}`
    });
  } finally {
    activeTasks.delete(taskId);
  }
}

// Transmux TS segment buffers into MP4 Blob
// 判断这批分片是不是 fMP4/CMAF（.m4s 或带时间段的 .mp4）。
// 这类分片本身就已经是 MP4 盒子（moof/mdat），不能再送进 mux.js —— 
// mux.js 只吃 MPEG-TS，硬灌进去会产出 0 字节或损坏的文件。
function isFmp4Segments(items) {
  if (!items || !items.length) return false;
  return items.every(it => {
    const p = (() => {
      try { return new URL(it.url).pathname.toLowerCase(); } catch (e) { return String(it.url || '').toLowerCase(); }
    })();
    if (it.type === 'm4s' || it.type === 'init') return true;
    return /\.m4s$/.test(p) || (/\.mp4$/.test(p) && /\/\d+\/\d+\//.test(p));
  });
}

// Transmux TS segment buffers into MP4 Blob
function transmuxToMp4(tsBuffers) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof muxjs === 'undefined' || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
        // Fallback if muxjs is unavailable: concatenate raw buffers
        const combined = new Blob(tsBuffers.filter(Boolean), { type: 'video/mp2t' });
        resolve(combined);
        return;
      }

      const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
      const mp4Segments = [];
      let initSegment = null;

      transmuxer.on('data', (segment) => {
        if (!initSegment && segment.initSegment) {
          initSegment = segment.initSegment;
        }
        if (segment.data) {
          mp4Segments.push(new Uint8Array(segment.data));
        }
      });

      transmuxer.on('done', () => {
        const parts = [];
        if (initSegment) {
          parts.push(initSegment);
        }
        parts.push(...mp4Segments);
        const finalBlob = new Blob(parts, { type: 'video/mp4' });
        resolve(finalBlob);
      });

      // Feed segments in sequence
      for (const buf of tsBuffers) {
        if (buf && buf.byteLength > 0) {
          transmuxer.push(new Uint8Array(buf));
          transmuxer.flush();
        }
      }

      transmuxer.end();
    } catch (e) {
      reject(e);
    }
  });
}

// fMP4/CMAF 分片拼接：初始化段（moov）+ 各分片（moof+mdat）按顺序直接字节拼接，
// 产出的就是标准 fMP4 文件，无需也绝不能经过 mux.js 转封装。
function concatFmp4Segments(buffers) {
  const parts = buffers.filter(b => b && b.byteLength > 0);
  if (!parts.length) throw new Error('没有可拼接的分片数据');
  return new Blob(parts, { type: 'video/mp4' });
}

// Message Listener from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'START_M3U8_DOWNLOAD') {
    const taskId = (message.mediaItem && message.mediaItem.id) || `task_${Date.now()}`;
    startM3u8Download(message.mediaItem, message.options);
    sendResponse({ ok: true, taskId });
    return false;
  }

  if (message.type === 'START_MERGE_TS_DOWNLOAD') {
    // 优先使用后台派发的 taskId，保证侧边栏持有的 id 与登记在 activeTasks 中的完全一致
    const taskId = message.taskId || `merge_${Date.now()}`;
    startMergeTsDownload(message.items, message.options, taskId);
    sendResponse({ ok: true, taskId });
    return false;
  }

  if (message.type === 'CANCEL_DOWNLOAD') {
    const controller = activeTasks.get(message.taskId);
    if (controller) {
      controller.abort();
      sendResponse({ ok: true, aborted: true });
    } else {
      // 任务可能已结束或 taskId 不匹配 —— 兜底中止全部在途任务，确保「取消」永远有效
      let count = 0;
      for (const ctrl of activeTasks.values()) {
        ctrl.abort();
        count++;
      }
      sendResponse({ ok: true, aborted: count > 0, fallback: true, running: count });
    }
    return false;
  }

  return false;
});
