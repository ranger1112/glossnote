// pdf.js 只在运行时才去取 cMaps、标准字体和 wasm 解码器；打包后这些文件不在
// dist 里，扫描件的 JPEG2000 图片和部分中文 PDF 就会静默失败。构建前后各同步一次。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../node_modules/pdfjs-dist');
const target = resolve(here, '../public/pdfjs');

const folders = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

if (!existsSync(source)) {
  console.error('找不到 pdfjs-dist，请先安装依赖。');
  process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const folder of folders) {
  cpSync(resolve(source, folder), resolve(target, folder), { recursive: true });
  console.log(`pdfjs: ${folder} -> public/pdfjs/${folder}`);
}
