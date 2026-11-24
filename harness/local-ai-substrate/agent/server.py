import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

QEV_URL = os.environ.get("QEV_URL", "http://host.docker.internal:8080/v1/systemone")
QEV_MODEL = os.environ.get("QEV_MODEL", "labqoat/qev-0.8b-GGUF:text-Q8_0")
LLM_URL = os.environ.get("LLM_URL", "http://host.docker.internal:8081/v1/chat/completions")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3.5-9b")

STATE = {"turn_count": 0, "history": []}

def post_json(url, payload, timeout=180):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

class AgentHandler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/readyz", "/healthz"):
            self._send(200, {"status": "ok", "turn_count": STATE["turn_count"], "qev_url": QEV_URL, "llm_url": LLM_URL})
            return
        if self.path == "/state":
            self._send(200, STATE)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/agent":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req_body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            prompt = req_body.get("prompt", "Say hello briefly.")
            max_tokens = int(req_body.get("max_tokens", 128))
            skip_qev = bool(req_body.get("skip_qev", False))

            t0 = time.time()
            qev_result = None
            if not skip_qev:
                qev_resp = post_json(QEV_URL, {
                    "model": QEV_MODEL,
                    "state": {"prompt": prompt, "turn": STATE["turn_count"] + 1},
                    "questions": {
                        "actionable": {"type": "noul", "instructions": "Is this coding request safe and actionable?"}
                    },
                }, timeout=60)
                ans = qev_resp.get("answers", {}).get("actionable", {})
                noul = ans.get("noul")
                qev_result = {"noul": noul, "actionable": (noul or 0) >= 0.5}
            t_qev = round((time.time() - t0) * 1000, 1)

            messages = [{"role": "system", "content": "You are a concise coding assistant running inside Agent Substrate."}]
            messages.extend(STATE["history"][-6:])
            messages.append({"role": "user", "content": prompt})

            t1 = time.time()
            llm_resp = post_json(LLM_URL, {
                "model": LLM_MODEL,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": 0.2,
            }, timeout=180)
            t_llm = round((time.time() - t1) * 1000, 1)

            reply = llm_resp.get("choices", [{}])[0].get("message", {}).get("content", "")
            STATE["turn_count"] += 1
            STATE["history"].append({"role": "user", "content": prompt})
            STATE["history"].append({"role": "assistant", "content": reply})

            self._send(200, {
                "turn_count": STATE["turn_count"],
                "qev_ms": t_qev,
                "qev_decision": qev_result,
                "llm_ms": t_llm,
                "timings": llm_resp.get("timings"),
                "reply": reply,
            })
        except urllib.error.HTTPError as e:
            self._send(502, {"error": f"upstream {e.code}: {e.read().decode(errors="replace")}"})
        except Exception as e:
            self._send(500, {"error": str(e)})

if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 80), AgentHandler)
    print("local-ai-agent listening on :80", flush=True)
    server.serve_forever()
