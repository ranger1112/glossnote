/** 按扩展名推断图片 MIME；URL、asset 路径和普通文件路径都适用。 */
export function imageMimeFromPath(path: string): string | null {
  let value = path;
  try {
    value = new URL(path).pathname;
  } catch {
    // 相对路径或 asset: 地址按字符串取扩展名。
  }
  const extension = value.split('#')[0].split('?')[0].split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    default:
      return null;
  }
}
