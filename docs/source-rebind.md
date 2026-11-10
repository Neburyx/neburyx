# A source pointed at another database

A source is a name in the mapping file. If someone points that name at another URI or another database, the investigations made against the old connection must not quietly show another graph. Each investigation stores a hash of the connection it was made on (the connector, the URI and the database; nothing else, and never the address itself).

## What a person sees

- **The source now points at another database.** Its investigations open read-only on their saved layout. Each saved item is drawn where it was, as a placeholder that says "Saved layout · not read"; nothing is read from the source for them, and no search, expansion or evidence read runs while one is open. The banner says an operator must confirm the change.
- **The source is no longer in the mapping.** Its investigations open the same way, with a banner that says so, and the owner can delete the investigation.
- Both states are listed with a "Source re-pointed" or "Source removed" pill on the Investigations page and on Home. Opening a referral again finds the same read-only investigation of a re-pointed source until the operator confirms the change; a removed source answers not found, as any source that is not configured does.
- Draft writes, renames, saving a view, restoring one, renaming one and deleting one are refused with `CONFLICT` and the reason `source-changed` (`details.sourceState` is `repointed` or `removed`). Opening, closing, archiving, reopening and deleting still work, since none of them reads the source or writes the draft.

## Confirming the change

When the new connection is the right one, an operator confirms it with one command, after testing it:

```bash
neburyx test-source --name <source>
neburyx source rebind <source> --confirm <source>
```

On a terminal the command asks for the source ID again instead of taking `--confirm`. It needs the same `DATABASE_URL` and `NEBURYX_CONFIG` as `test-source`. It does the following, in one database transaction, and refuses without writing anything when a step does not hold:

1. The ID is exactly one source of the mapping file, and the database holds it as an active source (no other case, no prefix).
2. The source row of the database holds the connection hash that the mapping has now, which means the API has started since the change and synced it.
3. A stored check that reached the source on this connection exists, so `test-source` (or the Sources page) has run against the new connection.

Then it sets the stored hash of every investigation of that source to the new one and prints the source ID and how many it changed. It reads nothing from the source, prints no address, login, database name or hash, and writes nothing else. There is no endpoint for it. Running it again changes nothing.

A hash cannot prove that two databases hold the same graph. The command asks the operator to retype the ID and to have tested the new connection; the decision that the new database is the same source stays with the operator.
