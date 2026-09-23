#!/usr/bin/env bash
# Phase 82 (82-09 Task 1) — non-mutating Apps Script probes.
# Usage: APPS_SCRIPT_URL=... SERVER_TOKEN=... PROBE_SKU=... PROBE_SO=... bash scripts/phase82-appsscript-probes.sh
# Prints only ok/error fields — never the token or row data.
set -u
: "${APPS_SCRIPT_URL:?set APPS_SCRIPT_URL}" "${SERVER_TOKEN:?set SERVER_TOKEN}"
# Strip whitespace/newlines (pbpaste / copied values often carry a trailing newline).
SERVER_TOKEN=$(printf '%s' "$SERVER_TOKEN" | tr -d '[:space:]')
APPS_SCRIPT_URL=$(printf '%s' "$APPS_SCRIPT_URL" | tr -d '[:space:]')
echo "token length: ${#SERVER_TOKEN}; url ends: …${APPS_SCRIPT_URL: -12}"

summarize() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=j.data&&j.data.values;console.log(JSON.stringify({ok:j.ok,error:j.error||null,message:j.message?String(j.message).slice(0,120):undefined,firstRow:v&&v[0]?v[0].slice(0,4):undefined,allStrings:v?v.every(r=>r.every(c=>typeof c==="string")):undefined}))}catch(e){console.log("NON-JSON:",s.slice(0,120).replace(/\s+/g," "))}})'
}
get()  { curl -sLG --data-urlencode "action=$1" --data-urlencode "server_token=$SERVER_TOKEN" "$APPS_SCRIPT_URL" | summarize; }
post() { curl -sL -H 'Content-Type: text/plain' --data "$1" "$APPS_SCRIPT_URL" | summarize; }

echo "1 get_ingredients (expect ok:true, header row):";      get get_ingredients
echo "2 get_homepage (expect ok:true, allStrings:true):";     get get_homepage
echo "3 get_config (expect invalid_action):";                 get get_config
echo "4 update_hold dispatch (expect NOT 'Unknown server action'):"
post "{\"action\":\"update_hold\",\"server_token\":\"$SERVER_TOKEN\",\"holdId\":\"H-00000000-X000\",\"updates\":{}}"
echo "5 update_inventory_cells sheet=Holds (expect invalid_sheet):"
post "{\"action\":\"update_inventory_cells\",\"server_token\":\"$SERVER_TOKEN\",\"sheet\":\"Holds\",\"updates\":[]}"
echo "6 update_schedule_slots empty (expect invalid_updates):"
post "{\"action\":\"update_schedule_slots\",\"server_token\":\"$SERVER_TOKEN\",\"updates\":[]}"
echo "7 update_kits (expect Unknown server action / invalid_action):"
post "{\"action\":\"update_kits\",\"server_token\":\"$SERVER_TOKEN\"}"
if [ -n "${PROBE_SKU:-}" ] && [ -n "${PROBE_SO:-}" ]; then
  echo "8 create_batch duplicate SO (expect duplicate_so_number, nothing created):"
  post "{\"action\":\"create_batch\",\"server_token\":\"$SERVER_TOKEN\",\"product_sku\":\"$PROBE_SKU\",\"customer_name\":\"probe\",\"zoho_so_number\":\"$PROBE_SO\",\"unit_total\":1}"
else
  echo "8 skipped — set PROBE_SKU and PROBE_SO to an existing batch's SKU and invoice/SO number"
fi
echo "9 manual: load the CURRENT production admin dashboard and confirm a read works"
