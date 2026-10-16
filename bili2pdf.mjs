#!/usr/bin/env node
// B 站专栏 / 文集 → PDF
//
// 用法：
//   直接运行进入交互向导          node bili2pdf.mjs
//   带参数批量执行                node bili2pdf.mjs --url <专栏地址> --lists all --name 书名
//
// 设计要点见 README.md。抓取与出 PDF 都通过一个自己拉起的 Chrome 完成，
// 因此不需要登录、不需要装任何依赖、也不会动用户自己的浏览器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { Browser } from './lib/cdp.mjs';
import { BiliSession, parseInput } from './lib/bili.mjs';
import { generate } from './lib/pipeline.mjs';
import { createUi, banner, step, printTable, rule } from './lib/ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

// ---------------------------------------------------------------- 小工具
function parseArgs(argv) {
  const o = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const takesValue = ['url', 'lists', 'range', 'name', 'out', 'chrome', 'workdir', 'delay', 'attach'];
    if (takesValue.includes(key)) {
      const v = argv[i + 1];
      // 空值或下一个参数本身是开关时，视为未提供，避免把 --out 当成 --name 的值
      if (v === undefined || v === '' || v.startsWith('--')) {
        o[key] = undefined;
      } else {
        o[key] = v;
        i += 1;
      }
    } else {
      o.flags.add(key);
    }
  }
  return o;
}

function sanitizeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'B站专栏';
}

function desktopDir() {
  const home = os.homedir();
  for (const c of [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, '桌面')]) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return home;
}

function makeProgress(label) {
  const tty = process.stdout.isTTY;
  let last = 0;
  return {
    update(done, total, extra = '') {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      const line = `  ${label} ${done}/${total} (${pct}%)${extra}`;
      const now = Date.now();
      if (tty) {
        process.stdout.write('\r' + line.padEnd(78));
      } else if (now - last > 4000) {
        console.log(line);
        last = now;
      }
    },
    done() { if (tty) process.stdout.write('\r' + ' '.repeat(78) + '\r'); },
  };
}

async function waitEnter(prompt) {
  if (!process.stdin.isTTY) return;   // 非交互环境不阻塞
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question(prompt); } finally { rl.close(); }
}

/** 一次性登录：开一个可见窗口让用户登录，登录态存进程序自己的配置目录。 */
async function doLogin({ profileDir, chromePath, workRoot }) {
  banner('登录 B 站（只需一次）');
  console.log('  接下来会打开一个浏览器窗口。请在窗口里登录 B 站（扫码即可）。');
  console.log('  登录成功后回到这个窗口按回车，登录状态会保存下来，以后就不用再登了。');
  console.log('');
  const browser = await Browser.launch({ profileDir, headless: false, chromePath, log: (m) => console.log('  ' + m) });
  try {
    const page = await browser.newPage('https://www.bilibili.com/');
    const bili = new BiliSession(page, { delayMs: 800 });
    await waitEnter('  登录完成后按回车继续…');
    const state = await bili.getLoginState();
    if (state.isLogin) {
      console.log('');
      console.log(`  ✓ 登录成功：${state.uname}`);
      console.log(`    登录信息保存在 ${path.join(workRoot, 'profile')}`);
      console.log('    现在可以直接运行本程序生成 PDF 了。');
    } else {
      console.log('');
      console.log('  ⚠ 看起来还没有登录成功（或者登录后页面没刷新）。');
      console.log('    可以再运行一次 --login 重试。');
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  // Windows 控制台默认不是 UTF-8，中文会变乱码；能改则改（失败不影响运行）。
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('node:child_process');
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.flags.has('h')) { printHelp(); return; }
  if (args.flags.has('version')) { console.log(VERSION); return; }

  const headless = !args.flags.has('headed');
  const useCache = !args.flags.has('no-cache');
  const assumeYes = args.flags.has('yes');
  const workRoot = path.resolve(args.workdir || path.join(HERE, '.bili2pdf'));
  const cacheRoot = path.join(workRoot, 'cache');
  const buildRoot = path.join(workRoot, 'build');
  const profileDir = path.join(workRoot, 'profile');

  if (args.flags.has('login')) {
    await doLogin({ profileDir, chromePath: args.chrome, workRoot });
    return;
  }

  const ui = args.url ? null : await createUi();
  let browser = null;

  const cleanup = async () => { if (browser) await browser.close(); };
  process.on('SIGINT', async () => {
    console.log('\n已中断。');
    await cleanup();
    process.exit(130);
  });

  try {
    banner(`B 站专栏 / 文集 → PDF   v${VERSION}`,
           '把专栏下的文集合并成一份排版好的 PDF（封面 / 目录 / 书签 / 本地图片）');

    // ---------- 1. 专栏地址 ----------
    let input = args.url;
    if (!input) {
      step(1, 4, '专栏地址');
      console.log('  支持：文集页、UP 主专栏页、文章页、opus 页，或直接填 UID');
      console.log('  例：https://www.bilibili.com/read/readlist/rl45758');
      console.log('');
      input = await ui.ask('  请粘贴地址');
    } else {
      step(1, 4, '专栏地址');
      console.log(`  ${input}`);
    }
    if (!parseInput(input).kind || parseInput(input).kind === 'unknown') {
      throw new Error(`无法识别地址：${input}`);
    }

    console.log('');
    console.log('  正在启动浏览器并识别…');

    const openSession = async () => {
      const b = args.attach
        ? await Browser.attach({ target: args.attach, log: (m) => console.log('  ' + m) })
        : await Browser.launch({ profileDir, headless, chromePath: args.chrome, log: (m) => console.log('  ' + m) });
      const p = await b.newPage();
      await p.navigate('https://www.bilibili.com/');
      return {
        browser: b,
        bili: new BiliSession(p, {
          // 700ms/篇 是实测能稳定抓完 123 篇的节奏；再快会在几十篇后被风控。
          delayMs: Number(args.delay) || 700,
          log: (m) => console.log(m),
        }),
      };
    };

    let session = await openSession();
    browser = session.browser;
    let bili = session.bili;

    let login = await bili.getLoginState();
    if (login.isLogin) {
      console.log(`  ✓ 已登录：${login.uname}`);
    } else {
      console.log('');
      console.log('  ⚠ 当前未登录 B 站。');
      console.log('    未登录时抓几十篇之后，接口会开始返回风控网页而不是数据，导致大量篇目抓取失败。');
      if (ui && !args.attach) {
        const go = await ui.confirm('  现在登录一次吗？（会打开一个窗口，扫码即可，只需一次）', true);
        if (go) {
          await session.browser.close();
          browser = null;
          await doLogin({ profileDir, chromePath: args.chrome, workRoot });
          console.log('');
          console.log('  重新连接…');
          session = await openSession();
          browser = session.browser;
          bili = session.bili;
          login = await bili.getLoginState();
          if (login.isLogin) console.log(`  ✓ 已登录：${login.uname}`);
        }
      } else if (!args.attach) {
        console.log('    建议先运行一次：  启动.cmd --login');
      }
      console.log('');
    }

    const author = await bili.resolveAuthor(input);
    console.log(`  ✓ 作者：${author.name || '(未知)'}（UID ${author.mid}）${author.via ? '  ·  ' + author.via : ''}`);

    // ---------- 2. 识别并选择文集 ----------
    step(2, 4, '选择文集与数量');
    let lists = author.lists;
    if (!lists) lists = await bili.listReadingLists(author.mid);
    if (!lists.length) {
      throw new Error(`该 UP 主（UID ${author.mid}）名下没有文集，无法合并。`);
    }
    console.log(`  ✓ 共识别到 ${lists.length} 个文集：`);
    console.log('');
    printTable(
      ['序号', '文集名', '篇数'],
      lists.map((l, i) => [`[${i + 1}]`, l.name, l.count || '?']),
    );
    console.log('');

    // 优先预选：若输入本身指向某个文集，默认选中它
    const preselect = author.list ? [lists.findIndex((l) => l.id === author.list.id) + 1].filter((i) => i > 0) : null;

    let chosenIdx;
    if (args.lists) {
      const { parseSelection } = await import('./lib/ui.mjs');
      chosenIdx = parseSelection(args.lists, lists.length);
      if (!chosenIdx) throw new Error(`--lists 取值非法：${args.lists}`);
    } else if (ui) {
      const hint = preselect ? `（回车 = 选 ${preselect.join(',')}）` : '';
      chosenIdx = await ui.chooseMany(
        `  请选择要合并的文集，可多选（1,3 / 1-3 / all）${hint}`, lists.length);
    } else {
      // 非交互：地址本身指向某个文集就选它，否则全选
      chosenIdx = preselect && preselect.length ? preselect : lists.map((_, i) => i + 1);
    }

    const chosen = chosenIdx.map((i) => lists[i - 1]);
    console.log(`  → 已选：${chosen.map((l) => `《${l.name}》`).join('、')}`);

    // 每个文集的篇数范围
    const selections = [];
    for (const l of chosen) {
      const detail = await bili.getReadingList(l.id);
      const total = detail.articles.length;
      let range;
      if (args.range) {
        const { parseRange } = await import('./lib/ui.mjs');
        range = parseRange(args.range, total);
        if (!range) throw new Error(`--range 取值非法：${args.range}（该文集共 ${total} 篇）`);
      } else if (total <= 1 || !ui) {
        range = { from: 1, to: total };
      } else {
        console.log('');
        range = await ui.chooseRange(
          `  《${detail.name}》共 ${total} 篇，下载范围（回车 = 全部 / 数字 = 前 N 篇 / a-b = 区间）`, total);
      }
      const picked = detail.articles.slice(range.from - 1, range.to);
      const limited = !(range.from === 1 && range.to === total);
      selections.push({ list: detail, picked, range, total, limited });
      console.log(`  → 《${detail.name}》：第 ${range.from}–${range.to} 篇，共 ${picked.length} 篇` +
                  (limited ? `（该文集共 ${total} 篇）` : '（全部）'));
    }

    // 合并成一份，还是每个文集一份（注意 split 是开关，值在 args.flags 里）
    let split = args.flags.has('split');
    if (chosen.length > 1 && !split) {
      if (args.url) {
        split = false;
      } else {
        const merge = await ui.confirm('  要合并成一份 PDF 吗？（选 n = 每个文集各出一份）', true);
        split = !merge;
      }
    }

    // ---------- 3. 输出名称与位置 ----------
    const totalArticles = selections.reduce((n, s) => n + s.picked.length, 0);
    const defaultName = sanitizeFileName(
      selections.length === 1 ? selections[0].list.name
        : `${selections[0].list.name}等${selections.length}个文集`);

    let outName = args.name;
    let outDir = args.out ? path.resolve(args.out) : null;
    if (!outName || !outDir) {
      step(3, 4, '输出设置');
    }
    if (!outName && ui) outName = await ui.ask('  PDF 名称（不含扩展名）', defaultName);
    outName = sanitizeFileName(outName || defaultName);
    if (!outDir && ui) outDir = path.resolve(await ui.ask('  输出目录', desktopDir()));
    outDir = outDir || desktopDir();
    fs.mkdirSync(outDir, { recursive: true });

    const jobs = split
      ? selections.map((s) => ({
          kind: 'split',
          books: [s],
          name: sanitizeFileName(s.list.name),
        }))
      : [{ kind: 'merged', books: selections, name: outName }];

    // ---------- 4. 确认并生成 ----------
    step(4, 4, '生成 PDF');
    console.log(`  文集：${selections.length} 个`);
    console.log(`  文章：${totalArticles} 篇`);
    console.log(`  输出：${split ? `${jobs.length} 份 PDF` : '1 份 PDF'} → ${outDir}`);
    for (const j of jobs) console.log(`        ${path.join(outDir, j.name + '.pdf')}`);
    console.log('');
    if (!assumeYes && ui) {
      const ok = await ui.confirm('  确认开始生成？', true);
      if (!ok) { console.log('  已取消。'); await cleanup(); ui.close(); return; }
    }

    const showProgress = (label, done, total) => {
      if (process.stdout.isTTY) {
        process.stdout.write('\r' + `  ${label} ${done}/${total} (${total ? Math.floor((done / total) * 100) : 0}%)`.padEnd(78));
      }
    };
    const endProgress = () => { if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(78) + '\r'); };

    console.log('');
    await generate({
      browser, bili, selections,
      name: outName, outDir, split,
      cacheRoot, buildRoot,
      cssPath: path.join(HERE, 'assets', 'print.css'),
      useCache,
      onEvent: (e) => {
        switch (e.type) {
          case 'phase':
            if (e.phase === 'fetch') {
              console.log(`  开始抓取 ${e.total} 篇文章正文…`);
              showProgress('抓取正文', 0, e.total);
            } else if (e.phase === 'images') {
              endProgress();
              console.log('');
              console.log(`  《${e.name}》：下载图片 ${e.total} 张…`);
              showProgress('下载图片', 0, e.total);
            } else if (e.phase === 'render') {
              endProgress();
            }
            break;
          case 'fetch': showProgress('抓取正文', e.done, e.total); break;
          case 'images': showProgress('下载图片', e.done, e.total); break;
          case 'render':
            if (process.stdout.isTTY) process.stdout.write('\r' + `  已接收 ${(e.bytes / 1024 / 1024).toFixed(1)} MB`.padEnd(40));
            break;
          case 'log':
            endProgress();
            console.log(`  ${e.level === 'warn' ? '⚠ ' : ''}${e.message}`);
            break;
          case 'checks':
            for (const c of e.checks) {
              if (c.skipped) { console.log(`  · 《${c.list}》：${c.message}`); continue; }
              console.log(`  ${c.ok ? '✓' : '⚠'} 《${c.list}》字数校验：${c.actual.toLocaleString('en-US')}` +
                          `${c.expected ? ` / 应为 ${c.expected.toLocaleString('en-US')}` : ''}` +
                          (c.ok ? '（一致）' : '（不一致，可能有篇目缺失）'));
            }
            break;
          case 'result':
            endProgress();
            console.log(`  ✓ ${e.file}`);
            console.log(`    ${e.pages} 页 · ${(e.bytes / 1024 / 1024).toFixed(1)} MB · ` +
                        `${e.links} 个目录内链 · ${e.outlines} 条书签 · ${e.images} 张图`);
            if (e.linkMismatch) console.log(`    ⚠ 目录内链数（${e.links}）与篇数（${e.articles}）不一致，请检查。`);
            break;
          default: break;
        }
      },
    });
    endProgress();

    console.log(rule('═'));
    console.log('  全部完成 ✓');
    console.log(rule('═'));
    console.log('');
  } finally {
    await cleanup();
    if (ui) ui.close();
  }
}

function printHelp() {
  console.log(`
B 站专栏 / 文集 → PDF  v${VERSION}

用法
  node bili2pdf.mjs                                  交互向导（推荐）
  node bili2pdf.mjs --url <地址> --lists all --name 书名 [--out 目录]

参数
  --url <地址>     专栏地址：文集页 / UP 主专栏页 / 文章页 / opus 页 / 纯 UID
  --login          一次性登录 B 站（强烈建议先做，未登录抓几十篇后会被风控）
  --attach <端口>  复用已开启调试端口的浏览器（端口号或 ws:// 地址），不再新开实例
  --lists <选择>   要合并的文集：1,3 / 1-3 / all
  --range <范围>   每个文集取多少篇：all（默认）/ 20（前 20 篇）/ 5-20（第 5–20 篇）
  --name <名称>    PDF 名称（不含 .pdf）
  --out <目录>     输出目录（默认：桌面）
  --split          多选文集时，每个文集各出一份 PDF（默认合并成一份）
  --headed         显示浏览器窗口（默认后台无窗口运行）
  --chrome <路径>  指定 Chrome/Edge 可执行文件
  --workdir <目录> 工作目录（缓存、浏览器配置、中间文件）
  --no-cache       忽略正文缓存，全部重新抓取
  --delay <毫秒>   两次请求之间的间隔（默认 600，越小越快但更容易触发风控）
  --yes            跳过最终确认
  --version / --help
`);
}

main().catch((e) => {
  console.error('');
  console.error('  ✗ ' + (e && e.message ? e.message : String(e)));
  if (e && e.stack) {
    if (process.env.BILI2PDF_DEBUG) {
      console.error('');
      console.error(e.stack);
    } else {
      const frame = String(e.stack).split('\n').find((l) => l.includes('bili2pdf'));
      if (frame) console.error('    ' + frame.trim());
    }
  }
  console.error('');
  process.exit(1);
});
