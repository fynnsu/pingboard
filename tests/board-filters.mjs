import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { createFixture, installRoutes, seed, ORIGIN } from "./support/fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const browser = await chromium.launch(process.env.PINGBOARD_BROWSER_CHANNEL ? { channel: process.env.PINGBOARD_BROWSER_CHANNEL } : {});
const context = await browser.newContext();
const fixture = createFixture(3);
fixture.items[0].reviewRequests = { nodes: [{ requestedReviewer: { isViewer: true } }] };
await installRoutes(context, root, fixture);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const rendered = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await seed(page);
  await page.goto(ORIGIN);
  await page.waitForFunction(() => Work.ready && Work.meta.get("repo:acme/widgets")?.complete && !Work.syncer.running.size);
  assert.equal(await page.locator(".inbox-row").filter({ hasText: "Review requested" }).count(), 1, "inbox shows direct review requests");
  await page.evaluate(async () => {
    state.prefs.boardGrouping = "manual";
    await Work.decide(Work.ref("acme/widgets#1"), { status: "needs_me" }, { track: true, advance: false });
    await Work.decide(Work.ref("acme/widgets#2"), { status: "waiting", waitingFor: "ci", dueAt: new Date(Date.now() + 86400000).toISOString() }, { track: true, advance: false });
    addPin("acme/widgets", 3);
    Work.setPage("board");
  });
  await rendered();
  const select = page.getByRole("combobox", { name: "Triage status", exact: true });
  await select.focus();
  const original = await select.elementHandle();
  await page.evaluate(() => render());
  await rendered();
  const survivedRefresh = await original.evaluate((node) => node.isConnected && node === document.activeElement);

  // Native menus may consume pointerup outside the document. Unlike selectOption,
  // this exercises the pointerdown → change path through the render safeguard.
  await select.evaluate((node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    node.value = "waiting";
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await rendered();
  const changed = await page.evaluate(() => ({
    paused: pointerHeld || renderSkipped,
    queue: Work.boardQueue,
    rows: [...document.querySelectorAll("#board .row")].map((row) => row.dataset.key)
  }));
  assert.deepEqual({ survivedRefresh, ...changed }, {
    survivedRefresh: true, paused: false, queue: "waiting", rows: ["acme/widgets#2"]
  }, "the dropdown survives refresh and selecting an option immediately filters the board");

  await select.evaluate((node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  });
  await rendered();
  assert.equal(await page.evaluate(() => pointerHeld), false, "dismissing the native menu must also release rendering");
  await select.selectOption("needs_me");
  await rendered();
  assert.deepEqual(await page.locator("#board .row").evaluateAll((rows) => rows.map((row) => row.dataset.key)), ["acme/widgets#1"]);
  await select.selectOption("new");
  await rendered();
  assert.deepEqual(await page.locator("#board .row").evaluateAll((rows) => rows.map((row) => row.dataset.key)), ["acme/widgets#3"]);
  await select.selectOption("all");
  await rendered();
  assert.equal(await page.locator("#board .row").count(), 3);
  const refreshBefore = await page.evaluate(() => state.status.get("acme/widgets#1")?.at || 0);
  await page.evaluate(() => refreshAll());
  await page.waitForFunction((before) => (state.status.get("acme/widgets#1")?.at || 0) > before, refreshBefore);
  assert.ok(fixture.calls.some(({ pathname, body }) => pathname === "/graphql" && body.query.includes("pr0: repository") && body.query.includes("pr1: repository")), "pinned refreshes are batched");

  await page.evaluate(() => {
    const board = document.querySelector("#board");
    board.style.height = "120px";
    board.scrollTop = 50;
    render();
  });
  await rendered();
  assert.equal(await page.evaluate(() => document.querySelector("#board").scrollTop), 50, "board scroll position survives rerender");
  await page.locator('#board .row[data-key="acme/widgets#1"]').click();
  await rendered();
  await page.evaluate(() => {
    const detail = document.querySelector("#detail");
    detail.style.height = "120px";
    detail.scrollTop = 40;
    render();
  });
  await rendered();
  assert.equal(await page.evaluate(() => document.querySelector("#detail").scrollTop), 40, "detail scroll position survives rerender");

  const firstRow = page.locator('#board .row[data-key="acme/widgets#1"]');
  await firstRow.click();
  await rendered();
  const otherActivityAt = new Date(Date.now() + 1000).toISOString();
  fixture.items[0].comments.nodes.push({ id: "COMMENT_OTHER", author: { login: "alex", __typename: "User" }, createdAt: otherActivityAt, bodyText: "Please take a look", url: fixture.items[0].url });
  await page.evaluate(() => refreshAll());
  await page.waitForFunction((at) => state.data.get("acme/widgets#1")?.activityAt === at, otherActivityAt);
  await rendered();
  assert.equal(await firstRow.locator(".new-dot").count(), 1, "new activity lights the change dot");
  await firstRow.click();
  await rendered();
  assert.equal(await firstRow.locator(".new-dot").count(), 0, "selecting the PR acknowledges activity");

  const ownActivityAt = new Date(Date.now() + 2000).toISOString();
  fixture.items[0].comments.nodes.push({ id: "COMMENT_SELF", author: { login: fixture.login, __typename: "User" }, createdAt: ownActivityAt, bodyText: "My own follow-up", url: fixture.items[0].url });
  await page.evaluate(() => refreshAll());
  await page.waitForFunction(() => state.status.get("acme/widgets#1")?.loading === false);
  await rendered();
  assert.equal(await firstRow.locator(".new-dot").count(), 0, "the user's own activity does not light the change dot");

  // The same native event path is used by the repository selector.
  await page.getByRole("combobox", { name: "Repository", exact: true }).evaluate((node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    node.value = "";
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await rendered();
  assert.equal(await page.evaluate(() => pointerHeld || renderSkipped), false);
  assert.equal(await page.getByRole("combobox", { name: "Repository", exact: true }).inputValue(), "");
  assert.deepEqual(errors, []);
  console.log("Review requests, batched refreshes, activity dots, dropdown stability, and triage filtering passed.");
} finally { await browser.close(); }
