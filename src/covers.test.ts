import { describe, expect, it } from 'vitest';
import { coverImageSize } from './covers';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe('coverImageSize', () => {
  it('reads PNG, GIF, BMP and JPEG dimensions', () => {
    expect(coverImageSize(png(320, 440))).toEqual({ width: 320, height: 440 });

    const gif = new Uint8Array(10);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xb8, 0x01]);
    expect(coverImageSize(gif)).toEqual({ width: 320, height: 440 });

    const bmp = new Uint8Array(26);
    bmp.set([0x42, 0x4d]);
    const view = new DataView(bmp.buffer);
    view.setInt32(18, 800, true);
    view.setInt32(22, -600, true);
    expect(coverImageSize(bmp)).toEqual({ width: 800, height: 600 });

    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xb8, 0x01, 0x40, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ]);
    expect(coverImageSize(jpeg)).toEqual({ width: 320, height: 440 });
  });

  it('returns null for unknown formats and truncated data', () => {
    expect(coverImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(coverImageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
