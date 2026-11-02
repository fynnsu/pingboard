// Opt-in read-only schema/real-data check; never uses browser credentials or writes to GitHub.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import vm from "node:vm";
const [repo, number] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !/^\d+$/.test(number || "")) throw new Error("Usage: node tests/support/check-live-timeline.mjs owner/repo number");
const context = vm.createContext({ Date, Map, Set, Promise });
vm.runInContext(`${await readFile(new URL("../../timeline.js", import.meta.url), "utf8")}\nglobalThis.api = {TIMELINE_QUERY, TIMELINE_CLOSED_QUERY, Timeline};`, context);
async function query(query, variables) {
  if (/\bmutation\b/.test(query)) throw new Error("Read queries only");
  const output = await new Promise((resolve, reject) => {
    const child = execFile("gh", ["api", "graphql", "--input", "-"], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin.end(JSON.stringify({ query, variables }));
  });
  const result = JSON.parse(output);
  if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
  return result.data;
}
const [owner, name] = repo.split("/");
const pr = await query("query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}", { owner, name, number: Number(number) });
const since = new Date(Date.now() - 90 * 86400000).toISOString();
let cursor = null, count = 0, pages = 0;
const types = new Set();
do {
  const data = await query(context.api.TIMELINE_QUERY, { id: pr.repository.pullRequest.id, since, cursor });
  const connection = data.node.timelineItems;
  for (const node of connection.nodes) { const event = context.api.Timeline.normalize(node); if (event) { count++; types.add(event.kind); } }
  cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  pages++;
  if (pages > 100) throw new Error("Unexpectedly long timeline");
} while (cursor);
const closed = await query(context.api.TIMELINE_CLOSED_QUERY, { owner, name, cursor: null });
console.log(JSON.stringify({ repo, number: Number(number), pages, events: count, types: [...types], closedPRsOnFirstPage: closed.repository.pullRequests.nodes.length }));
