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

## Measure another canvas

The measurements run against the `RendererAdapter` interface in `src/adapter.ts`. To measure another canvas, implement the interface, register it with `registerAdapter(name, factory)` in `src/adapters/registry.ts`, and add its name to `ADAPTER_PACKAGES` in `src/adapters/names.ts` with the `package.json` files whose versions the report should record; the measurement code does not change.

## Tests

`pnpm --filter @neburyx/renderer-spike test` runs the unit tests (no browser). The browser measurements are run by hand with `spike`.
