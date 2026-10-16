// 保证有可用的浏览器。
//
// Windows 上 Chrome 或 Edge 几乎必然存在，所以先找系统里的；两个都没有时（极少见，
// 比如刚装好的精简系统）才自动下载一份便携的 Chrome for Testing 放进 runtime/，
// 实现「自带浏览器」—— 不需要用户自己装。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const CFT_MANIFEST = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** 已就绪的浏览器路径，没有则 null。 */
export function findExistingBrowser(runtimeDir) {
  if (process.env.BILI2PDF_CHROME && exists(process.env.BILI2PDF_CHROME)) return process.env.BILI2PDF_CHROME;
  const local = path.join(runtimeDir, 'chrome', 'chrome-win64', 'chrome.exe');
  if (exists(local)) return local;
  for (const c of CANDIDATES) if (exists(c)) return c;
  return null;
}

function run(cmd, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error('超时')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 退出码 ${code} ${err.slice(0, 300)}`));
    });
  });
}

/**
 * 确保有浏览器可用；必要时下载便携版。
 * @param {string} runtimeDir  <程序目录>/runtime
 * @param {(msg:string)=>void} log
 * @returns {Promise<string>} 浏览器可执行文件路径
 */
export async function ensureBrowser(runtimeDir, log = () => {}) {
  const found = findExistingBrowser(runtimeDir);
  if (found) {
    log(`使用系统已安装的浏览器：${found}`);
    return found;
  }

  log('系统里没有找到 Chrome/Edge，准备自动下载一份便携版浏览器（约 190 MB，只需一次）…');
  const dir = path.join(runtimeDir, 'chrome');
  fs.mkdirSync(dir, { recursive: true });

  let url;
  try {
    const r = await fetch(CFT_MANIFEST);
    const j = await r.json();
    const stable = j.channels.Stable;
    url = stable.downloads.chrome.find((d) => d.platform === 'win64').url;
    log(`将下载 Chrome for Testing ${stable.version}`);
  } catch (e) {
    throw new Error('无法获取浏览器下载地址（需要联网）：' + e.message);
  }

  const zip = path.join(dir, 'chrome.zip');
  log('下载中…');
  await run('powershell', ['-NoProfile', '-Command',
    `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip.replace(/'/g, "''")}'`]);

  log('解压中…');
  // Windows 10+ 自带 bsdtar
  await run('tar', ['-xf', zip, '-C', dir]);
  try { fs.rmSync(zip, { force: true }); } catch { /* ignore */ }

  const exe = path.join(dir, 'chrome-win64', 'chrome.exe');
  if (!exists(exe)) throw new Error('下载完成但没找到 chrome.exe，请手动安装 Chrome 后重试。');
  log(`便携版浏览器已就绪：${exe}`);
  return exe;
}
