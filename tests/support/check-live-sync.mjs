// Opt-in, read-only GitHub discovery smoke test. Uses gh's existing login.
// No browser token, local workspace, or GitHub mutation is involved.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import vm from "node:vm";

const repo = process.argv[2];
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("Usage: node tests/support/check-live-sync.mjs owner/repo");
const source = await readFile(new URL("../../repository-sync.js", import.meta.url), "utf8");
const context = vm.createContext({ Date, Map, Set, Promise, Error, TypeError, AbortController, structuredClone, setTimeout, clearTimeout });
vm.runInContext(`${source}\nglobalThis.RepositorySync = RepositorySync;`, context);
const items = new Map();
const metadata = new Map();
let requests = 0;
let lastStatus = "";
const syncer = new context.RepositorySync({
  query: async (query, variables, options = {}) => {
    if (/\bmutation\b/.test(query)) throw new Error("This check only permits read queries.");
    const start = Date.now();
    // gh needs a JSON body for array/null variables, without shell interpolation.
    const result = await new Promise((resolve, reject) => {
      const child = execFile("gh", ["api", "graphql", "--input", "-"], { maxBuffer: 16 * 1024 * 1024, signal: options.signal }, (error, stdout, stderr) => {
        if (error) { reject(new Error(stderr.trim() || error.message)); return; }
        resolve(stdout);
      });
      child.stdin.end(JSON.stringify({ query, variables }));
    });
    requests += 1;
    const json = JSON.parse(result);
    if (json.errors?.length) throw new Error(json.errors.map((error) => error.message).join("; "));
    console.log(`Read ${requests}: ${Date.now() - start} ms; ${variables.states ? "open PRs" : variables.ids ? "reconciliation" : "recent updates"}; ${json.data?.repository?.pullRequests?.nodes.length ?? json.data?.nodes?.length ?? 0} records`);
    return json.data;
  },
  observe: async (records) => { for (const item of records) items.set(item.id, item); },
  metadata: (name) => metadata.get(name),
  saveMetadata: async (record) => { metadata.set(record.repo, structuredClone(record)); },
  items: () => [...items.values()],
  changed: () => {
    const status = syncer.status.get(repo);
    if (status?.error && status.error !== lastStatus) { lastStatus = status.error; console.log(status.error); }
  }
});
await syncer.sync(repo);
if (!metadata.get(repo)?.complete || syncer.status.get(repo)?.error) process.exitCode = 1;
console.log(JSON.stringify({ repo, complete: metadata.get(repo)?.complete || false, loaded: items.size, requests }));
