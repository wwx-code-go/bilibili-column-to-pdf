// Chrome 启动与一个够用的 CDP 客户端（只用 Node 内置能力，无需 npm 依赖）。
//
// 为什么需要真实浏览器：B 站的 x/article/view 接口会以 -352（风控）拒绝普通
// HTTP 请求，即使带上完整 cookie 也一样；而在真实页面里发起 fetch 时，浏览器会
// 自动携带指纹与签名，未登录也能正常返回。所以抓取和出 PDF 都走同一个浏览器。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.BILI2PDF_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export function findChrome(explicit) {
  const list = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  throw new Error(
    '找不到 Chrome/Edge。请用 --chrome "C:\\路径\\chrome.exe" 指定，' +
    '或设置环境变量 BILI2PDF_CHROME。'
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) || []).forEach((h) => h(m.params, m.sessionId));
      }
    };
    // 连接断了必须让所有等待中的请求立刻失败，否则调用方会一直干等
    ws.onclose = (ev) => {
      this.closed = true;
      this.failAll(new Error(`调试连接已断开（code ${ev && ev.code}）`));
    };
    ws.onerror = () => {
      if (!this.closed) this.failAll(new Error('调试连接出错'));
    };
  }

  failAll(err) {
    for (const [, { rej }] of this.pending) rej(err);
    this.pending.clear();
  }

  send(method, params = {}, sessionId, timeoutMs = 600000) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  once(method, timeoutMs = 120000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`等待事件超时: ${method}`)), timeoutMs);
      this.on(method, (p) => { clearTimeout(t); res(p); });
    });
  }
}

export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  async eval(expression, { awaitPromise = true, timeoutMs = 600000 } = {}) {
    const r = await this.browser.cdp.send('Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true }, this.sessionId, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内脚本出错: ' + (d.exception?.description || d.text || '').slice(0, 300));
    }
    return r.result.value;
  }

  async evalJson(expression, opts) {
    const raw = await this.eval(expression, opts);
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    return JSON.parse(raw);
  }

  async navigate(url, timeoutMs = 180000) {
    const loaded = this.browser.cdp.once('Page.loadEventFired', timeoutMs);
    await this.browser.cdp.send('Page.navigate', { url }, this.sessionId);
    await loaded;
  }

  /**
   * 生成 PDF。
   *
   * 这里必须用 ReturnAsStream 分块读：ReturnAsBase64 会把整个 PDF 塞进一条
   * WebSocket 消息，图片多的文集（实测有个 48 篇的文集图片共 132 MB）会让消息
   * 超过上限、连接被掐断（close code 1006）。分块读则与体积无关。
   * 注意 IO.read 必须带 sessionId，否则报 Invalid stream handle。
   */
  async printToPDF(params, { onProgress = () => {} } = {}) {
    const TIMEOUT = 1800000;
    let stream = null;
    try {
      ({ stream } = await this.browser.cdp.send('Page.printToPDF',
        { ...params, transferMode: 'ReturnAsStream' }, this.sessionId, TIMEOUT));

      const chunks = [];
      let bytes = 0;
      for (;;) {
        const r = await this.browser.cdp.send('IO.read',
          { handle: stream, size: 1 << 22 }, this.sessionId, 300000);
        if (r.data) {
          const buf = Buffer.from(r.data, 'base64');
          chunks.push(buf);
          bytes += buf.length;
          onProgress(bytes);
        }
        if (r.eof) break;
      }
      const out = Buffer.concat(chunks);
      if (out.length < 8 || out.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('拿到的数据不是有效 PDF');
      }
      return out;
    } catch (e) {
      // 只有在流还没建立时才回退；已经读到一半再回退会重复生成
      if (stream) throw e;
      const { data } = await this.browser.cdp.send('Page.printToPDF',
        { ...params, transferMode: 'ReturnAsBase64' }, this.sessionId, TIMEOUT);
      return Buffer.from(data, 'base64');
    } finally {
      if (stream) {
        try { await this.browser.cdp.send('IO.close', { handle: stream }, this.sessionId, 5000); }
        catch { /* 已经读完了，关不掉也无所谓 */ }
      }
    }
  }

  async close() {
    try { await this.browser.cdp.send('Target.closeTarget', { targetId: this.targetId }); }
    catch { /* 目标可能已关闭 */ }
  }
}

export class Browser {
  constructor({ proc, cdp, ws, profileDir, chromePath, attached = false }) {
    this.proc = proc;
    this.cdp = cdp;
    this.ws = ws;
    this.profileDir = profileDir;
    this.chromePath = chromePath;
    this.attached = attached;   // 复用别人的浏览器时，退出不能把对方关掉
    this.ownTabs = new Set();
    this.closed = false;
  }

  static async launch({ profileDir, headless = true, chromePath, log = () => {} } = {}) {
    const exe = findChrome(chromePath);
    // Chrome 不接受相对的 --user-data-dir（会静默启动失败），这里统一转成绝对路径
    const dir = path.resolve(profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'bili2pdf-')));
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--disable-gpu',
      '--hide-scrollbars', '--allow-file-access-from-files',
      '--user-data-dir=' + dir,
      '--remote-debugging-port=0',
      '--window-size=1280,1000',
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new');

    log(`启动浏览器: ${exe}${headless ? '（后台无窗口）' : '（可见窗口）'}`);
    // 配置目录是复用的，上一次运行留下的端口文件会指向已经死掉的端口，
    // 必须在新实例写入之前删掉，否则会连到旧端口。
    const portFile = path.join(dir, 'DevToolsActivePort');
    try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }

    const proc = spawn(exe, args, { stdio: 'ignore' });
    proc.on('error', () => {});

    const started = Date.now();
    let wsUrl = null;
    while (Date.now() - started < 45000) {
      if (fs.existsSync(portFile)) {
        const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (port && wsPath) { wsUrl = `ws://127.0.0.1:${port}${wsPath}`; break; }
      }
      await sleep(200);
    }
    if (!wsUrl) {
      try { proc.kill(); } catch { /* ignore */ }
      throw new Error(
        '浏览器启动失败（45 秒内未就绪）。可能上一次的实例还在运行或配置目录被占用，' +
        '请稍后重试，或删除 .bili2pdf/profile 后重试。'
      );
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('无法连接调试端口'));
      setTimeout(() => rej(new Error('连接调试端口超时')), 20000);
    });
    const cdp = new Cdp(ws);
    const browser = new Browser({ proc, cdp, ws, profileDir: dir, chromePath: exe });
    await cdp.send('Browser.getVersion').catch(() => {});
    return browser;
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await this.cdp.send('Page.enable', {}, sessionId);
    this.ownTabs.add(targetId);
    const page = new Page(this, targetId, sessionId);
    page.onClosed = () => this.ownTabs.delete(targetId);
    if (url && url !== 'about:blank') await page.navigate(url);
    return page;
  }

  /** 复用一个已经在跑调试端口的浏览器（不会启动新进程）。 */
  static async attach({ target, log = () => {} } = {}) {
    let wsUrl = String(target || '').trim();
    if (!/^wss?:\/\//i.test(wsUrl)) {
      const port = Number(wsUrl);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error('--attach 需要端口号（如 9222）或完整的 ws:// 调试地址');
      }
      let j;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        j = await r.json();
      } catch (e) {
        throw new Error(
          `无法连接 ${port} 端口的调试接口（${e.message}）。\n` +
          `  注意：用 chrome://inspect 打开的调试端口不提供 HTTP 接口，` +
          `这种情况请改用 --login 让本程序自己登录。`
        );
      }
      wsUrl = j.webSocketDebuggerUrl;
    }
    log(`连接已有浏览器: ${wsUrl.slice(0, 70)}…`);
    let ws = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !ws; attempt++) {
      const sock = new WebSocket(wsUrl);
      try {
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('连接调试地址超时')), 30000);
          sock.onopen = () => { clearTimeout(timer); res(); };
          sock.onerror = () => { clearTimeout(timer); rej(new Error('无法连接该调试地址')); };
        });
        ws = sock;
      } catch (e) {
        lastErr = e;
        try { sock.close(); } catch { /* ignore */ }
        if (attempt < 3) {
          log(`  连接失败（${e.message}），${attempt * 2} 秒后重试…`);
          await sleep(attempt * 2000);
        }
      }
    }
    if (!ws) throw new Error(`连接调试地址失败：${lastErr ? lastErr.message : '未知'}`);
    const cdp = new Cdp(ws);
    const info = await cdp.send('Browser.getVersion');
    log(`已连接：${info.product}`);
    return new Browser({ proc: null, cdp, ws, attached: true });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.attached) {
      // 只关掉自己开的标签页，绝不动对方的浏览器
      for (const id of this.ownTabs) {
        try { await this.cdp.send('Target.closeTarget', { targetId: id }, undefined, 5000); } catch { /* ignore */ }
      }
      try { this.ws.close(); } catch { /* ignore */ }
      return;
    }
    try { await this.cdp.send('Browser.close', {}, undefined, 8000); } catch { /* ignore */ }
    try { this.ws.close(); } catch { /* ignore */ }
    await sleep(600);
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}
