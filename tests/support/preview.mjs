/* Local, credential-free preview for manual browser QA. Never reaches GitHub. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";
import { addTimelineFixture } from "./timeline-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = createFixture(12);
addTimelineFixture(fixture);
fixture.addRepository("acme/runner", 6);
const seed = `<script>
if (!localStorage.getItem('pingboard.preview.seeded')) {
  localStorage.setItem('pingboard.githubToken', 'local-preview-token');
  localStorage.setItem('pingboard.v3.maintainer.prefs', JSON.stringify({defaultRepo:'acme/widgets',trackedRepos:['acme/widgets','acme/runner'],dailyGoal:5}));
  localStorage.setItem('pingboard.preview.seeded', '1');
}
if (!localStorage.getItem('pingboard.preview.multi-repo')) {
  const key = 'pingboard.v3.maintainer.prefs';
  const prefs = JSON.parse(localStorage.getItem(key) || '{}');
  prefs.trackedRepos = [...new Set([...(prefs.trackedRepos || []), 'acme/widgets', 'acme/runner'])];
  localStorage.setItem(key, JSON.stringify(prefs));
  localStorage.setItem('pingboard.preview.multi-repo', '1');
}
</script>`;
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const result = fixture.api({ pathname: url.pathname.slice(4), method: request.method, body: JSON.parse(raw || "{}") });
      response.writeHead(result.status || 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.json));
      return;
    }
    const file = path.resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    let body = await readFile(file, "utf8");
    if (file.endsWith("app.js")) body = body.replace('const API_ROOT = "https://api.github.com";', 'const API_ROOT = location.origin + "/api";');
    if (file.endsWith("index.html")) body = body.replace('<script defer src="./workflow.js">', `${seed}<script defer src="./workflow.js">`);
    response.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "text/plain", "cache-control": "no-store" });
    response.end(body);
  } catch (error) { response.writeHead(500); response.end(error.message); }
}).listen(8083, "127.0.0.1", () => console.log("Mock GitHub preview: http://127.0.0.1:8083"));
