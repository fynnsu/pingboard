import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const context = vm.createContext({ Date, Map, Set, Promise });
vm.runInContext(`${await readFile(new URL("../repository-sync.js", import.meta.url), "utf8")}\n${await readFile(new URL("../timeline.js", import.meta.url), "utf8")}\nglobalThis.api = {Timeline, TimelineSync};`, context);
const { Timeline, TimelineSync } = context.api;
const now = Date.now(), iso = (days) => new Date(now - days * Timeline.day).toISOString();
const range = Timeline.range(90, now);
assert.equal(Timeline.position(iso(200), range), 0);
assert.equal(Timeline.position(iso(-20), range), range.width);
assert.equal(Timeline.normalize({ __typename: "PullRequestReview", id: "pending", state: "PENDING", submittedAt: iso(1) }), null);
const item = { id: "pr", repo: "acme/widgets", state: "OPEN", createdAt: iso(150), updatedAt: iso(1) };
const events = [{ id: "closed", kind: "closed", label: "Closed", at: iso(110) }, { id: "reopen", kind: "reopened", label: "Reopened", at: iso(40) }];
const segments = Timeline.segments(item, events.filter((event) => Date.parse(event.at) > range.start), range);
assert.equal(segments.length, 2);
assert.equal(segments[0].active, false, "first visible reopening means the PR was closed at the range start");
assert.equal(segments[1].active, true);
assert.equal(segments[0].x, 0);
const points = Timeline.clusters(Array.from({ length: 70 }, (_, i) => ({ id: `event-${i}`, at: new Date(now - 1000 * i).toISOString() })).reverse(), range);
assert.equal(points.length, 1);
assert.equal(points[0].events.length, 70);

const records = new Map(), cursors = [], seen = [];
let active = true, fail = true;
const since = new Date(range.start).toISOString();
const syncer = new TimelineSync({
  reader: { async read(key, query, input) {
    const variables = input(); cursors.push(variables.cursor);
    if (variables.cursor && fail) throw new Error("Connection interrupted");
    const number = variables.cursor ? 2 : 1;
    return { data: { repository: { pullRequests: {
      nodes: [{ id: `closed-${number}`, number, state: "CLOSED", createdAt: iso(80), closedAt: iso(number === 2 ? 100 : 30), updatedAt: iso(number === 2 ? 100 : 20), title: "A PR" }],
      pageInfo: { hasNextPage: true, endCursor: `page-${number}` }
    } } } };
  } },
  records: () => records, save: async (record) => records.set(record.id, structuredClone(record)),
  observe: async (items) => seen.push(...items), changed: () => {}, active: () => active
});
syncer.ensure({ items: [], repos: ["acme/widgets"], since }); await syncer.task;
assert.equal(syncer.errors.size, 1);
assert.equal(records.get("repo:acme/widgets").cursor, "page-1");
assert.equal(records.get("repo:acme/widgets").complete, false);
fail = false; syncer.retry(); await syncer.task;
assert.deepEqual(cursors, [null, "page-1", "page-1"]);
assert.equal(records.get("repo:acme/widgets").complete, true, "archive scan stops at the range boundary");
assert.deepEqual(seen.map((item) => item.id), ["closed-1"], "older completed PRs stay outside the backfill");
syncer.ensure({ items: [], repos: ["acme/widgets"], since }); await syncer.task;
assert.equal(cursors.length, 3, "complete archive coverage is cached");
active = false;
syncer.ensure({ items: [], repos: ["acme/other"], since }); await syncer.task;
assert.equal(cursors.length, 3, "leaving the view stops new history requests");
console.log("Timeline rules: clipping/reopening/clustering and archive pagination, resume, range cutoff, cache, and inactivity passed.");

const cache = new Map(), requests = [];
let release;
const slowPage = new Promise((resolve) => { release = resolve; });
const oldRow = { ...item, id: "old-row" }, visibleRow = { ...item, id: "visible-row" };
const scrolling = new TimelineSync({
  reader: { async read(key, query, input) {
    const variables = input(); requests.push(variables);
    if (requests.length === 1) await slowPage;
    const more = variables.id === oldRow.id && !variables.cursor;
    return { data: { node: { timelineItems: { nodes: [], pageInfo: { hasNextPage: more, endCursor: more ? "next-history-page" : null } } } } };
  } },
  records: () => cache, save: async (record) => cache.set(record.id, structuredClone(record)),
  observe: async () => {}, changed: () => {}, active: () => true
});
scrolling.ensure({ items: [oldRow], repos: [], since });
scrolling.ensure({ items: [visibleRow], repos: [], since });
release(); await scrolling.task;
assert.deepEqual(requests.map((request) => request.id), [oldRow.id, visibleRow.id], "scrolling prioritizes the new viewport after the in-flight page");
assert.equal(cache.get(oldRow.id).complete, false, "offscreen history does not drain remaining API pages");
scrolling.ensure({ items: [oldRow], repos: [], since }); await scrolling.task;
assert.equal(requests.at(-1).cursor, "next-history-page", "returning to an unfinished row resumes its history");
const total = requests.length;
scrolling.ensure({ items: [visibleRow, oldRow], repos: [], since }); await scrolling.task;
assert.equal(requests.length, total, "scrolling through complete cached rows issues no reads");
console.log("Viewport history: reprioritization, deferred offscreen pages, resume, and cached scrolling passed.");
