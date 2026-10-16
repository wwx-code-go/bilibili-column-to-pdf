// 本地服务：给网页界面提供 API，并负责跑生成任务。
//
// 只监听 127.0.0.1，不对外网开放。所有抓取/渲染都在本进程里复用同一个浏览器。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Browser } from '../lib/cdp.mjs';
import { BiliSession, parseInput } from '../lib/bili.mjs';
import { generate } from '../lib/pipeline.mjs';
import { sanitizeFileName, desktopDir, ensureDir } from '../lib/util.mjs';
import { createSettings } from './settings.mjs';
import { ensureBrowser, findExistingBrowser } from './browser_setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const UI_DIR = path.join(HERE, 'ui');

const WORK_ROOT = path.join(ROOT, '.bili2pdf');
const CACHE_ROOT = path.join(WORK_ROOT, 'cache');
const BUILD_ROOT = path.join(WORK_ROOT, 'build');
const PROFILE_DIR = path.join(WORK_ROOT, 'profile');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const CSS_PATH = path.join(ROOT, 'assets', 'print.css');

const settings = createSettings(path.join(WORK_ROOT, 'settings.json'));

// ---------------------------------------------------------------- 运行时状态
let chromePath = null;
let browser = null;
let browserHeadless = true;
let bili = null;
let browserBusy = false;

let loginFlow = null;                 // { status, message, startedAt }
let loginCache = { at: 0, state: null };
let sessionReady = false;             // 浏览器是否已经拉起来并加载过 B 站
let warming = null;                   // 预热中的 Promise（避免重复启动）

/** 后台预热：把浏览器拉起来并加载一次 B 站，这样界面首次查询就能立刻拿到登录状态。 */
function warmup() {
  if (sessionReady) return Promise.resolve(true);
  if (warming) return warming;
  warming = (async () => {
    try {
      await getSession({ headless: true });
      await readLogin(true);
      sessionReady = true;
    } catch (e) {
      emit('log', { message: '浏览器启动失败：' + e.message });
    } finally {
      warming = null;
    }
    return sessionReady;
  })();
  return warming;
}

const job = {
  id: 0,
  status: 'idle',                     // idle | running | done | error | cancelled
  events: [],
  seq: 0,
  startedAt: 0,
  endedAt: 0,
  outputs: [],
  error: null,
  title: '',
};
const sseClients = new Set();
let cancelRequested = false;

function emit(type, data = {}) {
  const ev = { seq: ++job.seq, type, at: Date.now(), ...data };
  job.events.push(ev);
  if (job.events.length > 3000) job.events.splice(0, 1000);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* 客户端断开 */ }
  }
}

// ---------------------------------------------------------------- 浏览器 / 登录
async function getSession({ headless = true } = {}) {
  if (browser && browserHeadless !== headless) {
    if (job.status === 'running') throw new Error('正在生成 PDF，暂时不能切换浏览器窗口模式');
    await browser.close();
    browser = null;
    bili = null;
  }
  if (!browser) {
    if (!chromePath) chromePath = await ensureBrowser(RUNTIME_DIR, (m) => emit('log', { message: m }));
    browser = await Browser.launch({
      profileDir: PROFILE_DIR,
      headless,
      chromePath,
      log: (m) => emit('log', { message: m }),
    });
    browserHeadless = headless;
    const page = await browser.newPage();
    await page.navigate('https://www.bilibili.com/');
    bili = new BiliSession(page, { delayMs: 700, log: (m) => emit('log', { message: m }) });
  }
  return { browser, bili };
}

async function readLogin(force = false) {
  if (!force && loginCache.state && Date.now() - loginCache.at < 8000) return loginCache.state;
  const { bili: s } = await getSession({ headless: browserHeadless });
  const st = await s.getLoginState();
  loginCache = { at: Date.now(), state: st };
  return st;
}

async function startLogin() {
  if (job.status === 'running') throw new Error('正在生成 PDF，请等它结束后再登录');
  if (loginFlow && loginFlow.status === 'waiting') return loginFlow;

  loginFlow = { status: 'waiting', message: '正在打开登录窗口…', startedAt: Date.now() };
  emit('login', { status: 'waiting' });

  (async () => {
    try {
      const already = await readLogin(true);
      if (already.isLogin) {
        loginFlow = { status: 'ok', message: `已登录：${already.uname}`, uname: already.uname };
        emit('login', { status: 'ok', uname: already.uname });
        return;
      }

      // 登录要在可见窗口里扫码，所以这里用有窗口模式
      const { bili: s } = await getSession({ headless: false });
      const st = await s.getLoginState();
      if (st.isLogin) {
        loginFlow = { status: 'ok', message: `已登录：${st.uname}`, uname: st.uname };
        emit('login', { status: 'ok', uname: st.uname });
        return;
      }

      loginFlow.message = '请在弹出的浏览器窗口里扫码登录…';
      emit('login', { status: 'waiting', message: loginFlow.message });

      const deadline = Date.now() + 5 * 60 * 1000;
      let tick = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        tick += 1;
        if (tick % 15 === 0) emit('login', { status: 'waiting', message: '仍在等待扫码…（5 分钟内有效）' });
        const st2 = await s.getLoginState();
        if (st2.isLogin) {
          loginCache = { at: Date.now(), state: st2 };
          loginFlow = { status: 'ok', message: `登录成功：${st2.uname}`, uname: st2.uname };
          emit('login', { status: 'ok', uname: st2.uname });
          // 登录态已存进程序自己的浏览器配置，之后换回无窗口模式
          try {
            await browser.close();
            browser = null; bili = null;
            await getSession({ headless: true });
          } catch { /* 换回失败也不影响已登录的状态 */ }
          return;
        }
      }
      loginFlow = { status: 'timeout', message: '等待超时，请重试' };
      emit('login', { status: 'timeout' });
    } catch (e) {
      loginFlow = { status: 'error', message: e.message };
      emit('login', { status: 'error', message: e.message });
    }
  })();

  return loginFlow;
}

// ---------------------------------------------------------------- 任务
async function startJob(req) {
  if (job.status === 'running') throw new Error('已经有一个任务在跑了');

  const picks = Array.isArray(req.picks) ? req.picks : [];
  if (!picks.length) throw new Error('还没有选择文集');
  const outDir = ensureDir(req.outDir || settings.read().outDir || desktopDir());
  const name = sanitizeFileName(req.name || 'B站专栏');
  const split = !!req.split;

  settings.write({ outDir, pdfName: name, split, lastUrl: req.url || settings.read().lastUrl });

  job.id += 1;
  job.status = 'running';
  job.events = [];
  job.seq = 0;
  job.outputs = [];
  job.error = null;
  job.title = name;
  job.startedAt = Date.now();
  job.endedAt = 0;
  cancelRequested = false;
  emit('start', { name, outDir, split, picks: picks.length });

  // 后台执行，HTTP 立即返回
  (async () => {
    try {
      const { bili: s } = await getSession({ headless: browserHeadless || true });

      const login = await s.getLoginState();
      loginCache = { at: Date.now(), state: login };
      emit('login-state', { isLogin: !!login.isLogin, uname: login.uname || '' });
      if (!login.isLogin) {
        emit('log', {
          level: 'warn',
          message: '当前未登录：抓几十篇之后 B 站会开始风控拦截。建议先点右上角「登录 B 站」。',
        });
      }

      emit('phase', { phase: 'resolve' });
      const selections = [];
      for (const p of picks) {
        const list = await s.getReadingList(p.rlId);
        const total = list.articles.length;
        const from = Math.max(1, Number(p.from) || 1);
        const to = Math.min(total, Number(p.to) || total);
        if (from > to) throw new Error(`《${list.name}》的篇数范围不对：${from}-${to}`);
        const picked = list.articles.slice(from - 1, to);
        selections.push({
          list,
          picked,
          range: { from, to },
          total,
          limited: !(from === 1 && to === total),
        });
        emit('log', { message: `《${list.name}》：第 ${from}–${to} 篇，共 ${picked.length} 篇` });
      }

      const { outputs } = await generate({
        browser, bili: s, selections, name, outDir, split,
        cacheRoot: CACHE_ROOT, buildRoot: BUILD_ROOT, cssPath: CSS_PATH,
        onEvent: (e) => {
          if (cancelRequested) throw new Error('已取消');
          emit(e.type, e);
        },
      });

      job.outputs = outputs;
      job.status = 'done';
      job.endedAt = Date.now();
      emit('done', { outputs, ms: job.endedAt - job.startedAt });
    } catch (e) {
      job.status = cancelRequested ? 'cancelled' : 'error';
      job.error = e.message;
      job.endedAt = Date.now();
      emit('failed', { message: e.message, cancelled: cancelRequested });
    }
  })();

  return { jobId: job.id };
}

// ---------------------------------------------------------------- 辅助
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    // 必须先把 Buffer 收齐再整体按 UTF-8 解码：逐块 toString 会在
    // 多字节字符正好被 TCP 分包切开时把中文弄坏。
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/** 弹出系统原生的「选择文件夹」对话框。没人操作时 5 分钟自动放弃。 */
function pickFolder(initial) {
  const esc = (s) => String(s || '').replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择 PDF 输出目录'",
    "$d.ShowNewFolderButton = $true",
    initial ? `$d.SelectedPath = '${esc(initial)}'` : '',
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].filter(Boolean).join('; ');
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { p.kill(); } catch { /* ignore */ }
      finish('');
    }, 5 * 60 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { clearTimeout(timer); finish(out.trim()); });
    p.on('error', () => { clearTimeout(timer); finish(''); });
  });
}

function openFolder(dir) {
  try {
    spawn('explorer', [path.resolve(dir)], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, rel) {
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 路由
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
  if (p.startsWith('/ui/')) return serveStatic(res, p.slice(4));

  // ---- 状态 ----
  if (p === '/api/state' && req.method === 'GET') {
    const st = settings.read();
    const base = {
      settings: st,
      defaultOutDir: st.outDir || desktopDir(),
      browser: findExistingBrowser(RUNTIME_DIR) ? 'ok' : 'missing',
      job: {
        id: job.id, status: job.status, title: job.title, error: job.error,
        outputs: job.outputs, seq: job.seq,
        startedAt: job.startedAt, endedAt: job.endedAt,
      },
    };
    // 浏览器还没起来时立刻返回，别让页面干等（冷启动要十几秒）
    if (!sessionReady) {
      warmup();
      return json(res, 200, {
        ...base, warming: true, loggedIn: false, uname: '', mid: 0, face: '',
        loginExpired: false, loginError: null,
        loginFlow: loginFlow ? { status: loginFlow.status, message: loginFlow.message } : null,
      });
    }
    let login = loginCache.state;
    try { login = await readLogin(false); } catch (e) { login = { isLogin: false, uname: '', error: e.message }; }
    return json(res, 200, {
      ...base,
      warming: false,
      loggedIn: !!login.isLogin,
      uname: login.uname || '',
      mid: login.mid || 0,
      face: login.face || '',
      loginExpired: !!login.expired,
      loginError: login.error || null,
      loginFlow: loginFlow ? { status: loginFlow.status, message: loginFlow.message } : null,
    });
  }

  // ---- 解析专栏地址 ----
  if (p === '/api/resolve' && req.method === 'POST') {
    const body = await readBody(req);
    const input = String(body.url || '').trim();
    if (!input) return json(res, 400, { error: '请填写专栏地址' });
    if (parseInput(input).kind === 'unknown') {
      return json(res, 400, {
        error: '无法识别这个地址。支持：文集页、UP 主专栏页、文章页、opus 页，或直接填 UID。',
      });
    }
    const { bili: s } = await getSession({ headless: browserHeadless });
    const author = await s.resolveAuthor(input);
    let lists = author.lists || await s.listReadingLists(author.mid);
    if (!lists.length) return json(res, 404, { error: `该 UP 主（UID ${author.mid}）名下没有文集` });

    const preselect = author.list ? [author.list.id] : [];
    settings.write({ lastUrl: input });
    // 顺便刷新登录态
    try { loginCache = { at: Date.now(), state: await s.getLoginState() }; } catch { /* ignore */ }

    return json(res, 200, {
      author: { mid: author.mid, name: author.name || '', via: author.via || '' },
      lists: lists.map((l) => ({ id: l.id, name: l.name, count: l.count || 0 })),
      preselect,
    });
  }

  // ---- 登录 ----
  if (p === '/api/login' && req.method === 'POST') {
    try {
      const st = await startLogin();
      return json(res, 200, { ok: true, status: st.status });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/logout' && req.method === 'POST') {
    if (job.status === 'running') return json(res, 400, { error: '正在生成 PDF，稍后再试' });
    try {
      if (browser) { await browser.close(); browser = null; bili = null; }
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      loginCache = { at: 0, state: null };
      loginFlow = null;
      await getSession({ headless: true });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---- 生成 ----
  if (p === '/api/generate' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r = await startJob(body);
      return json(res, 200, { ok: true, ...r });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/cancel' && req.method === 'POST') {
    if (job.status !== 'running') return json(res, 400, { error: '当前没有任务在跑' });
    cancelRequested = true;
    emit('log', { level: 'warn', message: '已请求取消，正在收尾…' });
    return json(res, 200, { ok: true });
  }

  // ---- 进度事件（SSE）----
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const since = Number(url.searchParams.get('since') || 0);
    for (const ev of job.events) if (ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return undefined;
  }

  // ---- 杂项 ----
  // 网页内的文件夹浏览器：列出某个目录下的子文件夹。
  // 之所以不用系统原生对话框：它由后台服务进程创建，不会自动置顶，
  // 用户很可能看不见，接口就会一直挂着（实际踩过这个坑）。
  if (p === '/api/fs' && req.method === 'GET') {
    const wanted = url.searchParams.get('path') || settings.read().outDir || desktopDir();
    try {
      const abs = path.resolve(wanted);
      const st = fs.statSync(abs);
      if (!st.isDirectory()) throw new Error('这不是一个文件夹');
      const dirs = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => {
          if (!d.isDirectory()) return false;
          if (d.name.startsWith('$') || d.name === 'System Volume Information') return false;
          return true;
        })
        .map((d) => {
          const full = path.join(abs, d.name);
          let writable = true;
          try { fs.accessSync(full, fs.constants.W_OK); } catch { writable = false; }
          return { name: d.name, path: full, writable };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      const parent = path.dirname(abs);
      const roots = [];
      for (let c = 65; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:\\`;
        try { if (fs.existsSync(drive)) roots.push(drive); } catch { /* 无此盘 */ }
      }
      return json(res, 200, {
        path: abs,
        parent: parent === abs ? null : parent,
        dirs,
        roots,
        desktop: desktopDir(),
        home: os.homedir(),
      });
    } catch (e) {
      return json(res, 400, { error: '打不开这个文件夹：' + e.message });
    }
  }

  // 记住设置（选中目录后立刻保存，不用等到生成）
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const patch = {};
    if (typeof body.outDir === 'string' && body.outDir.trim()) patch.outDir = path.resolve(body.outDir.trim());
    if (typeof body.pdfName === 'string') patch.pdfName = body.pdfName.trim();
    if (typeof body.split === 'boolean') patch.split = body.split;
    return json(res, 200, { ok: true, settings: settings.write(patch) });
  }

  // 在指定目录下新建文件夹（供文件夹选择器使用）
  if (p === '/api/mkdir' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: '请填写文件夹名称' });
    if (name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
      return json(res, 400, { error: '名称里不能包含 \\ / : * ? " < > | 这些字符' });
    }
    let parent;
    try {
      parent = path.resolve(String(body.parent || ''));
      if (!fs.statSync(parent).isDirectory()) throw new Error('不是文件夹');
    } catch (e) {
      return json(res, 400, { error: '上级目录不可用：' + e.message });
    }
    const full = path.join(parent, name);
    if (path.dirname(full) !== parent) return json(res, 400, { error: '名称不合法' });
    try {
      if (fs.existsSync(full)) return json(res, 409, { error: `「${name}」已经存在了` });
      fs.mkdirSync(full);
      return json(res, 200, { path: full, name });
    } catch (e) {
      return json(res, 400, { error: '创建失败：' + e.message });
    }
  }

  // 系统原生对话框（备用）。加超时，避免没人点就一直挂着。
  if (p === '/api/pick-folder' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const dir = await pickFolder(body.current || settings.read().outDir || desktopDir());
    if (dir) settings.write({ outDir: dir });
    return json(res, 200, { dir: dir || '' });
  }
  if (p === '/api/open-folder' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return json(res, 200, { ok: openFolder(body.dir || settings.read().outDir || desktopDir()) });
  }
  if (p === '/api/shutdown' && req.method === 'POST') {
    json(res, 200, { ok: true });
    setTimeout(async () => {
      try { if (browser) await browser.close(); } catch { /* ignore */ }
      process.exit(0);
    }, 300);
    return undefined;
  }

  res.writeHead(404);
  res.end('not found');
  return undefined;
}

// ---------------------------------------------------------------- 启动
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开就手动点链接 */ }
}

async function main() {
  const wantPort = Number(process.env.BILI2PDF_PORT || 17321);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { json(res, 500, { error: e.message }); } catch { /* ignore */ }
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${wantPort} 已被占用，请关掉已在运行的窗口，或设置环境变量 BILI2PDF_PORT 换一个端口。`);
      process.exit(1);
    }
    throw e;
  });

  await new Promise((resolve) => server.listen(wantPort, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${wantPort}/`;

  console.log('');
  console.log('  ============================================================');
  console.log('   B 站专栏 / 文集 → PDF');
  console.log('  ============================================================');
  console.log('');
  console.log(`   界面地址：${url}`);
  console.log('   浏览器应该会自动打开；没打开的话，手动复制上面的地址到浏览器。');
  console.log('');
  console.log('   用完后直接关掉这个窗口，或者在网页右上角点「退出程序」。');
  console.log('');

  // 预热浏览器（不阻塞界面）：先把浏览器拉起来并加载 B 站，首次查询登录态就能秒回
  warmup();

  if (process.env.BILI2PDF_NO_OPEN !== '1') openBrowser(url);
}

main().catch((e) => {
  console.error('启动失败：' + e.message);
  process.exit(1);
});
