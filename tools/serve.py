"""Local preview with the same clean URLs as Cloudflare Pages (/services -> services.html).

Run from the repo root:  py tools/serve.py   then open http://localhost:8800
"""
import http.server, os, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8800


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webp": "image/webp", ".woff2": "font/woff2", ".svg": "image/svg+xml"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def send_head(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path != "/" and "." not in path.rsplit("/", 1)[-1] and (ROOT / (path.strip("/") + ".html")).exists():
            self.path = path + ".html" + self.path[len(path):]
        return super().send_head()


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
