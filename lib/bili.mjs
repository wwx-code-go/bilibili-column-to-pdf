// B 站专栏相关接口封装。
//
// 全部请求都在真实页面上下文里用 fetch 发起（见 cdp.mjs 的说明），
// 因此无需登录、无需自己实现 WBI 签名。
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.bilibili.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把用户粘贴的内容识别成 (类型, id)。 */
export function parseInput(text) {
  const s = String(text || '').trim();
  if (!s) return { kind: 'unknown', raw: s };

  let m;
  if ((m = s.match(/readlist\/rl(\d+)/i)) || (m = s.match(/^rl(\d+)$/i))) {
    return { kind: 'rl', id: Number(m[1]), raw: s };
  }
  if ((m = s.match(/space\.bilibili\.com\/(\d+)/i))) {
    return { kind: 'mid', id: Number(m[1]), raw: s };
  }
  if ((m = s.match(/\/read\/cv(\d+)/i)) || (m = s.match(/\/article\/(?:cv)?(\d+)/i)) || (m = s.match(/^cv(\d+)$/i))) {
    return { kind: 'cv', id: Number(m[1]), raw: s };
  }
  if ((m = s.match(/\/opus\/(\d+)/i))) {
    return { kind: 'opus', id: m[1], raw: s };
  }
  // 裸数字：按 UID 处理（最常见的「专栏地址」形态是 UP 主主页）
  if ((m = s.match(/^(\d{2,})$/))) {
    return { kind: 'mid', id: Number(m[1]), raw: s, bare: true };
  }
  return { kind: 'unknown', raw: s };
}

export class BiliError extends Error {}

export class BiliSession {
  /**
   * @param {import('./cdp.mjs').Page} page 已导航到 bilibili.com 的页面
   */
  constructor(page, { delayMs = 600, retries = 3, log = () => {} } = {}) {
    this.page = page;
    this.delayMs = delayMs;
    this.retries = retries;
    this.log = log;
    this.lastCall = 0;
  }

  /** 在页面里 fetch 一个 URL，返回解析后的 JSON。带节流与重试。 */
  async raw(url, { expectJson = true } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const wait = this.delayMs - (Date.now() - this.lastCall);
      if (wait > 0) await sleep(wait);

      const expr = `(async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
          return JSON.stringify({ ok: true, status: r.status, text: await r.text() });
        } catch (e) {
          return JSON.stringify({ ok: false, error: String(e) });
        }
      })()`;

      let res;
      try {
        res = await this.page.evalJson(expr);
      } catch (e) {
        lastErr = e;
        this.log(`  请求异常，重试 ${attempt}/${this.retries}: ${e.message}`);
        await sleep(1200 * attempt);
        continue;
      } finally {
        this.lastCall = Date.now();
      }

      if (!res || !res.ok) {
        lastErr = new Error(res?.error || '请求失败');
        await sleep(1200 * attempt);
        continue;
      }
      if (!expectJson) return res.text;

      let json;
      try {
        json = JSON.parse(res.text);
      } catch {
        // 未登录时高频请求会把接口「打」到直接返回风控网页
        lastErr = new Error('接口返回的是网页而不是 JSON（被风控拦截，登录后即可恢复正常）');
        await sleep(2500 * attempt);
        continue;
      }
      // -352 是风控，值得等一下再试；其余业务错误直接抛出
      if (json.code === -352) {
        lastErr = new Error('接口风控拒绝（-352）');
        this.log(`  触发风控，等待后重试 ${attempt}/${this.retries}`);
        await sleep(3000 * attempt);
        continue;
      }
      return json;
    }
    throw new BiliError(`请求失败: ${url}\n  原因: ${lastErr ? lastErr.message : '未知'}`);
  }

  async api(url) {
    const j = await this.raw(url);
    if (j.code !== 0) {
      throw new BiliError(`接口返回错误 code=${j.code} ${j.message || ''} (${url})`);
    }
    return j.data;
  }

  /** 当前浏览器是否已登录 B 站。批量抓取是否顺畅主要取决于这个。 */
  async getLoginState() {
    try {
      const j = await this.raw(`${API}/x/web-interface/nav`);
      if (j.code === 0 && j.data) {
        const d = j.data;
        return {
          isLogin: !!d.isLogin,
          uname: d.uname || '',
          mid: d.mid || 0,
          face: d.face || '',
          level: (d.level_info && d.level_info.current_level) ?? null,
        };
      }
      // -101 既表示「从未登录」，也表示「登录态过期」，光看错误码分不出来。
      // DedeUserID 是登录时写入的非 httpOnly cookie，过期后依然在，
      // 用它区分：有 = 过期，没有 = 从未登录。
      let hadLogin = false;
      try {
        hadLogin = String(await this.page.eval('document.cookie')).includes('DedeUserID');
      } catch { /* 读不到就当从未登录 */ }
      return { isLogin: false, uname: '', expired: hadLogin };
    } catch (e) {
      return { isLogin: false, uname: '', error: e.message };
    }
  }

  /** 文集详情 + 文章清单。 */
  async getReadingList(rlId) {
    const d = await this.api(`${API}/x/article/list/web/articles?id=${rlId}`);
    const list = d.list || {};
    return {
      id: Number(rlId),
      name: list.name || `文集 ${rlId}`,
      summary: list.summary || '',
      mid: list.mid || 0,
      author: (d.author && d.author.name) || '',
      words: list.words || 0,
      count: list.articles_count || (d.articles || []).length,
      articles: (d.articles || []).map((a) => ({ id: a.id, title: a.title })),
    };
  }

  /** UP 主名下的全部文集。 */
  async listReadingLists(mid) {
    const d = await this.api(`${API}/x/article/up/lists?mid=${mid}&sort=0`);
    return (d.lists || []).map((l) => ({
      id: l.id,
      name: l.name,
      count: l.articles_count || 0,
      ctime: l.ctime || 0,
      summary: l.summary || '',
    }));
  }

  /** 单篇文章详情。 */
  async fetchArticle(cv) {
    const d = await this.api(`${API}/x/article/view?id=${cv}`);
    return {
      id: Number(cv),
      title: d.title || '',
      author: (d.author && d.author.name) || '',
      author_mid: (d.author && d.author.mid) || 0,
      publish_time: d.publish_time || d.ctime || 0,
      words: d.words || 0,
      summary: d.summary || '',
      lists: d.list ? { id: d.list.id, name: d.list.name } : null,
      image_urls: d.image_urls || [],
      content: d.content || '',
    };
  }

  /** opus 链接 → 作者。 */
  async getOpusAuthor(opusId) {
    const d = await this.api(`${API}/x/polymer/web-dynamic/v1/detail?id=${opusId}`);
    const mods = (d.item && d.item.modules) || {};
    const author = mods.module_author || {};
    if (!author.mid) throw new BiliError('无法从该 opus 页面识别作者');
    return { mid: author.mid, name: author.name || '' };
  }

  /**
   * 把任意一种输入解析成作者。
   * @returns {{mid:number, name:string, via:string, list?:object}}
   */
  async resolveAuthor(input) {
    const p = parseInput(input);
    if (p.kind === 'unknown') {
      throw new BiliError(
        '无法识别这个地址。支持：文集页（/read/readlist/rl45758）、' +
        'UP 主专栏页（space.bilibili.com/5034998）、文章页（/read/cv1689316）、opus 页，或直接填 UID。'
      );
    }
    if (p.kind === 'rl') {
      const list = await this.getReadingList(p.id);
      return { mid: list.mid, name: list.author, via: `文集「${list.name}」`, list };
    }
    if (p.kind === 'cv') {
      const a = await this.fetchArticle(p.id);
      return { mid: a.author_mid, name: a.author, via: `文章「${a.title}」`, article: a };
    }
    if (p.kind === 'opus') {
      const a = await this.getOpusAuthor(p.id);
      return { mid: a.mid, name: a.name, via: `opus ${p.id}` };
    }
    // mid
    const lists = await this.listReadingLists(p.id);
    let name = '';
    if (lists.length) {
      try {
        name = (await this.getReadingList(lists[0].id)).author;
      } catch { /* 名称只是展示用，失败不影响 */ }
    }
    return { mid: p.id, name, via: `UID ${p.id}`, lists };
  }

  /**
   * 抓一批文章（一次 eval 内串行）。返回每篇的原始结果，不抛业务错误。
   * 批内请求间隔等于 delayMs —— 实测低于这个节奏会在几十篇后被限流。
   */
  async fetchBatch(ids, delayMs) {
    const expr = `(async () => {
      const ids = ${JSON.stringify(ids)};
      const out = [];
      for (const id of ids) {
        try {
          const r = await fetch('https://api.bilibili.com/x/article/view?id=' + id, { credentials: 'include' });
          const text = await r.text();
          let j;
          try { j = JSON.parse(text); }
          catch {
            // 被风控时接口会直接返回一张网页，而不是 JSON
            out.push({ id, code: -352, msg: '返回网页而非 JSON（疑似风控拦截）' });
            await new Promise(r => setTimeout(r, 600));
            continue;
          }
          if (j.code !== 0) { out.push({ id, code: j.code, msg: j.message }); }
          else {
            const d = j.data;
            out.push({
              id, code: 0, title: d.title || '',
              author: (d.author && d.author.name) || '',
              author_mid: (d.author && d.author.mid) || 0,
              publish_time: d.publish_time || d.ctime || 0,
              words: d.words || 0, summary: d.summary || '',
              lists: d.list ? { id: d.list.id, name: d.list.name } : null,
              image_urls: d.image_urls || [],
              content: d.content || ''
            });
          }
        } catch (e) { out.push({ id, code: -1, msg: String(e) }); }
        await new Promise(r => setTimeout(r, ${delayMs}));
      }
      return JSON.stringify(out);
    })()`;
    return await this.page.evalJson(expr);
  }

  /**
   * 批量抓取文章：命中缓存直接跳过，失败篇目自动进入下一轮重试并逐步放慢节奏。
   * @param {number[]} cvIds
   */
  async fetchArticles(cvIds, { cacheDir, onProgress = () => {}, batchSize = 4, maxRounds = 6 } = {}) {
    const results = new Map();
    const lastError = new Map();
    let pending = [];

    for (const cv of cvIds) {
      let hit = false;
      if (cacheDir) {
        const f = path.join(cacheDir, `${cv}.json`);
        if (fs.existsSync(f)) {
          try {
            const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (cached && cached.content) { results.set(cv, cached); hit = true; }
          } catch { /* 缓存损坏则重抓 */ }
        }
      }
      if (!hit) pending.push(cv);
    }
    const cachedCount = results.size;
    if (cachedCount) onProgress({ cached: cachedCount, total: cvIds.length, done: cachedCount });

    let delay = this.delayMs;
    let round = 0;

    while (pending.length && round < maxRounds) {
      round += 1;
      // 第一轮走批量；之后逐篇重试，并逐轮放慢，避开风控
      const size = round === 1 ? batchSize : 1;
      const roundDelay = Math.round(delay * (round === 1 ? 1 : Math.min(4, round)));
      if (round > 1) {
        onProgress({ done: results.size, total: cvIds.length, retrying: pending.length, round, delay: roundDelay });
      }

      const failedIds = [];
      for (let i = 0; i < pending.length; i += size) {
        const batch = pending.slice(i, i + size);
        let items = null;
        try {
          items = await this.fetchBatch(batch, roundDelay);
        } catch (e) {
          this.log(`  批次异常（第 ${round} 轮），稍后重试: ${e.message}`);
        }
        if (!Array.isArray(items)) {
          failedIds.push(...batch);
          await sleep(2000);
          continue;
        }
        let batchFailed = 0;
        for (const it of items) {
          if (it.code === 0 && it.content) {
            results.set(it.id, it);
            if (cacheDir) {
              fs.mkdirSync(cacheDir, { recursive: true });
              fs.writeFileSync(path.join(cacheDir, `${it.id}.json`), JSON.stringify(it), 'utf8');
            }
          } else {
            failedIds.push(it.id);
            batchFailed += 1;
            lastError.set(it.id, `${it.code} ${it.msg || ''}`.trim());
          }
        }
        // 整批失败 → 明显是被限流，立刻放慢
        if (batchFailed === batch.length && batch.length > 0) {
          delay = Math.min(5000, Math.round(delay * 1.8));
          this.log(`  疑似被限流，把请求间隔放慢到 ${delay}ms`);
        }
        onProgress({ done: results.size, total: cvIds.length });
      }

      pending = [...new Set(failedIds)].filter((id) => !results.has(id));
      if (pending.length) {
        const wait = Math.min(45000, 6000 * round);
        onProgress({ done: results.size, total: cvIds.length, cooling: wait, remaining: pending.length });
        await sleep(wait);
      }
    }

    const failed = pending.map((id) => ({ id, reason: lastError.get(id) || '未知' }));
    return { articles: results, failed, cachedCount };
  }
}

/** 校验：抓到的各篇字数之和应等于文集元数据里的总字数。 */
export function verifyCompleteness(list, articles) {
  const sum = articles.reduce((n, a) => n + (a.words || 0), 0);
  return {
    expected: list.words || 0,
    actual: sum,
    ok: !list.words || sum === list.words,
    count: articles.length,
    expectedCount: list.count || 0,
  };
}
