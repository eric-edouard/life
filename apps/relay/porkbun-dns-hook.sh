#!/bin/sh
# OpenTunnel's DNS_HOOK for a zone at Porkbun: `<hook> create|delete <name> <value>` (its docs/server.md, "Self-hosting").
# Idempotent both ways; needs ZONE, PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY (a key scoped to DNS on ZONE).
set -eu
action=$1 name=$2 value=$3
sub=${name%."$ZONE"}
api=https://api.porkbun.com/api/json/v3
auth="{\"apikey\":\"$PORKBUN_API_KEY\",\"secretapikey\":\"$PORKBUN_SECRET_API_KEY\""
call() { curl -fsS -X POST "$api/$1" -H 'Content-Type: application/json' -d "$auth$2}"; }
# The id of the TXT record at $sub holding exactly $value, if any.
existing=$(call "dns/retrieveByNameType/$ZONE/TXT/$sub" "" | jq -r --arg v "$value" '.records[]? | select(.content == $v) | .id' | head -n1)
case "$action" in
  create) [ -n "$existing" ] || call "dns/create/$ZONE" ",\"name\":\"$sub\",\"type\":\"TXT\",\"content\":\"$value\",\"ttl\":\"600\"" >/dev/null ;;
  delete) [ -z "$existing" ] || call "dns/delete/$ZONE/$existing" "" >/dev/null ;;
  *) exit 2 ;;
esac
