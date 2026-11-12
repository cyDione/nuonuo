#!/bin/sh
# The client protocol with nothing but curl (docs/11-client-protocol.md).
#   ./curl.sh pair http://192.168.1.5:7420 K7QF-2M9D      → prints a token; keep it
#   NUONUO_URL=http://192.168.1.5:7420 NUONUO_DEVICE_TOKEN=nnd_… ./curl.sh ask "明天要带伞吗？"
#   NUONUO_URL=… NUONUO_DEVICE_TOKEN=… ./curl.sh events
set -eu
cmd=${1:-}
case "$cmd" in
  pair)
    curl -sS -X POST "$2/client/v1/pair" -H 'content-type: application/json' \
      -d "{\"code\":\"$3\",\"device\":{\"name\":\"${4:-curl}\",\"kind\":\"bot\"}}"
    echo ;;
  ask)
    auth="authorization: Bearer $NUONUO_DEVICE_TOKEN"
    body=$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
    id=$(curl -sS -X POST "$NUONUO_URL/client/v1/conversations/main/messages" -H "$auth" -H 'content-type: application/json' -d "$body" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["message"]["id"])')
    # Poll for the answer.
    for _ in $(seq 1 80); do
      sleep 1.5
      reply=$(curl -sS "$NUONUO_URL/client/v1/conversations/main/messages?after=$id" -H "$auth" \
        | python3 -c 'import json,sys; m=[x for x in json.load(sys.stdin)["messages"] if x["role"]=="assistant" and x["text"].strip() and x.get("final", True)]; print(m[0]["text"] if m else "")')
      if [ -n "$reply" ]; then echo "$reply"; exit 0; fi
    done
    echo "等回复超时了" >&2; exit 1 ;;
  events)
    curl -sSN "$NUONUO_URL/client/v1/events" -H "authorization: Bearer $NUONUO_DEVICE_TOKEN" ;;
  *) echo "usage: $0 pair <url> <code> [name] | ask <text> | events" >&2; exit 2 ;;
esac
