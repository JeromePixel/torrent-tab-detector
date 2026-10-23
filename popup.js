'use strict';

/* ============================================================
 * Torrent Tab Detector - popup
 * ============================================================ */

const KIND_META = {
  magnet: { label: '磁力链接', cls: 'magnet' },
  'torrent-file': { label: '.torrent', cls: 'torrent-file' },
  webtorrent: { label: 'WebTorrent', cls: 'webtorrent' },
  tracker: { label: 'Tracker', cls: 'tracker' },
};

const KIND_ORDER = { magnet: 0, 'torrent-file': 1, webtorrent: 2, tracker: 3 };
const AUTO_SCAN_MAX_AGE_MS = 120000;

const els = {
  scanBtn: document.getElementById('scanBtn'),
  scanBtnText: document.getElementById('scanBtnText'),
  statScanned: document.getElementById('statScanned'),
  statHits: document.getElementById('statHits'),
  statSkipped: document.getElementById('statSkipped'),
  progressWrap: document.getElementById('progressWrap'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  progressPercent: document.getElementById('progressPercent'),
  results: document.getElementById('results'),
  scanTime: document.getElementById('scanTime'),
  copyBtn: document.getElementById('copyBtn'),
  clearBtn: document.getElementById('clearBtn'),
  dashboardBtn: document.getElementById('dashboardBtn'),
  toast: document.getElementById('toast'),
  filterButtons: Array.from(document.querySelectorAll('.seg-btn')),
};

let state = emptyState();
let progress = { done: 0, total: 0 };
let filter = 'hits';
let renderQueued = false;
let toastTimer = 0;

function emptyState() {
  return {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    tabs: [],
    skipped: [],
    error: '',
    hitTabs: 0,
    scannedTabs: 0,
  };
}

/* ---------- 基础工具 ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(pathData, viewBox) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox || '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function displayHost(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'magnet:') return 'magnet 链接';
    if (parsed.protocol === 'file:') return '本地文件';
    return parsed.hostname || parsed.protocol.replace(':', '');
  } catch (_) {
    return String(url || '').slice(0, 48);
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(start, end) {
  if (!start || !end || end < start) return '';
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => {
      els.toast.hidden = true;
    }, 220);
  }, 1600);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage || '已复制');
    return true;
  } catch (_) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      toast(successMessage || '已复制');
      return true;
    } catch (__) {
      toast('复制失败，请手动选择文本');
      return false;
    }
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/* ---------- 数据 ---------- */

async function loadState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response && response.state) state = response.state;
  } catch (_) {
    state = emptyState();
  }
}

function requestScan(force) {
  chrome.runtime
    .sendMessage({ type: 'SCAN', trigger: 'popup', force: Boolean(force) })
    .catch(() => {});
}

function focusTab(tab) {
  chrome.runtime
    .sendMessage({ type: 'FOCUS_TAB', tabId: tab.id, windowId: tab.windowId })
    .then((response) => {
      if (response && response.ok) {
        window.close();
      } else {
        toast('无法切换到该标签页');
      }
    })
    .catch(() => toast('无法切换到该标签页'));
}

/* ---------- 渲染 ---------- */

function render() {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const skipped = Array.isArray(state.skipped) ? state.skipped : [];
  const scanned = Math.max(state.scannedTabs || 0, tabs.length);
  const hits = tabs.filter((tab) => tab.findings && tab.findings.length).length;

  els.statScanned.textContent = String(scanned);
  els.statHits.textContent = String(hits);
  els.statSkipped.textContent = String(skipped.length);

  els.scanBtn.disabled = state.running;
  els.scanBtnText.textContent = state.running ? '扫描中…' : '重新扫描';

  if (state.running) {
    els.progressWrap.hidden = false;
    const known = progress.total > 0;
    const percent = known ? Math.round((progress.done / progress.total) * 100) : 0;
    els.progressBar.classList.toggle('indeterminate', !known);
    els.progressBar.style.width = known ? `${Math.max(percent, 4)}%` : '';
    els.progressText.textContent = known
      ? `正在扫描 ${progress.done} / ${progress.total} 个标签页`
      : '正在枚举标签页…';
    els.progressPercent.textContent = known ? `${percent}%` : '…';
  } else {
    els.progressWrap.hidden = true;
  }

  if (state.finishedAt) {
    const duration = formatDuration(state.startedAt, state.finishedAt);
    els.scanTime.textContent = `上次扫描 ${formatTime(state.finishedAt)}${duration ? ` · ${duration}` : ''}`;
  } else {
    els.scanTime.textContent = '';
  }

  for (const button of els.filterButtons) {
    button.classList.toggle('active', button.dataset.filter === filter);
  }

  els.results.textContent = '';

  if (state.error) {
    const errorBox = el('div', 'card');
    errorBox.appendChild(el('div', 'card-note', `扫描出错：${state.error}`));
    els.results.appendChild(errorBox);
  }

  const visible = (filter === 'hits' ? tabs.filter((tab) => tab.findings && tab.findings.length) : tabs.slice())
    .sort((a, b) => {
      const diff = (b.findings ? b.findings.length : 0) - (a.findings ? a.findings.length : 0);
      return diff || a.index - b.index;
    });

  if (!visible.length) {
    els.results.appendChild(buildEmptyState(tabs, skipped));
  } else {
    for (const tab of visible) {
      els.results.appendChild(buildTabCard(tab));
    }
  }

  if (filter === 'all' && skipped.length) {
    els.results.appendChild(buildSkipped(skipped));
  }
}

function buildEmptyState(tabs, skipped) {
  const wrapper = el('div', 'empty-state');
  wrapper.appendChild(el('div', 'empty-icon', state.running ? '◎' : '◇'));

  if (state.running) {
    wrapper.appendChild(el('p', '', '正在扫描所有已打开的标签页…'));
  } else if (!tabs.length && skipped.length) {
    wrapper.appendChild(el('p', '', '没有可扫描的标签页'));
    wrapper.appendChild(el('p', 'hint', '当前打开的页面都受浏览器保护'));
  } else if (filter === 'hits') {
    wrapper.appendChild(el('p', '', '未发现 torrent 痕迹'));
    wrapper.appendChild(el('p', 'hint', '所有可访问的标签页都是干净的'));
  } else {
    wrapper.appendChild(el('p', '', '暂无扫描结果'));
    wrapper.appendChild(el('p', 'hint', '点击右上角「重新扫描」开始检测'));
  }
  return wrapper;
}

function buildTabCard(tab) {
  const findings = Array.isArray(tab.findings) ? tab.findings.slice() : [];
  findings.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));

  const card = el('div', `card${findings.length ? ' hit' : ''}`);

  const head = el('div', 'card-head');
  head.title = '点击切换到该标签页';

  const favicon = el('div', 'favicon');
  if (tab.favIconUrl && /^https?:/i.test(tab.favIconUrl)) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
      favicon.textContent = '◈';
    });
    favicon.appendChild(img);
  } else {
    favicon.textContent = '◈';
  }

  const info = el('div', 'card-info');
  info.appendChild(el('div', 'card-title', tab.title || '(无标题)'));
  info.appendChild(el('div', 'card-host', displayHost(tab.url)));

  head.appendChild(favicon);
  head.appendChild(info);

  if (findings.length) {
    head.appendChild(el('span', 'count-pill hit', String(findings.length)));
  } else if (tab.accessible === false) {
    head.appendChild(el('span', 'count-pill denied', '受限'));
  } else {
    head.appendChild(el('span', 'count-pill clean', '干净'));
  }

  head.addEventListener('click', () => focusTab(tab));
  card.appendChild(head);

  if (!findings.length && tab.note) {
    card.appendChild(el('div', 'card-note', tab.note));
  }

  if (findings.length) {
    const list = el('div', 'findings');
    for (const finding of findings) {
      list.appendChild(buildFinding(finding));
    }
    card.appendChild(list);
  }

  return card;
}

function buildFinding(finding) {
  const meta = KIND_META[finding.kind] || { label: finding.kind, cls: 'tracker' };
  const row = el('div', 'finding');
  row.appendChild(el('span', `badge ${meta.cls}`, meta.label));

  const body = el('div', 'finding-body');
  if (finding.label) body.appendChild(el('div', 'finding-label', finding.label));
  const value = el('div', 'finding-value', finding.value);
  value.title = finding.value;
  body.appendChild(value);
  row.appendChild(body);

  const copyButton = el('button', 'icon-btn');
  copyButton.type = 'button';
  copyButton.title = '复制';
  copyButton.appendChild(
    icon('M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1')
  );
  copyButton.addEventListener('click', (event) => {
    event.stopPropagation();
    copyText(finding.value, '已复制到剪贴板');
  });
  row.appendChild(copyButton);

  return row;
}

function buildSkipped(skipped) {
  const wrapper = document.createElement('details');
  wrapper.className = 'skipped';

  const summary = document.createElement('summary');
  summary.appendChild(el('span', '', `未扫描的标签页（${skipped.length}）`));
  summary.appendChild(el('span', '', '展开'));
  wrapper.appendChild(summary);
  wrapper.addEventListener('toggle', () => {
    summary.lastChild.textContent = wrapper.open ? '收起' : '展开';
  });

  for (const tab of skipped) {
    const row = el('div', 'skipped-row');
    row.appendChild(el('span', 'skipped-title', tab.title || tab.url || '(无标题)'));
    row.appendChild(el('span', 'skipped-reason', tab.reason || '无法访问'));
    wrapper.appendChild(row);
  }

  return wrapper;
}

/* ---------- 报告 ---------- */

function buildReport() {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const skipped = Array.isArray(state.skipped) ? state.skipped : [];
  const hits = tabs.filter((tab) => tab.findings && tab.findings.length);
  const lines = [];

  lines.push('Torrent Tab Detector · 扫描报告');
  lines.push(`扫描时间：${state.finishedAt ? new Date(state.finishedAt).toLocaleString('zh-CN') : '未完成'}`);
  lines.push(`已扫描：${tabs.length} 个标签页 ｜ 命中：${hits.length} ｜ 跳过：${skipped.length}`);
  lines.push('');

  if (!hits.length) {
    lines.push('未在任何可访问的标签页中发现 torrent 痕迹。');
  }

  for (const tab of hits) {
    lines.push(`[命中] ${tab.title || '(无标题)'}`);
    lines.push(`  ${tab.url}`);
    for (const finding of tab.findings) {
      const meta = KIND_META[finding.kind] || { label: finding.kind };
      lines.push(`  - [${meta.label}] ${finding.value}`);
    }
    lines.push('');
  }

  if (skipped.length) {
    lines.push(`[跳过 ${skipped.length} 个标签页]`);
    for (const tab of skipped) {
      lines.push(`  ${tab.title || '(无标题)'} — ${tab.reason || '无法访问'}`);
    }
  }

  return lines.join('\n');
}

/* ---------- 事件 ---------- */

function bindEvents() {
  els.scanBtn.addEventListener('click', () => {
    if (state.running) return;
    progress = { done: 0, total: 0 };
    requestScan(true);
  });

  els.dashboardBtn.addEventListener('click', () => {
    chrome.runtime
      .sendMessage({ type: 'OPEN_DASHBOARD' })
      .then(() => window.close())
      .catch(() => toast('无法打开批量管理页面'));
  });

  els.copyBtn.addEventListener('click', () => {
    copyText(buildReport(), '扫描报告已复制');
  });

  els.clearBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR' });
    } catch (_) {
      /* ignore */
    }
    state = emptyState();
    progress = { done: 0, total: 0 };
    render();
    toast('已清空扫描结果');
  });

  for (const button of els.filterButtons) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter || 'hits';
      render();
    });
  }
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'SCAN_STARTED') {
    state = {
      ...emptyState(),
      running: true,
      startedAt: message.startedAt,
    };
    progress = { done: 0, total: 0 };
    render();
    return;
  }

  if (message.type === 'TAB_SCANNED') {
    progress = { done: message.done || 0, total: message.total || 0 };
    if (!state.tabs.some((tab) => tab.id === message.tab.id)) {
      state.tabs.push(message.tab);
    }
    state.scannedTabs = message.scannedTabs || state.tabs.length;
    state.hitTabs = message.hitTabs || 0;
    scheduleRender();
    return;
  }

  if (message.type === 'SCAN_FINISHED') {
    state = message.state || emptyState();
    state.running = false;
    progress = { done: state.tabs.length, total: state.tabs.length };
    render();
    return;
  }

  if (message.type === 'STATE_CLEARED') {
    state = emptyState();
    render();
  }
}

async function init() {
  bindEvents();
  chrome.runtime.onMessage.addListener(handleMessage);
  await loadState();
  render();

  const stale = !state.finishedAt || Date.now() - state.finishedAt > AUTO_SCAN_MAX_AGE_MS;
  if (!state.running && stale) {
    progress = { done: 0, total: 0 };
    state.running = true;
    render();
    requestScan();
  }
}

init();
