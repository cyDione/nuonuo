"""A minimal Python client for Nuonuo's client protocol v1 (docs/11-client-protocol.md). Standard library only, so it
runs on a Raspberry Pi, in Home Assistant's python_script, or anywhere with Python 3.8+.

    python3 nuonuo_client.py pair http://192.168.1.5:7420 K7QF-2M9D 客厅音箱 speaker   # prints the token
    NUONUO_URL=http://192.168.1.5:7420 NUONUO_DEVICE_TOKEN=nnd_… python3 nuonuo_client.py ask "明天要带伞吗？"
    NUONUO_URL=… NUONUO_DEVICE_TOKEN=… python3 nuonuo_client.py events
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid


class NuonuoError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def _request(method, url, token=None, body=None, timeout=30):
    headers = {"accept": "application/json"}
    data = None
    if token:
        headers["authorization"] = f"Bearer {token}"
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            text = res.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode())["error"]
        except Exception:
            err = {"code": "http", "message": f"HTTP {e.code}"}
        raise NuonuoError(e.code, err.get("code"), err.get("message")) from None


class NuonuoClient:
    def __init__(self, base_url, token):
        self.base = base_url.rstrip("/") + "/client/v1"
        self.token = token

    @staticmethod
    def pair(base_url, code, name, kind="other", display=None):
        device = {"name": name, "kind": kind}
        if display:
            device["display"] = display
        return _request("POST", base_url.rstrip("/") + "/client/v1/pair", body={"code": code, "device": device})

    def hello(self):
        return _request("GET", self.base + "/hello", self.token)

    def messages(self, conversation="main", after=None, limit=50):
        q = f"?limit={limit}" + (f"&after={after}" if after else "")
        return _request("GET", f"{self.base}/conversations/{conversation}/messages{q}", self.token)["messages"]

    def send(self, text, conversation="main", client_id=None):
        body = {"text": text, "clientId": client_id or str(uuid.uuid4())}
        return _request("POST", f"{self.base}/conversations/{conversation}/messages", self.token, body)["message"]

    def ask(self, text, conversation="main", timeout=120):
        sent = self.send(text, conversation)
        cursor, deadline = sent["id"], time.time() + timeout
        while time.time() < deadline:
            time.sleep(1.5)
            new = self.messages(sent["conversationId"], after=cursor)
            for m in new:
                if m["role"] == "assistant" and m["text"].strip():
                    if m.get("final", True):
                        return m
                    print(m["text"], file=sys.stderr)  # "I'm on it" while a task works
            if new:
                cursor = new[-1]["id"]
        raise NuonuoError(0, "timeout", "等回复超时了")

    def events(self):
        """Yields (event, data) from the SSE stream; reconnect yourself on errors."""
        req = urllib.request.Request(self.base + "/events", headers={"authorization": f"Bearer {self.token}", "accept": "text/event-stream"})
        with urllib.request.urlopen(req, timeout=60) as res:
            event, data = "message", []
            for raw in res:
                line = raw.decode().rstrip("\r\n")
                if not line:
                    if data:
                        yield event, json.loads("\n".join(data))
                    event, data = "message", []
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip())


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["pair"] and len(args) >= 3:
        print(json.dumps(NuonuoClient.pair(args[1], args[2], args[3] if len(args) > 3 else "python", args[4] if len(args) > 4 else "bot"), ensure_ascii=False, indent=2))
    elif args[:1] == ["ask"] and len(args) == 2:
        print(NuonuoClient(os.environ["NUONUO_URL"], os.environ["NUONUO_DEVICE_TOKEN"]).ask(args[1])["text"])
    elif args[:1] == ["events"]:
        for name, payload in NuonuoClient(os.environ["NUONUO_URL"], os.environ["NUONUO_DEVICE_TOKEN"]).events():
            print(name, json.dumps(payload, ensure_ascii=False))
    else:
        print(__doc__)
        sys.exit(2)
