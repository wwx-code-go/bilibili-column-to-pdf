// 把抓到的文章组装成可打印的 HTML（封面 + 目录 + 逐篇正文）。
//
// 版面约定（配合 render.mjs 的 Chrome 打印）：
//   · 每篇 <section class="article"> 用 break-before:page 独占新页
//   · 文章标题用 h1/h2 —— Chrome 的 generateDocumentOutline 据此生成 PDF 书签
//   · 目录条目是 <a href="#art-N"> —— Chrome 会保留为 PDF 内部链接
import fs from 'node:fs';
import path from 'node:path';

const SINGLE = '单篇文章';

const PAT_NUM_DASH = /^(.+?)(\d+)[—–－-]+(.+)$/;
const PAT_PAREN = /^(.+?)[（(](\d+)[）)]\s*$/;
const PAT_DASH = /^(.+?)[—–－-]+(.+)$/;

/** 标题 → [系列名, 条目名]。顺序重要：结尾的「（n）」要优先于破折号切分，
 *  否则 `…--《魔神之脑-理论篇》（1）` 会被切错。 */
export function splitTitle(title) {
  let m = title.match(PAT_NUM_DASH);
  if (m && m[1].trim().length >= 3) {
    return [m[1].trim(), `${m[2]}—${m[3].trim()}`];
  }
  m = title.match(PAT_PAREN);
  if (m && m[1].trim().length >= 3) {
    return [m[1].trim(), `（${m[2]}）`];
  }
  m = title.match(PAT_DASH);
  if (m && m[1].trim().length >= 3) {
    return [m[1].trim(), m[2].trim()];
  }
  return [SINGLE, title];
}

function core(label) {
  const book = label.match(/《[^》]+》/);
  if (book) return book[0].replace(/[—–－-]{2,}/g, '—');
  return label.replace(/^【[^】]*】/, '').replace(/[—–－-]{2,}/g, '—');
}

function mergeKey(label) {
  return core(label).replace(/和/g, '与').replace(/跟/g, '与').trim();
}

function displayLabel(labels) {
  const uniq = [...new Set(labels)];
  if (uniq.length === 1) return uniq[0];
  const cores = new Set(uniq.map(core));
  if (cores.size === 1) return [...cores][0];
  const best = uniq.reduce((a, b) =>
    labels.filter((x) => x === b).length > labels.filter((x) => x === a).length ? b : a);
  return best.replace(/[—–－-]{2,}/g, '—');
}

/**
 * 按系列分组。作者对不同篇目的系列写法常不一致（宝牌“和/与”赤牌、
 * 同一本书每次换个【…】前缀），所以先按 label 切连续段，再按 mergeKey 合并相邻段；
 * 只有一篇的组退回「单篇文章」，避免冒出一个只有一条的系列标题。
 */
export function groupArticles(articles) {
  const runs = [];
  for (const a of articles) {
    const last = runs[runs.length - 1];
    if (!last || last.label !== a.series) {
      runs.push({ label: a.series, labels: [a.series], items: [a] });
    } else {
      last.labels.push(a.series);
      last.items.push(a);
    }
  }

  let groups = [];
  for (const run of runs) {
    const key = mergeKey(run.label);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.labels.push(...run.labels);
      last.items.push(...run.items);
    } else {
      groups.push({ key, labels: [...run.labels], items: [...run.items] });
    }
  }

  // 只有一篇的系列不单列，归入「单篇文章」
  groups = groups.map((g) => ({
    ...g,
    label: g.items.length === 1 ? SINGLE : displayLabel(g.labels),
  }));

  const merged = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (last && last.label === SINGLE && g.label === SINGLE) {
      last.items.push(...g.items);
    } else {
      merged.push({ ...g, items: [...g.items] });
    }
  }
  return merged;
}

/** 系列所属的作品名，用于封面副标题。 */
export function family(label) {
  const book = label.match(/《([^》]+)》/);
  if (book) {
    const trimmed = book[1].replace(/[—–－-]+[^—–－-]*篇$/, '').trim();
    return trimmed || book[1];
  }
  const banner = label.match(/^【([^】]+)】/);
  return banner ? banner[1].trim() : '';
}

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 清洗正文 HTML，并把图片指向本地副本。 */
export function cleanContent(content, missingNames = new Set()) {
  let c = String(content || '');
  c = c.replace(/<(script|style|iframe|video|audio|object|embed)\b.*?<\/\1\s*>/gis, '');
  c = c.replace(/<(script|style|iframe|video|audio|object|embed)\b[^>]*\/?>/gi, '');
  c = c.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  c = c.replace(/javascript:/gi, '');

  c = c.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (tag, src) => {
    const url = src.startsWith('//') ? 'https:' + src : src.startsWith('http://') ? 'https://' + src.slice(7) : src;
    const name = url.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop();
    if (missingNames.has(name)) return '<span class="img-missing">[图片缺失]</span>';
    let out = tag.replace(/src="[^"]*"/, `src="images/${escapeHtml(name)}"`);
    out = out.replace(/\s(?:data-size|data-src|loading|decoding|referrerpolicy)="[^"]*"/gi, '');
    return out;
  });
  // 旧版编辑器留下的编辑态属性
  c = c.replace(/<figure[^>]*>/gi, '<figure class="img-box">');
  c = c.replace(/<figcaption[^>]*>/gi, '<figcaption>');
  return c;
}

/** 正文里作者自己写的 h1–h6 要下沉到文章标题之下，否则会变成文章标题的兄弟节点，
 *  把 PDF 书签层级弄乱。offset = 文章标题的级别（单文集 1，多文集 2）。 */
export function remapHeadings(html, offset) {
  return String(html || '').replace(/<(\/?)h([1-6])(\s[^>]*)?>/gi, (m, slash, n, attrs = '') => {
    const lvl = Math.min(6, Number(n) + offset);
    return `<${slash}h${lvl}${attrs}>`;
  });
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 生成整本书的 HTML。
 * @param {object} o
 * @param {Array} o.books  [{ list:{name,summary,author,words,count,id}, articles:[{id,title,author,ts,words,content,url,rangeNote}] }]
 * @param {string} o.docTitle  封面标题
 * @param {string} o.sourceUrl 来源地址
 * @param {string} o.css       样式内容
 * @param {string} o.outFile   输出 HTML 路径
 */
export function assembleHtml({ books, docTitle, sourceUrl, css, outFile }) {
  const merged = books.length > 1;
  let counter = 0;

  const prepared = books.map((b) => {
    const arts = b.articles.map((a) => {
      counter += 1;
      const [series, item] = splitTitle(a.title);
      return { ...a, no: counter, series, item };
    });
    return { list: b.list, articles: arts, groups: groupArticles(arts) };
  });

  const totalArticles = counter;
  const totalWords = prepared.reduce((n, b) => n + b.articles.reduce((m, a) => m + (a.words || 0), 0), 0);
  const authors = [...new Set(prepared.map((b) => b.list.author).filter(Boolean))];

  // ---------- 封面 ----------
  const subtitle = merged
    ? prepared.map((b) => b.list.name).join(' · ')
    : escapeHtml(prepared[0].list.summary || '');

  const rows = [];
  rows.push(`<tr><th>作者</th><td>${escapeHtml(authors.join('、') || '—')}</td></tr>`);
  if (merged) {
    rows.push(`<tr><th>文集</th><td>${prepared.length} 个</td></tr>`);
  } else {
    rows.push(`<tr><th>文集</th><td>${escapeHtml(prepared[0].list.name)}</td></tr>`);
  }
  rows.push(`<tr><th>文章</th><td>${totalArticles} 篇</td></tr>`);
  if (totalWords > 0) {
    rows.push(`<tr><th>字数</th><td>约 ${totalWords.toLocaleString('en-US')} 字</td></tr>`);
  }
  if (sourceUrl) rows.push(`<tr><th>来源</th><td class="u">${escapeHtml(sourceUrl)}</td></tr>`);
  const now = new Date();
  const exported = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  rows.push(`<tr><th>导出日期</th><td>${exported}</td></tr>`);

  const rangeNotes = prepared.flatMap((b) => b.articles.map((a) => a.rangeNote).filter(Boolean));
  const rangeNote = [...new Set(rangeNotes)];
  const noteHtml = rangeNote.length
    ? rangeNote.map((t) => `<div class="cover-note">${escapeHtml(t)}</div>`).join('')
    : '';

  const cover = `<section class="cover">
  <div class="cover-top">哔哩哔哩专栏文集</div>
  <h1 class="cover-title">${escapeHtml(docTitle)}</h1>
  <div class="cover-sub">${subtitle}</div>
  <div class="cover-rule"></div>
  <table class="cover-meta">
    ${rows.join('\n    ')}
  </table>
  <div class="cover-foot">本文档由原文字转录，仅供个人学习使用。版权归原作者及哔哩哔哩所有。</div>${noteHtml}
</section>`;

  // ---------- 目录 ----------
  const toc = ['<section class="toc">', '<h1 class="toc-title">目录</h1>'];
  for (const b of prepared) {
    if (merged) {
      toc.push(`<div class="toc-book">${escapeHtml(b.list.name)}` +
               `<span class="toc-book-count">${b.articles.length} 篇</span></div>`);
    }
    for (const g of b.groups) {
      if (g.label !== SINGLE) toc.push(`<div class="toc-group">${escapeHtml(g.label)}</div>`);
      toc.push('<ul class="toc-list">');
      for (const a of g.items) {
        toc.push(`<li><a href="#art-${a.no}"><span class="toc-no">${a.no}</span>` +
                 `<span class="toc-t">${escapeHtml(a.item)}</span></a></li>`);
      }
      toc.push('</ul>');
    }
  }
  toc.push('</section>');

  // ---------- 正文 ----------
  const body = [];
  const titleTag = merged ? 'h2' : 'h1';
  for (const b of prepared) {
    if (merged) {
      const w = b.articles.reduce((m, a) => m + (a.words || 0), 0);
      const bits = [`${b.articles.length} 篇`];
      if (w > 0) bits.push(`约 ${w.toLocaleString('en-US')} 字`);
      if (b.list.author) bits.push(escapeHtml(b.list.author));
      body.push('<section class="book-divider">');
      body.push(`<h1 class="book-divider-title">${escapeHtml(b.list.name)}</h1>`);
      body.push(`<div class="book-divider-sub">${bits.join(' · ')}</div>`);
      body.push('</section>');
    }
    for (const a of b.articles) {
      body.push(`<section class="article" id="art-${a.no}">`);
      body.push(`<${titleTag} class="art-title"><span class="art-no">${a.no}.</span>${escapeHtml(a.title)}</${titleTag}>`);
      const metaBits = [escapeHtml(a.author || ''), fmtDate(a.ts)];
      if (a.words) metaBits.push(`${a.words} 字`);
      metaBits.push(`<span class="u">${escapeHtml(a.url)}</span>`);
      body.push(`<div class="art-meta">${metaBits.join(' · ')}</div>`);
      body.push(`<div class="art-body">${remapHeadings(a.html, merged ? 2 : 1)}</div>`);
      body.push('</section>');
    }
  }

  const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(docTitle)} — 哔哩哔哩专栏文集</title>
<style>
${css}
</style>
</head>
<body>
${cover}
${toc.join('\n')}
${body.join('\n')}
</body>
</html>
`;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, doc, 'utf8');
  return { totalArticles, totalWords, merged, htmlBytes: Buffer.byteLength(doc) };
}
