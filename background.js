'use strict';

/* ============================================================
 * Torrent Tab Detector - background service worker
 * 扫描所有可访问的标签页，检测 torrent 相关痕迹。
 * ============================================================ */

const RESTRICTED_URL =
  /^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|data|blob|filesystem|chrome-search|opera|brave|vivaldi|yandex|chrome-untrusted):/i;

const SCAN_TIMEOUT_MS = 5000;
const RUNTIME_TIMEOUT_MS = 1500;
const CONCURRENCY = 10;
const CACHE_TTL_MS = 60000;
const STORAGE_KEY = 'lastScan';

// tabId -> { url, findings, at }，避免重复扫描未变化的标签页
const tabCache = new Map();

let scanState = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  tabs: [],
  skipped: [],
  error: '',
};

/* ---------- 工具 ---------- */

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('扫描超时，页面无响应')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function friendlyError(error) {
  const message = String((error && error.message) || error || '');
  if (/No tab with id|Invalid tab ID/i.test(message)) return '标签页已关闭';
  if (/Missing host permission|manifest must request permission|Cannot access contents of the page/i.test(message)) {
    return '缺少该网站的访问权限：请在扩展详情中把「网站访问权限」设为「在所有网站上」，然后重新扫描';
  }
  if (/extensions gallery cannot be scripted|cannot be scripted|chrome web store/i.test(message)) {
    return '浏览器禁止扩展读取该页面（应用商店或浏览器内部页面）';
  }
  if (/Frame with ID .* (was removed|not found)|frame.*removed/i.test(message)) {
    return '页面正在跳转或尚未加载完成，请稍后重新扫描';
  }
  if (/超时|timeout/i.test(message)) return '扫描超时（页面加载过慢），可稍后重新扫描';
  if (/The tab was discarded|discarded/i.test(message)) return '标签页已休眠，点击激活后再重新扫描';
  return message.slice(0, 160) || '无法访问该页面';
}

function restrictedReason(url) {
  if (!url) return '标签页尚未加载';
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return 'Chrome 应用商店页面，浏览器禁止注入';
  if (/^https:\/\/chrome\.google\.com\/webstore/i.test(url)) return 'Chrome 应用商店页面，浏览器禁止注入';
  if (/^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|data|blob|filesystem|chrome-search|opera|brave|vivaldi|yandex|chrome-untrusted):/i.test(url)) {
    return '浏览器内部页面，无法读取';
  }
  return '受限制的页面';
}

function publicState() {
  return {
    running: scanState.running,
    startedAt: scanState.startedAt,
    finishedAt: scanState.finishedAt,
    tabs: scanState.tabs,
    skipped: scanState.skipped,
    error: scanState.error,
    hitTabs: scanState.tabs.filter((tab) => tab.findings && tab.findings.length).length,
    scannedTabs: scanState.tabs.length,
  };
}

function broadcast(message) {
  // 弹窗可能已关闭，忽略发送失败
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function persist() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: publicState() });
  } catch (_) {
    /* ignore */
  }
}

function setBadge(hitCount, running) {
  const text = running ? '…' : hitCount > 0 ? String(hitCount) : '';
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({
    color: hitCount > 0 ? '#e5533d' : '#2f9e6b',
  });
  if (hitCount > 0) {
    chrome.action.setTitle({ title: `发现 ${hitCount} 个标签页含 torrent 痕迹` });
  } else {
    chrome.action.setTitle({ title: 'Torrent Tab Detector' });
  }
}

/* ============================================================
 * 注入函数：DOM 层检测（ISOLATED world）
 * 必须自包含，不能引用外部变量。
 * ============================================================ */
function domScan() {
  const findings = [];
  const seen = new Set();
  const MAX = 60;

  const push = (kind, value, label) => {
    if (findings.length >= MAX) return;
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const key = kind + '::' + text;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      kind: kind,
      value: text.slice(0, 500),
      label: String(label == null ? '' : label).replace(/\s+/g, ' ').trim().slice(0, 140),
    });
  };

  const MAGNET_RE = /magnet:\?xt=urn:(?:btih:[a-z0-9]{32,40}|btmh:[a-z0-9]{32,68})[^\s"'<>]*/gi;
  const TORRENT_RE = /\.torrent(?:[?#&]|$)/i;
  const TRACKER_RE = /\b(?:udp|https?|wss?):\/\/[^\s"'<>]+\/announce\b/gi;
  const TORRENT_TEXT_RE = /([^\s/\\:*?"<>|]+\.torrent)\b/i;
  const ATTACHMENT_HREF_RE = /[?&](?:mod=attachment|aid=|attach(?:ment)?=)/i;

  const findTorrentName = (value) => {
    const match = TORRENT_TEXT_RE.exec(String(value || ''));
    return match ? match[1].slice(0, 140) : '';
  };

  const abs = (raw) => {
    try {
      return new URL(raw, document.baseURI).href;
    } catch (_) {
      return raw;
    }
  };

  try {
    const selfUrl = location.href;
    if (/^magnet:/i.test(selfUrl)) push('magnet', selfUrl, '当前页面地址');
    else if (TORRENT_RE.test(selfUrl)) push('torrent-file', selfUrl, '当前页面地址');
  } catch (_) {
    /* ignore */
  }

  // 1. 链接（同时识别论坛附件链接：URL 本身不含 .torrent，但链接文字/标题带后缀）
  let anchors = null;
  try {
    anchors = document.querySelectorAll('a[href]');
  } catch (_) {
    /* ignore */
  }
  const anchorCount = anchors ? Math.min(anchors.length, 4000) : 0;
  for (let i = 0; i < anchorCount; i += 1) {
    if (findings.length >= MAX) break;
    const anchor = anchors[i];
    const raw = (anchor.getAttribute('href') || '').trim();
    if (!raw || raw === '#') continue;

    const text = (anchor.textContent || '').trim();
    const title = (anchor.getAttribute('title') || '').trim();
    const download = (anchor.getAttribute('download') || '').trim();
    const aria = (anchor.getAttribute('aria-label') || '').trim();

    if (/^magnet:/i.test(raw)) {
      const matches = raw.match(MAGNET_RE);
      push('magnet', matches ? matches[0] : raw, text || '链接');
      continue;
    }

    let hint =
      findTorrentName(download) ||
      findTorrentName(title) ||
      findTorrentName(aria) ||
      findTorrentName(text);

    const looksAttachment = ATTACHMENT_HREF_RE.test(raw) || /attachment|附件/i.test(title);
    if (!hint && looksAttachment) {
      try {
        const container = anchor.closest('tr, li, dl, dd, p, .attach, .attachment');
        const containerText = container ? container.textContent || '' : '';
        if (containerText.length < 400) hint = findTorrentName(containerText);
      } catch (_) {
        /* ignore */
      }
    }

    if (TORRENT_RE.test(raw)) {
      push('torrent-file', abs(raw), hint || text || title || '链接');
    } else if (hint && !/^(javascript|mailto|tel|data):/i.test(raw)) {
      push('torrent-file', abs(raw), hint);
    }
  }

  // 2. 资源元素
  const resourceMap = [
    ['iframe[src], embed[src], source[src], video[src], audio[src], script[src], img[src]', 'src'],
    ['object[data]', 'data'],
    ['link[href]', 'href'],
  ];
  for (const [selector, attribute] of resourceMap) {
    let nodes = null;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (_) {
      continue;
    }
    for (const node of nodes) {
      if (findings.length >= MAX) break;
      const raw = node.getAttribute(attribute) || '';
      if (/^magnet:/i.test(raw)) {
        push('magnet', raw, node.tagName.toLowerCase() + ' 资源');
      } else if (TORRENT_RE.test(raw)) {
        push('torrent-file', abs(raw), node.tagName.toLowerCase() + ' 资源');
      }
      if (node.tagName === 'SCRIPT' && /webtorrent/i.test(raw)) {
        push('webtorrent', abs(raw), '页面引入了 WebTorrent 脚本');
      }
    }
  }

  // 3. meta refresh
  let metas = null;
  try {
    metas = document.querySelectorAll('meta[http-equiv]');
  } catch (_) {
    /* ignore */
  }
  if (!metas) metas = [];
  for (const meta of metas) {
    if ((meta.getAttribute('http-equiv') || '').toLowerCase() !== 'refresh') continue;
    const content = meta.getAttribute('content') || '';
    const magnet = content.match(MAGNET_RE);
    if (magnet) push('magnet', magnet[0], 'meta refresh 跳转');
    else if (TORRENT_RE.test(content)) push('torrent-file', content, 'meta refresh 跳转');
  }

  // 4. 表单输入框中的磁力链接
  let inputs = null;
  try {
    inputs = document.querySelectorAll('input[value], textarea');
  } catch (_) {
    /* ignore */
  }
  if (!inputs) inputs = [];
  for (const input of inputs) {
    if (findings.length >= MAX) break;
    const value = input.tagName === 'TEXTAREA' ? input.value : input.getAttribute('value');
    if (!value) continue;
    if (/^magnet:/i.test(value.trim())) {
      const matches = value.match(MAGNET_RE);
      push('magnet', matches ? matches[0] : value, '页面输入框');
    }
  }

  // 5. 页面文本（textContent 不触发布局，比 innerText 快一个数量级）
  let bodyText = '';
  try {
    bodyText = (document.body && document.body.textContent) || '';
  } catch (_) {
    /* ignore */
  }
  if (bodyText.length > 800000) bodyText = bodyText.slice(0, 800000);
  const textMagnets = bodyText.match(MAGNET_RE) || [];
  for (const magnet of textMagnets.slice(0, 10)) push('magnet', magnet, '页面文本');
  const textTrackers = bodyText.match(TRACKER_RE) || [];
  for (const tracker of textTrackers.slice(0, 6)) push('tracker', tracker, '页面文本');

  // 6. 内联脚本
  let inlineCode = '';
  try {
    const scripts = Array.from(document.querySelectorAll('script:not([src])')).slice(0, 20);
    inlineCode = scripts.map((node) => node.textContent || '').join('\n').slice(0, 300000);
  } catch (_) {
    /* ignore */
  }
  if (inlineCode) {
    const codeMagnets = inlineCode.match(MAGNET_RE) || [];
    for (const magnet of codeMagnets.slice(0, 8)) push('magnet', magnet, '页面内联脚本');
    if (/webtorrent/i.test(inlineCode)) {
      push('webtorrent', '内联脚本包含 WebTorrent 代码', '页面内联脚本');
    }
  }

  // 7. 已加载的网络资源
  try {
    const entries = performance.getEntriesByType('resource') || [];
    for (const entry of entries) {
      if (findings.length >= MAX) break;
      if (/^magnet:/i.test(entry.name)) push('magnet', entry.name, '网络资源');
      else if (TORRENT_RE.test(entry.name)) push('torrent-file', entry.name, '网络资源');
    }
  } catch (_) {
    /* ignore */
  }

  return findings;
}

/* ============================================================
 * 注入函数：运行时检测（MAIN world，可访问页面 JS 全局变量）
 * 必须自包含，不能引用外部变量。
 * ============================================================ */
function runtimeScan() {
  const findings = [];
  const seen = new Set();

  const push = (kind, value, label) => {
    const text = String(value == null ? '' : value);
    const key = kind + '::' + text;
    if (!text || seen.has(key) || findings.length >= 20) return;
    seen.add(key);
    findings.push({ kind: kind, value: text.slice(0, 300), label: label });
  };

  let names = [];
  try {
    names = Object.getOwnPropertyNames(window);
  } catch (_) {
    /* ignore */
  }

  const hits = names.filter((name) => /torrent/i.test(name));
  for (const name of hits.slice(0, 12)) {
    push('webtorrent', 'window.' + name, '运行时全局对象');
  }

  // 常见 BT 客户端库的全局命名
  const knownClients = ['WebTorrent', 'webtorrent', 'Torrent', 'torrent', 'InstantClient'];
  for (const name of knownClients) {
    if (hits.indexOf(name) !== -1) continue;
    try {
      if (typeof window[name] !== 'undefined') {
        push('webtorrent', 'window.' + name, '运行时全局对象');
      }
    } catch (_) {
      /* ignore */
    }
  }

  // 检测页面是否注册了 P2P / magnet 协议处理痕迹
  try {
    if (navigator.registerProtocolHandler && /magnet/i.test(String(navigator.registerProtocolHandler))) {
      // 仅作为辅助信号，不单独产生结论
    }
  } catch (_) {
    /* ignore */
  }

  return findings;
}

/* ============================================================
 * 扫描编排
 * ============================================================ */

function mergeFindings(target, incoming) {
  const seen = new Set(target.map((item) => item.kind + '::' + item.value));
  for (const item of incoming || []) {
    if (!item || !item.kind) continue;
    const key = item.kind + '::' + item.value;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
  }
}

function readCache(tab, force) {
  if (force) return null;
  const cached = tabCache.get(tab.id);
  if (!cached) return null;
  if (cached.url !== (tab.url || '')) return null;
  if (Date.now() - cached.at > CACHE_TTL_MS) return null;
  return cached.findings;
}

async function scanTab(tab, force) {
  const record = {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title || '(无标题)',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    findings: [],
    accessible: true,
    note: '',
  };

  if (tab.discarded) {
    record.accessible = false;
    record.note = '标签页已休眠，尚未加载内容';
    return record;
  }

  const cached = readCache(tab, force);
  if (cached) {
    record.findings = cached.map((item) => ({ ...item }));
    return record;
  }

  // DOM 扫描与运行时扫描并行，整体耗时取决于较慢的那个
  const [domOutcome, runtimeOutcome] = await Promise.allSettled([
    withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: domScan,
        world: 'ISOLATED',
      }),
      SCAN_TIMEOUT_MS
    ),
    withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runtimeScan,
        world: 'MAIN',
      }),
      RUNTIME_TIMEOUT_MS
    ),
  ]);

  if (domOutcome.status === 'rejected') {
    record.accessible = false;
    record.note = friendlyError(domOutcome.reason);
    return record;
  }

  for (const result of domOutcome.value || []) {
    mergeFindings(record.findings, result && result.result);
  }

  // 运行时检测失败不影响 DOM 检测结果
  if (runtimeOutcome.status === 'fulfilled') {
    for (const result of runtimeOutcome.value || []) {
      mergeFindings(record.findings, result && result.result);
    }
  }

  tabCache.set(tab.id, {
    url: tab.url || '',
    findings: record.findings.map((item) => ({ ...item })),
    at: Date.now(),
  });

  return record;
}

async function startScan(trigger, force) {
  if (scanState.running) return;
  scanState.running = true;
  scanState.startedAt = Date.now();
  scanState.finishedAt = 0;
  scanState.tabs = [];
  scanState.skipped = [];
  scanState.error = '';
  setBadge(0, true);
  broadcast({ type: 'SCAN_STARTED', startedAt: scanState.startedAt, trigger: trigger || 'manual' });

  try {
    const tabs = await chrome.tabs.query({});
    const targets = [];
    for (const tab of tabs) {
      if (!tab.url || RESTRICTED_URL.test(tab.url) || /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(tab.url)) {
        scanState.skipped.push({
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title || '(无标题)',
          url: tab.url || '',
          reason: restrictedReason(tab.url),
        });
      } else {
        targets.push(tab);
      }
    }

    let cursor = 0;
    let done = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const tab = targets[cursor];
        cursor += 1;
        const record = await scanTab(tab, force);
        scanState.tabs.push(record);
        done += 1;
        broadcast({
          type: 'TAB_SCANNED',
          done: done,
          total: targets.length,
          scannedTabs: scanState.tabs.length,
          hitTabs: scanState.tabs.filter((item) => item.findings.length).length,
          tab: record,
        });
      }
    };

    const workerCount = Math.min(CONCURRENCY, targets.length);
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) workers.push(worker());
    await Promise.all(workers);

    scanState.tabs.sort((a, b) => b.findings.length - a.findings.length || a.index - b.index);
    scanState.finishedAt = Date.now();
  } catch (error) {
    scanState.error = friendlyError(error);
    scanState.finishedAt = Date.now();
  } finally {
    scanState.running = false;
    const hitTabs = scanState.tabs.filter((tab) => tab.findings.length).length;
    setBadge(hitTabs, false);
    await persist();
    broadcast({ type: 'SCAN_FINISHED', state: publicState() });
  }
}

async function focusTab(tabId, windowId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (typeof windowId === 'number') {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    }
    return true;
  } catch (_) {
    return false;
  }
}

/* ---------- 生命周期 & 消息 ---------- */

async function restoreState() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored && stored[STORAGE_KEY];
    if (value && Array.isArray(value.tabs)) {
      scanState = {
        running: false,
        startedAt: value.startedAt || 0,
        finishedAt: value.finishedAt || 0,
        tabs: value.tabs,
        skipped: value.skipped || [],
        error: value.error || '',
      };
      const hitTabs = scanState.tabs.filter((tab) => tab.findings && tab.findings.length).length;
      setBadge(hitTabs, false);
    }
  } catch (_) {
    /* ignore */
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCache.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') tabCache.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge(0, false);
});

chrome.runtime.onStartup.addListener(() => {
  restoreState();
});

restoreState();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'GET_STATE') {
    sendResponse({ ok: true, state: publicState() });
    return;
  }

  if (message.type === 'SCAN') {
    startScan(message.trigger || 'manual', Boolean(message.force));
    sendResponse({ ok: true, running: true });
    return;
  }

  if (message.type === 'FOCUS_TAB') {
    focusTab(message.tabId, message.windowId).then((ok) => sendResponse({ ok: ok }));
    return true;
  }

  if (message.type === 'OPEN_DASHBOARD') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('dashboard.html') })
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'CLEAR') {
    scanState.tabs = [];
    scanState.skipped = [];
    scanState.startedAt = 0;
    scanState.finishedAt = 0;
    scanState.error = '';
    setBadge(0, false);
    persist();
    broadcast({ type: 'STATE_CLEARED' });
    sendResponse({ ok: true });
    return;
  }
});
