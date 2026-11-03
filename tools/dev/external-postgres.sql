-- See docs/run-locally.md. Run it with psql, as a login that has CREATEROLE and CREATEDB (or is a superuser), with the passwords as variables:
--   psql -v ON_ERROR_STOP=1 -v migration_password=... -v app_password=... -f tools/dev/external-postgres.sql
CREATE ROLE neburyx_dev_migrate LOGIN PASSWORD :'migration_password';
CREATE ROLE neburyx_dev_app LOGIN PASSWORD :'app_password';
GRANT neburyx_dev_migrate TO CURRENT_USER WITH SET TRUE;
CREATE DATABASE neburyx_dev OWNER neburyx_dev_migrate;
