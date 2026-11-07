# docs

Public technical documentation. Pre-release placeholder: the technical architecture will be published here once it has been reviewed for publication.

- [run-locally.md](run-locally.md): bring the whole app up on your machine with one command, against the demo graphs.
- [coding-guidelines.md](coding-guidelines.md): how code is written here (TypeScript rules, comments, tests, API and web client).
- [architecture-checks.md](architecture-checks.md): the checks that fail the build (nothing outside the gate reaches the adapter; no domain words in code) and what they cannot see.
- [api-conventions.md](api-conventions.md): the rules every endpoint follows: pagination, field limits, idempotency keys, concurrency and the permission each route declares.
- [benchmarks/](benchmarks/README.md): the supernode benchmark, what it measures, how to run it and the last record.
