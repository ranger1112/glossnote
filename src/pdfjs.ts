import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * pdf.js 在运行时才去取这些资源：cMaps 决定中文等 CJK 字体的字形，
 * wasm 解码器负责 JPEG2000（OpenJPEG）与 JBIG2 扫描图。
 * 不提供时 pdf.js 会静默降级，PDF 里的图会变成黑块。
 */
const assetBase = `${import.meta.env.BASE_URL}pdfjs/`;

export const pdfjsAssets = {
  cMapUrl: `${assetBase}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetBase}standard_fonts/`,
  wasmUrl: `${assetBase}wasm/`,
  iccUrl: `${assetBase}iccs/`,
} as const;

/**
 * 大文档只按需取范围：关闭后台整本预取，避免 90MB 文档在首屏渲染时
 * 同时把整份文件经 asset protocol 搬进 WebView。Tauri 的 asset 协议支持 Range。
 */
export const pdfjsOpenOptions = {
  ...pdfjsAssets,
  disableAutoFetch: true,
  rangeChunkSize: 1 << 18,
} as const;

export { pdfjsLib };

/** 只保留我们用得到的字段，避免把 pdf.js 的内部类型泄漏到组件里。 */
export interface PdfTextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}
