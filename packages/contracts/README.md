# packages/contracts

Shared definitions for the API and its clients, as Zod schemas, and the `openapi.json` generated
from them.

- **Error model.** The error codes, one fixed message, HTTP status and `retryable` flag per code, the
  allowed `details` fields per code, and the `ErrorResponse` schema (`{ error: { code, message,
  retryable, traceId, details? } }`). The schema fixes each code's message, flag and details, so a
  response with other text or fields does not validate.
- **`openapi.json`.** An OpenAPI 3.1 document built from the schemas. It has no endpoints yet.
  Regenerate it with `pnpm --filter @neburyx/contracts generate` after changing a schema; the
  contract test fails if the committed file differs from what the schemas generate.
- **Use.** The package is built before it is imported: the root `typecheck` and `test` scripts do
  this first.
