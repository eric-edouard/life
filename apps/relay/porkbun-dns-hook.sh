#!/bin/sh
# OpenTunnel's DNS_HOOK for a zone at Porkbun: `<hook> create|delete <name> <value>` (its docs/server.md, "Self-hosting").
# Idempotent both ways; needs ZONE, PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY (a key scoped to DNS on ZONE).
set -eu
action=$1 name=$2 value=$3
sub=${name%."$ZONE"}
api=https://api.porkbun.com/api/json/v3
# POSTs $1 with the keys and the fields in $2 (a JSON object); fails unless Porkbun answers SUCCESS.
call() {
  body=$(jq -cn --arg k "$PORKBUN_API_KEY" --arg s "$PORKBUN_SECRET_API_KEY" --argjson f "$2" '$f + {apikey: $k, secretapikey: $s}')
  reply=$(curl -fsS -X POST "$api/$1" -H 'Content-Type: application/json' -d "$body")
  printf '%s' "$reply" | jq -e '.status == "SUCCESS"' >/dev/null
  printf '%s' "$reply"
}
# The id of the TXT record at $sub holding exactly $value, if any.
records=$(call "dns/retrieveByNameType/$ZONE/TXT/$sub" '{}')
existing=$(printf '%s' "$records" | jq -r --arg v "$value" '.records[]? | select(.content == $v) | .id' | head -n1)
case "$action" in
  create) [ -n "$existing" ] || call "dns/create/$ZONE" "$(jq -cn --arg n "$sub" --arg v "$value" '{name: $n, type: "TXT", content: $v, ttl: "600"}')" >/dev/null ;;
  delete) [ -z "$existing" ] || call "dns/delete/$ZONE/$existing" '{}' >/dev/null ;;
  *) exit 2 ;;
esac
