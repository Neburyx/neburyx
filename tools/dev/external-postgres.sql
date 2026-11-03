-- The database and the two logins for running pnpm dev against a Postgres you already run.
-- Run it once, as a login that may create roles and databases, with the passwords as psql variables:
--   psql -v ON_ERROR_STOP=1 -v migration_password=... -v app_password=... -f tools/dev/external-postgres.sql
-- The migration login owns the database and is the only one that changes its schema; the app login is the one the API uses.
-- Needs Postgres 16 with the pg_trgm extension available (it is part of the standard contrib package); no superuser is needed afterwards.
CREATE ROLE neburyx_dev_migrate LOGIN PASSWORD :'migration_password';
CREATE ROLE neburyx_dev_app LOGIN PASSWORD :'app_password';
CREATE DATABASE neburyx_dev OWNER neburyx_dev_migrate;
