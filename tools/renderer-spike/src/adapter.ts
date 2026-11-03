import type { Additions, Fixture } from './fixture/schema.js';
import type { IconKey } from './look.js';

export const ADAPTER_ERROR_CODES = ['ADAPTER_UNKNOWN', 'ADAPTER_ALREADY_MOUNTED', 'ADAPTER_NOT_MOUNTED', 'ADAPTER_NEEDS_BROWSER', 'ADAPTER_EXISTS', 'ADAPTER_UNSUPPORTED', 'ADAPTER_GROUP_EMPTY', 'ADAPTER_NODE_UNKNOWN'] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode) {
    super(code);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export interface DrawnNode {
  readonly id: string;
  readonly kind: 'entity' | 'neighborAggregate';
  readonly label: string;
  readonly iconKey: IconKey;
  readonly iconDrawn: boolean;
  readonly color: string;
  readonly dashedBorder: boolean;
}

export interface DrawnRelationship {
  readonly id: string;
  readonly kind: 'sourced' | 'derived' | 'aggregate';
  readonly lineStyle: 'solid' | 'dashed';
  readonly width: number;
  readonly label: string;
  readonly labelOutlined: boolean;
  readonly hasArrow: boolean;
}

export interface Drawing {
  readonly nodes: readonly DrawnNode[];
  readonly relationships: readonly DrawnRelationship[];
}

export interface ViewState {
  readonly zoomFactor: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface GroupState {
  readonly typeId: string;
  readonly members: number;
}

export const FIT_VIEW: ViewState = { zoomFactor: 1, offsetX: 0, offsetY: 0 };

export interface RendererAdapter {
  readonly name: string;
  readonly notes: readonly string[];
  readonly holdMechanism: string;
  mount(fixture: Fixture): void;
  describe(): Drawing;
  applyView(view: ViewState): void;
  getPositions(): ReadonlyMap<string, Position>;
  setPositions(positions: ReadonlyMap<string, Position>): void;
  fix(ids: readonly string[]): void;
  addNodes(additions: Additions): void;
  groupByType(typeId: string): void;
  ungroupByType(typeId: string): void;
  groups(): readonly GroupState[];
  setFocus(id: string | undefined): void;
  isFocusRingVisible(id: string): boolean;
  dispose(): void;
}

