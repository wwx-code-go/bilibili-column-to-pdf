// 交互式问答与终端排版小工具。
import readline from 'node:readline/promises';

/** 中日韩字符占两列，做表格对齐时按显示宽度算。 */
function charWidth(cp) {
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )) return 2;
  return 1;
}

export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

export function padEnd(s, width) {
  const pad = width - displayWidth(s);
  return s + ' '.repeat(pad > 0 ? pad : 0);
}

export function rule(char = '─', width = 62) {
  return char.repeat(width);
}

export function banner(title, subtitle) {
  console.log('');
  console.log(rule('═'));
  console.log('  ' + title);
  if (subtitle) console.log('  ' + subtitle);
  console.log(rule('═'));
  console.log('');
}

export function step(index, total, title) {
  console.log('');
  console.log(`【${index}/${total}】${title}`);
  console.log(rule('─'));
}

export function printTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => displayWidth(String(r[i] ?? '')))));
  const line = (r) => '  ' + r.map((c, i) => padEnd(String(c ?? ''), widths[i])).join('   ');
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('   '));
  for (const r of rows) console.log(line(r));
}

/** "1,3" / "1-3" / "1-3,7" / "all" / "" → 1-based 索引数组，非法返回 null */
export function parseSelection(spec, n) {
  const s = String(spec || '').trim().toLowerCase();
  if (s === '' || s === 'all' || s === '*') return Array.from({ length: n }, (_, i) => i + 1);
  const out = new Set();
  for (const part of s.split(/[,，、\s]+/).filter(Boolean)) {
    let m;
    if ((m = part.match(/^(\d+)\s*[-~到]\s*(\d+)$/))) {
      const a = Number(m[1]); const b = Number(m[2]);
      if (a < 1 || b > n || a > b) return null;
      for (let i = a; i <= b; i++) out.add(i);
    } else if ((m = part.match(/^(\d+)$/))) {
      const a = Number(m[1]);
      if (a < 1 || a > n) return null;
      out.add(a);
    } else return null;
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/** "" / "all" → {from:1,to:total}；"20" → 前 20 篇；"5-20" → 第 5–20 篇 */
export function parseRange(spec, total) {
  const s = String(spec || '').trim().toLowerCase();
  if (s === '' || s === 'all' || s === '*') return { from: 1, to: total };
  let m;
  if ((m = s.match(/^(\d+)\s*[-~到]\s*(\d+)$/))) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a < 1 || b > total || a > b) return null;
    return { from: a, to: b };
  }
  if ((m = s.match(/^(\d+)$/))) {
    const a = Number(m[1]);
    if (a < 1 || a > total) return null;
    return { from: 1, to: a };
  }
  return null;
}

/** 非终端（管道/重定向）输入时，一次性把 stdin 读完再按行回答。
 *  否则 readline 会在 EOF 关闭接口，后续 question 直接抛 ERR_USE_AFTER_CLOSE。 */
async function readPipedLines() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch { /* 忽略读取失败 */ }
  const text = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8');
  return text.length ? text.split(/\r?\n/) : [];
}

export async function createUi() {
  const piped = process.stdin.isTTY ? null : await readPipedLines();
  let pipedIndex = 0;
  const rl = piped ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  const readLine = async (prompt) => {
    if (piped) {
      const line = pipedIndex < piped.length ? piped[pipedIndex++] : '';
      process.stdout.write(`${prompt}${line}\n`);   // 回显，便于看日志
      return line;
    }
    return await rl.question(prompt);
  };

  return {
    close() { try { if (rl) rl.close(); } catch { /* ignore */ } },

    async ask(question, def = '') {
      const suffix = def ? `（回车 = ${def}）` : '';
      const a = (await readLine(`${question}${suffix}: `)).trim();
      return a || def;
    },

    async confirm(question, defYes = true) {
      const hint = defYes ? 'Y/n' : 'y/N';
      const a = (await readLine(`${question} (${hint}): `)).trim().toLowerCase();
      if (!a) return defYes;
      return a === 'y' || a === 'yes' || a === '是';
    },

    /** 反复追问直到拿到合法选择，返回 1-based 索引数组 */
    async chooseMany(question, n) {
      for (;;) {
        const a = await readLine(`${question}: `);
        const sel = parseSelection(a, n);
        if (sel) return sel;
        console.log('  ⚠ 输入无法识别，请用 1,3,5 或 1-3 或 all 的形式。');
        if (piped) return parseSelection('all', n);   // 管道输入用尽时退回全选，避免死循环
      }
    },

    /** 反复追问直到拿到合法范围，返回 {from,to} */
    async chooseRange(question, total) {
      for (;;) {
        const a = await readLine(`${question}: `);
        const r = parseRange(a, total);
        if (r) return r;
        console.log(`  ⚠ 输入无法识别，请输入 all、前 N 篇的数量（如 20）或区间（如 5-20），范围 1–${total}。`);
        if (piped) return { from: 1, to: total };
      }
    },
  };
}
