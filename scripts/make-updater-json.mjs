// 生成 Tauri updater 读取的 latest.json；在 release workflow 构建完成后运行。
// 用法：node scripts/make-updater-json.mjs v0.1.0
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = process.argv[2];
if (!tag) {
  console.error('用法：node scripts/make-updater-json.mjs <tag>');
  process.exit(1);
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const bundleDir = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const signatures = readdirSync(bundleDir).filter((name) => name.endsWith('.exe.sig'));
if (signatures.length !== 1) {
  console.error(`期望一个 .exe.sig，实际找到 ${signatures.length} 个：${signatures.join(', ')}`);
  process.exit(1);
}

const signatureFile = signatures[0];
const installer = signatureFile.slice(0, -'.sig'.length);
const signature = readFileSync(join(bundleDir, signatureFile), 'utf8').trim();

const manifest = {
  version,
  notes: `GlossNote ${version}，详见 https://github.com/ranger1112/glossnote/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/ranger1112/glossnote/releases/download/${tag}/${installer}`,
    },
  },
};

const target = join(bundleDir, 'latest.json');
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`已写入 ${target}（${installer}）`);
