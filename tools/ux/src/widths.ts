/** The browser projects: every spec runs at 1440 wide, and the specs below also (or only) at 1280. */
export const WIDE = 'laptop-1440';
export const NARROW = 'laptop-1280';
export const BENCHMARK = 'benchmark';

/** Specs whose result depends on the width of the window (a region inside the window, boxes that must not overlap): they run at both widths. */
export const WIDTH_DEPENDENT: readonly string[] = [
  'ai-header.spec.ts',
  'compare.spec.ts',
  'evidence.spec.ts',
  'first-run.spec.ts',
  'help-menu.spec.ts',
  'home-controls.spec.ts',
  'inspector.spec.ts',
  'layouts.spec.ts',
  'page-shell.spec.ts',
  'pattern-builder.spec.ts',
  'pattern-run.spec.ts',
  'pattern-run-long.spec.ts',
  'patterns-keyboard.spec.ts',
  'patterns-panel.spec.ts',
  'saved-patterns.spec.ts',
  'starting-hint.spec.ts',
  'workspace-shell.spec.ts',
  'zoomed-out.spec.ts',
];

/** Specs made for the narrow window: each skips at any other width. */
export const ONLY_1280: readonly string[] = ['left-panel.spec.ts', 'short-canvas.spec.ts'];

/** Specs that carry a width marker and are in neither list, each with the reason one width (or their own sizes) is enough. */
export const EXEMPT: Readonly<Record<string, string>> = {
  'benchmark.spec.ts': 'runs in the benchmark project, at its own size',
  'deletion.spec.ts': 'sets 1280 and 1440 itself in one test',
  'draft-reload.spec.ts': 'drags from offsets of the canvas box, so the result does not depend on the width',
  'evidence-selection.spec.ts': 'clicks near the edge of the canvas box, relative to the box',
  'keyboard-canvas.spec.ts': 'right-clicks at an offset from the corner of the canvas box',
  'modifier-click.spec.ts': 'clicks at an offset from the corner of the canvas box',
  'derived-evidence.spec.ts': 'sets 1440 x 900 and 1280 x 720 itself',
  'focus-neighborhood.spec.ts': 'sets its own widths',
  'named-views.spec.ts': 'compares the vertical order of stacked blocks, which does not change with the width',
  'pin-position.spec.ts': 'turns a model position into a screen position from the canvas box, pan and zoom, so it is relative to the canvas',
  'search-filters.spec.ts': 'sets its own 640 px width',
  'search-tool.spec.ts': 'brings an entity to the middle of the canvas box, relative to the box',
  'search.spec.ts': 'reads the project name only to make a search text unique',
  'sources-controls.spec.ts': 'asserts a button is narrower than 200 px and not as wide as its section, which the wider window tests more strictly',
};

export const isBenchmark = (file: string): boolean => file.includes('benchmark');

/** The projects a spec runs in. */
export function projectsOf(file: string): readonly string[] {
  if (isBenchmark(file)) return [BENCHMARK];
  if (ONLY_1280.includes(file)) return [NARROW];
  return WIDTH_DEPENDENT.includes(file) ? [WIDE, NARROW] : [WIDE];
}

/** A pattern that matches one spec file by its name. */
export const patternOf = (file: string): RegExp => new RegExp(`(^|/)${file.replace(/\./g, '\\.')}$`);

/** What a spec has to carry to be a candidate for a second width, searched for in its text. */
export const WIDTH_MARKERS: readonly RegExp[] = [
  /viewportSize/,
  /viewport\?\.width/,
  /test\.use\(\{[^}]*viewport/,
  /setViewportSize/,
  /expectInsideViewport/,
  /boxOf\(/,
  /boundingBox\(/,
  /(testInfo|info)\.project/,
  /\b(1280|1440)\b/,
];
