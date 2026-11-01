# Migrations

Plain SQL files that `neburyx migrate` applies to the database, in file-name order. The command
runs as the migration role (`DATABASE_MIGRATION_URL`); the API never holds that credential.

## Adding a migration

- Add a new `.sql` file whose name sorts **after** every existing one, for example
  `0003-describe-the-change.sql`. A file that sorts before an applied migration is refused: the run
  stops, names the file, and applies nothing.
- Write plain SQL. All pending files run as one batch in one transaction, so either all of them
  apply or none does.
- Migrations are **forward-only**. Fix a mistake with a new migration, never by editing one that has
  been released. There is no "down" step; a rollback is the previous image tag running against the
  newer schema (see below), or a database backup.
- A statement that cannot run inside a transaction (for example `CREATE INDEX CONCURRENTLY`) is not
  supported yet and fails the batch. When one is needed it will run in a separate, non-transactional
  step with its own session-level lock.

## Expand, then contract

A migration must stay compatible with the **previous image tag for one minor version**, so that
rolling back the image still works against the new schema. In practice:

1. **Expand.** In one release, add what the new code needs (a new column, table or index) and keep
   everything the old code uses.
2. **Contract.** In a later release, once the old code can no longer be running, remove what nothing
   uses any more.

Never rename or drop something in the same release that stops using it.

## When a run stops half-way

`neburyx migrate` applies your SQL files first, in one transaction, and then installs or upgrades the
job queue's own tables and the app role's rights. If the second part fails, the command exits 1
with "the job queue step failed after the application migrations were applied": your SQL files are
**already committed** and are not rolled back. Fix the cause and run the command again; it
applies only what is missing and does not run your migrations twice. The history tables stay closed
to the app role throughout.

## Rights on new tables

The first run gives the app role read and write rights on tables and sequences that the migration
role creates later, and records that it did so in a small `neburyx_setup` table. Later runs leave
those defaults alone, so if you narrow or remove them (for example `ALTER DEFAULT PRIVILEGES … REVOKE`),
the change stays.

## What the API can see of your migrations

The app role cannot read the migration history. `/readyz` still has to tell whether a migration is
pending, so the migration `0003-applied-migrations-function.sql` adds a function,
`public.applied_migrations()`, that returns only the names of the applied migrations; `neburyx migrate`
grants it to the app role. The API compares those names with the `.sql` files it ships, so a database
that has applied a newer migration (after rolling the image back one tag) is still ready.
