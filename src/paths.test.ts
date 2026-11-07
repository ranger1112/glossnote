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
