import type { Drawing } from '../adapter.js';
import type { IncrementalResult } from '../measure/incremental.js';
import type { GroupingSnapshot, KeyboardState } from '../measure/probes.js';

export interface SpikeHandle {
  readonly adapterName: string;
  readonly ready: Promise<void>;
  mount(): Promise<void>;
  dispose(): void;
  describe(): Drawing;
  measurePanZoom(durationMs: number): Promise<number[]>;
  measureIncremental(): Promise<IncrementalResult>;
  groupingSnapshot(): GroupingSnapshot;
  group(typeId: string): GroupingSnapshot;
  ungroup(typeId: string): GroupingSnapshot;
  keyboardState(): KeyboardState;
}

declare global {
  interface Window {
    __spike?: SpikeHandle;
  }
}
