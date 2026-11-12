# `ee/` migrations

SQL migrations for the tables of the `ee/` modules, applied by `neburyx migrate` only when the Enterprise and AI preview is switched on (both `NEBURYX_PROFILE=enterprise` and `ai.preview: true` in the mapping file are set). They are recorded in a history table of their own, so a new migration of the Community product never sorts before one already applied here.

There is none yet. A file is named `NNNN-what-it-does.sql`, one statement list per file, in the order it must run.
