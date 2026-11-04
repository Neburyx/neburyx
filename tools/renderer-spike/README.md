# Renderer spike

A small harness that draws the same synthetic graph with Cytoscape.js and with Sigma.js and measures what the product needs to know before it picks a graph renderer: frame rate during pan and zoom, how far existing nodes move when nodes are added, grouping, keyboard access, licence and bundle size. Nothing in `apps/web` or `services/api` imports it.

## The fixture

`src/fixture` generates a seeded graph of 300 drawn elements: nodes and relationships (sourced, derived and one aggregate relationship with a member count), one supernode with a neighbor aggregate node whose total is a lower bound of 3,000, and no node for those 3,000 neighbors. Names are neutral (`type-a`, `rel-a`); the data is synthetic.

## Run it

```bash
pnpm --filter @neburyx/renderer-spike dev        # the harness page: ?adapter=cytoscape or ?adapter=sigma
pnpm --filter @neburyx/renderer-spike spike --adapter cytoscape --out report.json --screenshots ./shots
pnpm --filter @neburyx/renderer-spike spike --adapter cytoscape --cpu-throttle 4 --out report-4x.json
pnpm --filter @neburyx/renderer-spike bundle-size
```

`spike` builds the page, opens it in headed Chromium (Playwright; run `npx playwright install chromium` once), and:

1. runs a scripted pan and zoom for 10 s, three times, and records the median and 5th-percentile frame rate;
2. groups the nodes of one entity type, takes a screenshot and ungroups them;
3. presses a fixed sequence of keys and records the focus, the focus ring and the activation after each press;
4. places 20 nodes by hand, fixes them and 10 more, adds 25 nodes through the adapter's own layout and records how many nodes of each kind moved (any change of either coordinate counts) and by how much, how long the add blocked the page, the longest frame and the frame rate over the next 30 frames.

`--cpu-throttle n` slows the browser's CPU by that factor (a whole number of at least 1) to stand in for a weaker machine; the factor is recorded in the report.

The report is written once, after everything finished and the browser and server closed cleanly; if anything fails, or a step does not answer within its deadline, the command exits non-zero, names the cause and writes no file. It records the browser, the OS, the CPU and the viewport, so a number always says where it came from.

## Measure the product's canvas

`--target product` measures the web app's own canvas instead of a spike adapter: pan and zoom at 300 drawn elements (the development fixture: 120 entities and 180 relationships), against the frame-rate target recorded with the renderer decision.

```bash
pnpm dev                                    # or any development build of apps/web that is already running
pnpm --filter @neburyx/renderer-spike spike --target product --url http://127.0.0.1:5173 --out report-4x.json --cpu-throttle 4
```

- It needs a running **development** build of the app (the fixture loader and the canvas read-out are development-only, so a production build cannot be measured) and the same Chromium as the adapter runs.
- It opens `<url>/dev/fixture`, loads the fixture through the app's own loader, opens Explore and checks, before any figure is taken, that the renderer itself reports 300 drawn elements, that no failure notice is shown, that the canvas is not blank, that one real wheel step zooms by a factor between 1.02 and 2 and the opposite step brings the zoom back to within 1 %, and that one real drag moves the renderer's pan by the drag distance and changes the picture.
- It then runs the harness's scripted pan and zoom three times for 10 s, sent to the canvas as mouse and wheel events dispatched in the page. The library ignores the wheel while a button is held and throttles pointer moves, so a drag is a press with a first move past its drag threshold, the move that matters 25 ms later and a release, and the zoom follows the script in separate frames, in whole wheel steps calibrated against one step; the pan is read at the start of the next frame and counted only after a drag, so zoom anchoring is never counted as pan, and the zoom is walked back at the end of each run. A run fails if the zoom did not change by at least 1.2 times or the pan the drags made is under 200 px; both figures are in the report.
- The report records the browser, the OS, the CPU, the viewport (1280 x 720), the throttle, the per-run median and 5th-percentile frame rate, the target (median at least 55 fps and 5th percentile at least 30 fps with the CPU slowed 4x) and a verdict: `met`, `not-met`, or `not-applicable` for a run with less than 4x throttle.
- A failed check, an unreachable app, a step that does not answer in time or a browser that does not close makes the command exit non-zero, name the cause and write no report. The report file appears all at once or not at all.
- It is run by hand on the recorded laptop; a run for CI is a separate piece of work.

## Measure another canvas

The measurements run against the `RendererAdapter` interface in `src/adapter.ts`. To measure another canvas, implement the interface, register it with `registerAdapter(name, factory)` in `src/adapters/registry.ts`, and add its name to `ADAPTER_PACKAGES` in `src/adapters/names.ts` with the `package.json` files whose versions the report should record; the measurement code does not change.

## Tests

`pnpm --filter @neburyx/renderer-spike test` runs the unit tests (no browser). The browser measurements are run by hand with `spike`.
