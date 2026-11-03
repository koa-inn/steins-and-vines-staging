#!/usr/bin/env bash
# Cal.com local smoke test (Phase 25 staging-proof, run against a LOCAL middleware).
#
# Prereqs:
#   1. zoho-middleware/.env contains CALCOM_API_KEY, CALCOM_EVENT_TYPE_FERMENT_KIT,
#      CALCOM_EVENT_TYPE_BOTTLING, CALCOM_WEBHOOK_SECRET (plus the existing ZOHO_*,
#      API_SECRET_KEY, REDIS_URL).
#   2. The middleware is running locally:  cd zoho-middleware && node server.js
#   3. Zoho is authenticated locally (visit http://localhost:3001/auth/zoho once),
#      otherwise GET routes 401 and POST falls back to a fake PENDING- booking.
#
# Usage:
#   cd zoho-middleware
#   bash scripts/calcom-smoke.sh                # read-only checks + prints a POST template
#
# This script makes NO booking on its own. It runs the GET checks and prints a
# ready-to-edit curl for the POST so you stay in control of the real booking.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HERE/.env"
BASE="${BASE:-http://localhost:3001}"

if [ ! -f "$ENV_FILE" ]; then echo "ERROR: $ENV_FILE not found"; exit 1; fi

# Load only the keys we need, without echoing secrets.
API_KEY="$(grep -E '^API_SECRET_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
FERMENT_ID="$(grep -E '^CALCOM_EVENT_TYPE_FERMENT_KIT=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
BOTTLING_ID="$(grep -E '^CALCOM_EVENT_TYPE_BOTTLING=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"

if [ -z "${API_KEY:-}" ]; then echo "ERROR: API_SECRET_KEY missing from .env"; exit 1; fi
if [ -z "${FERMENT_ID:-}" ]; then echo "ERROR: CALCOM_EVENT_TYPE_FERMENT_KIT missing from .env"; exit 1; fi

echo "Base: $BASE"
echo "Ferment event-type id: $FERMENT_ID    Bottling event-type id: ${BOTTLING_ID:-<unset>}"
echo

echo "=== 0. Health ==="
curl -s "$BASE/health" | sed 's/.\{400\}/&\n/g' | head -3 || true
echo; echo

echo "=== 1. GET /api/bookings/services  (expect BOTH event types, staff:[]) ==="
curl -s "$BASE/api/bookings/services" | python3 -m json.tool 2>/dev/null || curl -s "$BASE/api/bookings/services"
echo

# Current month for availability (endpoint expects separate year + month params).
YEAR="$(date +%Y)"; MON="$(date +%m)"
echo "=== 2. GET /api/bookings/availability?year=$YEAR&month=$MON  (expect dates[].slots_count) ==="
curl -s "$BASE/api/bookings/availability?year=$YEAR&month=$MON" | python3 -m json.tool 2>/dev/null || curl -s "$BASE/api/bookings/availability?year=$YEAR&month=$MON"
echo

CAL_KEY="$(grep -E '^CALCOM_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
if [ -n "${CAL_KEY:-}" ]; then
  echo "=== 2b. Cal.com list bookings (read-only; HTTP code only, body holds customer emails) ==="
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://api.cal.com/v2/bookings?status=upcoming&limit=1" \
    -H "Authorization: Bearer $CAL_KEY" -H "cal-api-version: 2026-05-01" || true)"
  echo "list bookings (2026-05-01): HTTP $CODE"
  echo
fi

echo ">>> Pick an available YYYY-MM-DD from the dates above, then check its slots:"
echo "    curl -s \"$BASE/api/bookings/slots?date=YYYY-MM-DD\" | python3 -m json.tool"
echo

cat <<EOF
=== 3. When ready, make the REAL booking (this creates a Cal.com booking + sends the email) ===
Replace DATE, TIME (must be a slot from step 2), and EMAIL (an inbox you can check):

  curl -s -X POST "$BASE/api/bookings" \\
    -H "Content-Type: application/json" \\
    -H "x-api-key: \$(grep -E '^API_SECRET_KEY=' .env | cut -d= -f2- | tr -d '\"')" \\
    -d '{"date":"YYYY-MM-DD","time":"10:00 AM","customer":{"name":"Test Booking","email":"YOU@example.com","phone":"604-555-0100"},"notes":"Phase 25 Cal.com smoke test"}' \\
    | python3 -m json.tool

Expect: {"ok": true, "booking_id": "<cal uid>", "timeslot": "YYYY-MM-DD 10:00 AM"}

Then to also prove the BOTTLING type books (add "service":"bottling"):

  curl -s -X POST "$BASE/api/bookings" \\
    -H "Content-Type: application/json" \\
    -H "x-api-key: \$(grep -E '^API_SECRET_KEY=' .env | cut -d= -f2- | tr -d '\"')" \\
    -d '{"service":"bottling","date":"YYYY-MM-DD","time":"2:00 PM","customer":{"name":"Test Bottling","email":"YOU@example.com","phone":"604-555-0100"},"notes":"bottling type test"}' \\
    | python3 -m json.tool

VERIFY (the acceptance proof):
  - The booking appears in the Cal.com dashboard at the correct Squamish local time (NOT UTC-shifted).
  - The test inbox RECEIVES the Cal.com confirmation email.
  - booking_id is a Cal.com uid (not a PENDING-... value — PENDING means Zoho-offline intercepted it; authenticate Zoho and retry).
EOF
