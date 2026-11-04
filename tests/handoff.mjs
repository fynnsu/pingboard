import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createFixture, installRoutes, seed, ORIGIN } from "./support/fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const browser = await chromium.launch(process.env.PINGBOARD_BROWSER_CHANNEL ? { channel: process.env.PINGBOARD_BROWSER_CHANNEL } : {});
const fixture = createFixture(6);
fixture.addRepository("acme/runner", 3);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await installRoutes(context, root, fixture);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const ready = () => page.waitForFunction(() => Work.ready && Work.meta.get("repo:acme/widgets")?.complete && Work.meta.get("repo:acme/runner")?.complete && !Work.syncer.running.size);
const selectRepo = async (repo) => {
  await page.getByRole("combobox", { name: "Repository", exact: true }).selectOption(repo);
  await page.waitForFunction((value) => Work.repo === value, repo);
  await page.waitForFunction(() => !renderQueued && !renderSkipped);
};
const rowKeys = async () => {
  await page.waitForFunction(() => !renderQueued && !renderSkipped);
  return page.locator("#board .row").evaluateAll((rows) => rows.map((row) => row.dataset.key));
};
try {
  await seed(page);
  await page.evaluate(() => {
    const key = "pingboard.v3.maintainer.prefs";
    const prefs = JSON.parse(localStorage.getItem(key));
    prefs.trackedRepos.push("acme/runner");
    localStorage.setItem(key, JSON.stringify(prefs));
  });
  await page.goto(ORIGIN);
  await ready();
  await page.evaluate(() => { state.prefs.boardGrouping = "manual"; persistPrefs(); });
  await page.keyboard.press("t");
  await page.waitForFunction(() => !Work.saving && Boolean(pinByKey("acme/widgets#1")));
  await page.evaluate(() => Work.setQueue("needs_me"));
  await page.getByRole("button", { name: "View on CI board", exact: true }).click();
  await page.waitForFunction(() => state.page === "board" && state.cursor === "acme/widgets#1");
  assert.deepEqual(await rowKeys(), ["acme/widgets#1"]);
  assert.match(await page.locator("#board .row").innerText(), /Needs me/);
  assert.equal(await page.locator("#workspace-toolbar").isHidden(), true, "the board has no extra toolbar row");
  assert.equal(await page.locator(".triage-actions .triage-open-inbox").count(), 1, "inbox navigation shares the compact action row");
  assert.doesNotMatch(await page.locator(".triage-panel").innerText(), /Notes & reminders are private/);

  await page.getByRole("button", { name: "Waiting…", exact: true }).click();
  await page.getByLabel("Private note · optional", { exact: true }).fill("Wait for the new CI run");
  await page.getByLabel("Waiting for", { exact: true }).selectOption("ci");
  await page.getByRole("button", { name: "Save waiting state", exact: true }).click();
  await page.waitForFunction(() => Work.decisions.get("PR_1")?.status === "waiting" && !Work.saving);
  assert.deepEqual(await rowKeys(), ["acme/widgets#1"], "waiting PRs remain in the working set");
  await page.getByRole("combobox", { name: "Triage status", exact: true }).selectOption("needs_me");
  await page.waitForFunction(() => !state.cursor);
  assert.deepEqual(await rowKeys(), []);
  await page.getByRole("combobox", { name: "Triage status", exact: true }).selectOption("waiting");
  await page.getByRole("button", { name: "Open in PR inbox", exact: true }).click();
  await page.waitForFunction(() => state.page === "inbox" && state.cursor === "acme/widgets#1");
  assert.match(await page.locator(".triage-panel").innerText(), /Wait for the new CI run/);
  assert.match(await page.locator('.inbox-row[data-key="acme/widgets#1"]').innerText(), /On CI board/);

  await selectRepo("acme/runner");
  await page.waitForFunction(() => state.cursor === "acme/runner#1");
  assert.equal(await page.locator(".inbox-row").count(), 3);
  assert.match(await page.locator("#detail h2").innerText(), /runner:/);
  assert.equal(await page.evaluate(() => Work.decision(Work.ref(state.cursor)) || null), null, "equal PR numbers in different repos have separate decisions");
  await page.getByRole("button", { name: "Take on · t", exact: true }).click();
  await page.waitForFunction(() => !Work.saving && Boolean(pinByKey("acme/runner#1")));
  await page.getByRole("button", { name: "CI board", exact: true }).click();
  await page.waitForFunction(() => state.page === "board");
  // A shared filter is still applied across repository changes; reset it explicitly.
  await page.getByRole("combobox", { name: "Triage status", exact: true }).selectOption("all");
  assert.deepEqual(await rowKeys(), ["acme/runner#1"]);
  assert.equal(await page.locator("#chips").isHidden(), true, "the unused CI filter chips are gone");
  await selectRepo("acme/widgets");
  assert.deepEqual(await rowKeys(), ["acme/widgets#1"]);
  assert.equal(await page.evaluate(() => state.cursor), "acme/widgets#1");
  assert.match(await page.locator(".triage-panel").innerText(), /Wait for the new CI run/);
  await selectRepo("");
  assert.deepEqual(await rowKeys(), ["acme/widgets#1", "acme/runner#1"]);
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => Work.repo), "", "All repositories survives reload");
  await page.getByRole("button", { name: "CI board", exact: true }).click();
  assert.deepEqual(await rowKeys(), ["acme/widgets#1", "acme/runner#1"], "both working sets survive reload");
  await selectRepo("acme/runner");
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => Work.repo), "acme/runner", "selected repository survives reload");
  await page.getByRole("button", { name: "Progress", exact: true }).click();
  assert.equal(await page.evaluate(() => Work.scopedEvents().every((event) => event.repo === "acme/runner")), true);
  console.log("Inbox → CI board → follow-up, shared filters, repository isolation, and reload passed.");

  // Undo must preserve manual organization and must not overwrite a newer decision.
  await selectRepo("acme/widgets");
  await page.evaluate(async () => {
    const group = ensureGroup("Review next");
    addPin("acme/widgets", 2, group.id);
    await Work.decide(Work.ref("acme/widgets#2"), { status: "needs_me" }, { track: true, advance: false });
    await state.toasts.at(-1).action.run();
  });
  assert.equal(await page.evaluate(() => state.board.groups.find((group) => group.id === pinByKey("acme/widgets#2").group).name), "Review next");
  assert.equal(await page.evaluate(() => Work.decisions.has("PR_2")), false);
  await page.evaluate(async () => {
    await Work.decide(Work.ref("acme/widgets#3"), { status: "needs_me" }, { track: true, advance: false });
    const undo = state.toasts.at(-1).action.run;
    await Work.decide(Work.ref("acme/widgets#3"), { status: "later", note: "After release", dueAt: new Date(Date.now() + 86400000).toISOString() }, { advance: false });
    await undo();
  });
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_3").status), "later");
  assert.equal(await page.evaluate(() => Boolean(pinByKey("acme/widgets#3"))), true);
  await page.evaluate(async () => {
    removePin("acme/widgets#1");
    await Work.decide(Work.ref("acme/widgets#1"), { status: "needs_me" }, { track: true, advance: false });
    removePin("acme/widgets#1");
    const count = Work.events.size;
    await Work.decide(Work.ref("acme/widgets#1"), { status: "needs_me" }, { track: true, advance: false });
    if (Work.events.size !== count) throw new Error("Retracking must not award extra progress");
    await state.toasts.at(-1).action.run();
  });
  assert.equal(await page.evaluate(() => Boolean(pinByKey("acme/widgets#1"))), false);
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_1").status), "needs_me", "undoing a retrack preserves its existing decision");
  console.log("Undo preserves pre-existing pins, groups, and newer decisions; retracking does not add credit.");

  await page.evaluate(async () => {
    const decide = Work.storage.decide;
    Work.storage.decide = async () => { throw new Error("Disk unavailable"); };
    await WorkUI.action("take", Work.ref("acme/widgets#4"));
    Work.storage.decide = decide;
  });
  assert.equal(await page.evaluate(() => Boolean(pinByKey("acme/widgets#4"))), false, "failed triage must not add a pin");
  await page.evaluate(() => Work.retryStorage());

  // Manually pinned repositories remain reachable even without complete discovery.
  fixture.addRepository("acme/manual", 1);
  await page.evaluate(() => addPin("acme/manual", 1));
  await page.waitForFunction(() => Work.ref("acme/manual#1"));
  await selectRepo("acme/manual");
  await page.getByRole("button", { name: "CI board", exact: true }).click();
  assert.deepEqual(await rowKeys(), ["acme/manual#1"]);
  await page.getByRole("button", { name: "Open in PR inbox", exact: true }).click();
  await page.locator("#board .sync-note").filter({ hasText: "Add this repository in Settings" }).waitFor();
  assert.match(await page.locator("#board").innerText(), /Add this repository in Settings/);
  assert.equal(await page.evaluate(() => WorkUI.complete()), false);

  // Unknown mock repositories fail visibly instead of showing another repo's data.
  await page.evaluate(async () => {
    state.prefs.trackedRepos.push("acme/missing");
    Work.setRepo("acme/missing");
    await Work.syncer.sync("acme/missing");
  });
  await page.getByRole("alert").filter({ hasText: "Mock repository acme/missing is not configured" }).waitFor();
  assert.equal(await page.locator(".inbox-row").count(), 0);
  assert.equal(await page.evaluate(() => state.cursor), null);

  await selectRepo("acme/widgets");
  await page.getByRole("button", { name: "CI board", exact: true }).click();
  await page.evaluate(() => { state.toasts = []; render(); });
  await page.waitForFunction(() => !renderQueued && !renderSkipped);
  if (process.env.PINGBOARD_SCREENSHOTS) {
    await mkdir(process.env.PINGBOARD_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "board-handoff.png") });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open in PR inbox", exact: true }).waitFor({ state: "visible" });
  if (process.env.PINGBOARD_SCREENSHOTS) {
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "board-mobile.png") });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole("button", { name: "Open in PR inbox", exact: true }).click();
  await page.waitForFunction(() => state.page === "inbox" && state.cursor === "acme/widgets#2");
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log("Storage failure, manually pinned repositories, missing repositories, and board layout passed.");
} catch (error) {
  console.log("Handoff diagnostics", await page.evaluate(() => ({ error: Work.error, repo: Work.repo, page: state.page, queue: Work.queue, boardQueue: Work.boardQueue, cursor: state.cursor, pins: state.board.pins, board: document.querySelector("#board")?.innerText })).catch(() => null), errors);
  throw error;
} finally { await browser.close(); }
