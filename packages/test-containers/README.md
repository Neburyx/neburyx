# packages/test-containers

How the tests and tools of this repository start a container with `testcontainers`.

- **`startWithRetry`.** testcontainers 12.2.1 waits a fixed 30 s for a container's host port to be
  bound and has no setting for it, so a stall of the Docker daemon fails a start with "Timed out
  after 30000ms while waiting for container ports to be bound to the host". `startWithRetry` starts
  again after exactly that error, up to three attempts in all, and throws every other error at
  once. Each attempt gets its own label, and the containers of a failed attempt are removed before
  the next one or before the error is thrown, so a failed attempt never keeps a host port. When that removal fails, nothing starts again and both errors are thrown.
- **Use.** Every container start goes through it: `startWithRetry((labels) => new XContainer(image).withLabels(labels).start())`.
  The architecture checks report a start outside it.
