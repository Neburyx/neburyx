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

### Adding entities

`--scenario add` (with `--target product`) measures what the pan and zoom run does not: the frames while 25 entities are added to the 300-element fixture.

```bash
pnpm --filter @neburyx/renderer-spike spike --target product --scenario add --url http://127.0.0.1:5173 --out add-4x.json --cpu-throttle 4
```

- It needs the same development build. Each of its three runs opens a page of its own, loads the fixture, opens Explore and checks that the renderer reports 300 drawn elements with no failure notice and ink on the canvas.
- A run records frame times from just before it presses the development control "Add 25 entities" (a button on the canvas of a development build, which loads 25 more entities, each joined to one that is loaded), after marking where the renderer drew every entity. It waits for the add to be drawn and for 30 frames after it, without navigating or reloading.
- Before a run's figures are accepted it checks that the drawn entities rose by exactly 25 and the drawn relationships by exactly 25, that the mark held every entity drawn before the add and that none of them, pinned or not, is drawn elsewhere afterwards (a redraw that changes nothing does not hide an earlier move), that no failure notice shows and that the frame times rise strictly with at least 30 frames after the add.
- The report has, per run, the longest frame from the press to the end of the 30 frames after the add, and the median and 5th-percentile frame rate over those 30 frames. The target (recorded with the renderer decision) is no frame longer than 100 ms and at least 30 fps at the 5th percentile, with the CPU slowed 4x; below 4x the figures are recorded with no verdict.
- A failed check, an add that drew nothing or only part, a moved entity, invalid frames, an unreachable app, a step that does not answer in time or a browser that does not close makes the command exit non-zero, name the cause and write no report.

### Laying the graph out again

`--scenario layout` (with `--target product`) measures the explicit layout run on the same 300-element fixture.

```bash
pnpm --filter @neburyx/renderer-spike spike --target product --scenario layout --url http://127.0.0.1:5173 --out layout-4x.json --cpu-throttle 4
```

- Each of its three runs opens a page of its own and loads the fixture, as the add scenario does. It presses the development control "Displace 10 entities" (ten unpinned entities are put far from the rest through the store function a drag uses), marks where every entity is drawn, records frame times from just before it presses the layout control and chooses Force, and records how long the command itself took.
- Before a run's figures are accepted it checks that no failure notice shows, that the drawn counts are the fixture's and unchanged, that the mark held every entity, that no pinned entity is drawn elsewhere, that at least the ten displaced entities moved, that the zoom and pan are exactly as before and that the frame times are valid.
- The report has, per run, the unpinned entities that moved, the command's time, the longest frame and the median and 5th-percentile frame rate over the 30 frames after the run. The target is the add's: no frame longer than 100 ms and at least 30 fps at the 5th percentile with the CPU slowed 4x; below 4x the figures are recorded with no verdict.

## Measure another canvas

The measurements run against the `RendererAdapter` interface in `src/adapter.ts`. To measure another canvas, implement the interface, register it with `registerAdapter(name, factory)` in `src/adapters/registry.ts`, and add its name to `ADAPTER_PACKAGES` in `src/adapters/names.ts` with the `package.json` files whose versions the report should record; the measurement code does not change.

## Tests

`pnpm --filter @neburyx/renderer-spike test` runs the unit tests (no browser). The browser measurements are run by hand with `spike`.
