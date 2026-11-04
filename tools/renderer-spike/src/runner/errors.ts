export const RUNNER_ERROR_CODES = ['ADAPTER_UNKNOWN', 'BUILD_MISSING', 'SERVER_START_FAILED', 'BROWSER_START_FAILED', 'ADAPTER_FAILED', 'MEASUREMENT_FAILED', 'CLEANUP_FAILED', 'USAGE', 'APP_UNREACHABLE', 'CANVAS_MISSING', 'PARTIAL_DRAW', 'RENDERER_FAILED', 'CANVAS_BLANK', 'CANVAS_UNCHANGED', 'WHEEL_NO_EFFECT', 'DRAG_NO_EFFECT', 'GESTURE_INEFFECTIVE', 'CONTROL_MISSING', 'PARTIAL_ADD', 'MARK_MISSING', 'ENTITY_MOVED', 'FRAMES_INVALID', 'LAYOUT_INEFFECTIVE', 'PIN_MOVED', 'VIEW_CHANGED', 'DISPLACEMENT_FAILED'] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'RunnerError';
    this.code = code;
  }
}
