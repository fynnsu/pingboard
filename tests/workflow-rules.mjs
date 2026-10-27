import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const head = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const context = { Date, Set, Map };
vm.runInNewContext(await readFile(path.join(head, "workflow.js"), "utf8"), context);
const W = context.Workflow;
const now = Date.now();
const stamp = (offset) => new Date(now + offset).toISOString();
const item = { id: "pr1", state: "OPEN", author: "alex", headOid: "old", rollup: "PENDING", comments: [], reviews: [] };
const waiting = { triagedAt: stamp(-1000), updatedAt: stamp(-1000), status: "waiting", waitingFor: "author", dueAt: stamp(10000) };
assert.equal(W.queue(item), "new", "reading without a decision stays new");
assert.equal(W.queue(item, waiting, now), "waiting");
assert.equal(W.queue(item, waiting, now + 20000), "needs_me", "due reminders surface without modifying history");
assert.equal(W.queue({ ...item, state: "MERGED" }, waiting, now + 20000), "resolved", "GitHub resolution overrides a due reminder");
assert.equal(W.wakeReason(item, { ...item, comments: [{ login: "alex", at: stamp(0) }] }, waiting, "me"), "New reply");
assert.equal(W.wakeReason(item, { ...item, comments: [{ login: "bot", at: stamp(0), bot: true }] }, waiting, "me"), null);
assert.equal(W.wakeReason(item, { ...item, comments: [{ login: "me", at: stamp(0) }] }, { ...waiting, waitingFor: "reviewer" }, "me"), null);
assert.equal(W.wakeReason(item, { ...item, headOid: "new" }, waiting, "me"), "New commits");
assert.equal(W.wakeReason(item, { ...item, rollup: "SUCCESS" }, { ...waiting, waitingFor: "ci" }, "me"), "CI finished");
assert.equal(W.wakeReason(item, { ...item, rollup: "SUCCESS" }, waiting, "me"), null, "routine CI should not interrupt waiting for the author");
assert.equal(W.wakeReason({ ...item, state: "CLOSED" }, item, waiting, "me"), "PR reopened");
const events = [
  { itemId: "pr1", actor: "Me", kind: "triage", at: stamp(0) },
  { itemId: "pr1", actor: "me", kind: "review", at: stamp(0) },
  { itemId: "pr2", actor: "other", kind: "review", at: stamp(0) },
  { itemId: "pr3", actor: "me", kind: "triage", at: stamp(0), reverted: true },
  { itemId: "pr4", actor: "me", kind: "ci", at: stamp(0) },
  { itemId: "pr5", actor: "me", kind: "label", at: stamp(0) },
  { itemId: "pr2", actor: "other", kind: "resolved", state: "MERGED", at: stamp(0) }
];
assert.equal(W.progress(events, "me").moved, 1, "deduplicate distinct PRs and exclude retries, labels, undone work, and other actors");
assert.equal(W.progress(events, "me").merged, 1, "repository outcomes have independent attribution");
console.log("Workflow rules: attention, reopening, local dates, attribution, undo, and deduplication passed.");
