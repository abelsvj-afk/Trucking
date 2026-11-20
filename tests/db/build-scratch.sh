#!/usr/bin/env bash
# Build a disposable database from EVERY migration, in order (audit F-010),
# then run every SQL test in tests/db against it. Local Postgres 15+ only;
# never point this at the live project.
#   bash tests/db/build-scratch.sh [dbname]     (default: scratch_all)
# The one replay tweak: roles are cluster-wide, so a rebuild in the same
# cluster tolerates an existing industry_briefing_job role (00008 creates it).
set -u
cd "$(dirname "$0")/../.."
DB=${1:-scratch_all}
dropdb --if-exists "$DB" && createdb "$DB" || exit 1
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f tests/db/scratch-supabase-stub.sql -f tests/db/scratch-supabase-defaults.sql >/dev/null || exit 1
fail=0
for f in supabase/migrations/*.sql; do
  sql=$(sed "s/^create role industry_briefing_job with login noinherit;/do \$r\$ begin if not exists (select from pg_roles where rolname = 'industry_briefing_job') then create role industry_briefing_job with login noinherit; end if; end \$r\$;/" "$f")
  if ! out=$(printf '%s\n' "$sql" | psql -d "$DB" -1 -q -v ON_ERROR_STOP=1 2>&1); then
    echo "MIGRATION FAILED $(basename "$f"): $(echo "$out" | grep ERROR | head -1)"; fail=1
  fi
done
echo "built $DB from $(ls supabase/migrations/*.sql | wc -l) migrations"
[ "$fail" = 0 ] || exit 1
psql -d "$DB" -q -f tests/db/scratch-auth-shim.sql >/dev/null
for t in tenant-fk rls-isolation anon-privileges outbound-call-claim bot-spend-reservation business-credit-owner-only driver-positions documents-trigger pool-role-grants email-tables; do
  if out=$(psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "tests/db/$t.sql" 2>&1); then echo "PASS $t"; else echo "FAIL $t: $(echo "$out" | grep ERROR | head -1)"; fail=1; fi
done
exit $fail
