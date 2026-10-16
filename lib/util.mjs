// 通用小工具。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** 去掉文件名里的非法字符。 */
export function sanitizeFileName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'B站专栏';
}

/** 桌面目录（兼容 OneDrive 重定向与中文目录名）。 */
export function desktopDir() {
  const home = os.homedir();
  for (const c of [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, '桌面'),
  ]) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return home;
}

/** 保证目录存在，返回绝对路径。 */
export function ensureDir(dir) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** 在终端原地刷新一行进度（非 TTY 时降频打印）。 */
export function makeProgress(label) {
  const tty = process.stdout.isTTY;
  let last = 0;
  return {
    update(done, total, extra = '') {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      const line = `  ${label} ${done}/${total} (${pct}%)${extra}`;
      const now = Date.now();
      if (tty) process.stdout.write('\r' + line.padEnd(78));
      else if (now - last > 4000) { console.log(line); last = now; }
    },
    done() { if (tty) process.stdout.write('\r' + ' '.repeat(78) + '\r'); },
  };
}

/** 把可能被占用的目标文件写入，给出人能看懂的报错。 */
export function writeFileSafely(file, buf) {
  try {
    fs.writeFileSync(file, buf);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
      throw new Error(
        `写不进去：${file}\n` +
        `  这个文件正被其它程序占用（多半是你在 PDF 阅读器里开着它）。\n` +
        `  请关掉那个窗口后重试；已抓好的文章都在缓存里，重跑只要几秒。`
      );
    }
    throw e;
  }
}
