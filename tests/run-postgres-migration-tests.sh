#!/usr/bin/env bash
set -euo pipefail

container_name="hookengine-postgres-migration-test"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull -f tests/postgres/Dockerfile -t hookengine-postgres-test .
docker run -d --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  -p 5432:5432 \
  hookengine-postgres-test >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker logs "$container_name"
    echo "PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 2
done

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/postgres/bootstrap.sql

migrations=(
  supabase/migrations/20261024155344_hookengine_usage_limits_history.sql
  supabase/migrations/20261024155721_revoke_hookengine_trigger_function_execute.sql
  supabase/migrations/20261024155837_backfill_hookengine_accounts.sql
  supabase/migrations/20261030224027_hookengine_platforms_provider_fallback.sql
  supabase/migrations/20261031000141_hookengine_revoke_unsafe_table_privileges.sql
  supabase/migrations/20261031000151_hookengine_revoke_anon_table_read.sql
  supabase/migrations/20261031004500_hookengine_plan_credits_entitlements.sql
  supabase/migrations/20261031083757_hookengine_usage_daily_reset.sql
  supabase/migrations/20261031084402_hookengine_reservation_limit_reset_messages.sql
  supabase/migrations/20261031090000_hookengine_usage_reporting_admin_entitlements.sql
  supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql
  supabase/migrations/20261031123000_hookengine_regeneration_cost_one_credit.sql
  supabase/migrations/20261031130000_hookengine_internal_accounts_admin_audit.sql
  supabase/migrations/20261031130500_hookengine_unpriced_generation_metric.sql
  supabase/migrations/20261031140000_hookengine_paypal_refund_reversal_events.sql
)

for migration in "${migrations[@]}"; do
  echo "Applying $migration"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
done

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/postgres/entitlements.sql
