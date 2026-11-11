# docs

Public technical documentation.

- [technical-architecture.md](technical-architecture.md): how Neburyx is built: the gate, the schema mapping, the templates, the API, security, deployment and testing, with the decisions behind them.
- [run-locally.md](run-locally.md): run the whole app on your machine with one command, against your own Neo4j and Postgres.
- [coding-guidelines.md](coding-guidelines.md): how code is written here (TypeScript rules, comments, tests, API and web client).
- [architecture-checks.md](architecture-checks.md): the checks that fail the build (nothing outside the gate reaches the adapter; no domain words in code) and what they cannot see.
- [configuration.md](configuration.md): the deployment settings of the mapping file: how long deleted investigations and exports are kept, their ranges and what a refused value says.
- [api-conventions.md](api-conventions.md): the rules every endpoint follows: pagination, field limits, idempotency keys, concurrency and the permission each route declares.
- [cancellation.md](cancellation.md): what happens when a request is cancelled, what is not promised, what was tested and what was not verified.
- [query-timeout.md](query-timeout.md): the limit on every read, what a timed-out request answers and shows, what was measured and what was not verified.
- [filtered-expansion.md](filtered-expansion.md): filtering and ranking an expansion by the properties a mapping declares, the operators, the count, what masking does and what it costs.
- [fuzz-suite.md](fuzz-suite.md): the input fuzz suite, what it proves about statement text and refusals, a recorded run and how to replay a failure.
- [circuit-breaker.md](circuit-breaker.md): the rule that stops a source being asked when its reads keep timing out, how it recovers, what a person sees and the three settings.
- [source-rebind.md](source-rebind.md): what a person sees when a source name is pointed at another database or removed, and how an operator confirms the change with `neburyx source rebind`.
- [source-state.md](source-state.md): which stored check decides the state a source shows when several API copies run, and what stays different between copies.
- [concurrency.md](concurrency.md): the read-slot, request-rate and breaker limits with their numbers, and what the concurrency suite proves about them.
- [layouts.md](layouts.md): the layouts, the Physics switch, how a pinned entity is treated, the limits of live physics and what was measured.
- [benchmarks/](benchmarks/README.md): the supernode benchmark, what it measures, how to run it and the last record.
