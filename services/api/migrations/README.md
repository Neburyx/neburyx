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

## Running an older image against a newer database

After a rollback the database has applied migrations that the older image does not ship. `neburyx migrate`
accepts that: it treats the unshipped names as applied, applies only the shipped files that are still
pending, and prints `nothing to apply` when there are none. It never undoes a migration.

What it refuses, and why:

- **A shipped file that is not applied but sorts before an applied name** (shipped or not). It would run
  after migrations that, on every other database, run after it, so the schema could differ from a fresh
  install's. The run stops, names the file and applies nothing. Give the file a later name.

What it does not check:

- **How far back the image is.** The command cannot tell, so it accepts any number of unshipped names.
  Compatibility is promised only for the previous tag (see above); running an older image is unsupported
  even though the command does not refuse it.
- **Changed contents of an applied file.** The history stores only the name and the time, so an edited
  file is not detected. Never edit a released migration.

## When a run stops half-way

`neburyx migrate` applies your SQL files first, in one transaction, and then installs or upgrades the
job queue's own tables and the app role's rights. If the second part fails, the command exits 1
with "the job queue step failed after the application migrations were applied": your SQL files are
**already committed** and are not rolled back. Fix the cause and run the command again; it
applies only what is missing and does not run your migrations twice. The history tables stay closed
to the app role throughout.

## The enterprise migrations

When the AI preview is switched on (`NEBURYX_PROFILE=enterprise` together with `ai.preview: true` in the mapping file; `neburyx migrate` needs both, so it needs `NEBURYX_CONFIG` too), the command applies the migrations of the enterprise code last, after your SQL files and the job queue step. They are recorded in tables of their own, `kysely_migration_ee` and `kysely_migration_lock_ee`, closed to the app role like the others, so a new migration of the product never sorts before one already applied there. If an enterprise migration fails, the command exits 1 and names it; your SQL files and the job queue step of that run are **already committed** and stay applied, as are the enterprise migrations of earlier runs. An enterprise migration that is not applied yet but sorts before one that is applied is refused, as for the others. With the switch off the command ignores them and leaves their tables and history as they are.

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
