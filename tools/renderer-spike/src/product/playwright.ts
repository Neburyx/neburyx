import { chromium, type Page } from 'playwright';
import { viewAt } from '../measure/pan-zoom.js';
import { machine } from '../runner/environment.js';
import { parseReadout, type CanvasPixels } from './checks.js';
import { writeAddReport, type AddCapture } from './add.js';
import { writeProductReport } from './report.js';
import { ADD_BUTTON, DISPLACE_BUTTON, FORCE_ROW, LAYOUT_CONTROL, MARK_EVENT } from './page-constants.js';
import { parseIds, writeLayoutReport, type LayoutCapture } from './layout.js';
import type { ProductBrowser, ProductDeps, ProductPage } from './run.js';

const VIEWPORT = { width: 1280, height: 720 };
const FIXTURE_ROUTE = '[data-dev-tool="neburyx-dev-fixture-route"]';
const CANVAS = '.graph-canvas';
/** Where a drag starts: empty canvas near the left edge, below the tool strip. */
const DRAG_START = { x: 0.03, y: 0.75 };
const GESTURE_SAMPLES = 600;
/** The library throttles pointer moves, so the move that matters comes this long after the press. */
const POINTER_MOVE_GAP_MS = 25;
/** A move this far enters the library's drag; a smaller one is below its threshold. */
const FIRST_MOVE_PX = 8;
const SETTLE_MS = 100;
const FRAMES_TO_SETTLE = 2;

async function settle(page: Page): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, FRAMES_TO_SETTLE);
}

async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(CANVAS).boundingBox();
  if (box === null) throw new Error('CANVAS_MISSING');
  return box;
}

function productPage(page: Page): ProductPage {
  return {
    async openFixture() {
      await page.locator(`${FIXTURE_ROUTE} button`).first().click();
      await page.getByRole('button', { name: 'Load', exact: true }).click();
      await page.getByRole('link', { name: 'Open Explore' }).click();
      await page.waitForSelector(`${CANVAS}[data-drawn-entities]`);
      await settle(page);
    },
    readout: () =>
      page.evaluate(() => {
        const element = document.querySelector('.graph-canvas');
        if (!(element instanceof HTMLElement)) return undefined;
        const { drawnEntities, drawnRelationships, zoom, panX, panY } = element.dataset;
        return { entities: drawnEntities, relationships: drawnRelationships, zoom, panX, panY };
      }).then((values) => (values === undefined ? undefined : parseReadout(values))),
    notice: () => page.evaluate(() => document.querySelector('.canvas-notice')?.textContent ?? undefined),
    pixels: (): Promise<CanvasPixels> =>
      page.evaluate(() => {
        let ink = 0;
        let signature = 0;
        for (const canvas of document.querySelectorAll('.graph-canvas canvas')) {
          if (!(canvas instanceof HTMLCanvasElement)) continue;
          const context = canvas.getContext('2d');
          if (context === null || canvas.width === 0 || canvas.height === 0) continue;
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let at = 0; at < data.length; at += 4) {
            const alpha = data[at + 3] ?? 0;
            if (alpha > 0) ink += 1;
            if ((at / 4) % 16 === 0) signature = (signature * 31 + (data[at] ?? 0) + (data[at + 1] ?? 0) * 3 + (data[at + 2] ?? 0) * 5 + alpha * 7) >>> 0;
          }
        }
        return { ink, signature: String(signature) };
      }),
    async wheel(deltaY) {
      const box = await canvasBox(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, deltaY);
      await settle(page);
    },
    async drag(dx, dy) {
      const box = await canvasBox(page);
      const start = { x: box.x + box.width * DRAG_START.x, y: box.y + box.height * DRAG_START.y };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 });
      await page.mouse.up();
      await settle(page);
    },
    async measureAdd(framesAfter): Promise<AddCapture> {
      const captured = await page.evaluate(
        async ({ after, markEvent, button }) => {
          const element = document.querySelector('.graph-canvas');
          const control = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === button);
          if (!(element instanceof HTMLElement)) throw new Error('CANVAS_MISSING');
          if (control === undefined) throw new Error('CONTROL_MISSING');
          const read = (): Record<string, string | undefined> => {
            const { drawnEntities, drawnRelationships, zoom, panX, panY, markedEntities, movedPinned, movedUnpinned } = element.dataset;
            return { entities: drawnEntities, relationships: drawnRelationships, zoom, panX, panY, markedEntities, movedPinned, movedUnpinned };
          };
          const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
          let before: Record<string, string | undefined> | undefined;
          const times: number[] = [];
          let drawnAt: number | undefined;
          let recording = true;
          const record = async (): Promise<void> => {
            while (recording) {
              times.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
              if (drawnAt === undefined && before !== undefined && read()['entities'] !== before['entities']) drawnAt = times.length - 1;
              if (drawnAt !== undefined && times.length >= drawnAt + 1 + after) recording = false;
            }
          };
          const recorded = record();
          await frame();
          await frame();
          before = read();
          element.dispatchEvent(new Event(markEvent));
          const startAt = times.length - 1;
          control.click();
          let guard = 0;
          while (recording && guard < 600) {
            await frame();
            guard += 1;
          }
          recording = false;
          await recorded;
          if (drawnAt === undefined) throw new Error('NOT_DRAWN');
          return { times: times.slice(startAt, drawnAt + 1 + after), drawnAt: drawnAt - startAt, before, after: read(), notice: document.querySelector('.canvas-notice')?.textContent ?? undefined };
        },
        { after: framesAfter, markEvent: MARK_EVENT, button: ADD_BUTTON },
      );
      const finished = captured.after;
      return {
        times: captured.times,
        drawnAt: captured.drawnAt,
        before: parseReadout(captured.before),
        after: parseReadout(finished),
        marked: finished['markedEntities'] === undefined ? undefined : Number(finished['markedEntities']),
        movedPinned: finished['movedPinned'] === undefined ? undefined : Number(finished['movedPinned']),
        movedUnpinned: finished['movedUnpinned'] === undefined ? undefined : Number(finished['movedUnpinned']),
        notice: captured.notice,
      };
    },
    async measureLayout(framesAfter): Promise<LayoutCapture> {
      const captured = await page.evaluate(
        async ({ after, markEvent, displaceButton, controlLabel, forceRow }) => {
          const element = document.querySelector('.graph-canvas');
          if (!(element instanceof HTMLElement)) throw new Error('CANVAS_MISSING');
          const displace = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === displaceButton);
          const control = [...document.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === controlLabel);
          if (displace === undefined || control === undefined) throw new Error('CONTROL_MISSING');
          const read = (): Record<string, string | undefined> => {
            const { drawnEntities, drawnRelationships, zoom, panX, panY, markedEntities, movedPinned, movedUnpinned, movedIds } = element.dataset;
            return { entities: drawnEntities, relationships: drawnRelationships, zoom, panX, panY, markedEntities, movedPinned, movedUnpinned, movedIds };
          };
          const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
          element.dispatchEvent(new Event(markEvent));
          displace.click();
          for (let count = 0; count < 4; count += 1) await frame();
          const displaced = read();
          const times: number[] = [];
          let drawnAt: number | undefined;
          let armed = false;
          let recording = true;
          const record = async (): Promise<void> => {
            while (recording) {
              times.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
              if (drawnAt === undefined && armed && Number(read()['movedUnpinned'] ?? '0') > 0) drawnAt = times.length - 1;
              if (drawnAt !== undefined && times.length >= drawnAt + 1 + after) recording = false;
            }
          };
          const recorded = record();
          await frame();
          await frame();
          element.dispatchEvent(new Event(markEvent));
          const before = read();
          const startAt = times.length - 1;
          armed = true;
          control.click();
          const rowNow = (): Element | undefined => [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent === forceRow);
          for (let count = 0; count < 20 && rowNow() === undefined; count += 1) await frame();
          const row = rowNow();
          if (!(row instanceof HTMLElement)) throw new Error('CONTROL_MISSING');
          const pressed = performance.now();
          row.click();
          const commandMs = performance.now() - pressed;
          let guard = 0;
          while (recording && guard < 600) {
            await frame();
            guard += 1;
          }
          recording = false;
          await recorded;
          if (drawnAt === undefined) throw new Error('NOT_DRAWN');
          return { times: times.slice(startAt, drawnAt + 1 + after), drawnAt: drawnAt - startAt, displaced, before, after: read(), commandMs, notice: document.querySelector('.canvas-notice')?.textContent ?? undefined };
        },
        { after: framesAfter, markEvent: MARK_EVENT, displaceButton: DISPLACE_BUTTON, controlLabel: LAYOUT_CONTROL, forceRow: FORCE_ROW },
      );
      const finished = captured.after;
      const number = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));
      return {
        times: captured.times,
        drawnAt: captured.drawnAt,
        before: parseReadout(captured.before),
        after: parseReadout(finished),
        displaced: { movedPinned: number(captured.displaced['movedPinned']), movedUnpinned: number(captured.displaced['movedUnpinned']), ids: parseIds(captured.displaced['movedIds']) },
        marked: number(finished['markedEntities']),
        movedPinned: number(finished['movedPinned']),
        movedUnpinned: number(finished['movedUnpinned']),
        movedIds: parseIds(finished['movedIds']),
        commandMs: captured.commandMs,
        notice: captured.notice,
      };
    },
    viewport: () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })),
    measurePanZoom(durationMs, wheelStep) {
      const table = Array.from({ length: GESTURE_SAMPLES + 1 }, (_unused, index) => viewAt(index / GESTURE_SAMPLES));
      return page.evaluate(
        async ({ duration, samples, step, dragStart, moveGap, FIRST_MOVE_PX, SETTLE_MS }) => {
          const element = document.querySelector('.graph-canvas');
          const canvas = [...document.querySelectorAll('.graph-canvas canvas')].pop();
          if (!(element instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) throw new Error('CANVAS_MISSING');
          const rect = element.getBoundingClientRect();
          const centre = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
          const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
          const wheel = (deltaY: number): void => {
            canvas.dispatchEvent(new WheelEvent('wheel', { ...centre, deltaY, deltaMode: 0, bubbles: true, cancelable: true }));
          };
          // the library applies a wheel step a little after the event, so the view is read after a short wait as well as after frames
          const settled = async (): Promise<void> => {
            await frame();
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
            await frame();
          };
          const zoomNow = (): number => Number(element.dataset['zoom']);
          const panNow = (): { x: number; y: number } => ({ x: Number(element.dataset['panX']), y: Number(element.dataset['panY']) });
          const before = zoomNow();
          wheel(step);
          await settled();
          const stepLog = Math.abs(Math.log(zoomNow() / before));
          wheel(-step);
          await settled();
          if (!(stepLog > 0)) throw new Error(`WHEEL_NO_EFFECT: a step changed the zoom from ${before} to ${zoomNow()} before the run`);
          const start = { clientX: rect.left + rect.width * dragStart.x, clientY: rect.top + rect.height * dragStart.y };
          const mouse = (type: string, at: { clientX: number; clientY: number }, target: EventTarget): void => {
            target.dispatchEvent(new MouseEvent(type, { ...at, bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
          };
          const times: number[] = [];
          let zoomMin = zoomNow();
          let zoomMax = zoomMin;
          let panTravel = 0;
          let last = panNow();
          let previousLog = 0;
          let previousOffset = { x: 0, y: 0 };
          let acted: 'drag' | 'wheel' | undefined;
          let pressedAt: number | undefined;
          let first: number | undefined;
          let progress = 0;
          while (progress < 1) {
            const time = await frame();
            first ??= time;
            times.push(time);
            progress = Math.min((time - first) / duration, 1);
            // what the previous action did to the view is read now, so a drag's move is never mixed with a wheel step's anchoring
            const pan = panNow();
            const zoom = zoomNow();
            if (acted === 'drag') panTravel += Math.hypot(pan.x - last.x, pan.y - last.y);
            zoomMin = Math.min(zoomMin, zoom);
            zoomMax = Math.max(zoomMax, zoom);
            last = pan;
            const view = samples[Math.round(progress * (samples.length - 1))];
            if (view === undefined) throw new Error('GESTURE_INVALID');
            // the library ignores the wheel while a button is held and throttles pointer moves, so a drag is a press with a first move, then (at least the library's throttle later) the move that matters and the release, and a wheel step follows in its own frame
            if (pressedAt === undefined && acted !== 'drag') {
              // the first move has to be past the library's drag threshold, so it goes a few pixels past halfway
              const offset = { x: view.offsetX * rect.width, y: view.offsetY * rect.height };
              mouse('mousedown', start, canvas);
              mouse('mousemove', { clientX: start.clientX + (offset.x - previousOffset.x) / 2 + FIRST_MOVE_PX, clientY: start.clientY + (offset.y - previousOffset.y) / 2 + FIRST_MOVE_PX }, window);
              pressedAt = time;
              acted = undefined;
            } else if (pressedAt !== undefined) {
              if (time - pressedAt < moveGap) continue;
              const offset = { x: view.offsetX * rect.width, y: view.offsetY * rect.height };
              const to = { clientX: start.clientX + offset.x - previousOffset.x, clientY: start.clientY + offset.y - previousOffset.y };
              mouse('mousemove', to, window);
              mouse('mouseup', to, window);
              previousOffset = offset;
              pressedAt = undefined;
              acted = 'drag';
            } else {
              // the library's wheel response is not proportional to the delta, so the zoom follows the script in whole calibrated steps
              const wanted = Math.log(view.zoomFactor);
              const steps = Math.round((wanted - previousLog) / stepLog);
              for (let count = 0; count < Math.abs(steps); count += 1) wheel(steps > 0 ? step : -step);
              previousLog += steps * stepLog;
              acted = 'wheel';
            }
          }
          // a press still open when the script ends is released, or the library would ignore the wheel from then on
          if (pressedAt !== undefined) mouse('mouseup', start, window);
          // the next run starts from the view this one started from, so the zoom is walked back by the steps it took
          const back = Math.round(previousLog / stepLog);
          for (let count = 0; count < Math.abs(back); count += 1) wheel(back > 0 ? -step : step);
          await settled();
          return { times, motion: { zoomRatio: zoomMax / zoomMin, panTravel } };
        },
        { duration: durationMs, samples: table, step: wheelStep, dragStart: DRAG_START, moveGap: POINTER_MOVE_GAP_MS, FIRST_MOVE_PX: FIRST_MOVE_PX, SETTLE_MS: SETTLE_MS },
      );
    },
  };
}

export function createProductDeps(): ProductDeps {
  return {
    async launchBrowser(): Promise<ProductBrowser> {
      const browser = await chromium.launch({ headless: false });
      return {
        name: 'chromium',
        version: browser.version(),
        async openPage(url, options) {
          const page = await browser.newPage({ viewport: VIEWPORT });
          if (options.cpuThrottle > 1) {
            const session = await page.context().newCDPSession(page);
            await session.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottle });
          }
          await page.goto(url);
          return productPage(page);
        },
        close: () => browser.close(),
      };
    },
    machine,
    now: () => new Date(),
    writeReport: writeProductReport,
    writeAddReport,
    writeLayoutReport,
  };
}
