// 佑佑的游戏屋: serves every game in this folder and mounts 星星小勇士 (star-hero/, which has its
// own Node server for logins and family data) under /star-hero/ by forwarding requests to it.
//
//   cd star-hero && PORT=8080 npm start     # 星星小勇士
//   node server.js                          # 游戏屋 on http://localhost:8727
//
// The talking games (天空滚球, 地铁话题) ask api/health and api/chat for "Amp AI"; those are
// forwarded to the kids-ai Amp plugin when it runs (.amp/plugins/kids-ai.ts in the orb).
//
// Environment: PORT (default 8727), STAR_HERO_URL (default http://localhost:8080),
// KIDS_AI_URL (default http://127.0.0.1:8790).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8727;
const STAR_HERO = new URL(process.env.STAR_HERO_URL || "http://localhost:8080");
const KIDS_AI = new URL(process.env.KIDS_AI_URL || "http://127.0.0.1:8790");
const ROOT = __dirname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".apk": "application/vnd.android.package-archive",
};

// The home page is "index (1).html"; "index.html" is the Yo-Yo game, linked from home as /yo-yo/.
function fileFor(pathname) {
  if (pathname === "/") return "index (1).html";
  if (pathname.startsWith("/yo-yo/")) pathname = pathname.slice("/yo-yo".length) === "/" ? "/index.html" : pathname.slice("/yo-yo".length);
  const file = path.normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  // Stay inside the folder and keep dotfiles and this server out of reach.
  if (!file || file.startsWith("..") || file.split(path.sep).some((p) => p.startsWith(".")) || file === "server.js") return null;
  return file;
}

function forward(req, res, target, path, downMessage) {
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, method: req.method, path, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(downMessage);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const { pathname, search } = new URL(req.url, "http://x");
  if (pathname === "/star-hero") {
    res.writeHead(302, { Location: "/star-hero/" + search });
    return res.end();
  }
  if (pathname.startsWith("/star-hero/")) return forward(req, res, STAR_HERO, pathname.slice("/star-hero".length) + search, "星星小勇士没有启动");
  if (pathname === "/api/health" || pathname === "/api/chat") return forward(req, res, KIDS_AI, pathname.slice("/api".length), "AI 没有启动");

  // The metro game's AI settings are saved here so every device picks them up from ai-config.json.
  if (pathname === "/save-ai-config" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { endpoint = "", key = "", model = "" } = JSON.parse(body);
        fs.writeFileSync(path.join(ROOT, "ai-config.json"), JSON.stringify({ endpoint, key, model }, null, 2) + "\n");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  const file = req.method === "GET" || req.method === "HEAD" ? fileFor(pathname) : null;
  fs.readFile(file ? path.join(ROOT, file) : "", (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
});

server.listen(PORT, () => console.log(`佑佑的游戏屋 running on http://localhost:${PORT} (星星小勇士 at ${STAR_HERO.origin})`));
