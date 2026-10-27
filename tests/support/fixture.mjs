import { readFile } from "node:fs/promises";
import path from "node:path";

export const ORIGIN = "http://pingboard.test";
export function createFixture(total = 57) {
  const now = Date.now();
  const fixture = { login: "maintainer", repo: "acme/widgets", failSecondPage: false, failClose: false, failComments: false, calls: [], items: [] };
  const titles = ["Fix a race when refreshing the cache", "Add support for streaming responses", "Improve error messages for invalid configuration", "Document the deployment workflow", "Reduce allocations in the request scheduler", "Handle empty batches without a crash"];
  fixture.makeItem = (number, extra = {}, repo = fixture.repo) => ({
    id: repo === fixture.repo ? `PR_${number}` : `PR_${repo}_${number}`, number, title: titles[(number - 1) % titles.length] + ` (#${number})`,
    repository: { nameWithOwner: repo },
    url: `https://github.com/${repo}/pull/${number}`, state: "OPEN", isDraft: number % 7 === 0,
    createdAt: new Date(now - (total + 1 - number) * 86400000).toISOString(),
    updatedAt: new Date(now - number * 60000).toISOString(), closedAt: null, mergedAt: null, mergedBy: null,
    author: { login: number % 2 ? "alex" : "sam", __typename: "User" }, authorAssociation: "CONTRIBUTOR",
    headRefOid: "a".repeat(40), baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "REVIEW_REQUIRED",
    viewerCanUpdateBranch: true, autoMergeRequest: null,
    additions: number * 12, deletions: number * 3, changedFiles: number % 8 + 1,
    bodyText: "This change fixes a problem reported by a contributor.\n\nThe previous implementation could leave requests waiting indefinitely. The new behavior handles the empty queue and includes regression coverage.\n\nTesting: existing suite and a focused reproduction both pass.",
    labels: { nodes: [{ name: number % 2 ? "bug" : "enhancement", color: number % 2 ? "d73a4a" : "a2eeef" }] },
    latestOpinionatedReviews: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] },
    closingIssuesReferences: { nodes: number === 1 ? [{ number: 88, title: "Requests hang on an empty queue", url: `https://github.com/${repo}/issues/88` }] : [] },
    commits: { nodes: [{ commit: { oid: "a".repeat(40), committedDate: new Date(now - 60000).toISOString(), statusCheckRollup: null } }] },
    ...extra
  });
  fixture.items = Array.from({ length: total }, (_, index) => fixture.makeItem(index + 1));
  fixture.repositories = new Map([[fixture.repo, fixture.items]]);
  fixture.addRepository = (repo, count = 4) => {
    const items = Array.from({ length: count }, (_, index) => fixture.makeItem(index + 1, {
      title: `${repo.split("/")[1]}: ${titles[index % titles.length]}`,
      bodyText: `A change to ${repo}. This repository has its own PRs, triage decisions, and CI board.`
    }, repo));
    fixture.repositories.set(repo, items);
    return items;
  };
  fixture.api = ({ pathname, method = "GET", body = {} }) => {
    fixture.calls.push({ pathname, method, body });
    if (pathname === "/user") return { json: { login: fixture.login } };
    if (pathname === "/graphql") {
      const { query, variables = {} } = body;
      const repo = `${variables.owner}/${variables.name}`;
      const repositoryItems = fixture.repositories.get(repo);
      if (variables.owner && !repositoryItems) return { json: { errors: [{ message: `Mock repository ${repo} is not configured.` }] } };
      if (query.includes("PingboardInventory")) {
        if (fixture.failSecondPage && variables.cursor) return { status: 503, json: { message: "Simulated second page failure" } };
        const field = variables.order?.field === "CREATED_AT" ? "createdAt" : "updatedAt";
        const direction = variables.order?.direction === "ASC" ? 1 : -1;
        const items = repositoryItems.filter((item) => !variables.states || variables.states.includes(item.state)).sort((a, b) => direction * (new Date(a[field]) - new Date(b[field])));
        const offset = Number(variables.cursor || 0);
        const size = variables.pageSize || 50;
        const nodes = items.slice(offset, offset + size);
        return { json: { data: { repository: { pullRequests: { totalCount: items.length, nodes, pageInfo: { hasNextPage: offset + size < items.length, endCursor: String(offset + size) } } } } } };
      }
      if (query.includes("PingboardReconcile")) return { json: { data: { nodes: variables.ids.map((id) => [...fixture.repositories.values()].flat().find((item) => item.id === id) || null) } } };
      if (query.includes("pullRequest(number:")) return { json: { data: { repository: { ref: { compare: { aheadBy: 1, behindBy: 0 } }, pullRequest: repositoryItems.find((item) => item.number === variables.number) } } } };
      if (query.includes("history(first:")) return { json: { data: { repository: { ref: { target: { history: { nodes: [] } } } } } } };
      if (query.includes("search(")) {
        const searchRepo = variables.query.match(/repo:([^\s]+)/)?.[1];
        const items = searchRepo ? fixture.repositories.get(searchRepo) || [] : [...fixture.repositories.values()].flat();
        return { json: { data: { search: { issueCount: items.length, nodes: items.slice(0, 30) } } } };
      }
      return { json: { data: { repository: { object: null } } } };
    }
    const match = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(?:pulls|issues)\/(\d+)/);
    const item = match && fixture.repositories.get(match[1])?.find((item) => item.number === Number(match[2]));
    if (match && !item) return { status: 404, json: { message: "Mock PR not found in this repository." } };
    if (pathname.endsWith("/comments") && method === "POST") {
      if (fixture.failComments) return { status: 422, json: { message: "Simulated comment rejection" } };
      const id = `COMMENT_${fixture.calls.length}`;
      const at = new Date().toISOString();
      item.comments.nodes.push({ id, author: { login: fixture.login, __typename: "User" }, createdAt: at, bodyText: body.body, url: item.url });
      item.updatedAt = at;
      return { json: { node_id: id, created_at: at } };
    }
    if (method === "PATCH" && body.state === "closed") {
      if (fixture.failClose) return { status: 422, json: { message: "Simulated close rejection" } };
      item.state = "CLOSED";
      item.updatedAt = item.closedAt = new Date().toISOString();
      return { json: { state: "closed", closed_at: item.closedAt, updated_at: item.updatedAt } };
    }
    if (pathname.endsWith("/merge")) {
      item.state = "MERGED";
      item.updatedAt = item.closedAt = item.mergedAt = new Date().toISOString();
      item.mergedBy = { login: fixture.login };
      return { json: { merged: true } };
    }
    if (pathname.endsWith("/reviews") && method === "POST") {
      const at = new Date().toISOString();
      const id = `REVIEW_${fixture.calls.length}`;
      item.reviews.nodes.push({ id, author: { login: fixture.login }, submittedAt: at, state: "APPROVED" });
      return { json: { node_id: id, submitted_at: at } };
    }
    return { json: {} };
  };
  return fixture;
}

export async function installRoutes(context, root, fixture) {
  await context.route("**/*", (route) => route.abort());
  await context.route("https://api.github.com/**", (route) => {
    const request = route.request();
    const result = fixture.api({ pathname: new URL(request.url()).pathname, method: request.method(), body: JSON.parse(request.postData() || "{}") });
    if (result.abort) return route.abort("failed");
    return route.fulfill({ status: result.status || 200, json: result.json, headers: { "access-control-allow-origin": "*", ...result.headers } });
  });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/__blank") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    try {
      const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream";
      await route.fulfill({ body: await readFile(file), contentType });
    } catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
}

export async function seed(page, login = "maintainer", repo = "acme/widgets") {
  await page.goto(`${ORIGIN}/__blank`);
  await page.evaluate(({ login, repo }) => {
    localStorage.setItem("pingboard.githubToken", "test-token-never-sent-to-github");
    localStorage.setItem(`pingboard.v3.${login}.prefs`, JSON.stringify({ defaultRepo: repo, trackedRepos: [repo], dailyGoal: 3, interval: 60 }));
  }, { login, repo });
}
