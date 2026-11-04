import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import { createFixture, installRoutes, seed, ORIGIN } from "./support/fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const browser = await chromium.launch(process.env.PINGBOARD_BROWSER_CHANNEL ? { channel: process.env.PINGBOARD_BROWSER_CHANNEL } : {});
const fixture = createFixture();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await installRoutes(context, root, fixture);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const ready = () => page.waitForFunction(() => Work.ready && Work.meta.get("repo:acme/widgets")?.complete && !Work.syncer.running.size);
const decide = (number, values) => page.evaluate(({ number, values }) => Work.decide(Work.ref(`acme/widgets#${number}`), values, { advance: false }), { number, values });
const sync = () => page.evaluate(() => Work.syncer.sync("acme/widgets"));
try {
  await seed(page);
  await page.goto(ORIGIN);
  await ready();
  assert.equal(await page.evaluate(() => Work.items.size), 57, "all pages discovered, beyond the old 30-result limit");
  assert.equal(await page.locator(".inbox-row").count(), 57);
  assert.equal(await page.evaluate(() => Work.decisions.size), 0, "opening a detail does not triage it");
  assert.equal(await page.evaluate(() => Work.counts().new), 57);
  assert.equal(await page.evaluate(() => [...Work.events.values()].filter((event) => event.kind === "arrival").length), 0, "initial backlog is not new arrival credit");
  console.log("Complete repository discovery and honest initial backlog passed.");

  await page.keyboard.press("t");
  await page.waitForFunction(() => Work.counts().new === 56 && !Work.saving);
  assert.equal(await page.evaluate(() => state.cursor), "acme/widgets#2", "triage advances to the next PR");
  assert.equal(await page.evaluate(() => Boolean(pinByKey("acme/widgets#1"))), true, "Take on adds the PR to the board");
  assert.equal(await page.evaluate(() => Workflow.progress([...Work.events.values()], Work.login).moved), 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => Work.counts().new === 57);
  assert.equal(await page.evaluate(() => Workflow.progress([...Work.events.values()], Work.login).moved), 0, "undo removes credit");
  assert.equal(await page.evaluate(() => Boolean(pinByKey("acme/widgets#1"))), false, "undo removes the pin introduced by Take on");
  await decide(1, { status: "needs_me" });
  await page.reload();
  await ready();
  assert.equal(await page.evaluate(() => Work.counts().new), 56, "decision survives reload");
  assert.equal(await page.evaluate(() => Workflow.progress([...Work.events.values()], Work.login).moved), 1, "history survives reload");

  const second = await context.newPage();
  await second.goto(ORIGIN);
  await second.waitForFunction(() => Work.ready);
  await decide(2, { status: "later", dueAt: new Date(Date.now() + 86400000).toISOString(), note: "Review after the release" });
  await second.waitForFunction(() => Work.decisions.get("PR_2")?.status === "later");
  await second.close();
  console.log("Keyboard triage, undo, reload, and cross-tab persistence passed.");

  await decide(3, { status: "waiting", waitingFor: "author", dueAt: new Date(Date.now() + 86400000).toISOString(), note: "Needs a reproduction" });
  fixture.items[2].comments.nodes.push({ id: "AUTHOR_REPLY", author: { login: "alex", __typename: "User" }, createdAt: new Date(Date.now() + 1000).toISOString(), bodyText: "Here is a reproduction.", url: fixture.items[2].url });
  fixture.items[2].updatedAt = new Date(Date.now() + 1000).toISOString();
  await sync();
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_3").status), "needs_me", "author reply resurfaces");
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_3").reason), "New reply");
  await page.evaluate(async () => {
    const decision = Work.decisions.get("PR_2");
    await Work.storage.put("decisions", { ...decision, dueAt: new Date(Date.now() - 1000).toISOString() });
    await Work.reload();
  });
  assert.equal(await page.evaluate(() => Workflow.queue(Work.items.get("PR_2"), Work.decisions.get("PR_2"))), "needs_me");

  fixture.items[0].state = "MERGED";
  fixture.items[0].mergedAt = fixture.items[0].closedAt = fixture.items[0].updatedAt = new Date().toISOString();
  fixture.items[0].mergedBy = { login: "another-maintainer" };
  await sync();
  await page.evaluate(() => { addPin("acme/widgets", 1); clearClosed(); removePin("acme/widgets#1"); });
  assert.equal(await page.evaluate(() => Work.items.get("PR_1").state), "MERGED");
  assert.equal(await page.evaluate(() => Work.decisions.has("PR_1")), true, "unpin and clear do not destroy decisions");
  assert.equal(await page.evaluate(() => Workflow.progress([...Work.events.values()], Work.login).merged), 1);
  await sync();
  assert.equal(await page.evaluate(() => [...Work.events.values()].filter((event) => event.kind === "resolved").length), 1, "sync does not duplicate outcomes");
  fixture.items[0].state = "OPEN";
  fixture.items[0].updatedAt = new Date(Date.now() + 2000).toISOString();
  await sync();
  assert.equal(await page.evaluate(() => Work.decisions.get("PR_1").reason), "PR reopened");
  console.log("Replies, reminders, external resolution, reopening, and retained history passed.");

  await page.evaluate(() => Work.setQueue("new"));
  const arrived = new Date(Date.now() + 3000).toISOString();
  fixture.items.push(fixture.makeItem(99, { createdAt: arrived, updatedAt: arrived }));
  await sync();
  assert.equal(await page.evaluate(() => Work.visible().some((item) => item.number === 99)), true, "arrivals join the continuous inbox");
  await page.evaluate(() => Work.storage.put("meta", { id: "session", itemIds: ["PR_4"], startedAt: new Date().toISOString() }));
  await page.reload();
  await ready();
  assert.equal(await page.getByRole("button", { name: /session/i }).count(), 0, "retired sessions cannot constrain the inbox after an upgrade");
  assert.equal(await page.evaluate(() => Work.visible().some((item) => item.number === 99)), true);
  assert.equal(await page.evaluate(async () => (await Work.export()).meta.some((record) => record.id === "session")), false);
  console.log("Continuous intake and compatibility with retired sessions passed.");

  fixture.failSecondPage = true;
  await sync();
  assert.equal(await page.evaluate(() => WorkUI.complete()), false);
  await page.getByRole("alert").filter({ hasText: "incomplete" }).waitFor();
  assert.match(await page.locator("#board").innerText(), /incomplete/);
  assert.equal(await page.evaluate(() => Work.items.size), 58, "partial failure retains known items");
  fixture.failSecondPage = false;
  await sync();
  assert.equal(await page.evaluate(() => WorkUI.complete()), true);

  await page.evaluate(() => { Work.queue = "all"; Work.select("acme/widgets#10"); });
  fixture.failComments = true;
  await page.getByRole("button", { name: "Respond · n", exact: true }).click();
  assert.deepEqual(await page.locator(".quick-duration").allTextContents(), ["1h", "3h", "1d", "3d", "1w"]);
  assert.equal(await page.getByRole("button", { name: "Remind me in 1d", exact: true }).getAttribute("aria-pressed"), "true", "Respond uses the same 1d quick reminder default");
  await page.getByLabel("Comment · posted publicly on GitHub").fill("Could you add a regression test?");
  await page.getByRole("button", { name: "Post response & wait", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Simulated comment rejection" }).waitFor();
  assert.equal(await page.evaluate(() => Work.decisions.has("PR_10")), false, "failed public action must not triage or advance");
  fixture.failComments = false;
  await page.getByRole("button", { name: "Post response & wait", exact: true }).click();
  await page.waitForFunction(() => Work.decisions.get("PR_10")?.status === "waiting");
  await sync();
  assert.equal(await page.evaluate(() => [...Work.events.values()].filter((event) => event.kind === "comment" && event.itemId === "PR_10").length), 1, "confirmed and synced comments deduplicate");

  await page.evaluate(() => { Work.queue = "all"; Work.select("acme/widgets#11"); });
  fixture.failClose = true;
  await page.getByRole("button", { name: "Close PR… · x", exact: true }).click();
  await page.getByLabel("Reason · posted publicly on GitHub").fill("Duplicate of #12; continuing the discussion there.");
  await page.getByRole("button", { name: "Post reason & close PR", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Simulated close rejection" }).waitFor();
  fixture.failClose = false;
  await page.getByRole("button", { name: "Post reason & close PR", exact: true }).click();
  await page.waitForFunction(() => Work.items.get("PR_11")?.state === "CLOSED");
  assert.equal(fixture.calls.filter((call) => call.pathname.endsWith("/issues/11/comments") && call.method === "POST").length, 1, "retrying a partial close must not duplicate the reason comment");
  console.log("Partial discovery, failed mutations, deduplication, and partial-action retry passed.");

  const closedWhileAway = new Date().toISOString();
  fixture.items.push(fixture.makeItem(100, { createdAt: closedWhileAway, updatedAt: closedWhileAway, closedAt: closedWhileAway, state: "CLOSED" }));
  await sync();
  assert.equal(await page.evaluate(() => Work.items.get("PR_100")?.state), "CLOSED", "discover a PR opened and closed between visits");
  const beforeFailure = await page.evaluate(() => Workflow.progress([...Work.events.values()], Work.login).moved);
  await page.evaluate(async () => {
    const save = Work.storage.decide;
    Work.storage.decide = async () => { throw new Error("Simulated disk full"); };
    await Work.decide(Work.ref("acme/widgets#20"), { status: "needs_me" });
    Work.storage.decide = save;
  });
  assert.equal(await page.evaluate(() => Work.decisions.has("PR_20")), false);
  assert.equal(await page.evaluate(() => Workflow.progress([...Work.events.values()], Work.login).moved), beforeFailure, "failed local saves cannot earn progress");
  await page.getByRole("button", { name: "Retry local storage", exact: true }).click();
  await page.waitForFunction(() => !Work.error);
  await page.evaluate(async () => {
    const put = Work.storage.put;
    Work.storage.put = async () => { throw new Error("Simulated event write failure"); };
    await Work.record(Work.items.get("PR_21"), "route", { id: "confirmed-but-unsaved", message: "Requested review" });
    Work.storage.put = put;
  });
  assert.equal(await page.evaluate(() => Work.events.has("confirmed-but-unsaved")), false);
  assert.equal(await page.evaluate(async () => (await Work.export()).events.some((event) => event.id === "confirmed-but-unsaved")), true, "export preserves a confirmed action when the event write failed");
  await page.getByRole("button", { name: "Retry local storage", exact: true }).click();
  await page.waitForFunction(() => !Work.error && Work.events.has("confirmed-but-unsaved"));
  console.log("Offline catch-up and failed local save integrity passed.");

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => exportBoard());
  const download = await downloadPromise;
  const backup = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(backup.pingboard, 2);
  assert.ok(backup.workspace.events.length > 0);
  assert.equal(JSON.stringify(backup).includes("test-token-never-sent"), false, "backup must not contain token");
  const malformed = structuredClone(backup.workspace);
  malformed.items[0].labels = "invalid";
  assert.equal(await page.evaluate((value) => { try { WorkspaceStore.validate(value); return false; } catch { return true; } }, malformed), true, "reject malformed backups before mutation");
  const freshContext = await browser.newContext();
  await installRoutes(freshContext, root, fixture);
  const fresh = await freshContext.newPage();
  await seed(fresh);
  await fresh.goto(ORIGIN);
  await fresh.waitForFunction(() => Work.ready);
  await fresh.evaluate(async (backup) => { await Work.import(backup.workspace, true); }, backup);
  assert.equal(await fresh.evaluate(() => Work.decisions.get("PR_10")?.status), "waiting");
  assert.ok(await fresh.evaluate(() => Work.events.size) >= backup.workspace.events.length);
  await freshContext.close();
  console.log("Token-free export and restore into a fresh browser passed.");

  if (process.env.PINGBOARD_SCREENSHOTS) {
    await mkdir(process.env.PINGBOARD_SCREENSHOTS, { recursive: true });
    await page.evaluate(() => { Work.queue = "new"; Work.setPage("inbox"); });
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "inbox.png") });
    await page.getByRole("button", { name: "Progress", exact: true }).click();
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "progress.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "progress-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => Work.setPage("inbox"));
    await page.screenshot({ path: path.join(process.env.PINGBOARD_SCREENSHOTS, "mobile.png") });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "page should not overflow horizontally");
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => { Work.setPage("inbox"); openSettings(); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "settings should fit a narrow viewport");
  await page.evaluate(() => closeModal());
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log("Workspace release checks passed.");
} catch (error) {
  console.log("Browser diagnostics", await page.evaluate(() => ({ error: Work.error, ready: Work.ready, saving: Work.saving, cursor: state.cursor, page: state.page, focus: document.activeElement?.tagName, counts: Work.counts(), decisions: [...Work.decisions.values()], toasts: state.toasts.map((toast) => toast.message) })).catch(() => null), errors);
  throw error;
} finally { await browser.close(); }
