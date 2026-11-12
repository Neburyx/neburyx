# `ee/` migrations

SQL migrations for the tables of the `ee/` modules, applied by `neburyx migrate` only when the Enterprise and AI preview is switched on (both `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in the mapping file are set). They are recorded in a history table of their own, so a new migration of the Community product never sorts before one already applied here.

A file is named `NNNN-what-it-does.sql`, one statement list per file, in the order it must run. `0001-audit-events.sql` and `0002-ask-runs.sql` create the preview's audit table and the table of Ask runs.

## Rights

The first `neburyx migrate` gives the application role read and write rights on tables that the migration role creates later (see the "Rights on new tables" section of `services/api/migrations/README.md`). `audit_events` is append-only, so its migration takes `UPDATE`, `DELETE` and `TRUNCATE` away from every role but the owner, which leaves the application role with `INSERT` and `SELECT`. If you removed those default rights before the first migrate, the application role has no right on `audit_events` and the migration grants none: grant `INSERT` and `SELECT` on `audit_events` to the application role by hand.
