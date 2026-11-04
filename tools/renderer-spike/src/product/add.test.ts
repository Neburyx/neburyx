import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADD_TARGET, addReportSchema, checkAdd, evaluateAdd, EXPECTED_ADDED, writeAddReport } from './add.js';
import { AFTER, BEFORE, capture, frames } from './add-fixtures.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-add-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the check of one add', () => {
  it('passes an add of 25 entities and their relationships that moved nothing, with its figures: the longest frame, and the rate over the 30 frames after the add', () => {
    const run = checkAdd(capture());
    expect(run).toMatchObject({ addedEntities: 25, addedRelationships: 25, longestFrameMs: 40, frames: 30, movedPinned: 0, movedUnpinned: 0 });
    expect(run.medianFps).toBeCloseTo(1000 / 16.7, 1);
    expect(run.p5Fps).toBeCloseTo(1000 / 16.7, 1);
  });

  it('takes the longest frame from the whole capture, the add included, and the rates from the last 30 frames only', () => {
    const times = frames(40, 40);
    const run = checkAdd(capture({ times }));
    expect(run.longestFrameMs).toBe(40);
    expect(run.frames).toBe(30);
    const slowTail = [...frames(40, 20).slice(0, 10), ...Array.from({ length: 30 }, (_unused, index) => 1000 + index * 50)];
    expect(checkAdd(capture({ times: slowTail })).p5Fps).toBeCloseTo(20, 1);
  });

  it.each([
    ['a canvas with no read-out before', { before: undefined }, 'CANVAS_MISSING'],
    ['a canvas with no read-out after', { after: undefined }, 'CANVAS_MISSING'],
    ['a failure notice', { notice: 'RENDERER_UNAVAILABLE' }, 'RENDERER_FAILED'],
    ['a drawing of the fixture that was partial before the add', { before: { ...BEFORE, relationships: 100 } }, 'PARTIAL_DRAW'],
    ['an add that drew nothing', { after: BEFORE }, 'PARTIAL_ADD'],
    ['an add that drew only some entities', { after: { ...AFTER, entities: 140 } }, 'PARTIAL_ADD'],
    ['an add that drew some entities but too few relationships', { after: { ...AFTER, relationships: 190 } }, 'PARTIAL_ADD'],
    ['an add that drew too many relationships', { after: { ...AFTER, relationships: 230 } }, 'PARTIAL_ADD'],
    ['a canvas that carries no mark', { marked: undefined, movedPinned: undefined, movedUnpinned: undefined }, 'MARK_MISSING'],
    ['a mark that held fewer entities than were drawn', { marked: 100 }, 'MARK_MISSING'],
    ['a count of moved pinned entities below zero', { movedPinned: -1 }, 'MARK_MISSING'],
    ['a count of moved unpinned entities below zero', { movedUnpinned: -1 }, 'MARK_MISSING'],
    ['a count that is not whole', { movedUnpinned: 0.5 }, 'MARK_MISSING'],
    ['a count that is not a number', { movedPinned: Number.NaN }, 'MARK_MISSING'],
    ['an add drawn at a frame that is not there', { drawnAt: 60 }, 'FRAMES_INVALID'],
    ['an add drawn at a negative frame', { drawnAt: -1 }, 'FRAMES_INVALID'],
    ['an unpinned entity that moved', { movedUnpinned: 1 }, 'ENTITY_MOVED'],
    ['a pinned entity that moved', { movedPinned: 1 }, 'ENTITY_MOVED'],
    ['no frames after the add', { times: frames(10) }, 'FRAMES_INVALID'],
    ['frame times that do not rise', { times: [...frames().slice(0, 20), 100, ...frames().slice(21)] }, 'FRAMES_INVALID'],
    ['a frame time that is not a number', { times: [...frames().slice(0, 5), Number.NaN, ...frames().slice(6)] }, 'FRAMES_INVALID'],
  ] as const)('fails for %s, naming the cause', (_name, overrides, code) => {
    expect(() => checkAdd(capture(overrides))).toThrow(expect.objectContaining({ code }));
  });

  it('takes the rates over exactly the 30 frames after the frame that showed the add: two slow frames right after it are in the window, and a slow frame before it is not', () => {
    const smooth = (count: number): number[] => Array.from({ length: count }, (_unused, index) => index * 16.7);
    const slowAfter = [...smooth(10)];
    for (const gap of [40, 40, ...Array.from({ length: 28 }, () => 16.7)]) slowAfter.push((slowAfter[slowAfter.length - 1] ?? 0) + gap);
    const late = checkAdd(capture({ times: slowAfter, drawnAt: 9 }));
    expect(late.p5Fps).toBeCloseTo(25, 1);
    expect(late.frames).toBe(30);
    const slowBefore = [0, 16.7, 100, 116.7];
    for (let index = 0; index < 30; index += 1) slowBefore.push((slowBefore[slowBefore.length - 1] ?? 0) + 16.7);
    const early = checkAdd(capture({ times: slowBefore, drawnAt: 3 }));
    expect(early.p5Fps).toBeCloseTo(1000 / 16.7, 1);
    expect(early.longestFrameMs).toBeCloseTo(83.3, 1);
  });

  it('refuses a window that has fewer than 30 frames after the frame that showed the add, however many frames came before it', () => {
    expect(() => checkAdd(capture({ times: frames(40), drawnAt: 20 }))).toThrow(expect.objectContaining({ code: 'FRAMES_INVALID' }));
    expect(() => checkAdd(capture({ times: frames(51), drawnAt: 20 }))).not.toThrow();
  });

  it('expects the 25 entities and 25 relationships the app\'s development control adds', () => {
    expect(EXPECTED_ADDED).toEqual({ entities: 25, relationships: 25 });
  });
});

describe('the target for adding entities', () => {
  it('is the one recorded with the renderer decision: no frame over 100 ms and 30 fps at the 5th percentile over the next 30 frames, with the CPU slowed 4x', () => {
    expect(ADD_TARGET).toEqual({ cpuThrottle: 4, longestFrameMs: 100, p5Fps: 30, framesAfter: 30 });
  });

  it('is met when every run stays within both figures at 4x, and not when any run exceeds either', () => {
    expect(evaluateAdd([{ longestFrameMs: 100, p5Fps: 30 }, { longestFrameMs: 40, p5Fps: 59 }], 4)).toBe('met');
    expect(evaluateAdd([{ longestFrameMs: 40, p5Fps: 59 }, { longestFrameMs: 100.1, p5Fps: 59 }], 4)).toBe('not-met');
    expect(evaluateAdd([{ longestFrameMs: 40, p5Fps: 29.9 }], 6)).toBe('not-met');
  });

  it('gives no verdict below 4x, however the figures look', () => {
    expect(evaluateAdd([{ longestFrameMs: 900, p5Fps: 1 }], 1)).toBe('not-applicable');
    expect(evaluateAdd([{ longestFrameMs: 10, p5Fps: 60 }], 3)).toBe('not-applicable');
  });
});

describe('the report of the add benchmark', () => {
  const run = { addedEntities: 25, addedRelationships: 25, longestFrameMs: 40, frames: 30, medianFps: 59.9, p5Fps: 59, movedPinned: 0, movedUnpinned: 0 };
  const report = {
    status: 'complete',
    target: 'product',
    scenario: 'add',
    measuredAt: '2026-11-03T10:00:00.000Z',
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
    writeAddReport(path, report);
    expect(addReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toEqual(report);
  });

  it.each([
    ['a missing field', { ...report, verdict: undefined }],
    ['a run that moved an entity', { ...report, runs: [{ ...run, movedUnpinned: 2 }] }],
    ['a run with a negative count of moved entities', { ...report, runs: [{ ...run, movedPinned: -1 }] }],
    ['a run with a count of moved entities that is not whole', { ...report, runs: [{ ...run, movedUnpinned: -0.5 }] }],
    ['a goal that is not the recorded one', { ...report, goal: { ...report.goal, longestFrameMs: 200 } }],
    ['no runs', { ...report, runs: [] }],
  ])('is refused, and no file is written, for %s', (_name, bad) => {
    const path = join(directory, 'bad.json');
    expect(() => writeAddReport(path, bad)).toThrow(expect.objectContaining({ code: 'REPORT_INVALID' }));
    expect(existsSync(path)).toBe(false);
  });
});
