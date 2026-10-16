// 生成管线的核心：抓正文 → 下图片 → 组装 HTML → 渲染 PDF → 体检。
// 命令行界面和网页界面都调用这里，保证两边行为完全一致。
import fs from 'node:fs';
import path from 'node:path';

import { verifyCompleteness } from './bili.mjs';
import { downloadImages, normalizeUrl } from './images.mjs';
import { assembleHtml, cleanContent } from './build.mjs';
import { renderPdf, inspectPdf } from './render.mjs';
import { sanitizeFileName } from './util.mjs';

/**
 * @param {object} o
 * @param {import('./cdp.mjs').Browser} o.browser
 * @param {import('./bili.mjs').BiliSession} o.bili
 * @param {Array} o.selections  [{ list, picked:[{id,title}], range:{from,to}, total, limited }]
 * @param {string} o.name       PDF 名称（合并时用）
 * @param {string} o.outDir     输出目录
 * @param {boolean} o.split     每个文集各出一份
 * @param {string} o.cacheRoot  正文缓存目录
 * @param {string} o.buildRoot  中间产物目录
 * @param {string} o.cssPath    打印样式
 * @param {boolean} o.useCache
 * @param {(e:object)=>void} o.onEvent 进度事件回调
 */
export async function generate({ browser, bili, selections, name, outDir, split, cacheRoot, buildRoot, cssPath, useCache = true, onEvent = () => {} }) {
  const emit = (e) => { try { onEvent(e); } catch { /* 回调出错不影响生成 */ } };

  const allIds = selections.flatMap((s) => s.picked.map((a) => a.id));

  // ---------- 抓正文 ----------
  emit({ type: 'phase', phase: 'fetch', total: allIds.length });
  const cachedShown = { done: false };
  const { articles, failed, cachedCount } = await bili.fetchArticles(allIds, {
    cacheDir: useCache ? cacheRoot : null,
    onProgress: (p) => {
      if (p.cached && !cachedShown.done) {
        cachedShown.done = true;
        emit({ type: 'log', message: `命中缓存 ${p.cached} 篇` });
      }
      if (p.cooling) {
        emit({ type: 'log', message: `等待 ${Math.round(p.cooling / 1000)} 秒后重试剩下的 ${p.remaining} 篇…`, level: 'warn' });
      } else if (p.retrying) {
        emit({ type: 'log', message: `第 ${p.round} 轮重试 ${p.retrying} 篇（间隔 ${p.delay}ms）…`, level: 'warn' });
      } else if (p.total) {
        emit({ type: 'fetch', done: p.done ?? 0, total: p.total });
      }
    },
  });

  if (failed.length) {
    emit({
      type: 'log', level: 'warn',
      message: `${failed.length} 篇最终未抓到：` +
        failed.slice(0, 5).map((f) => `cv${f.id}(${f.reason})`).join('、') +
        (failed.length > 5 ? ' …' : ''),
    });
  }
  if (!articles.size) throw new Error('一篇文章都没抓到，已中止。');
  emit({ type: 'log', message: `正文抓取完成：${articles.size} 篇${cachedCount ? `（其中 ${cachedCount} 篇来自缓存）` : ''}` });

  // ---------- 缺失篇目 ----------
  const missing = [];
  for (const s of selections) {
    for (const a of s.picked) if (!articles.get(a.id)) missing.push({ list: s.list.name, id: a.id, title: a.title });
  }
  if (missing.length) {
    emit({
      type: 'missing', level: 'error',
      message: `有 ${missing.length} 篇没能抓全（常见原因：未登录被风控）`,
      items: missing.slice(0, 20).map((m) => `cv${m.id} ${m.title}`),
      hint: '已抓到的部分都在缓存里，登录后重新生成即可续抓，不会从头再来。',
    });
    throw new Error(`有 ${missing.length} 篇没能抓全，未生成残缺的 PDF。`);
  }

  // ---------- 完整性自检 ----------
  const checks = [];
  for (const s of selections) {
    if (s.limited) {
      checks.push({ list: s.list.name, skipped: true, message: `按范围取第 ${s.range.from}–${s.range.to} 篇（共 ${s.total} 篇），跳过整体字数校验` });
      continue;
    }
    const got = s.picked.map((a) => articles.get(a.id)).filter(Boolean);
    const v = verifyCompleteness(s.list, got);
    checks.push({ list: s.list.name, ...v });
  }
  emit({ type: 'checks', checks });

  // ---------- 逐份生成 ----------
  const jobs = split
    ? selections.map((s) => ({ name: sanitizeFileName(s.list.name), books: [s] }))
    : [{ name: sanitizeFileName(name), books: selections }];

  const outputs = [];
  for (const job of jobs) {
    emit({ type: 'phase', phase: 'book', name: job.name });

    const books = job.books.map((s) => ({
      list: s.list,
      articles: s.picked.filter((a) => articles.get(a.id)).map((a) => {
        const raw = articles.get(a.id);
        return {
          id: a.id,
          title: raw.title || a.title,
          author: raw.author,
          ts: raw.publish_time,
          words: raw.words,
          content: raw.content,
          url: `https://www.bilibili.com/read/cv${a.id}`,
          rangeNote: s.limited
            ? `本文档为《${s.list.name}》全 ${s.total} 篇中的第 ${s.range.from}–${s.range.to} 篇。`
            : '',
        };
      }),
    })).filter((b) => b.articles.length);

    const buildDir = path.join(buildRoot, job.name);
    const imageDir = path.join(buildDir, 'images');
    fs.mkdirSync(buildDir, { recursive: true });

    // 图片
    const urls = [];
    for (const b of books) {
      for (const a of b.articles) {
        for (const m of a.content.matchAll(/<img[^>]*src="([^"]+)"/gi)) urls.push(normalizeUrl(m[1]));
      }
    }
    const uniq = [...new Set(urls)];
    emit({ type: 'phase', phase: 'images', name: job.name, total: uniq.length });
    const imgStat = await downloadImages(uniq, imageDir, {
      onProgress: (s) => emit({ type: 'images', done: s.ok + s.cached + s.failed, total: s.total, failed: s.failed }),
    });
    emit({
      type: 'log',
      level: imgStat.failed ? 'warn' : 'info',
      message: `图片：成功 ${imgStat.ok + imgStat.cached}，失败 ${imgStat.failed}` + (imgStat.failed ? '（正文中会标出缺失位置）' : ''),
    });

    // 组装
    for (const b of books) {
      for (const a of b.articles) a.html = cleanContent(a.content, imgStat.missing);
    }
    const htmlPath = path.join(buildDir, 'index.html');
    const css = fs.readFileSync(cssPath, 'utf8');
    const built = assembleHtml({
      books,
      docTitle: job.name,
      sourceUrl: books.length === 1 ? `https://www.bilibili.com/read/readlist/rl${books[0].list.id}` : '',
      css,
      outFile: htmlPath,
    });
    emit({ type: 'log', message: `排版完成：${built.totalArticles} 篇，约 ${built.totalWords.toLocaleString('en-US')} 字` });

    // 渲染
    emit({ type: 'phase', phase: 'render', name: job.name });
    const outFile = path.join(outDir, job.name + '.pdf');
    const page = await browser.newPage();
    try {
      await renderPdf({
        page,
        htmlPath,
        outFile,
        log: (m) => emit({ type: 'log', message: m }),
        onProgress: (bytes) => emit({ type: 'render', bytes }),
      });
    } finally {
      await page.close();
    }

    const facts = inspectPdf(outFile);
    const result = {
      file: outFile,
      name: job.name + '.pdf',
      articles: built.totalArticles,
      words: built.totalWords,
      pages: facts.pages,
      bytes: facts.bytes,
      links: facts.links,
      outlines: facts.outlines,
      images: facts.images,
      linkMismatch: facts.links !== built.totalArticles,
    };
    outputs.push(result);
    emit({ type: 'result', ...result });
  }

  emit({ type: 'done', outputs });
  return { outputs, checks };
}
