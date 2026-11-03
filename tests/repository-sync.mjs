import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createFixture } from "./support/fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const context = vm.createContext({ Date, Map, Set, Promise, Error, TypeError, AbortController, structuredClone, setTimeout, clearTimeout });
vm.runInContext(`${await readFile(path.join(root, "repository-sync.js"), "utf8")}\nglobalThis.RepositorySync = RepositorySync;`, context);
vm.runInContext(`${await readFile(path.join(root, "workspace-store.js"), "utf8")}\nglobalThis.WorkspaceStore = WorkspaceStore;`, context);
const Sync = context.RepositorySync;
const repo = "acme/widgets";
const transient = () => Object.assign(new Error("NetworkError when attempting to fetch resource."), { retryable: true });
function harness() {
  const fixture = createFixture(57);
  const items = new Map();
  const metadata = new Map();
  const calls = [];
  const pauses = [];
  const states = [];
  let fail = () => {};
  const adapter = {
    query: async (query, variables, options) => {
      calls.push(structuredClone(variables));
      await fail(variables, options);
      return fixture.api({ pathname: "/graphql", body: { query, variables } }).json.data;
    },
    observe: async (records) => { for (const record of records) items.set(record.id, record); },
    metadata: (name) => metadata.get(name),
    saveMetadata: async (record) => { metadata.set(record.repo, structuredClone(record)); },
    items: () => [...items.values()],
    changed: () => { if (h.syncer) states.push(structuredClone(h.syncer.status.get(repo))); },
    pause: async (ms) => { pauses.push(ms); }, paceMs: 0, retryDelays: [1, 2, 4]
  };
  const h = { fixture, items, metadata, calls, pauses, states, adapter, fail: (fn) => { fail = fn; }, restart: () => { h.syncer = new Sync(adapter); return h.syncer; } };
  h.restart();
  return h;
}

{
  const h = harness();
  let failures = 0;
  h.fail((vars) => { if (vars.states && vars.cursor === "20" && failures++ === 0) throw transient(); });
  await h.syncer.sync(repo);
  assert.equal(h.items.size, 57);
  assert.equal(h.metadata.get(repo).complete, true);
  assert.equal(h.metadata.get(repo).scan, null);
  assert.equal(h.calls.filter((call) => call.states && call.cursor === null).length, 1, "retry never re-fetches successful pages");
  assert.deepEqual(h.calls.filter((call) => call.states && call.cursor === "20").map((call) => call.pageSize), [20, 10]);
  assert.ok(h.states.some((status) => status?.retry === 1 && status.count === 20), "show retry progress without losing the loaded count");
}
{
  const h = harness();
  h.fail((vars) => { if (vars.cursor === "20") throw transient(); });
  await h.syncer.sync(repo);
  assert.equal(h.items.size, 20);
  assert.equal(h.calls.filter((call) => call.cursor === "20").length, 4, "bounded automatic retry");
  assert.equal(h.metadata.get(repo).complete, false);
  assert.equal(h.metadata.get(repo).lastSync, null, "failure cannot move the watermark");
  assert.equal(h.metadata.get(repo).scan.cursor, "20");
  assert.equal(h.metadata.get(repo).scan.pageSize, 5);
  const backup = { version: 1, items: [], decisions: [], events: [], meta: [{ ...h.metadata.get(repo), scan: { ...h.metadata.get(repo).scan, token: "discard-me" } }] };
  const clean = context.WorkspaceStore.validate(backup);
  assert.equal(clean.meta[0].scan.cursor, "20", "checkpoints survive valid backup imports");
  assert.equal(clean.meta[0].scan.token, undefined);
  const previousCalls = h.calls.length;
  h.fail(() => {});
  await h.restart().sync(repo);
  assert.equal(h.calls[previousCalls].cursor, "20", "a fresh coordinator resumes the persisted cursor");
  assert.equal(h.items.size, 57);
  assert.equal(h.metadata.get(repo).complete, true);
}
{
  const h = harness();
  for (const item of h.fixture.items) item.updatedAt = new Date().toISOString();
  h.fail((vars) => { if (!vars.states && vars.cursor === "20") throw transient(); });
  await h.syncer.sync(repo);
  assert.equal(h.metadata.get(repo).scan.stage, "updated");
  assert.equal(h.metadata.get(repo).scan.cursor, "20");
  const before = h.calls.length;
  h.fail(() => {});
  await h.restart().sync(repo);
  assert.equal(h.calls[before].states, null, "resume the recent-update phase without restarting open discovery");
  assert.equal(h.calls[before].cursor, "20");
  assert.equal(h.metadata.get(repo).complete, true);
}
{
  const h = harness();
  const closed = h.fixture.makeItem(999, { state: "CLOSED", updatedAt: "2020-01-01T00:00:00Z", closedAt: "2020-01-01T00:00:00Z" });
  h.fixture.items.push(closed);
  h.items.set(closed.id, { id: closed.id, repo, number: 999, state: "OPEN" });
  h.fail((vars) => { if (vars.ids) throw transient(); });
  await h.syncer.sync(repo);
  assert.equal(h.metadata.get(repo).scan.stage, "reconcile");
  assert.equal(h.items.get(closed.id).state, "OPEN", "missing from discovery alone is not a closure");
  const before = h.calls.length;
  h.fail(() => {});
  await h.restart().sync(repo);
  assert.deepEqual(h.calls[before].ids, [closed.id]);
  assert.equal(h.items.get(closed.id).state, "CLOSED");
  assert.equal(h.metadata.get(repo).complete, true);
}
{
  const h = harness();
  const retryAt = Date.now() + 60000;
  h.fail(() => { throw Object.assign(new Error("Secondary rate limit"), { retryable: true, retryAt }); });
  await h.syncer.sync(repo);
  await h.restart().sync(repo);
  assert.equal(h.calls.length, 1, "respect the server cooldown even after reload or manual retry");
  assert.equal(h.metadata.get(repo).retryAt, retryAt);
}
{
  const h = harness();
  h.fail(() => { throw new Error("You do not have access to this repository."); });
  await h.syncer.sync(repo);
  assert.equal(h.calls.length, 1, "permission/schema errors are not repeatedly retried");
}
{
  const h = harness();
  h.fixture.addRepository("acme/runner", 3);
  let active = 0;
  let peak = 0;
  h.fail(async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1; });
  await Promise.all([h.syncer.sync(repo), h.syncer.sync("acme/runner"), h.syncer.sync(repo)]);
  assert.equal(peak, 1, "discovery requests are serialized across repositories");
  assert.equal(h.calls.filter((call) => call.name === "widgets" && call.states && call.cursor === null).length, 1, "duplicate sync triggers share the active scan");
}
{
  const h = harness();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  h.fail((vars, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(transient()), { once: true });
    started();
  }));
  const pending = h.syncer.sync(repo);
  await ready;
  h.syncer.stop();
  await pending;
  assert.equal(h.calls.length, 1, "sign-out cancels the request without retrying");
  assert.equal(h.metadata.get(repo).complete, false);
}
console.log("Discovery recovery: same-page retry, adaptive batches, durable checkpoints, reconciliation, rate limits, serialization, and cancellation passed.");
