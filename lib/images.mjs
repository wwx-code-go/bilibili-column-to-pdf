// 图片下载：B 站图片 CDN 是公开的，带上 Referer 即可，不需要 cookie。
import fs from 'node:fs';
import path from 'node:path';

const HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

const MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff],       // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // WEBP/RIFF
];

function looksLikeImage(buf) {
  if (!buf || buf.length < 4) return false;
  return MAGIC.some((m) => m.every((b, i) => buf[i] === b));
}

/** `//i0.hdslb.com/...` → `https://i0.hdslb.com/...` */
export function normalizeUrl(src) {
  const s = String(src || '').trim();
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('http://')) return 'https://' + s.slice(7);
  return s;
}

export function imageName(url) {
  return url.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadOne(url, dir, attempts = 3) {
  const name = imageName(url);
  const dest = path.join(dir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    const head = fs.readFileSync(dest).subarray(0, 8);
    if (looksLikeImage(head)) return { status: 'cached', url, name };
  }
  let lastErr = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('空响应');
      if (!looksLikeImage(buf)) throw new Error('不是图片数据');
      fs.writeFileSync(dest, buf);
      return { status: 'ok', url, name, bytes: buf.length };
    } catch (e) {
      lastErr = e.message;
      if (i < attempts) await sleep(500 * i);
    }
  }
  return { status: 'failed', url, name, error: lastErr };
}

/**
 * 下载一批图片。返回 { ok, cached, failed, missing:Set<name> }
 */
export async function downloadImages(urls, dir, { concurrency = 8, onProgress = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const unique = [...new Set(urls.map(normalizeUrl).filter((u) => /^https?:\/\//.test(u)))];
  const stats = { ok: 0, cached: 0, failed: 0, total: unique.length };
  const missing = new Set();
  let index = 0;

  async function worker() {
    for (;;) {
      const i = index++;
      if (i >= unique.length) return;
      const r = await downloadOne(unique[i], dir);
      if (r.status === 'failed') {
        stats.failed++;
        missing.add(r.name);
        onProgress({ ...stats, lastFailed: r });
      } else {
        stats[r.status]++;
        onProgress(stats);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, worker));
  return { ...stats, missing, unique };
}
