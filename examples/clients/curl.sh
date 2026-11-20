#!/bin/sh
# Nuonuo unified /v1 protocol with curl (docs/11-client-protocol.md).
#   ./curl.sh pair http://127.0.0.1:7420 K7QF-2M9D
#   NUONUO_URL=http://127.0.0.1:7420 NUONUO_ACCESS_TOKEN=nna_… ./curl.sh ask "明天要带伞吗？"
#   NUONUO_URL=… NUONUO_ACCESS_TOKEN=… ./curl.sh events
set -eu
cmd=${1:-}
case "$cmd" in
  pair)
    curl -sS -X POST "$2/v1/auth/pair/exchange" -H 'content-type: application/json' \
      -d "{\"code\":\"$3\",\"device\":{\"name\":\"${4:-curl}\",\"kind\":\"bot\"}}"
    echo ;;
  refresh)
    curl -sS -X POST "$2/v1/auth/refresh" -H 'content-type: application/json' \
      -d "{\"refreshToken\":\"$3\"}"
    echo ;;
  ask)
    auth="authorization: Bearer $NUONUO_ACCESS_TOKEN"
    body=$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
    id=$(curl -sS -X POST "$NUONUO_URL/v1/conversations/main/messages" -H "$auth" -H 'content-type: application/json' -d "$body" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["message"]["id"])')
    for _ in $(seq 1 80); do
      sleep 1.5
      reply=$(curl -sS "$NUONUO_URL/v1/conversations/main/messages?after=$id" -H "$auth" \
        | python3 -c 'import json,sys; m=[x for x in json.load(sys.stdin)["messages"] if x["role"]=="assistant" and x["text"].strip() and x.get("final", True)]; print(m[0]["text"] if m else "")')
      if [ -n "$reply" ]; then echo "$reply"; exit 0; fi
    done
    echo "等回复超时了" >&2; exit 1 ;;
  events)
    curl -sSN "$NUONUO_URL/v1/events" -H "authorization: Bearer $NUONUO_ACCESS_TOKEN" ;;
  *) echo "usage: $0 pair <url> <code> [name] | refresh <url> <refreshToken> | ask <text> | events" >&2; exit 2 ;;
esac
