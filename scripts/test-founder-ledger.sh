#!/bin/sh
# Disposable synthetic PostgreSQL, Unix socket only. Never starts the application.
set -eu
GOS_BACKEND_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GOS_TEST_ROOT=$(mktemp -d /tmp/gos-ledger-XXXXXX)
export LC_ALL=C
trap 'pg_ctl -D "$GOS_TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true' EXIT
initdb -D "$GOS_TEST_ROOT/data" -U gos_test -A trust --no-locale >/dev/null
pg_ctl -D "$GOS_TEST_ROOT/data" -l "$GOS_TEST_ROOT/server.log" -o "-k $GOS_TEST_ROOT -p 55439 -h ''" start >/dev/null
GOS_LEDGER_TEST_SOCKET="$GOS_TEST_ROOT" node --test "$GOS_BACKEND_ROOT/tests/revenuecat-ledger.cjs"
