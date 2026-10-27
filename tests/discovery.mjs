import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { createFixture, installRoutes, seed, ORIGIN } from "./support/fixture.mjs";

const root = path.resolve(process.argv[process.argv.indexOf("--head") + 1] || "..");
const browser = await chromium.launch(process.env.PINGBOARD_BROWSER_CHANNEL ? { channel: process.env.PINGBOARD_BROWSER_CHANNEL } : {});
const context = await browser.newContext();
const fixture = createFixture(65);
const api = fixture.api;
const calls = [];
let failures = 1;
let rateLimited = false;
fixture.api = (request) => {
  const { query = "", variables = {} } = request.body;
  if (query.includes("PingboardInventory")) {
    calls.push(variables);
    if (rateLimited) return { status: 429, headers: { "retry-after": "60" }, json: { message: "Secondary rate limit. Wait before retrying." } };
    if (variables.states && variables.cursor === "20" && failures > 0) { failures -= 1; return { abort: true }; }
  }
  return api(request);
};
await installRoutes(context, root, fixture);
const page = await context.newPage();
page.setDefaultTimeout(20000);
try {
  await seed(page);
  await page.goto(ORIGIN);
  await page.waitForFunction(() => Work.meta.get("repo:acme/widgets")?.complete && !Work.syncer.running.size);
  assert.equal(await page.evaluate(() => Work.items.size), 65);
  assert.equal(calls.filter((call) => call.states && call.cursor === null).length, 1);
  assert.deepEqual(calls.filter((call) => call.states && call.cursor === "20").map((call) => call.pageSize), [20, 10]);

  failures = Infinity;
  await page.evaluate(() => Work.syncer.sync("acme/widgets"));
  assert.equal(await page.evaluate(() => Work.meta.get("repo:acme/widgets").scan.cursor), "20");
  await page.getByRole("alert").filter({ hasText: "Saved progress will resume" }).waitFor();
  assert.equal(await page.evaluate(() => WorkUI.complete()), false);
  const before = calls.length;
  failures = 0;
  await page.reload();
  await page.waitForFunction(() => Work.meta.get("repo:acme/widgets")?.complete && !Work.syncer.running.size);
  assert.equal(calls[before].cursor, "20", "reload resumes at the saved cursor");
  assert.equal(await page.evaluate(() => Work.items.size), 65);
  assert.equal(await page.evaluate(() => [...Work.events.values()].filter((event) => event.kind === "arrival").length), 0, "replayed pages do not fabricate arrivals");

  rateLimited = true;
  const limited = calls.length;
  await page.evaluate(() => Work.syncer.sync("acme/widgets"));
  await page.evaluate(() => Work.syncer.sync("acme/widgets"));
  assert.equal(calls.length - limited, 1, "manual retry respects Retry-After");
  assert.ok(await page.evaluate(() => Work.meta.get("repo:acme/widgets").retryAt) > Date.now());
  await page.reload();
  await page.waitForFunction(() => Work.ready && Work.syncer);
  assert.equal(calls.length - limited, 1, "reload also respects the persisted cooldown");
  console.log("Browser discovery: fetch abort recovery, adaptive pagination, reload resume, event integrity, and GitHub cooldown passed.");
} finally { await browser.close(); }
