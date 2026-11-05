# packages/test-neo4j

How the Neo4j tests of this repository reach a Neo4j server. They do not start a container: they run against a Neo4j
**Enterprise** server that you own, and they leave it as they found it.

## The connection

Three variables, from the environment or, for the ones not set there, from the file `~/.config/neburyx/dev-neo4j.env`
(one `NAME=value` per line, mode `0600`, outside the repositories):

| Variable | Is |
|---|---|
| `NBX_EE_URI` | the Bolt address of the server (`bolt://…` or `neo4j://…`) |
| `NBX_EE_USER` | the login the tests use |
| `NBX_EE_PASSWORD` | its password |

If one is missing, `pnpm test:neo4j` stops before the first test and says which. It never skips and never passes without
a server. The errors that leave this package carry the server's code and no address, user name or password, and nothing
prints them; a test, a driver or a tool that is given them could. A login whose name starts with `nbx_test_` is refused,
wherever the settings come from: that prefix marks what the tests create and clean up.

## What the login needs

The login must be able to create and drop databases, logins and roles on the server (the `admin` role does). The server
must be Neo4j Enterprise 5.26.

## What the tests create, and what they never touch

Each test file makes its own database, `nbx-test-<time>-<random>` (a database name cannot have an underscore), and
drops it when the file ends. A test that needs logins makes `nbx_test_<time>_<random>_reader` and `…_writer` logins, each
with a role of its own that reaches that database only, and drops them with the file. A sweep at the start of each file
drops the leftovers of a run that was killed: only databases, logins and roles named exactly so and made more than three
hours ago. Before a start it lists the databases, logins and roles of the server to find them, and it checks that a name
it is about to make is free; it reads nothing else, drops only what it made (an object counts as made once its CREATE has succeeded; one that
failed, whose answer may have been lost, is left for the sweep and the error says so) or a leftover named so, and
changes no setting of the server. A hook that starts more than one server, or a start that fails half way, leaves nothing behind
that the end of the file does not stop (`stopAllStarted`); a run that is killed leaves it for the next sweep. A stopped
server is a closed port of a loopback forwarder (`forwardTo`, which takes `bolt://`, `neo4j://` and the `+ssc`
forms, and reads a `neo4j://` address as the direct address of that one server), not a stopped container.

## What is no longer tested

The tests ran against containers of Neo4j 5.26 (Community) and 2026 in CI. They now run against the one server you
point them at, and not in CI: Neo4j 2026 and the Community edition are not tested, and neither is a server that is
read-only through its configuration or that is stopped and started again (a closed port and a database set to read only
stand in for them).
