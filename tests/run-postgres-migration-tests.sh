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

mapfile -t migrations < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)

for migration in "${migrations[@]}"; do
  echo "Applying $migration"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
done

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/postgres/entitlements.sql
