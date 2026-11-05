# tools/demo-graph

Builds a deterministic, synthetic demo graph from a domain pack and loads it into a demo Neo4j. It is a developer tool: it is not the adapter, nothing in the product may import it (a workspace check fails the build if it does), and the product's access to any source stays read-only. Synthetic data only.

A pack's `demo.yaml` describes its dataset: for each entity type of the pack's `neburyx.yaml` a count and a rule for each property, and for each relationship type one or more patterns (`random`, with optional supernodes, or `ring`). The tool holds no entity type, label or property name of its own.

```bash
pnpm demo-graph build --pack banking-fraud --uri bolt://localhost:7687
pnpm demo-graph generate --pack insurance-claims --seed 7 --out /tmp/insurance-export
pnpm demo-graph load --pack insurance-claims --dir /tmp/insurance-export --uri bolt://localhost:7687 --reset
```

`generate` writes the export files and a manifest (seed, counts, SHA-256 of each file); the same definition and seed give byte-identical files. `load` checks the export and loads it. `build` does both. Credentials come from the environment variables the pack's mapping names. Each command accepts only its own options and prints the usage otherwise.

The loader writes only to a demo database. It refuses, before connecting, a source not marked `synthetic: true`, an address (in the mapping or given with `--uri`) that is not a loopback address or a single-label host name, missing credential variables and a damaged export. After connecting and before any write it refuses a database that already holds nodes unless `--reset` is given.

`pnpm test` runs the unit tests; `pnpm test:neo4j` loads the shipped packs into a database of its own on a Neo4j Enterprise server that you own (see `packages/test-neo4j/README.md`), through a forwarder on the loopback address, which is the address the loader accepts.

A pack's `cases.yaml` holds its scripted cases and its preset investigation. Each case lists expectations about named nodes: the stable IDs or the number of the distinct neighbors along one relationship type in one direction, or the value of a property. The answers are written for the default seed of the pack's `demo.yaml`. The tool reads the file with the pack's mapping and demo definition and refuses a name that either does not have; the tests check that every named node is in the export and that the loaded graph gives each answer by a count query.

`pnpm demo-graph combine --packs banking-fraud,insurance-claims --out <file>` writes one mapping file holding the source of each pack, read from the packs' own mapping files (a pack must hold exactly one source, and two packs may not repeat a source ID). The demo compose file uses it to give the API one mapping file without keeping a copy of any pack.
