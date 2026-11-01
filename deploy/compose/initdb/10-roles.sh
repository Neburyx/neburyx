#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migration_password="$NEBURYX_DB_MIGRATION_PASSWORD" \
  -v app_password="$NEBURYX_DB_APP_PASSWORD" <<'SQL'
CREATE ROLE neburyx_migrate LOGIN PASSWORD :'migration_password';
CREATE ROLE neburyx_app LOGIN PASSWORD :'app_password';
CREATE DATABASE neburyx OWNER neburyx_migrate;
SQL
