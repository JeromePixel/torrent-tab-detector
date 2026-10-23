'use strict';

/* ============================================================
 * Torrent 批量下载台
 * 汇总所有标签页中的磁力链接 / .torrent 文件，支持全选批量处理。
 * ============================================================ */

const AUTO_SCAN_MAX_AGE_MS = 120000;
const SEARCH_DEBOUNCE_MS = 120;

const els = {
  scanBtn: document.getElementById('scanBtn'),
  scanBtnText: document.getElementById('scanBtnText'),
  scanMeta: document.getElementById('scanMeta'),
  statTotal: document.getElementById('statTotal'),
  statMagnets: document.getElementById('statMagnets'),
  statFiles: document.getElementById('statFiles'),
  statSources: document.getElementById('statSources'),
  progressWrap: document.getElementById('progressWrap'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  progressPercent: document.getElementById('progressPercent'),
  typeFilters: document.getElementById('typeFilters'),
  searchInput: document.getElementById('searchInput'),
  selectAll: document.getElementById('selectAll'),
  list: document.getElementById('list'),
  scanFoot: document.getElementById('scanFoot'),
  selectionInfo: document.getElementById('selectionInfo'),
  copyMagnetsBtn: document.getElementById('copyMagnetsBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  toast: document.getElementById('toast'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  modalBody: document.getElementById('modalBody'),
  modalOk: document.getElementById('modalOk'),
};

let state = emptyState();
let progress = { done: 0, total: 0 };
let items = [];
let selected = new Set();
let typeFilter = 'all';
let searchQuery = '';
let renderQueued = false;
let toastTimer = 0;
let modalTimer = 0;
let searchTimer = 0;

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

/* ---------- 通用工具 ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(pathData) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
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

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(start, end) {
  if (!start || !end || end < start) return '';
  const ms = end - start;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
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
  }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
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
      return true;
    } catch (__) {
      return false;
    }
  }
}

/* ---------- 条目整理 ---------- */

function itemKey(finding) {
  if (finding.kind === 'magnet') {
    const match = /urn:bt(?:ih|mh):([a-z0-9]{32,68})/i.exec(finding.value);
    if (match) return `magnet:${match[1].toLowerCase()}`;
  }
  if (finding.kind === 'torrent-file') {
    try {
      const url = new URL(finding.value);
      url.hash = '';
      return `file:${url.href}`;
    } catch (_) {
      return `file:${finding.value}`;
    }
  }
  return `${finding.kind}:${finding.value}`;
}

function magnetName(value) {
  try {
    const query = value.replace(/^magnet:\?/i, '').split('#')[0];
    const params = new URLSearchParams(query);
    const dn = params.get('dn');
    if (dn) return dn;
    const xt = params.get('xt') || '';
    const hash = xt.split(':').pop() || '';
    return hash ? `磁力 ${hash.slice(0, 10)}…` : '磁力链接';
  } catch (_) {
    return '磁力链接';
  }
}

function torrentFileName(value, label) {
  const hint = String(label || '').trim();
  if (/\.torrent$/i.test(hint) && !/[\\/]/.test(hint)) return hint;

  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch (_) {
      /* 保留原始编码 */
    }
    return name || url.hostname || '种子文件';
  } catch (_) {
    return String(value).slice(0, 80);
  }
}

function torrentDownloadName(item) {
  const name = String(item.name || '').trim();
  if (!/\.torrent$/i.test(name)) return '';
  // 附件链接的显示名作为下载文件名，避免保存成 forum.php
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160);
}

function buildItems(tabs) {
  const map = new Map();

  for (const tab of tabs || []) {
    for (const finding of tab.findings || []) {
      if (finding.kind !== 'magnet' && finding.kind !== 'torrent-file') continue;

      const key = itemKey(finding);
      let item = map.get(key);
      if (!item) {
        item = {
          key: key,
          kind: finding.kind,
          value: finding.value,
          name: finding.kind === 'magnet' ? magnetName(finding.value) : torrentFileName(finding.value, finding.label),
          sources: [],
        };
        map.set(key, item);
      }

      if (!item.sources.some((source) => source.tabId === tab.id)) {
        item.sources.push({
          tabId: tab.id,
          windowId: tab.windowId,
          title: tab.title || '(无标题)',
          url: tab.url || '',
          favIconUrl: tab.favIconUrl || '',
        });
      }
    }
  }

  const list = Array.from(map.values());
  list.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'magnet' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return list;
}

/* ---------- 过滤 ---------- */

function matchesQuery(item) {
  if (!searchQuery) return true;
  if (item.name.toLowerCase().includes(searchQuery)) return true;
  if (item.value.toLowerCase().includes(searchQuery)) return true;
  return item.sources.some(
    (source) =>
      (source.title || '').toLowerCase().includes(searchQuery) ||
      (source.url || '').toLowerCase().includes(searchQuery)
  );
}

function visibleItems() {
  return items.filter((item) => (typeFilter === 'all' || item.kind === typeFilter) && matchesQuery(item));
}

/* ---------- 渲染 ---------- */

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

function renderAll() {
  items = buildItems(state.tabs);
  const existingKeys = new Set(items.map((item) => item.key));
  for (const key of Array.from(selected)) {
    if (!existingKeys.has(key)) selected.delete(key);
  }

  renderScanUI();
  renderStats();
  renderList();
  updateSelectionUI();
  renderScanFoot();
}

function renderScanUI() {
  els.scanBtn.disabled = state.running;
  els.scanBtnText.textContent = state.running ? '扫描中…' : '重新扫描';

  if (state.running) {
    els.progressWrap.hidden = false;
    const known = progress.total > 0;
    const percent = known ? Math.round((progress.done / progress.total) * 100) : 0;
    els.progressBar.classList.toggle('indeterminate', !known);
    els.progressBar.style.width = known ? `${Math.max(percent, 3)}%` : '';
    els.progressText.textContent = known
      ? `正在扫描 ${progress.done} / ${progress.total} 个标签页`
      : '正在枚举标签页…';
    els.progressPercent.textContent = known ? `${percent}%` : '…';
  } else {
    els.progressWrap.hidden = true;
  }

  if (state.finishedAt) {
    const duration = formatDuration(state.startedAt, state.finishedAt);
    const parts = [`上次扫描 ${formatTime(state.finishedAt)}`];
    if (duration) parts.push(duration);
    parts.push(`${Math.max(state.scannedTabs || 0, state.tabs.length)} 个标签页`);
    els.scanMeta.textContent = parts.join(' · ');
  } else {
    els.scanMeta.textContent = '';
  }
}

function renderStats() {
  const magnetCount = items.filter((item) => item.kind === 'magnet').length;
  els.statTotal.textContent = String(items.length);
  els.statMagnets.textContent = String(magnetCount);
  els.statFiles.textContent = String(items.length - magnetCount);

  const tabIds = new Set();
  for (const item of items) {
    for (const source of item.sources) tabIds.add(source.tabId);
  }
  els.statSources.textContent = String(tabIds.size);
}

function renderList() {
  els.list.textContent = '';
  const visible = visibleItems();

  if (!visible.length) {
    els.list.appendChild(buildEmptyState());
    updateSelectAllState();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of visible) fragment.appendChild(buildRow(item));
  els.list.appendChild(fragment);
  updateSelectAllState();
}

function buildEmptyState() {
  const wrapper = el('div', 'empty-state');
  wrapper.appendChild(el('div', 'empty-icon', state.running ? '◎' : '◇'));

  if (state.running && !items.length) {
    wrapper.appendChild(el('p', '', '正在扫描所有已打开的标签页…'));
  } else if (state.error && !items.length) {
    wrapper.appendChild(el('p', '', '扫描出错'));
    wrapper.appendChild(el('p', 'hint', state.error));
  } else if (items.length) {
    wrapper.appendChild(el('p', '', '当前筛选下没有匹配的条目'));
    wrapper.appendChild(el('p', 'hint', '试试切换类型或清空搜索关键词'));
  } else {
    wrapper.appendChild(el('p', '', '还没有发现可下载的 torrent'));
    wrapper.appendChild(el('p', 'hint', '打开含磁力链接或 .torrent 文件的页面，然后点击「重新扫描」'));
  }

  return wrapper;
}

function buildRow(item) {
  const row = el('div', 'list-row');
  row.dataset.key = item.key;
  if (selected.has(item.key)) row.classList.add('selected');

  const checkCell = el('label', 'check-cell');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(item.key);
  checkbox.setAttribute('aria-label', `选择 ${item.name}`);
  checkbox.addEventListener('change', () => setSelected(item.key, checkbox.checked));
  checkCell.appendChild(checkbox);

  const nameCell = el('div', 'col-name');
  const name = el('div', 'item-name', item.name);
  name.title = item.name;
  nameCell.appendChild(name);

  const link = el('div', 'item-link', item.value);
  link.title = item.value;
  nameCell.appendChild(link);

  const sourceCell = el('div', 'col-source');
  const firstSource = item.sources[0];
  if (firstSource) {
    const sourceBtn = el('button', 'source-btn');
    sourceBtn.type = 'button';
    sourceBtn.title = item.sources.map((source) => source.title).join('\n');

    const sourceIcon = el('span', 'source-icon', '◈');
    if (firstSource.favIconUrl && /^https?:/i.test(firstSource.favIconUrl)) {
      const img = document.createElement('img');
      img.src = firstSource.favIconUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        img.remove();
        sourceIcon.textContent = '◈';
      });
      sourceIcon.textContent = '';
      sourceIcon.appendChild(img);
    }
    sourceBtn.appendChild(sourceIcon);

    const sourceTitle = el('span', 'source-title', firstSource.title);
    sourceBtn.appendChild(sourceTitle);

    if (item.sources.length > 1) {
      sourceBtn.appendChild(el('span', 'source-more', `+${item.sources.length - 1}`));
    }

    sourceBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      focusSource(item);
    });
    sourceCell.appendChild(sourceBtn);
  }

  const typeCell = el('div', 'col-type');
  typeCell.appendChild(el('span', `badge ${item.kind === 'magnet' ? 'magnet' : 'file'}`, item.kind === 'magnet' ? '磁力' : '种子'));

  const actionCell = el('div', 'col-actions');

  const copyButton = el('button', 'icon-btn');
  copyButton.type = 'button';
  copyButton.title = '复制链接';
  copyButton.appendChild(icon('M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1'));
  copyButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    const ok = await copyText(item.value);
    toast(ok ? '链接已复制' : '复制失败');
  });

  const gotoButton = el('button', 'icon-btn');
  gotoButton.type = 'button';
  gotoButton.title = '定位到来源标签页';
  gotoButton.appendChild(icon('M6 3h7v10 M6 13 13 3 M3 5v8h8'));
  gotoButton.addEventListener('click', (event) => {
    event.stopPropagation();
    focusSource(item);
  });

  actionCell.appendChild(copyButton);
  actionCell.appendChild(gotoButton);

  row.appendChild(checkCell);
  row.appendChild(nameCell);
  row.appendChild(sourceCell);
  row.appendChild(typeCell);
  row.appendChild(actionCell);

  row.addEventListener('click', (event) => {
    if (event.target.closest('button, input, label, a')) return;
    const next = !selected.has(item.key);
    setSelected(item.key, next);
    checkbox.checked = next;
  });

  return row;
}

function renderScanFoot() {
  const unreadable = (state.tabs || []).filter((tab) => tab.accessible === false);
  const skipped = state.skipped || [];
  const total = unreadable.length + skipped.length;

  els.scanFoot.textContent = '';
  els.scanFoot.hidden = total === 0 && !state.error;
  if (els.scanFoot.hidden) return;

  if (total) {
    els.scanFoot.appendChild(el('span', '', `${total} 个标签页未能读取`));
    const button = el('button', 'link-btn', '查看原因');
    button.type = 'button';
    button.addEventListener('click', showUnreadableModal);
    els.scanFoot.appendChild(button);
  }

  if (state.error) {
    els.scanFoot.appendChild(el('span', 'warn-text', `扫描错误：${state.error}`));
  }
}

function showUnreadableModal() {
  const nodes = [];

  for (const tab of (state.tabs || []).filter((item) => item.accessible === false)) {
    const row = document.createElement('p');
    const name = document.createElement('b');
    name.textContent = tab.title || '(无标题)';
    row.appendChild(name);
    row.appendChild(document.createTextNode(` — ${tab.note || '无法读取该页面'}`));
    nodes.push(row);
  }

  for (const tab of state.skipped || []) {
    const row = document.createElement('p');
    const name = document.createElement('b');
    name.textContent = tab.title || tab.url || '(无标题)';
    row.appendChild(name);
    row.appendChild(document.createTextNode(` — ${tab.reason || '受限制的页面'}`));
    nodes.push(row);
  }

  if (!nodes.length) nodes.push(el('p', '', '没有无法读取的标签页。'));
  openModal('为什么有些标签页无法读取', nodes);
}

/* ---------- 选择 ---------- */

function setSelected(key, value) {
  if (value) selected.add(key);
  else selected.delete(key);

  const row = els.list.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (row) row.classList.toggle('selected', value);

  updateSelectionUI();
  updateSelectAllState();
}

function selectedItems() {
  return items.filter((item) => selected.has(item.key));
}

function updateSelectionUI() {
  const chosen = selectedItems();
  const magnets = chosen.filter((item) => item.kind === 'magnet').length;
  const files = chosen.length - magnets;

  els.selectionInfo.textContent = chosen.length
    ? `已选 ${chosen.length} 项 · 磁力 ${magnets} · 种子 ${files}`
    : '未选择任何条目';

  els.copyMagnetsBtn.disabled = magnets === 0;
  els.copyMagnetsBtn.textContent = magnets ? `复制磁力 (${magnets})` : '复制磁力';

  els.downloadBtn.disabled = chosen.length === 0;
  els.downloadBtn.textContent = chosen.length ? `下载选中 (${chosen.length})` : '下载选中';
}

function updateSelectAllState() {
  const visible = visibleItems();
  const chosenVisible = visible.filter((item) => selected.has(item.key)).length;
  els.selectAll.checked = visible.length > 0 && chosenVisible === visible.length;
  els.selectAll.indeterminate = chosenVisible > 0 && chosenVisible < visible.length;
}

/* ---------- 动作 ---------- */

function requestScan(force) {
  chrome.runtime
    .sendMessage({ type: 'SCAN', trigger: 'dashboard', force: Boolean(force) })
    .catch(() => {});
}

async function focusSource(item) {
  const source = item.sources[0];
  if (!source) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FOCUS_TAB',
      tabId: source.tabId,
      windowId: source.windowId,
    });
    if (!response || !response.ok) toast('无法切换到来源标签页');
  } catch (_) {
    toast('无法切换到来源标签页');
  }
}

async function copyMagnets() {
  const magnets = selectedItems().filter((item) => item.kind === 'magnet');
  if (!magnets.length) return;
  const ok = await copyText(magnets.map((item) => item.value).join('\n'));
  toast(ok ? `已复制 ${magnets.length} 条磁力链接，粘贴到 BT 客户端即可` : '复制失败，请重试');
}

async function downloadSelected() {
  const chosen = selectedItems();
  if (!chosen.length) return;

  const magnets = chosen.filter((item) => item.kind === 'magnet');
  const files = chosen.filter((item) => item.kind === 'torrent-file');

  els.downloadBtn.disabled = true;
  const label = els.downloadBtn.textContent;
  els.downloadBtn.textContent = '处理中…';

  const copied = magnets.length ? await copyText(magnets.map((item) => item.value).join('\n')) : false;

  let downloaded = 0;
  const failed = [];
  for (const item of files) {
    try {
      const options = {
        url: item.value,
        conflictAction: 'uniquify',
      };
      const filename = torrentDownloadName(item);
      if (filename) options.filename = filename;
      await chrome.downloads.download(options);
      downloaded += 1;
    } catch (_) {
      failed.push(item);
    }
  }

  els.downloadBtn.textContent = label;
  updateSelectionUI();

  const lines = [];

  if (magnets.length) {
    lines.push(
      copied
        ? `已复制 <b>${magnets.length}</b> 条磁力链接到剪贴板。`
        : `<span class="warn">${magnets.length} 条磁力链接复制失败</span>，请点击下方「复制磁力」重试。`
    );
  }

  if (files.length) {
    lines.push(`已开始下载 <b>${downloaded}</b> 个 .torrent 文件，可在浏览器下载栏查看。`);
  }

  if (failed.length) {
    lines.push(`<span class="warn">${failed.length} 个种子文件下载失败</span>，可能链接已失效或需要登录。`);
  }

  if (magnets.length && copied) {
    lines.push('打开 BT 客户端（qBittorrent / Transmission 等），选择「添加链接 / 添加任务」，粘贴一次即可批量下载。');
  }

  if (magnets.length || failed.length) {
    showModal(magnets.length ? '已准备好批量下载' : '部分文件下载失败', lines);
  } else if (downloaded) {
    toast(`已开始下载 ${downloaded} 个种子文件`);
  }
}

/* ---------- 弹窗 ---------- */

function openModal(title, nodes) {
  els.modalTitle.textContent = title;
  els.modalBody.textContent = '';
  for (const node of nodes) els.modalBody.appendChild(node);
  els.modal.hidden = false;
  requestAnimationFrame(() => els.modal.classList.add('show'));
}

function showModal(title, lines) {
  const nodes = lines.map((line) => {
    const paragraph = document.createElement('p');
    paragraph.innerHTML = line;
    return paragraph;
  });
  openModal(title, nodes);
}

function closeModal() {
  els.modal.classList.remove('show');
  clearTimeout(modalTimer);
  modalTimer = setTimeout(() => {
    els.modal.hidden = true;
  }, 180);
}

/* ---------- 事件与消息 ---------- */

function bindEvents() {
  els.scanBtn.addEventListener('click', () => {
    if (state.running) return;
    progress = { done: 0, total: 0 };
    state.running = true;
    renderScanUI();
    requestScan(true);
  });

  els.typeFilters.addEventListener('click', (event) => {
    const button = event.target.closest('.seg-btn');
    if (!button) return;
    typeFilter = button.dataset.type || 'all';
    for (const item of els.typeFilters.querySelectorAll('.seg-btn')) {
      item.classList.toggle('active', item === button);
    }
    renderList();
    updateSelectionUI();
  });

  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = els.searchInput.value.trim().toLowerCase();
      renderList();
      updateSelectionUI();
    }, SEARCH_DEBOUNCE_MS);
  });

  els.selectAll.addEventListener('change', () => {
    const visible = visibleItems();
    const checked = els.selectAll.checked;
    for (const item of visible) {
      if (checked) selected.add(item.key);
      else selected.delete(item.key);
    }
    for (const row of els.list.querySelectorAll('.list-row')) {
      const isSelected = selected.has(row.dataset.key);
      row.classList.toggle('selected', isSelected);
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = isSelected;
    }
    updateSelectionUI();
  });

  els.copyMagnetsBtn.addEventListener('click', copyMagnets);
  els.downloadBtn.addEventListener('click', downloadSelected);

  els.modalOk.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.modal.hidden) closeModal();
  });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'SCAN_STARTED') {
    state = { ...emptyState(), running: true, startedAt: message.startedAt };
    items = [];
    selected.clear();
    progress = { done: 0, total: 0 };
    renderAll();
    return;
  }

  if (message.type === 'TAB_SCANNED') {
    progress = { done: message.done || 0, total: message.total || 0 };
    if (message.tab && !state.tabs.some((tab) => tab.id === message.tab.id)) {
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
    renderAll();
    return;
  }

  if (message.type === 'STATE_CLEARED') {
    state = emptyState();
    items = [];
    selected.clear();
    renderAll();
  }
}

async function loadState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response && response.state) state = response.state;
  } catch (_) {
    state = emptyState();
  }
}

async function init() {
  bindEvents();
  chrome.runtime.onMessage.addListener(handleMessage);

  await loadState();
  items = buildItems(state.tabs);
  renderAll();

  const stale = !state.finishedAt || Date.now() - state.finishedAt > AUTO_SCAN_MAX_AGE_MS;
  if (!state.running && stale) {
    progress = { done: 0, total: 0 };
    state.running = true;
    renderAll();
    requestScan();
  }
}

init();
