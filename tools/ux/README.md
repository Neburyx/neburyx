# UX tests

Browser tests of the web app: Playwright with Chromium, at 1440 × 900 and 1280 × 720, on a **built** copy of `apps/web` served by a small support server (`src/support-server.ts`) that answers the few API reads the pages make with synthetic bodies. No database, no Neo4j, no Docker.

From a fresh checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @neburyx/web build:ux
pnpm --filter @neburyx/renderer-spike build:node
pnpm --filter @neburyx/ux-tests exec playwright install chromium
pnpm test:ux
```

`pnpm build` makes the production build in `apps/web/dist`; `build:ux` makes a second build (`apps/web/dist-ux`, mode `ux`) that carries the development pages and the canvas read-out the tests read. With an installed Chrome, set `NEBURYX_UX_CHROME` to its executable instead of installing Chromium.

The specs that switch source, follow deep links or use Home run against a third copy of the support server on port 4175, which lists a second source (`claims-demo`, the same profile under another ID) and a third that it lists but refuses the person (`restricted-demo`) beside the first; the other two servers list one. Every source it lists is connected and never tested until a spec changes it: `POST /__support/sources` takes a map of source ID to the fields of `GET /v1/sources` to change (`state`, `stateReason`, `lastTest`, `lastTestAt`, `mappingSummary`; each call replaces every earlier change, including a last test stored by a test run, and an unknown source or an invalid field is refused with 400 and changes nothing), `POST /v1/sources/{id}/test` answers a passing report and stores it as the source's last test, `POST /__support/hold-after-test` makes the `GET /v1/sources` that follows a test wait until `POST /__support/release`, and `POST /__support/reset` puts everything back (a spec that changes sources resets before and after). Like the application's own server it serves the page for every address that is not a file, and treats only `/v1`, what is under `/v1/` and the two probe paths as the API.

`fixtures/profile.json` is the synthetic source profile the pages read: the banking pack's, as the API's profile builder makes it. `pnpm --filter @neburyx/ux-tests check:profile` (after `pnpm build`) fails when it is out of date; `node tools/ux/scripts/make-profile.mjs` rewrites it.

## Checking that a test can fail

`pnpm --filter @neburyx/ux-tests mutate [keyboard|crossing|benchmark]` breaks the built app on purpose and runs the browser test that has to notice, three times: as it is, with the app broken, and with the source put back; it fails unless the first and last runs pass and the middle one fails on the test's own assertion. `keyboard` breaks the Legend key binding, `crossing` puts a 400 ms stall in the switch of the zoomed-out view (held to the runner limit, `NEBURYX_UX_PROFILE=runner`), and `benchmark` puts a 25 ms stall at every pan and zoom (held to the runner threshold). Each rebuilds `dist-ux` and puts the source back, also when it is interrupted.
