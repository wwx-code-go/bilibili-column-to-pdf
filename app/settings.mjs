// 记住用户的选择：输出目录、PDF 名称、上次的地址等，下次打开自动填好。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  outDir: '',          // 上次用的输出目录
  pdfName: '',         // 上次用的 PDF 名称
  lastUrl: '',         // 上次解析的专栏地址
  split: false,        // 多文集时是否各出一份
  delayMs: 700,        // 请求间隔
  recentDirs: [],      // 最近用过的目录，方便下拉选择
};

export function createSettings(file) {
  const read = () => {
    try {
      // 去掉可能的 BOM：被记事本/PowerShell 编辑过就会带上，JSON.parse 会直接失败
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  };

  const write = (patch) => {
    const next = { ...read(), ...patch };
    if (next.outDir) {
      next.recentDirs = [next.outDir, ...(next.recentDirs || []).filter((d) => d !== next.outDir)].slice(0, 8);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    } catch { /* 配置写不进去不该影响使用 */ }
    return next;
  };

  return { read, write, file };
}
