import { describe, expect, it } from 'vitest';
import { imageMimeFromPath } from './imageMime';

describe('imageMimeFromPath', () => {
  it('handles URLs, encoded paths and case-insensitive extensions', () => {
    expect(imageMimeFromPath('https://example.com/a/b.PNG?x=1')).toBe('image/png');
    expect(imageMimeFromPath('D:\\articles\\images\\pic%20one.jpeg')).toBe('image/jpeg');
    expect(imageMimeFromPath('asset://localhost/images/cover.webp')).toBe('image/webp');
    expect(imageMimeFromPath('images/vector.svg#frag')).toBe('image/svg+xml');
    expect(imageMimeFromPath('cover.bin')).toBeNull();
  });
});
