import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createFixture, installRoutes, seed, ORIGIN } from "./support/fixture.mjs";
import { addTimelineFixture } from "./support/timeline-fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const browser = await chromium.launch(process.env.PINGBOARD_BROWSER_CHANNEL ? { channel: process.env.PINGBOARD_BROWSER_CHANNEL } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const fixture = createFixture(12);
const { ago, merged, closed } = addTimelineFixture(fixture);
fixture.addRepository("acme/runner", 3);
// More than one API page, clustered comments, plus a retry from a saved cursor.
fixture.items[0].timeline.push(...Array.from({ length: 55 }, (_, i) => ({ __typename: "IssueComment", id: `thread-${i}`, createdAt: ago(4 - i / 200), author: { login: "alex" }, bodyText: `Discussion update ${i}`, url: fixture.items[0].url })));
const original = fixture.api;
let failHistory = true;
fixture.api = (input) => {
  if (failHistory && input.body.query?.includes("PingboardTimeline(") && input.body.variables.id === "PR_1" && input.body.variables.cursor) {
    fixture.calls.push(input);
    return { status: 403, json: { message: "Simulated history access interruption" } };
  }
  return original(input);
};
await installRoutes(context, root, fixture);
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ready = () => page.waitForFunction(() => Work.ready && Work.meta.get("repo:acme/widgets")?.complete && !Work.syncer.running.size);
const rendered = () => page.waitForFunction(() => !renderQueued && !renderSkipped);
const settled = () => page.waitForFunction(() => Work.timeline && !Work.timeline.busy && !TimelineUI.windowFrame
  && Work.history.get("repo:acme/widgets")?.complete && !renderQueued
  && TimelineUI.nearby.every((item) => Work.timeline.errors.has(item.id) || Work.timeline.fresh(Work.history.get(item.id), new Date(Timeline.range(state.prefs.timelineDays).start).toISOString(), item)));
try {
  await seed(page);
  // A real v1 IndexedDB database, as created by the previous release.
  await page.goto(`${ORIGIN}/index.html?migration`);
  await ready();
  await page.evaluate(async () => {
    Work.stop();
    const name = "pingboard.workspace.v1.maintainer";
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { for (const name of ["items", "decisions", "events", "meta"]) request.result.createObjectStore(name, { keyPath: "id" }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("decisions", "readwrite");
        tx.objectStore("decisions").put({ id: "previous-release-record", status: "waiting", note: "Keep this decision", revision: "old" });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });
  });
  await page.goto(ORIGIN);
  await ready();
  assert.equal(await page.evaluate(() => Work.storage.db.version), 2);
  assert.equal(await page.evaluate(() => Work.decisions.get("previous-release-record")?.note), "Keep this decision", "v1 storage upgrade preserves records");
  const initialDecisions = await page.evaluate(() => Work.decisions.size);
  assert.equal(await page.evaluate(() => Work.items.has("PR_101")), false, "old merged PR is outside initial discovery");
  const initialEvents = await page.evaluate(() => Work.events.size);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await settled();
  assert.equal(await page.locator(".timeline-table tbody tr").count(), 14);
  assert.equal(await page.evaluate(() => Work.events.size), initialEvents, "historical backfill does not create credit or arrivals");
  assert.equal(await page.evaluate(() => Work.decisions.size), initialDecisions, "viewing history does not triage");
  assert.equal(await page.evaluate(() => state.board.pins.length), 0, "viewing history does not add pins");
  assert.equal(await page.evaluate(() => Work.history.get("PR_1").complete), false);
  assert.match(await page.locator(".timeline-status").innerText(), /incomplete/);
  failHistory = false;
  await page.getByRole("button", { name: "Retry history", exact: true }).click();
  await page.waitForFunction(() => Work.history.get("PR_1")?.complete && !Work.timeline.busy);
  assert.equal(await page.evaluate(() => Work.history.get("PR_1").events.length), 61);
  const historyCalls = () => fixture.calls.filter((call) => call.body?.query?.includes("PingboardTimeline("));
  assert.equal(historyCalls().filter((call) => call.body.variables.id === "PR_1" && !call.body.variables.cursor).length, 1, "retry resumes second page");
  const requestCount = historyCalls().length;
  await page.evaluate(() => render());
  await rendered();
  assert.equal(historyCalls().length, requestCount, "idle renders do not refetch history");

  await page.evaluate(() => Work.openItem(Work.items.get("PR_1"), "inbox"));
  await page.waitForFunction(() => state.data.has("acme/widgets#1"));
  await page.locator(".detail-timeline").waitFor();
  assert.ok(await page.locator(".detail-timeline-event").count() >= 60, "focused PR shows the full event timeline");
  assert.match(await page.locator(".detail-timeline").innerText(), /Ready for review/);
  assert.match(await page.locator(".detail-timeline").innerText(), /Comment/);
  assert.match(await page.locator(".detail-timeline").innerText(), /Commit/);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await settled();

  const row = page.locator('.timeline-table tr[data-key="acme/widgets#101"]');
  assert.equal(await row.locator(".timeline-life").count(), 1);
  const endpoint = await page.evaluate(() => {
    const range = Timeline.range(90), item = Work.items.get("PR_101");
    const end = Timeline.segments(item, Timeline.events(item, Work.history.get(item.id)), range).at(-1);
    return { actual: end.x + end.width, expected: Timeline.position(item.mergedAt, range), today: Timeline.position(new Date(range.now).toISOString(), range) };
  });
  assert.ok(Math.abs(endpoint.actual - endpoint.expected) < .1);
  assert.ok(endpoint.actual < endpoint.today - 200, "merged line ends before today");
  assert.equal(await page.locator('.timeline-table tr[data-key="acme/widgets#102"] .timeline-life.inactive').count(), 1, "reopened PR has a closed interval");
  const scroll = page.locator(".timeline-scroll");
  const label = row.locator(".timeline-label");
  const beforeX = (await label.boundingBox()).x;
  await scroll.evaluate((node) => { node.scrollLeft = 0; });
  assert.equal((await label.boundingBox()).x, beforeX, "PR title stays pinned while dates scroll");
  const marker = row.locator(".event-review");
  await marker.scrollIntoViewIfNeeded();
  await marker.hover();
  await page.getByRole("dialog", { name: "Events for acme/widgets#101" }).waitFor();
  assert.match(await page.locator(".timeline-popover").innerText(), /Approved/);
  assert.match(await page.locator(".timeline-popover").innerText(), /rolling deployment/);
  await page.keyboard.press("Escape");
  await marker.focus();
  await page.locator(".timeline-popover").waitFor();
  await marker.press("Enter");
  assert.equal(await page.getByRole("button", { name: "Close", exact: true }).evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".timeline-popover").count(), 0);

  // Same native control survives background data renders.
  const control = await page.getByLabel("Time range", { exact: true }).elementHandle();
  await page.evaluate(() => render());
  await rendered();
  assert.equal(await control.evaluate((node) => node.isConnected), true);
  await page.getByLabel("Timeline PRs", { exact: true }).selectOption("resolved");
  await rendered();
  assert.equal(await page.locator(".timeline-table tbody tr").count(), 2);
  await page.getByLabel("Time range", { exact: true }).selectOption("30");
  await rendered();
  assert.equal(await page.locator(".timeline-table tbody tr").count(), 1);
  await page.getByLabel("Time range", { exact: true }).selectOption("180");
  await page.waitForFunction(() => Work.history.get("PR_101")?.since === new Date(Timeline.range(180).start).toISOString() && !Work.timeline.busy);
  await page.getByLabel("Time range", { exact: true }).selectOption("90");
  await page.getByLabel("Timeline PRs", { exact: true }).selectOption("all");
  await settled();
  await page.getByLabel("Timeline include drafts", { exact: true }).uncheck();
  await rendered();
  assert.equal(await page.locator('.timeline-table tr[data-key="acme/widgets#7"]').count(), 0);

  await page.evaluate(async () => {
    await Work.decide(Work.items.get("PR_2"), { status: "needs_me" }, { track: true, advance: false });
    await Work.decide(Work.items.get("PR_3"), { status: "purgatory" }, { advance: false });
  });
  await rendered();
  assert.equal(await page.locator('.timeline-table tr[data-key="acme/widgets#3"]').count(), 0);
  await page.getByLabel("Timeline PRs", { exact: true }).selectOption("purgatory");
  await rendered();
  assert.equal(await page.locator(".timeline-table tbody tr").count(), 1);
  await page.getByLabel("Timeline PRs", { exact: true }).selectOption("board");
  await rendered();
  assert.equal(await page.locator(".timeline-table tbody tr").count(), 1);
  assert.equal(await page.locator(".timeline-marker.event-local").count(), 1, "personal triage has its own marker");
  await page.getByRole("button", { name: "Open acme/widgets#2 on CI board", exact: true }).click();
  await page.waitForFunction(() => state.page === "board" && state.cursor === "acme/widgets#2");
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.locator(".timeline-title").click();
  await page.waitForFunction(() => state.page === "inbox" && state.cursor === "acme/widgets#2");
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.getByLabel("Timeline PRs", { exact: true }).selectOption("all");
  const backup = await page.evaluate(async () => WorkspaceStore.validate(await Work.export()));
  assert.ok(backup.history.length > 0);
  const legacy = { ...backup }; delete legacy.history;
  assert.equal(await page.evaluate((data) => WorkspaceStore.validate(data).history.length, legacy), 0, "old backups remain valid");
  await page.reload(); await ready();
  const requestsBefore = historyCalls().length;
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await settled();
  assert.equal(historyCalls().length, requestsBefore, "history cache survives reload");
  await page.evaluate(() => { state.prefs.trackedRepos.push("acme/runner"); persistPrefs(); render(); });
  await page.getByLabel("Repository", { exact: true }).selectOption("acme/runner");
  await page.evaluate(() => Work.tick(true));
  await page.waitForFunction(() => Work.meta.get("repo:acme/runner")?.complete && !Work.timeline.busy && Work.history.get("repo:acme/runner")?.complete);
  await rendered();
  const repos = await page.locator(".timeline-table tbody tr").evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
  assert.ok(repos.length && repos.every((key) => key.startsWith("acme/runner#")), "repo switch isolates rows");
  await page.getByLabel("Repository", { exact: true }).selectOption("acme/widgets");
  await settled();
  if (process.env.PINGBOARD_SCREENSHOTS) {
    await mkdir(process.env.PINGBOARD_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "timeline-desktop.png") });
  }
  await page.setViewportSize({ width: 430, height: 932 });
  await rendered();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "only the timeline scrolls horizontally on mobile");
  assert.ok((await scroll.boundingBox()).height > 180, "mobile retains useful timeline space");
  if (process.env.PINGBOARD_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "timeline-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The full list is scrollable, but distant PRs do not fetch detailed history.
  for (let i = 200; i < 235; i++) fixture.items.push(fixture.makeItem(i, { createdAt: ago(1), updatedAt: ago(.1) }));
  await page.evaluate(() => Work.syncer.sync("acme/widgets"));
  await settled();
  await scroll.evaluate((node) => { node.scrollTop = 0; });
  await settled();
  const rows = page.locator(".timeline-table tbody tr");
  const allKeys = await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
  assert.ok(allKeys.length > 35, "the whole filtered list is present without pagination");
  assert.equal(await page.getByRole("button", { name: "Next timeline PRs", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Previous timeline PRs", exact: true }).count(), 0);
  const loaded = await page.evaluate(() => [...Work.history.keys()].filter((id) => /^PR_2\d\d$/.test(id)));
  assert.ok(loaded.length < 30, "opening a large list does not load every PR's history");
  const distant = await page.evaluate(() => TimelineUI.list.findLast((item) => item.number >= 200 && !Work.history.has(item.id)));
  assert.ok(distant, "distant rows remain lightweight");
  const firstRow = await rows.first().elementHandle();
  const horizontal = await scroll.evaluate((node) => node.scrollLeft);
  await scroll.evaluate((node, key) => {
    const row = [...node.querySelectorAll("tbody tr")].find((row) => row.dataset.key === key);
    node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - node.querySelector("thead").getBoundingClientRect().height;
  }, distant.key);
  await page.waitForFunction((id) => Work.history.get(id)?.complete, distant.id);
  await settled();
  assert.equal(await firstRow.evaluate((node) => node.isConnected), true, "loading history preserves other rows");
  assert.equal(await scroll.evaluate((node) => node.scrollLeft), horizontal, "vertical scrolling preserves the date position");
  const scrollTop = await scroll.evaluate((node) => node.scrollTop);
  await page.evaluate(() => render()); await rendered();
  assert.equal(await scroll.evaluate((node) => node.scrollTop), scrollTop, "background renders preserve vertical position");
  const requestsAfterScroll = historyCalls().length;
  await scroll.evaluate((node) => { node.scrollTop = 0; });
  await settled();
  assert.equal(historyCalls().length, requestsAfterScroll, "scrolling back reuses cached history");
  await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await settled();
  assert.ok(await rows.last().isVisible());
  assert.equal(await rows.last().evaluate((node) => {
    const scroller = node.closest(".timeline-scroll");
    return node.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().bottom + 1;
  }), true, "scrolling reaches the final PR");
  await page.getByLabel("Timeline PRs", { exact: true }).selectOption("board");
  await rendered();
  assert.equal(await rows.count(), 1);
  assert.equal(await scroll.evaluate((node) => node.scrollTop), 0, "changing filters starts the new list at the top");
  assert.deepEqual(errors, []);
  console.log("Timeline: continuous scrolling, lazy history/cache, lifecycle geometry, hover/keyboard, scope/triage links, backups, and mobile passed.");
} finally { await browser.close(); }
