import { ARROW_SHAPE, AGGREGATE_WIDTH, DASH_PATTERN, DERIVED_COLOR, EDGE_COLOR, EDGE_WIDTH } from '../canvas/look.js';

export type SampleKind = 'sourced' | 'derived' | 'aggregate' | 'direction';

export const SAMPLE_WIDTH = 32;
export const SAMPLE_HEIGHT = 12;
const HEAD_LENGTH = 6;

type HeadShape = 'chevron' | 'triangle';

interface SampleLook {
  readonly stroke: string;
  readonly width: number;
  readonly dash: readonly number[] | undefined;
  readonly head: boolean;
}

/** How the canvas draws each kind of relationship, read from the canvas's own constants so the legend follows them. A rule-derived relationship has no arrowhead on the canvas. */
export function sampleLook(kind: SampleKind): SampleLook {
  switch (kind) {
    case 'sourced':
      return { stroke: EDGE_COLOR, width: EDGE_WIDTH, dash: undefined, head: false };
    case 'derived':
      return { stroke: DERIVED_COLOR, width: EDGE_WIDTH, dash: DASH_PATTERN, head: false };
    case 'aggregate':
      return { stroke: EDGE_COLOR, width: AGGREGATE_WIDTH, dash: undefined, head: false };
    case 'direction':
      return { stroke: EDGE_COLOR, width: EDGE_WIDTH, dash: undefined, head: true };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** The arrowhead drawn at the end of the sample's line for each shape the canvas can be set to; a shape that is not here fails the type check where the canvas's constant is read. */
function Head({ shape, stroke, width, middle }: { readonly shape: HeadShape; readonly stroke: string; readonly width: number; readonly middle: number }) {
  const back = SAMPLE_WIDTH - HEAD_LENGTH;
  const points = `${back},${middle - HEAD_LENGTH} ${SAMPLE_WIDTH},${middle} ${back},${middle + HEAD_LENGTH}`;
  return shape === 'triangle' ? (
    <polygon points={points} fill={stroke} stroke={stroke} strokeWidth={width} data-arrow={shape} />
  ) : (
    <polyline points={points} fill="none" stroke={stroke} strokeWidth={width} data-arrow={shape} />
  );
}

export function LegendSample({ kind }: { readonly kind: SampleKind }) {
  const look = sampleLook(kind);
  const middle = SAMPLE_HEIGHT / 2;
  return (
    <svg className="legend-sample" width={SAMPLE_WIDTH} height={SAMPLE_HEIGHT} viewBox={`0 0 ${SAMPLE_WIDTH} ${SAMPLE_HEIGHT}`} aria-hidden="true" data-kind={kind}>
      <line x1={0} y1={middle} x2={SAMPLE_WIDTH} y2={middle} stroke={look.stroke} strokeWidth={look.width} strokeDasharray={look.dash?.join(' ')} />
      {look.head ? <Head shape={ARROW_SHAPE} stroke={look.stroke} width={look.width} middle={middle} /> : null}
    </svg>
  );
}
