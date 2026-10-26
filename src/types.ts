import type { Anchor } from './anchoring';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface Annotation {
  id: string;
  page: number;
  anchor: Anchor;
  color: HighlightColor;
  note: string;
  createdAt: number;
  updatedAt: number;
  /** 墓碑式删除：同步与撤销都依赖它，不做物理删除 */
  deleted?: boolean;
}

export interface DocRecord {
  schemaVersion: 1;
  docId: string;
  name: string;
  size: number;
  annotations: Annotation[];
}
