function normalizeParts(value: string): string[] {
  const stack: string[] = [];
  for (const part of value.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack;
}

/** 根相对引用的起点：UNC 共享根、Windows 盘根或 POSIX 根。 */
function rootPrefix(baseFile: string): string | null {
  if (baseFile.startsWith('\\\\')) {
    const parts = baseFile.split(/[\\/]+/);
    return parts.length >= 3 ? `\\\\${parts[1]}\\${parts[2]}\\` : null;
  }
  const drive = /^[A-Za-z]:[\\/]/.exec(baseFile);
  if (drive) return drive[0];
  if (baseFile.startsWith('/')) return '/';
  if (baseFile.startsWith('\\')) return '\\';
  return null;
}

/**
 * 把 HTML 里的相对资源路径解析成源文件旁边的绝对路径。
 * 只做字符串层面的 . / .. 归一化，不访问文件系统。
 */
export function resolveRelativePath(baseFile: string, src: string): string {
  const separator = baseFile.includes('\\') ? '\\' : '/';
  // 先按原始 URL 去掉查询串和片段，再解码；这样文件名里的 %3F 不会被误删。
  let decoded = src.split('#')[0].split('?')[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 保留原样：少数 href 不是合法 URL 编码。
  }

  // /assets 这类根相对引用要回到盘根/共享根，而不是挂到 HTML 所在目录。
  if (/^[\\/]/.test(decoded)) {
    const root = rootPrefix(baseFile);
    if (root) return `${root}${normalizeParts(decoded).join(separator)}`;
  }

  const dir = baseFile.slice(0, baseFile.lastIndexOf(separator) + 1);
  const joined = normalizeParts(dir + decoded).join(separator);
  // 绝对 POSIX 路径以分隔符开头；Windows 盘符已经在 stack 里（如 D:）。
  if (baseFile.startsWith('\\\\')) return `\\\\${joined}`;
  return baseFile.startsWith('/') || baseFile.startsWith('\\')
    ? `${separator}${joined}`
    : joined;
}
