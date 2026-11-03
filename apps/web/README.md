# apps/web

The web client: React and TypeScript, built with Vite.

- `src/api/` is the only place that calls the API. It validates every answer with the schemas in `packages/contracts` and returns either a value or a named failure (`NETWORK_UNAVAILABLE`, `UNREADABLE_RESPONSE`, `SCHEMA_MISMATCH`, `ABORTED`, or the server's own error code with its trace ID). `useRequest` runs a read, keeps the data on screen when a later read fails, and ignores an answer that arrives after a newer one.
- `src/state/` keeps the four kinds of client state apart: server state (cached results), investigation state (the source and the element refs), presentation state (selection, positions, pins, panel sizes, viewport) and job state. The loaded graph is derived from the first two, never stored.
- `src/styles/` holds the design tokens and the base layout; no other stylesheet writes a colour or a size.
- `src/dev/` holds development tools that a production build leaves out: a page at `/dev/fixture` that reads the configured sources, lets you choose one and fills the client state with a synthetic graph drawn from that source's profile. The tools exist only when the build is not a production build (the `__DEV_TOOLS__` flag in `vite.config.ts`); a test builds for production and checks that none of them is in the output.

```bash
pnpm dev                              # the whole stack against the demo graphs (see docs/run-locally.md)
pnpm --filter @neburyx/web test       # unit and component tests
pnpm --filter @neburyx/web build      # type-check and build
```
