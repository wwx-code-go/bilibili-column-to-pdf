'use strict';

const $ = (sel) => document.querySelector(sel);

const el = {
  account: $('#account'),
  url: $('#url'),
  btnResolve: $('#btn-resolve'),
  authorLine: $('#author-line'),
  cardLists: $('#card-lists'),
  listsBody: $('#lists-body'),
  checkAll: $('#check-all'),
  pickSummary: $('#pick-summary'),
  cardOutput: $('#card-output'),
  name: $('#name'),
  outdir: $('#outdir'),
  recentDirs: $('#recent-dirs'),
  btnPick: $('#btn-pick'),
  fieldMode: $('#field-mode'),
  cardRun: $('#card-run'),
  btnGenerate: $('#btn-generate'),
  btnCancel: $('#btn-cancel'),
  btnOpen: $('#btn-open'),
  progressWrap: $('#progress-wrap'),
  bar: $('#bar'),
  progressText: $('#progress-text'),
  log: $('#log'),
  results: $('#results'),
  btnShutdown: $('#btn-shutdown'),
};

const state = {
  lists: [],
  preselect: [],
  jobRunning: false,
  lastSeq: 0,
  es: null,
  loginPoll: null,
  settingsLoaded: false,
};

// ------------------------------------------------------------------ 通用
async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `请求失败（${r.status}）`);
  return j;
}

let toastTimer = null;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function logLine(msg, level = '') {
  el.log.classList.remove('hidden');
  const div = document.createElement('div');
  if (level) div.className = level;
  div.textContent = msg;
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
}

function setProgress(pct, text) {
  el.progressWrap.classList.remove('hidden');
  el.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (text !== undefined) el.progressText.textContent = text;
}

/** 与命令行一致的范围写法：空=全部，20=前 20 篇，5-20=第 5–20 篇 */
function parseRange(spec, total) {
  const s = String(spec || '').trim().toLowerCase();
  if (!s || s === 'all' || s === '*') return { from: 1, to: total };
  let m;
  if ((m = s.match(/^(\d+)\s*[-~到]\s*(\d+)$/))) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a < 1 || b > total || a > b) return null;
    return { from: a, to: b };
  }
  if ((m = s.match(/^(\d+)$/))) {
    const a = Number(m[1]);
    if (a < 1 || a > total) return null;
    return { from: 1, to: a };
  }
  return null;
}

// ------------------------------------------------------------------ 登录状态
function renderLogin(st) {
  el.account.innerHTML = '';

  // 冷启动时浏览器还没起来，先给个明确的状态而不是一直「检测中」
  if (st.warming) {
    const s = document.createElement('span');
    s.className = 'muted';
    s.textContent = '正在启动浏览器…（首次约十几秒）';
    el.account.appendChild(s);
    if (!state.loginPoll) state.loginPoll = setInterval(() => refreshState(true), 1500);
    return;
  }
  if (state.loginPoll && (!st.loginFlow || st.loginFlow.status !== 'waiting')) {
    clearInterval(state.loginPoll);
    state.loginPoll = null;
  }

  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.alt = '';

  if (st.loggedIn) {
    // B 站头像 CDN 会拒绝来自 127.0.0.1 的 Referer（403），带 no-referrer 才能取到
    avatar.referrerPolicy = 'no-referrer';
    avatar.src = st.face || 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="#fb7299"/></svg>');
    avatar.onerror = () => { avatar.style.visibility = 'hidden'; };
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = st.uname || '已登录';
    const uid = document.createElement('span');
    uid.className = 'uid';
    uid.textContent = st.mid ? `UID ${st.mid}` : '';
    const out = document.createElement('button');
    out.className = 'link';
    out.textContent = '退出登录';
    out.onclick = async () => {
      if (!confirm('确定要退出登录吗？（会清除程序里保存的登录状态）')) return;
      try { await api('/api/logout', {}); toast('已退出登录'); refreshState(true); }
      catch (e) { toast(e.message); }
    };
    el.account.append(avatar, name, uid, out);
    return;
  }

  const text = document.createElement('span');
  text.className = 'muted';
  text.textContent = st.loginExpired
    ? '登录已过期，请重新登录（否则抓长文集会被风控拦截）'
    : '未登录 —— 抓长文集会被 B 站风控拦截';
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = '登录 B 站';
  btn.onclick = doLogin;
  el.account.append(text, btn);

  if (st.loginFlow && st.loginFlow.status === 'waiting') {
    text.textContent = st.loginFlow.message || '请在弹出的窗口里扫码登录…';
    btn.disabled = true;
    btn.textContent = '等待扫码…';
    if (!state.loginPoll) {
      state.loginPoll = setInterval(() => refreshState(true), 1500);
    }
  } else if (state.loginPoll) {
    clearInterval(state.loginPoll);
    state.loginPoll = null;
  }
}

async function doLogin() {
  try {
    toast('正在打开登录窗口…');
    await api('/api/login', {});
    refreshState(true);
    if (!state.loginPoll) state.loginPoll = setInterval(() => refreshState(true), 1500);
  } catch (e) {
    toast(e.message);
  }
}

async function refreshState(light = false) {
  let st;
  try { st = await api('/api/state'); } catch { return; }
  renderLogin(st);

  if (!state.settingsLoaded) {
    state.settingsLoaded = true;
    el.outdir.value = st.settings.outDir || st.defaultOutDir || '';
    el.name.value = st.settings.pdfName || '';
    if (st.settings.lastUrl) el.url.value = st.settings.lastUrl;
    document.querySelector(`input[name="mode"][value="${st.settings.split ? 'split' : 'merge'}"]`).checked = true;
    renderRecentDirs(st.settings.recentDirs || []);
  } else {
    renderRecentDirs(st.settings.recentDirs || []);
  }

  // 页面刷新后若任务还在跑，自动接上进度
  if (st.job && st.job.status === 'running' && !state.jobRunning) {
    state.jobRunning = true;
    setRunningUI(true);
    openEvents();
  }
  if (!state.jobRunning && st.job && st.job.status !== 'running' && st.job.outputs && st.job.outputs.length) {
    renderResults({ outputs: st.job.outputs });
  }
}

function renderRecentDirs(dirs) {
  el.recentDirs.innerHTML = '';
  for (const d of dirs) {
    const o = document.createElement('option');
    o.value = d;
    el.recentDirs.appendChild(o);
  }
}

// ------------------------------------------------------------------ 解析
async function doResolve() {
  const url = el.url.value.trim();
  if (!url) return toast('请先填写专栏地址');
  el.btnResolve.disabled = true;
  el.btnResolve.textContent = '识别中…';
  el.authorLine.innerHTML = '<span class="muted">正在启动浏览器并识别，第一次会慢一点…</span>';
  try {
    const r = await api('/api/resolve', { url });
    state.lists = r.lists;
    state.preselect = r.preselect || [];
    el.authorLine.innerHTML =
      `<span class="ok">✓</span> 作者：<b>${escapeHtml(r.author.name || '(未知)')}</b>` +
      `（UID ${r.author.mid}）` +
      (r.author.via ? ` <span class="muted">· ${escapeHtml(r.author.via)}</span>` : '') +
      ` <span class="muted">· 共识别到 ${r.lists.length} 个文集</span>`;
    renderLists();
    show(el.cardLists); show(el.cardOutput); show(el.cardRun);
  } catch (e) {
    el.authorLine.innerHTML = `<span class="err">✗ ${escapeHtml(e.message)}</span>`;
  } finally {
    el.btnResolve.disabled = false;
    el.btnResolve.textContent = '识别文集';
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(node) { node.classList.remove('hidden'); }

function renderLists() {
  el.listsBody.innerHTML = '';
  state.lists.forEach((l, i) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = String(i);

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'pick';
    cb.checked = state.preselect.length ? state.preselect.includes(l.id) : state.lists.length === 1;
    cb.onchange = () => { tr.classList.toggle('disabled', !cb.checked); updateSummary(); };
    tdCheck.appendChild(cb);

    const tdName = document.createElement('td');
    tdName.className = 'name';
    tdName.textContent = l.name;

    const tdCount = document.createElement('td');
    tdCount.textContent = l.count ? `${l.count} 篇` : '?';

    const tdRange = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'range';
    input.placeholder = `全部（1-${l.count || '?'}）`;
    input.oninput = updateSummary;
    tdRange.appendChild(input);

    tr.append(tdCheck, tdName, tdCount, tdRange);
    tr.classList.toggle('disabled', !cb.checked);
    el.listsBody.appendChild(tr);
  });
  updateSummary();
}

function selectedRows() {
  return [...el.listsBody.querySelectorAll('tr')].filter((tr) => tr.querySelector('.pick').checked);
}

function updateSummary() {
  const rows = selectedRows();
  let total = 0;
  let bad = 0;
  for (const tr of rows) {
    const l = state.lists[Number(tr.dataset.idx)];
    const spec = tr.querySelector('.range').value;
    const r = parseRange(spec, l.count || 0);
    if (!r) { bad += 1; tr.querySelector('.range').style.borderColor = 'var(--err)'; continue; }
    tr.querySelector('.range').style.borderColor = '';
    total += r.to - r.from + 1;
  }
  el.pickSummary.textContent = rows.length
    ? `已选 ${rows.length} 个文集，共 ${total} 篇${bad ? `（有 ${bad} 个范围填错了）` : ''}`
    : '还没有选择文集';
  el.btnGenerate.disabled = rows.length === 0 || bad > 0 || state.jobRunning;
  return { rows, total, bad };
}

// ------------------------------------------------------------------ 生成
function setRunningUI(running) {
  state.jobRunning = running;
  el.btnGenerate.classList.toggle('hidden', running);
  el.btnCancel.classList.toggle('hidden', !running);
  el.btnGenerate.disabled = running;
  el.btnResolve.disabled = running;
  if (!running) updateSummary();
}

async function doGenerate() {
  const { rows, bad } = updateSummary();
  if (!rows.length) return toast('请先选择要下载的文集');
  if (bad) return toast('有文集的篇数范围填错了');

  const picks = rows.map((tr) => {
    const l = state.lists[Number(tr.dataset.idx)];
    const r = parseRange(tr.querySelector('.range').value, l.count || 0);
    return { rlId: l.id, from: r.from, to: r.to };
  });

  const name = el.name.value.trim() || (picks.length === 1
    ? state.lists.find((l) => l.id === picks[0].rlId).name
    : `${state.lists.find((l) => l.id === picks[0].rlId).name}等${picks.length}个文集`);
  const outDir = el.outdir.value.trim();
  const split = document.querySelector('input[name="mode"]:checked').value === 'split';
  if (!outDir) return toast('请填写输出目录');

  el.log.innerHTML = '';
  el.results.innerHTML = '';
  el.log.classList.remove('hidden');
  state.lastSeq = 0;
  setRunningUI(true);
  setProgress(0, '正在准备…');

  try {
    await api('/api/generate', { url: el.url.value.trim(), picks, name, outDir, split });
    openEvents();
  } catch (e) {
    setRunningUI(false);
    logLine('✗ ' + e.message, 'error');
    toast(e.message);
  }
}

function openEvents() {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/events?since=${state.lastSeq}`);
  state.es = es;
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    state.lastSeq = Math.max(state.lastSeq, e.seq || 0);
    handleEvent(e);
  };
  es.onerror = () => { /* 浏览器会自动重连 */ };
}

function handleEvent(e) {
  switch (e.type) {
    case 'start':
      logLine(`开始生成《${e.name}》 → ${e.outDir}`);
      break;

    case 'phase':
      if (e.phase === 'resolve') setProgress(2, '正在读取文集目录…');
      else if (e.phase === 'fetch') setProgress(4, `开始抓取 ${e.total} 篇文章正文…`);
      else if (e.phase === 'images') { setProgress(45, `《${e.name}》：下载图片 ${e.total} 张…`); }
      else if (e.phase === 'render') setProgress(85, `《${e.name}》：正在生成 PDF…`);
      break;

    case 'fetch':
      setProgress(4 + (e.done / Math.max(1, e.total)) * 38, `抓取正文 ${e.done}/${e.total}`);
      break;

    case 'images':
      setProgress(45 + (e.done / Math.max(1, e.total)) * 38, `下载图片 ${e.done}/${e.total}`);
      break;

    case 'render':
      setProgress(85 + Math.min(12, (e.bytes / 1024 / 1024) / 20), `正在生成 PDF…已接收 ${(e.bytes / 1024 / 1024).toFixed(1)} MB`);
      break;

    case 'log':
      logLine((e.level === 'warn' ? '⚠ ' : '') + e.message, e.level || '');
      break;

    case 'checks':
      for (const c of e.checks) {
        if (c.skipped) logLine(`· 《${c.list}》：${c.message}`);
        else if (c.ok) logLine(`✓ 《${c.list}》字数校验一致：${c.actual.toLocaleString('en-US')}`, 'ok');
        else logLine(`⚠ 《${c.list}》字数校验不一致：${c.actual.toLocaleString('en-US')} / 应为 ${c.expected.toLocaleString('en-US')}`, 'warn');
      }
      break;

    case 'login-state':
      if (!e.isLogin) logLine('提示：当前未登录，长文集可能被抓到一半被风控拦截。', 'warn');
      break;

    case 'login':
      refreshState(true);
      break;

    case 'result':
      setProgress(98, '正在收尾…');
      logLine(`✓ ${e.file}`, 'ok');
      logLine(`   ${e.pages} 页 · ${(e.bytes / 1024 / 1024).toFixed(1)} MB · ${e.links} 个目录内链 · ${e.outlines} 条书签 · ${e.images} 张图`);
      renderResults({ outputs: [e] });
      break;

    case 'done':
      setProgress(100, '全部完成');
      setRunningUI(false);
      el.btnOpen.classList.remove('hidden');
      logLine('全部完成 ✓', 'ok');
      if (state.es) { state.es.close(); state.es = null; }
      break;

    case 'failed':
      setRunningUI(false);
      setProgress(0, e.cancelled ? '已取消' : '出错了');
      logLine('✗ ' + e.message, 'error');
      renderError(e.message);
      if (state.es) { state.es.close(); state.es = null; }
      break;

    case 'missing':
      logLine('✗ ' + e.message, 'error');
      for (const it of e.items || []) logLine('   ' + it);
      if (e.hint) logLine('   ' + e.hint, 'warn');
      break;

    default: break;
  }
}

function renderResults({ outputs }) {
  el.results.innerHTML = '';
  for (const o of outputs) {
    const div = document.createElement('div');
    div.className = 'result';
    div.innerHTML =
      `<div class="title">✓ ${escapeHtml(o.name)}</div>` +
      `<div class="facts">${o.pages} 页 · ${(o.bytes / 1024 / 1024).toFixed(1)} MB · ` +
      `${o.articles} 篇 · ${o.links} 个目录内链 · ${o.outlines} 条书签 · ${o.images} 张图</div>` +
      `<div class="path">${escapeHtml(o.file)}</div>`;
    el.results.appendChild(div);
  }
  el.btnOpen.classList.remove('hidden');
}

function renderError(msg) {
  const div = document.createElement('div');
  div.className = 'result error';
  div.innerHTML = `<div class="title">✗ 生成失败</div><div class="facts">${escapeHtml(msg)}</div>`;
  el.results.innerHTML = '';
  el.results.appendChild(div);
}

// ------------------------------------------------------------------ 文件夹选择器
const fsUi = {
  modal: $('#fs-modal'),
  path: $('#fs-path'),
  list: $('#fs-list'),
  shortcuts: $('#fs-shortcuts'),
  error: $('#fs-error'),
  current: '',
};

async function openFs(startPath) {
  fsUi.modal.classList.remove('hidden');
  $('#fs-new').classList.add('hidden');
  await loadFs(startPath || el.outdir.value.trim() || '');
}

function closeFs() {
  fsUi.modal.classList.add('hidden');
  $('#fs-new').classList.add('hidden');
}

async function loadFs(p) {
  try {
    const r = await api('/api/fs?path=' + encodeURIComponent(p || ''));
    fsUi.current = r.path;
    fsUi.path.value = r.path;
    fsUi.error.textContent = '';
    renderFs(r);
  } catch (e) {
    fsUi.error.textContent = e.message;
  }
}

function renderFs(r) {
  // 快捷入口
  fsUi.shortcuts.innerHTML = '';
  const addShortcut = (label, target) => {
    if (!target) return;
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => loadFs(target);
    fsUi.shortcuts.appendChild(b);
  };
  addShortcut('🏠 桌面', r.desktop);
  addShortcut('👤 用户目录', r.home);
  for (const d of r.roots) addShortcut('💽 ' + d, d);

  // 目录列表
  fsUi.list.innerHTML = '';
  if (r.parent) {
    const up = document.createElement('div');
    up.className = 'fs-item up';
    up.innerHTML = '<span class="ico">↑</span><span>..（上一级）</span>';
    up.onclick = () => loadFs(r.parent);
    fsUi.list.appendChild(up);
  }
  if (!r.dirs.length) {
    const empty = document.createElement('div');
    empty.className = 'fs-empty';
    empty.textContent = '这个文件夹里没有子文件夹，可以直接选它。';
    fsUi.list.appendChild(empty);
  }
  for (const d of r.dirs) {
    const row = document.createElement('div');
    row.className = 'fs-item' + (d.writable ? '' : ' locked');
    row.innerHTML = `<span class="ico">📁</span><span>${escapeHtml(d.name)}</span>` +
      (d.writable ? '' : '<span class="sub">无写入权限</span>');
    row.onclick = () => { if (d.writable) loadFs(d.path); };
    fsUi.list.appendChild(row);
  }
}

// ------------------------------------------------------------------ 事件绑定
el.btnResolve.onclick = doResolve;
el.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doResolve(); });

el.checkAll.onchange = () => {
  const on = el.checkAll.checked;
  for (const tr of el.listsBody.querySelectorAll('tr')) {
    tr.querySelector('.pick').checked = on;
    tr.classList.toggle('disabled', !on);
  }
  updateSummary();
};

el.btnPick.onclick = () => openFs(el.outdir.value.trim());
$('#fs-close').onclick = closeFs;
$('#fs-cancel').onclick = closeFs;
$('#fs-mask').onclick = closeFs;
$('#fs-go').onclick = () => loadFs(fsUi.path.value.trim());
$('#fs-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFs(fsUi.path.value.trim()); });
$('#fs-up').onclick = async () => {
  try {
    const r = await api('/api/fs?path=' + encodeURIComponent(fsUi.current));
    if (r.parent) loadFs(r.parent);
  } catch (e) { fsUi.error.textContent = e.message; }
};
$('#fs-ok').onclick = async () => {
  if (!fsUi.current) return;
  el.outdir.value = fsUi.current;
  closeFs();
  toast('已选择：' + fsUi.current);
  // 立刻记住，不用等到生成
  try { await api('/api/settings', { outDir: fsUi.current }); } catch { /* 记不住不影响使用 */ }
};
$('#fs-native').onclick = async () => {
  // 备用：系统原生对话框。它有窗口焦点问题，可能被挡在后面。
  toast('已打开系统对话框，若没看到请查看任务栏');
  try {
    const r = await api('/api/pick-folder', { current: el.outdir.value.trim() });
    if (r.dir) { el.outdir.value = r.dir; closeFs(); toast('已选择：' + r.dir); }
  } catch (e) { toast(e.message); }
};

// ---- 新建文件夹 ----
function showNewFolder(show) {
  $('#fs-new').classList.toggle('hidden', !show);
  if (show) {
    $('#fs-new-name').value = '';
    $('#fs-new-name').focus();
  }
}

async function createFolder() {
  const name = $('#fs-new-name').value.trim();
  if (!name) return toast('请先填写文件夹名称');
  try {
    const r = await api('/api/mkdir', { parent: fsUi.current, name });
    showNewFolder(false);
    toast('已创建：' + name);
    await loadFs(r.path);            // 直接进到新文件夹里
  } catch (e) {
    toast(e.message);
  }
}

$('#fs-mkdir').onclick = () => showNewFolder($('#fs-new').classList.contains('hidden'));
$('#fs-new-cancel').onclick = () => showNewFolder(false);
$('#fs-new-ok').onclick = createFolder;
$('#fs-new-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createFolder();
  if (e.key === 'Escape') { e.stopPropagation(); showNewFolder(false); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !fsUi.modal.classList.contains('hidden')) closeFs();
});

el.btnGenerate.onclick = doGenerate;
el.btnCancel.onclick = async () => {
  try { await api('/api/cancel', {}); toast('已请求取消'); } catch (e) { toast(e.message); }
};
el.btnOpen.onclick = async () => {
  try { await api('/api/open-folder', { dir: el.outdir.value.trim() }); } catch (e) { toast(e.message); }
};
el.btnShutdown.onclick = async () => {
  if (!confirm('确定要退出程序吗？关掉这个网页后需要重新双击启动。')) return;
  try { await api('/api/shutdown', {}); } catch { /* ignore */ }
  document.body.innerHTML =
    '<div style="display:grid;place-items:center;height:100vh;font-size:15px;color:#8a9099">' +
    '程序已退出，可以直接关闭这个页面。</div>';
};

refreshState();
setInterval(() => { if (!state.jobRunning) refreshState(true); }, 20000);
