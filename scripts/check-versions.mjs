// 发布前确认三处版本号一致：package.json、tauri.conf.json、Cargo.toml。
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const versions = {
  'package.json': JSON.parse(read('package.json')).version,
  'tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'Cargo.toml': read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1],
};

const unique = new Set(Object.values(versions));
if (unique.size !== 1 || unique.has(undefined)) {
  console.error('版本号不一致：', versions);
  process.exit(1);
}

console.log(`版本一致：${[...unique][0]}`);
