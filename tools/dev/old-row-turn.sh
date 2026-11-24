#!/bin/sh
# Makes the newest turn of an investigation's thread an old row (see old-row-turn.sql), in a database of your own whose name starts with nbx_test_.
# usage: old-row-turn.sh <settings file> <investigation id>
# The migration login is read from the settings file (NEBURYX_DEV_DATABASE_MIGRATION_URL) and goes to psql through the environment; nothing of it is printed.
set -eu
[ "$#" -eq 2 ] || { echo "usage: old-row-turn.sh <settings file> <investigation id>" >&2; exit 2; }
settings=$1
investigation=$2
case "$investigation" in
  *[!0-9a-fA-F-]*) echo "the investigation id is a uuid" >&2; exit 2 ;;
esac
[ -r "$settings" ] || { echo "the settings file cannot be read" >&2; exit 2; }
url=$(sed -n 's/^NEBURYX_DEV_DATABASE_MIGRATION_URL=//p' "$settings" | tr -d "\"'" | head -n 1)
[ -n "$url" ] || { echo "the settings file has no migration login" >&2; exit 2; }
database=${url##*/}
database=${database%%\?*}
case "$database" in
  nbx_test_*) ;;
  *) echo "refused: the database is not a nbx_test_ database" >&2; exit 1 ;;
esac
here=$(cd "$(dirname "$0")" && pwd)
changed=$(psql "$url" -v ON_ERROR_STOP=1 -v "investigation=$investigation" -f "$here/old-row-turn.sql" | tr -d '\n')
echo "old row made: $changed in $database"
