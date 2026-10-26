import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 生成一份两页的英文示例 PDF，用来验证选择、锚定与重放。
// 纯 ASCII + Helvetica，避免把字体子集塞进仓库。

const pageOne = [
  'GlossNote sample document',
  'This page exists so the anchoring prototype has something to select.',
  '',
  'Reading is not moving words from paper into your head.',
  'It is carrying questions back into your own life.',
  '',
  'Anchoring is the heart of annotation.',
  'A highlight that cannot survive a restart is only a decoration.',
  '',
  'The next paragraph repeats a sentence on purpose.',
  'Anchoring is the heart of annotation.',
  'The second occurrence sits in a different context,',
  'so the resolver has to use the surrounding words to pick the right one.',
  '',
  'Zoom in, zoom out, reload the page.',
  'The highlight should return to the same line every time.',
  '',
  'A good anchor stores four things:',
  'the quoted text, its neighbours, its position, and the page fingerprint.',
  '',
  'Coordinates are normalized to the page,',
  'so changing the window size never moves the mark.',
];

const pageTwo = [
  'Second page',
  '',
  'Try selecting across two lines.',
  'The highlight should cover each line separately.',
  '',
  'Try selecting a single word.',
  'Then try selecting a sentence that wraps onto another line.',
  '',
  'If the PDF changes, the resolver falls back:',
  'exact fingerprint, then text search, then similarity, then position.',
  '',
  'That fallback chain is the part worth testing',
  'before building the library, the database, or the sync layer.',
  '',
  'The rest of the product is ordinary engineering.',
  'The anchor is the part that decides whether the notes survive.',
];

function escapeText(value) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function contentStream(lines) {
  const body = lines.map((line) => `(${escapeText(line)}) Tj`).join('\nT*\n');
  return `BT\n/F1 12 Tf\n18 TL\n72 720 Td\n${body}\nET\n`;
}

const pages = [pageOne, pageTwo].map((lines) => contentStream(lines));
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
  `<< /Length ${Buffer.byteLength(pages[0])} >>\nstream\n${pages[0]}endstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>',
  `<< /Length ${Buffer.byteLength(pages[1])} >>\nstream\n${pages[1]}endstream`,
];

let pdf = '%PDF-1.4\n';
const offsets = [];

objects.forEach((body, index) => {
  offsets[index + 1] = Buffer.byteLength(pdf);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});

const xrefOffset = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (let i = 1; i <= objects.length; i += 1) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

const target = resolve(process.argv[2] ?? 'public/sample.pdf');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, pdf, 'binary');
console.log(`wrote ${target}`);
