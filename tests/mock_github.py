#!/usr/bin/env python3
"""
Local test harness: serves <repo>/_site at / and a tiny fake GitHub API at /api,
backed by the repo folder itself. Open http://localhost:8765/admin/?api=http://localhost:8765/api
with any token. Saving in the admin writes files into the repo folder, then
re-run scripts/build.py to see the result.

  python3 tests/mock_github.py /path/to/repo-copy
"""
import base64, hashlib, json, sys, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
OWNER, NAME, BRANCH = "you", "panoramas", "main"
lock = threading.Lock()
blobs: dict[str, bytes] = {}
trees: dict[str, dict[str, str]] = {}
commits: dict[str, dict] = {}
head = None
runs = []


def sha(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


def tracked():
    for p in sorted(REPO.rglob("*")):
        rel = p.relative_to(REPO).as_posix()
        if p.is_file() and not rel.startswith(("_site/", ".cache/", ".git/", "tests/")) and "__pycache__" not in rel:
            yield rel, p.read_bytes()


def init():
    global head
    t = {}
    for rel, data in tracked():
        s = sha(data); blobs[s] = data; t[rel] = s
    tsha = sha(json.dumps(t, sort_keys=True).encode()); trees[tsha] = t
    head = sha(b"commit" + tsha.encode()); commits[head] = {"tree": tsha, "parents": [], "message": "init"}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(REPO / "_site"), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()

    def j(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def route(self, method):
        p = self.path.split("?")[0]
        pre = f"/api/repos/{OWNER}/{NAME}"
        if not p.startswith("/api"):
            return False
        if not self.headers.get("Authorization"):
            self.j(401, {"message": "Bad credentials"}); return True
        if not p.startswith(pre):
            self.j(404, {"message": "Not Found"}); return True
        sub = p[len(pre):]
        with lock:
            global head
            if method == "GET" and sub == "":
                return self.j(200, {"default_branch": BRANCH, "html_url": "https://github.com/you/panoramas",
                                    "private": False, "permissions": {"push": True}}) or True
            if method == "GET" and sub.startswith("/git/trees/"):
                ref = sub.split("/")[-1]
                t = trees[commits[head]["tree"]] if ref == BRANCH else trees[ref]
                return self.j(200, {"truncated": False, "tree": [{"path": k, "type": "blob", "sha": v, "mode": "100644"} for k, v in t.items()]}) or True
            if method == "GET" and sub.startswith("/git/blobs/"):
                s = sub.split("/")[-1]
                return self.j(200, {"sha": s, "encoding": "base64", "content": base64.encodebytes(blobs[s]).decode()}) or True
            if method == "POST" and sub == "/git/blobs":
                data = base64.b64decode(self.body()["content"]); s = sha(data); blobs[s] = data
                return self.j(201, {"sha": s}) or True
            if method == "GET" and sub == f"/git/ref/heads/{BRANCH}":
                return self.j(200, {"object": {"sha": head}}) or True
            if method == "GET" and sub.startswith("/git/commits/"):
                c = commits[sub.split("/")[-1]]
                return self.j(200, {"tree": {"sha": c["tree"]}}) or True
            if method == "POST" and sub == "/git/trees":
                b = self.body(); t = dict(trees[b["base_tree"]])
                for e in b["tree"]:
                    if e["sha"] is None: t.pop(e["path"], None)
                    else: t[e["path"]] = e["sha"]
                ts = sha(json.dumps(t, sort_keys=True).encode()); trees[ts] = t
                return self.j(201, {"sha": ts}) or True
            if method == "POST" and sub == "/git/commits":
                b = self.body(); cs = sha(json.dumps(b, sort_keys=True).encode())
                commits[cs] = {"tree": b["tree"], "parents": b["parents"], "message": b["message"]}
                return self.j(201, {"sha": cs}) or True
            if method == "PATCH" and sub == f"/git/refs/heads/{BRANCH}":
                new = self.body()["sha"]
                if commits[new]["parents"] != [head]:
                    return self.j(422, {"message": "Update is not a fast forward"}) or True
                old, nt = trees[commits[head]["tree"]], trees[commits[new]["tree"]]
                for path in old:
                    if path not in nt: (REPO / path).unlink(missing_ok=True)
                for path, s in nt.items():
                    if old.get(path) != s:
                        (REPO / path).parent.mkdir(parents=True, exist_ok=True); (REPO / path).write_bytes(blobs[s])
                for d in sorted((REPO / "projects").glob("*"), reverse=True):
                    if d.is_dir() and not any(d.iterdir()): d.rmdir()
                head = new
                runs.insert(0, {"status": "completed", "conclusion": "success", "html_url": "#"})
                print("COMMIT:", commits[new]["message"], flush=True)
                return self.j(200, {"object": {"sha": head}}) or True
            if method == "GET" and sub == "/actions/runs":
                return self.j(200, {"workflow_runs": runs[:1]}) or True
        self.j(404, {"message": f"mock: no route {method} {sub}"}); return True

    def do_GET(self):
        if not self.route("GET"): super().do_GET()

    def do_HEAD(self):
        super().do_HEAD()

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")


if __name__ == "__main__":
    init()
    print(f"mock GitHub + site on http://localhost:8765  (repo: {REPO})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8765), H).serve_forever()
