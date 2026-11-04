import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateAdd } from './add.js';
import { BEFORE, DISPLACED_IDS, frames, layoutCapture } from './add-fixtures.js';
import { checkLayout, DISPLACED, layoutReportSchema, parseIds, writeLayoutReport } from './layout.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-layout-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the check of one layout run', () => {
  it('passes a run that moved the displaced entities and no pinned one, with the view unchanged, and gives its figures and how long the command took', () => {
    const run = checkLayout(layoutCapture());
    expect(run).toMatchObject({ displaced: 10, movedPinned: 0, movedUnpinned: 110, commandMs: 12, longestFrameMs: 40, frames: 30 });
    expect(run.medianFps).toBeCloseTo(1000 / 16.7, 1);
    expect(DISPLACED).toBe(10);
  });

  it.each([
    ['a canvas with no read-out before', { before: undefined }, 'CANVAS_MISSING'],
    ['a canvas with no read-out after', { after: undefined }, 'CANVAS_MISSING'],
    ['a failure notice', { notice: 'RENDERER_UNAVAILABLE' }, 'RENDERER_FAILED'],
    ['a fixture that was drawn only in part before the run', { before: { ...BEFORE, relationships: 100 }, after: { ...BEFORE, relationships: 100 } }, 'PARTIAL_DRAW'],
    ['a run that changed what is drawn', { after: { ...BEFORE, entities: 119 } }, 'PARTIAL_DRAW'],
    ['a canvas that carries no mark', { marked: undefined, movedPinned: undefined, movedUnpinned: undefined }, 'MARK_MISSING'],
    ['a mark that held fewer entities than were drawn', { marked: 90 }, 'MARK_MISSING'],
    ['a layout that did nothing', { movedUnpinned: 0, movedIds: [] }, 'LAYOUT_INEFFECTIVE'],
    ['a layout that moved only nine of the ten displaced entities', { movedIds: [...DISPLACED_IDS.slice(0, 9), ...Array.from({ length: 100 }, (_unused, index) => `other-${index}`)] }, 'LAYOUT_INEFFECTIVE'],
    ['a layout that moved ten entities that were not the displaced ones', { movedUnpinned: 10, movedIds: Array.from({ length: 10 }, (_unused, index) => `other-${index}`) }, 'LAYOUT_INEFFECTIVE'],
    ['no list of the entities the layout moved', { movedIds: undefined }, 'MARK_MISSING'],
    ['no read-out of the displacement', { displaced: undefined }, 'DISPLACEMENT_FAILED'],
    ['a displacement that moved nine entities', { displaced: { movedPinned: 0, movedUnpinned: 9, ids: DISPLACED_IDS.slice(0, 9) } }, 'DISPLACEMENT_FAILED'],
    ['a displacement that moved eleven entities', { displaced: { movedPinned: 0, movedUnpinned: 11, ids: [...DISPLACED_IDS, 'extra'] } }, 'DISPLACEMENT_FAILED'],
    ['a displacement that moved a pinned entity', { displaced: { movedPinned: 1, movedUnpinned: 10, ids: DISPLACED_IDS } }, 'DISPLACEMENT_FAILED'],
    ['a displacement with no list of the entities', { displaced: { movedPinned: 0, movedUnpinned: 10, ids: undefined } }, 'DISPLACEMENT_FAILED'],
    ['a count of moved pinned entities below zero', { movedPinned: -1 }, 'MARK_MISSING'],
    ['a count of moved unpinned entities that is not whole', { movedUnpinned: 10.5 }, 'MARK_MISSING'],
    ['a count of moved unpinned entities that is not a number', { movedUnpinned: Number.NaN }, 'MARK_MISSING'],
    ['a displacement count below zero', { displaced: { movedPinned: -1, movedUnpinned: 10, ids: DISPLACED_IDS } }, 'MARK_MISSING'],
    ['an action drawn at a frame that is not there', { drawnAt: 40 }, 'FRAMES_INVALID'],
    ['a pinned entity that moved', { movedPinned: 1 }, 'PIN_MOVED'],
    ['a zoom that changed', { after: { ...BEFORE, zoom: 1.1 } }, 'VIEW_CHANGED'],
    ['a pan that changed', { after: { ...BEFORE, panX: 3 } }, 'VIEW_CHANGED'],
    ['too few frames', { times: frames(10) }, 'FRAMES_INVALID'],
    ['frame times that do not rise', { times: [...frames().slice(0, 20), 100, ...frames().slice(21)] }, 'FRAMES_INVALID'],
    ['a command time that is not a number', { commandMs: Number.NaN }, 'FRAMES_INVALID'],
  ] as const)('fails for %s, naming the cause', (_name, overrides, code) => {
    expect(() => checkLayout(layoutCapture(overrides))).toThrow(expect.objectContaining({ code }));
  });

  it('is held to the same target as the add: no frame over 100 ms and 30 fps at the 5th percentile at 4x, and no verdict below it', () => {
    const slow = checkLayout(layoutCapture({ times: frames(33, 180) }));
    expect(evaluateAdd([slow], 4)).toBe('not-met');
    expect(evaluateAdd([checkLayout(layoutCapture())], 4)).toBe('met');
    expect(evaluateAdd([slow], 1)).toBe('not-applicable');
  });
});

describe('the entities the app lists as moved', () => {
  it('are read from a list of text, and nothing else is believed', () => {
    expect(parseIds('["a","b"]')).toEqual(['a', 'b']);
    expect(parseIds('[]')).toEqual([]);
    for (const bad of [undefined, 'not json', '{"a":1}', '[1,2]', 'null']) expect(parseIds(bad), String(bad)).toBeUndefined();
  });
});

describe('the report of the layout benchmark', () => {
  const run = { displaced: 10, movedPinned: 0, movedUnpinned: 118, commandMs: 12, longestFrameMs: 40, frames: 30, medianFps: 59.9, p5Fps: 59 };
  const report = {
    status: 'complete',
    target: 'product',
    scenario: 'layout',
    measuredAt: '2026-11-04T10:00:00.000Z',
    app: { origin: 'http://127.0.0.1:5174', drawnEntities: 120, drawnRelationships: 180 },
    browser: { name: 'chromium', version: '1', headed: true },
    os: { platform: 'test', release: '1', arch: 'x' },
    cpu: { model: 'm', cores: 4 },
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    protocol: { runs: 3, framesAfter: 30, cpuThrottle: 4 },
    runs: [run, run, run],
    goal: { cpuThrottle: 4, longestFrameMs: 100, p5Fps: 30 },
    verdict: 'met',
  };

  it('is written whole when it is complete', () => {
    const path = join(directory, 'r.json');
    writeLayoutReport(path, report);
    expect(layoutReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toEqual(report);
  });

  it.each([
    ['a missing field', { ...report, verdict: undefined }],
    ['a run in which a pinned entity moved', { ...report, runs: [{ ...run, movedPinned: 1 }] }],
    ['a run with a negative count of moved pinned entities', { ...report, runs: [{ ...run, movedPinned: -1 }] }],
    ['a run that moved fewer entities than were displaced', { ...report, runs: [{ ...run, movedUnpinned: 5 }] }],
    ['a goal that is not the recorded one', { ...report, goal: { ...report.goal, p5Fps: 20 } }],
    ['no runs', { ...report, runs: [] }],
  ])('is refused, and no file is written, for %s', (_name, bad) => {
    const path = join(directory, 'bad.json');
    expect(() => writeLayoutReport(path, bad)).toThrow(expect.objectContaining({ code: 'REPORT_INVALID' }));
    expect(existsSync(path)).toBe(false);
  });
});
