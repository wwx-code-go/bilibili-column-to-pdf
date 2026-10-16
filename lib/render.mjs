// 用 Chrome 的 Page.printToPDF 出 PDF：A4、页脚页码、PDF 书签、保留目录内链。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSafely } from './util.mjs';

const MM = 1 / 25.4;

export const A4 = { width: 8.27, height: 11.69 };

function fileUrl(p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * @param {import('./cdp.mjs').Page} page
 * @param {(bytes:number)=>void} [onProgress] 已接收字节数（回传过程中回调）
 */
export async function renderPdf({ page, htmlPath, outFile, margins, log = () => {}, onProgress = () => {} }) {
  log('加载排版结果…');
  await page.navigate(fileUrl(htmlPath));

  log('等待图片与字体就绪…');
  const stats = await page.evalJson(`(async () => {
    const imgs = [...document.images];
    await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => {
      i.addEventListener('load', r, { once: true });
      i.addEventListener('error', r, { once: true });
    })));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const broken = imgs.filter(i => !i.naturalWidth).map(i => i.getAttribute('src'));
    return JSON.stringify({
      images: imgs.length,
      broken: broken.length,
      brokenSample: broken.slice(0, 8),
      articles: document.querySelectorAll('.article').length,
      figures: document.querySelectorAll('figure').length,
      docHeight: document.documentElement.scrollHeight
    });
  })()`);
  log(`页面就绪：${stats.articles} 篇 / ${stats.images} 张图` +
      (stats.broken ? `（${stats.broken} 张加载失败）` : ''));

  const footer = `<div style="width:100%;font-size:8px;color:#8d8d8d;text-align:center;
    font-family:'Microsoft YaHei',sans-serif;margin:0 12mm;">
    <span class="pageNumber"></span><span style="color:#c8c8c8;"> / </span><span class="totalPages"></span>
  </div>`;

  log('正在生成 PDF…（图片多的文集可能要十几秒）');
  const started = Date.now();
  let lastTick = 0;
  const buf = await page.printToPDF({
    printBackground: true,
    paperWidth: A4.width,
    paperHeight: A4.height,
    marginTop: (margins?.top ?? 14) * MM,
    marginBottom: (margins?.bottom ?? 16) * MM,
    marginLeft: (margins?.left ?? 15) * MM,
    marginRight: (margins?.right ?? 15) * MM,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: footer,
    preferCSSPageSize: false,
    generateDocumentOutline: true,
  }, {
    // 分块回传，顺便报进度，避免看起来像卡死
    onProgress: (bytes) => {
      const now = Date.now();
      if (now - lastTick < 400) return;
      lastTick = now;
      onProgress(bytes);
    },
  });

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSafely(outFile, buf);
  log(`PDF 已写入（${(buf.length / 1024 / 1024).toFixed(1)} MB，用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
  return { ...stats, bytes: buf.length };
}

/** 不做第三方解析的 PDF 体检：数页数、图片、内链与书签。 */
export function inspectPdf(file) {
  const raw = fs.readFileSync(file);
  const count = (re) => (raw.toString('latin1').match(re) || []).length;
  const pages = count(/\/Type\s*\/Page(?![s])/g);
  const images = count(/\/Subtype\s*\/Image/g);
  const links = count(/\/Subtype\s*\/Link/g);
  const outlines = count(/\/Title\s*<[0-9A-Fa-f]{8,}>/g);
  return { pages, images, links, outlines, bytes: raw.length };
}
