import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createFixture, installRoutes, seed, ORIGIN } from "./support/fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const browser = await chromium.launch(process.env.PINGBOARD_BROWSER_CHANNEL ? { channel: process.env.PINGBOARD_BROWSER_CHANNEL } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const fixture = createFixture(12);
fixture.items[3].updatedAt = new Date(Date.now() + 10000).toISOString();
await installRoutes(context, root, fixture);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ready = () => page.waitForFunction(() => Work.ready && Work.meta.get("repo:acme/widgets")?.complete && !Work.syncer.running.size);
const rendered = () => page.waitForFunction(() => !renderQueued && !renderSkipped);
const rows = async () => { await rendered(); return page.locator(".inbox-row").evaluateAll((nodes) => nodes.map((node) => node.dataset.key)); };
const select = async (number) => {
  await page.evaluate((value) => Work.openItem(Work.ref(`acme/widgets#${value}`), "inbox"), number);
  await page.locator(`.inbox-row[data-key="acme/widgets#${number}"][aria-current=true]`).waitFor();
};
try {
  await seed(page);
  await page.goto(ORIGIN);
  await ready();
  assert.equal((await rows())[0], "acme/widgets#1");
  await page.getByLabel("Inbox sort order", { exact: true }).selectOption("newest");
  assert.equal((await rows())[0], "acme/widgets#12");
  await page.getByLabel("Inbox sort order", { exact: true }).selectOption("updated");
  assert.equal((await rows())[0], "acme/widgets#4");
  await page.getByLabel("Include draft PRs", { exact: true }).uncheck();
  assert.equal((await rows()).length, 11);
  assert.equal((await rows()).includes("acme/widgets#7"), false);
  await page.reload();
  await ready();
  assert.equal(await page.getByLabel("Inbox sort order", { exact: true }).inputValue(), "updated");
  assert.equal(await page.getByLabel("Include draft PRs", { exact: true }).isChecked(), false);
  const sort = await page.getByLabel("Inbox sort order", { exact: true }).elementHandle();
  await page.evaluate(() => render());
  await rendered();
  assert.equal(await sort.evaluate((node) => node.isConnected), true, "background renders preserve the sort control");

  await select(1);
  await page.getByRole("button", { name: "Take on · t", exact: true }).click();
  await page.waitForFunction(() => !Work.saving && Work.decisions.get("PR_1")?.status === "needs_me");
  await select(2);
  await page.getByRole("button", { name: "Waiting · w", exact: true }).click();
  assert.deepEqual(await page.locator(".quick-duration").allTextContents(), ["1h", "3h", "1d", "3d", "1w"]);
  assert.equal(await page.getByRole("button", { name: "Remind me in 1d", exact: true }).getAttribute("aria-pressed"), "true", "1d is the default quick reminder");
  await page.getByRole("button", { name: "Remind me in 3h", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Remind me in 3h", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "Remind me in 1d", exact: true }).getAttribute("aria-pressed"), "false");
  await page.getByRole("button", { name: "Save waiting state", exact: true }).click();
  await page.waitForFunction(() => !Work.saving && Work.decisions.get("PR_2")?.status === "waiting");
  await select(3);
  await page.getByRole("button", { name: "Later · s", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Remind me in 1d", exact: true }).getAttribute("aria-pressed"), "true", "1d is also the default for Later");
  await page.getByRole("button", { name: "Defer PR", exact: true }).click();
  await page.waitForFunction(() => !Work.saving && Work.decisions.get("PR_3")?.status === "later");
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_3").note), "", "deferring does not require a reason");
  assert.deepEqual(await page.evaluate(() => state.board.pins.map((pin) => pin.number)), [1, 2, 3]);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.locator('.group[data-lane="working"] .row').waitFor();
  assert.equal(await page.locator('.group[data-lane="waiting"] .row').count(), 0);
  assert.equal(await page.locator('.group[data-lane="waiting"] .group-count').innerText(), "1");
  assert.equal(await page.locator('.group[data-lane="later"] .row').count(), 0);
  assert.equal(await page.locator('.group[data-lane="later"] .group-count').innerText(), "1");
  assert.equal(await page.locator('.group[data-lane="new"] .row').count(), 0, "discovered New PRs do not populate the board");

  const statusGroupOrder = () => page.locator("#board > .board-groups > .group").evaluateAll((groups) => groups.map((group) => group.dataset.lane));
  assert.deepEqual(await statusGroupOrder(), ["updated", "working", "waiting", "later", "new", "resolved"]);
  await page.locator('.group[data-lane="waiting"] .group-head').dragTo(page.locator('.group[data-lane="updated"]'), { targetPosition: { x: 4, y: 20 } });
  await page.waitForFunction(() => state.prefs.boardStatusOrder[0] === "waiting");
  await rendered();
  assert.deepEqual(await statusGroupOrder(), ["waiting", "updated", "working", "later", "new", "resolved"], "status groups can be reordered");
  assert.deepEqual(await page.evaluate(() => state.prefs.boardStatusOrder.slice(0, 3)), ["waiting", "updated", "working"], "status group order is persisted in preferences");

  await page.locator('.group[data-lane="working"] .row[data-key="acme/widgets#1"]').dragTo(page.locator('.group[data-lane="waiting"] .group-head'));
  await page.getByRole("button", { name: "Save waiting state", exact: true }).click();
  await page.waitForFunction(() => !Work.saving && Work.decisions.get("PR_1")?.status === "waiting");
  await page.locator('.group[data-lane="waiting"] .row[data-key="acme/widgets#1"]').waitFor();
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_1").waitingFor), "author", "moving a PR to Waiting opens the existing triage flow");
  console.log("Status groups reorder; dragging a PR to a status updates its triage decision passed.");

  await page.evaluate(async () => {
    await Work.storage.put("decisions", { ...Work.decisions.get("PR_3"), dueAt: new Date(Date.now() - 1000).toISOString() });
    await Work.reload();
  });
  await page.locator('.group[data-lane="updated"] .row[data-key="acme/widgets#3"]').waitFor();
  const replyAt = new Date(Date.now() + 1000).toISOString();
  fixture.items[1].comments.nodes.push({ id: "new-reply", author: fixture.items[1].author, createdAt: replyAt, bodyText: "Updated the reproduction." });
  fixture.items[1].updatedAt = replyAt;
  await page.evaluate(() => Work.syncer.sync("acme/widgets"));
  await page.locator('.group[data-lane="updated"] .row[data-key="acme/widgets#2"]').waitFor();
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_2").reason), "New reply");
  await page.evaluate(() => Work.openItem(Work.ref("acme/widgets#3"), "board"));
  await page.locator("#detail").getByRole("button", { name: "Take on", exact: true }).click();
  await page.locator('.group[data-lane="working"] .row[data-key="acme/widgets#3"]').waitFor();
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_3").dueAt), null, "taking on a due follow-up acknowledges it");
  console.log("Saved sort/draft filters, optional triage notes, collapsed follow-ups, and automatic Updated grouping passed.");

  await select(2);
  await page.locator("#detail").getByRole("button", { name: "Purgatory", exact: true }).click();
  await page.waitForFunction(() => Work.decisions.get("PR_2")?.status === "purgatory" && !Work.saving);
  assert.equal((await rows()).includes("acme/widgets#2"), false, "All excludes purgatory");
  await page.locator("#chips").getByRole("button", { name: /^Purgatory/ }).click();
  assert.deepEqual(await rows(), ["acme/widgets#2"]);
  assert.equal(fixture.items[1].state, "OPEN", "purgatory never closes on GitHub");
  fixture.items[1].headRefOid = "b".repeat(40);
  fixture.items[1].updatedAt = new Date(Date.now() + 3000).toISOString();
  await page.evaluate(() => Work.syncer.sync("acme/widgets"));
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_2").status), "purgatory", "updates do not wake purgatory");
  await page.reload();
  await ready();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await rendered();
  assert.equal(await page.locator('.row[data-key="acme/widgets#2"]').count(), 0, "purgatory is hidden from the board");
  await page.evaluate(() => Work.setQueue("purgatory"));
  await page.getByRole("button", { name: "Restore to inbox", exact: true }).click();
  await page.waitForFunction(() => Work.decisions.get("PR_2")?.status === "new" && !Work.saving);
  await page.evaluate(() => Work.setQueue("new"));
  assert.equal((await rows()).includes("acme/widgets#2"), true);
  assert.equal(await page.evaluate(() => Work.counts().purgatory), 0);
  const backup = await page.evaluate(() => Work.export());
  assert.equal(await page.evaluate((value) => WorkspaceStore.validate(value).decisions.some((item) => item.id === "PR_2" && item.status === "new"), backup), true);
  console.log("Purgatory isolation, update suppression, reload, restoration, and backup validation passed.");

  await page.evaluate(() => {
    const group = ensureGroup("Review next");
    pinByKey("acme/widgets#1").group = group.id;
    persistBoard();
    Work.setPage("board");
  });
  await page.getByLabel("Board grouping", { exact: true }).selectOption("manual");
  await rendered();
  assert.match(await page.locator("#board").innerText(), /Review next/);
  const groups = await page.evaluate(() => JSON.stringify(state.board));
  await page.reload();
  await ready();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.equal(await page.getByLabel("Board grouping", { exact: true }).inputValue(), "manual");
  await page.getByLabel("Board grouping", { exact: true }).selectOption("status");
  await page.locator('.group[data-lane="waiting"] .row[data-key="acme/widgets#1"]').waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify(state.board)), groups, "status grouping does not rewrite manual organization");
  await page.evaluate(async () => {
    await Work.decide(Work.ref("acme/widgets#4"), { status: "waiting", dueAt: new Date(Date.now() + 86400000).toISOString() }, { track: true, advance: false });
    await Work.decide(Work.ref("acme/widgets#5"), { status: "later", dueAt: new Date(Date.now() + 86400000).toISOString() }, { track: true, advance: false });
    await Work.decide(Work.ref("acme/widgets#6"), { status: "waiting", dueAt: new Date(Date.now() - 1000).toISOString() }, { track: true, advance: false });
    state.toasts = []; render();
  });
  await rendered();
  if (process.env.PINGBOARD_SCREENSHOTS) {
    await mkdir(process.env.PINGBOARD_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "board-status-groups.png") });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await rendered();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  if (process.env.PINGBOARD_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "inbox-options-mobile.png") });
  assert.deepEqual(errors, []);
  console.log("Manual groups remain intact; status groups, view preferences, and mobile layout passed.");
} catch (error) {
  console.log("Intake diagnostics", await page.evaluate(() => ({ error: Work.error, cursor: state.cursor, queue: Work.queue, page: state.page, prefs: state.prefs, board: document.querySelector("#board")?.innerText })).catch(() => null), errors);
  throw error;
} finally { await browser.close(); }
