import { describe, expect, it } from 'vitest';
import { resolveRelativePath } from './paths';

describe('resolveRelativePath', () => {
  it('resolves Windows paths and parent segments', () => {
    expect(resolveRelativePath('D:\\books\\article.html', 'images/pic.png')).toBe(
      'D:\\books\\images\\pic.png',
    );
    expect(resolveRelativePath('D:\\books\\article.html', '../assets/pic.png')).toBe(
      'D:\\assets\\pic.png',
    );
    // 查询串按 URL 语义丢掉；编码过的 %3F 是文件名的一部分，要保留。
    expect(resolveRelativePath('D:\\books\\article.html', 'pic.png?v=2#frag')).toBe(
      'D:\\books\\pic.png',
    );
    expect(resolveRelativePath('D:\\books\\article.html', 'a%3Fb.png')).toBe(
      'D:\\books\\a?b.png',
    );
  });

  it('resolves POSIX paths and decodes URL encoding', () => {
    expect(resolveRelativePath('/home/me/article.html', 'images/pic%20one.png')).toBe(
      '/home/me/images/pic one.png',
    );
    expect(resolveRelativePath('/home/me/article.html', './pic.png#fragment')).toBe(
      '/home/me/pic.png',
    );
  });
});
