/**
 * 把 HTML 里的相对资源路径解析成源文件旁边的绝对路径。
 * 只做字符串层面的 . / .. 归一化，不访问文件系统。
 */
export function resolveRelativePath(baseFile: string, src: string): string {
  const separator = baseFile.includes('\\') ? '\\' : '/';
  const dir = baseFile.slice(0, baseFile.lastIndexOf(separator) + 1);
  // 先按原始 URL 去掉查询串和片段，再解码；这样文件名里的 %3F 不会被误删。
  let decoded = src.split('#')[0].split('?')[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 保留原样：少数 href 不是合法 URL 编码。
  }

  const stack: string[] = [];
  for (const part of (dir + decoded).split(/[\\/]/)) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }

  const joined = stack.join(separator);
  // 绝对 POSIX 路径以分隔符开头；Windows 盘符已经在 stack 里（如 D:）。
  if (baseFile.startsWith('\\\\')) return `\\${joined}`;
  return baseFile.startsWith('/') || baseFile.startsWith('\\')
    ? `${separator}${joined}`
    : joined;
}
