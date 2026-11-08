# docs

Public technical documentation. Pre-release placeholder: the technical architecture will be published here once it has been reviewed for publication.

- [run-locally.md](run-locally.md): run the whole app on your machine with one command, against your own Neo4j and Postgres.
- [coding-guidelines.md](coding-guidelines.md): how code is written here (TypeScript rules, comments, tests, API and web client).
- [architecture-checks.md](architecture-checks.md): the checks that fail the build (nothing outside the gate reaches the adapter; no domain words in code) and what they cannot see.
- [api-conventions.md](api-conventions.md): the rules every endpoint follows: pagination, field limits, idempotency keys, concurrency and the permission each route declares.
- [cancellation.md](cancellation.md): what happens when a request is cancelled, what is not promised, what was tested and what was not verified.
- [query-timeout.md](query-timeout.md): the limit on every read, what a timed-out request answers and shows, what was measured and what was not verified.
- [fuzz-suite.md](fuzz-suite.md): the input fuzz suite, what it proves about statement text and refusals, a recorded run and how to replay a failure.
- [circuit-breaker.md](circuit-breaker.md): the rule that stops a source being asked when its reads keep timing out, how it recovers, what a person sees and the three settings.
- [benchmarks/](benchmarks/README.md): the supernode benchmark, what it measures, how to run it and the last record.
