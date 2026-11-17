# docs

Public technical documentation.

- [install.md](install.md): install Community with Docker Compose on your own machine, keep it loopback-only, connect your Neo4j with a read-only login, rotate a login, set retention, upgrade and roll back.
- [technical-architecture.md](technical-architecture.md): how Neburyx is built: the gate, the schema mapping, the templates, the API, security, deployment and testing, with the decisions behind them.
- [unused-code.md](unused-code.md): find unused files, exports, types and dependencies with knip, and how to add an entry or an ignore.
- [run-locally.md](run-locally.md): run the whole app on your machine with one command, against your own Neo4j and Postgres.
- [mapping-guide.md](mapping-guide.md): write a mapping for your own Neo4j: every key, how to check it with `test-source`, what each check means, a worked example on the demo graph and what happens to saved investigations when a mapping changes.
- [coding-guidelines.md](coding-guidelines.md): how code is written here (TypeScript rules, comments, tests, API and web client).
- [architecture-checks.md](architecture-checks.md): the checks that fail the build (nothing outside the gate reaches the adapter; no domain words in code) and what they cannot see.
- [configuration.md](configuration.md): the deployment settings of the mapping file: how long deleted investigations and exports are kept, their ranges and what a refused value says.
- [pattern-definition.md](pattern-definition.md): the pattern definition: its fixed forms, the fan, time order and cycle, their limits and refusals, versions and what the checks prove.
- [aml-typologies.md](aml-typologies.md): the four AML typologies the banking pack ships as built-in definitions, their public basis, how to change them and what is not expressible yet.
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
- [benchmarks/](benchmarks/README.md): the supernode benchmark, an optional tool to run by hand (no release requires it): what it measures, how to run it and the last record.
