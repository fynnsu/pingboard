"use strict";

/* Repository enumeration is deliberately independent of the expensive CI detail
   query. Full open scans reconcile removals; overlapping updated scans also find
   PRs opened and closed while the browser was away. */
const INVENTORY_FIELDS = `
  id number title url state isDraft createdAt updatedAt closedAt mergedAt
  author { login } mergedBy { login } headRefOid reviewDecision
  additions deletions changedFiles labels(first: 20) { nodes { name color } }
  comments(last: 5) { nodes { id author { login __typename } createdAt bodyText } }
  reviews(last: 5) { nodes { id author { login } submittedAt state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
const INVENTORY_QUERY = `query PingboardInventory($owner: String!, $name: String!, $cursor: String, $states: [PullRequestState!], $pageSize: Int!, $order: IssueOrder!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $pageSize, after: $cursor, states: $states, orderBy: $order) {
      nodes { ${INVENTORY_FIELDS} }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const INVENTORY_NODES_QUERY = `query PingboardReconcile($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { ${INVENTORY_FIELDS} } } }`;

function inventoryItem(node, repo) {
  return {
    id: node.id, kind: "pr", key: `${repo}#${node.number}`, repo, number: node.number,
    title: node.title, url: node.url, state: node.state, isDraft: node.isDraft,
    author: node.author?.login || "ghost", createdAt: node.createdAt, updatedAt: node.updatedAt,
    closedAt: node.closedAt, mergedAt: node.mergedAt, mergedBy: node.mergedBy?.login,
    headOid: node.headRefOid, reviewDecision: node.reviewDecision,
    additions: node.additions, deletions: node.deletions, files: node.changedFiles,
    labels: node.labels?.nodes || [],
    comments: (node.comments?.nodes || []).map((comment) => ({ id: comment.id, login: comment.author?.login, bot: comment.author?.__typename === "Bot", at: comment.createdAt, text: (comment.bodyText || "").slice(0, 700) })),
    reviews: (node.reviews?.nodes || []).map((review) => ({ id: review.id, login: review.author?.login, at: review.submittedAt, state: review.state })),
    rollup: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null
  };
}

class RepositorySync {
  constructor({ query, observe, metadata, saveMetadata, items, changed, pause, paceMs = 250, retryDelays = [1000, 2000, 4000], timeoutMs = 20000 }) {
    Object.assign(this, { query, observe, metadata, saveMetadata, items, changed });
    Object.assign(this, { paceMs, retryDelays, timeoutMs });
    this.running = new Map();
    this.status = new Map();
    this.requests = Promise.resolve();
    this.controllers = new Set();
    this.waiters = new Set();
    this.pause = pause || ((ms) => new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
    }));
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    for (const finish of this.waiters) finish();
  }
  update(repo, values) {
    this.status.set(repo, { ...this.status.get(repo), ...values });
    this.changed();
  }
  async sync(repo) {
    if (this.stopped) return;
    if (this.running.has(repo)) return this.running.get(repo);
    const retryAt = this.metadata(repo)?.retryAt;
    if (retryAt > Date.now()) {
      this.update(repo, { busy: false, error: "GitHub asked discovery to wait before retrying.", retryAt });
      return;
    }
    const task = Promise.resolve().then(() => this.scan(repo));
    this.running.set(repo, task);
    try { await task; } finally {
      this.running.delete(repo);
      if (!this.stopped) this.update(repo, { attempt: Date.now() });
    }
  }
  // Only discovery reads are retried. Mutations never pass through this path.
  async read(repo, query, variables, scan) {
    for (let attempt = 0; ; attempt += 1) {
      if (this.stopped) throw new Error("Discovery stopped");
      try {
        // Serialize discovery across repositories and leave a short gap between
        // requests instead of issuing several expensive inventories together.
        const task = this.requests.catch(() => {}).then(async () => {
          await this.pause(this.paceMs);
          if (this.stopped) throw new Error("Discovery stopped");
          const controller = new AbortController();
          this.controllers.add(controller);
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
          const input = variables();
          try {
            const data = await this.query(query, input, { signal: controller.signal });
            return { data, variables: input };
          } catch (error) {
            if (timedOut && !this.stopped) throw Object.assign(new Error("GitHub discovery request timed out."), { retryable: true });
            throw error;
          } finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
          }
        });
        this.requests = task;
        const result = await task;
        this.update(repo, { retry: 0, retryAt: null });
        return result;
      } catch (error) {
        if (this.stopped || error.retryAt || !error.retryable || attempt >= this.retryDelays.length) throw error;
        scan.pageSize = Math.max(5, Math.floor(scan.pageSize / 2));
        const delay = this.retryDelays[attempt];
        this.update(repo, { retry: attempt + 1, retryAt: Date.now() + delay, pageSize: scan.pageSize });
        await this.pause(delay);
      }
    }
  }
  async scan(repo) {
    let meta;
    let scan;
    try {
      meta = this.metadata(repo);
      if (!meta) {
        meta = { id: `repo:${repo}`, repo, startedAt: new Date().toISOString(), complete: false, lastSync: null };
      }
      // An old cursor may no longer be valid. Saved PRs and history remain intact
      // when a scan needs to restart; normal retries/reloads resume the last page.
      scan = meta.scan?.version === 1 && Date.now() - Date.parse(meta.scan.startedAt) < 86400000
        ? structuredClone(meta.scan)
        : { version: 1, startedAt: new Date().toISOString(), stage: "open", cursor: null,
          cursors: [], openIds: [], reconciledIds: [], pageSize: 20, total: null };
      const checkpoint = async () => {
        if (this.stopped) return;
        meta = { ...meta, complete: false, retryAt: null, scan: structuredClone(scan) };
        await this.saveMetadata(meta);
      };
      this.update(repo, { busy: true, count: scan.openIds.length, total: scan.total, stage: scan.stage, error: "", retry: 0, retryAt: null, pageSize: scan.pageSize });
      await checkpoint();
      const [owner, name] = repo.split("/");
      const openIds = new Set(scan.openIds);
      while (!this.stopped && scan.stage !== "reconcile") {
        const open = scan.stage === "open";
        const cutoff = open ? null : Date.parse(meta.lastSync || meta.startedAt) - 5 * 60 * 1000;
        const { data } = await this.read(repo, INVENTORY_QUERY, () => ({ owner, name, cursor: scan.cursor,
          states: open ? ["OPEN"] : null, pageSize: scan.pageSize,
          order: { field: open ? "CREATED_AT" : "UPDATED_AT", direction: open ? "ASC" : "DESC" }
        }), scan);
        if (this.stopped) return;
        const connection = data.repository?.pullRequests;
        if (!connection?.pageInfo || !Array.isArray(connection.nodes) || connection.nodes.some((node) => !node?.id)) throw new Error("GitHub returned an incomplete repository page. Retry to finish discovery.");
        const nodes = connection.nodes.filter((node) => cutoff === null || Date.parse(node.updatedAt) >= cutoff);
        const finished = !connection.pageInfo.hasNextPage || nodes.length < connection.nodes.length;
        const cursor = connection.pageInfo.endCursor;
        if (!finished && (!cursor || cursor === scan.cursor || scan.cursors.includes(cursor))) throw new Error("GitHub pagination did not advance. Retry to finish discovery.");
        await this.observe(nodes.map((node) => inventoryItem(node, repo)), meta);
        if (open) {
          for (const node of nodes) openIds.add(node.id);
          scan.openIds = [...openIds];
          scan.total = Number.isInteger(connection.totalCount) ? connection.totalCount : null;
        }
        if (finished) { scan.stage = open ? "updated" : "reconcile"; scan.cursor = null; scan.cursors = []; }
        else { scan.cursor = cursor; scan.cursors.push(cursor); }
        // Commit the cursor only after the page's observations were saved.
        await checkpoint();
        this.update(repo, { count: openIds.size, total: scan.total, stage: scan.stage });
      }
      while (!this.stopped) {
        const missing = this.items().filter((item) => item.repo === repo && item.state === "OPEN" && !openIds.has(item.id) && !scan.reconciledIds.includes(item.id));
        if (!missing.length) break;
        const { data, variables } = await this.read(repo, INVENTORY_NODES_QUERY, () => ({ ids: missing.slice(0, scan.pageSize).map((item) => item.id) }), scan);
        if (this.stopped) return;
        if (!Array.isArray(data.nodes) || data.nodes.length !== variables.ids.length || data.nodes.some((node) => !node?.id || !variables.ids.includes(node.id))) throw new Error("Some tracked PRs could not be read. Discovery is incomplete; check repository access.");
        await this.observe(data.nodes.map((node) => inventoryItem(node, repo)), meta);
        scan.reconciledIds.push(...variables.ids);
        await checkpoint();
      }
      if (this.stopped) return;
      await this.saveMetadata({ ...meta, lastSync: scan.startedAt, complete: true, scan: null, retryAt: null });
      this.update(repo, { busy: false, count: openIds.size, error: "", retry: 0, retryAt: null });
    } catch (error) {
      if (this.stopped) return;
      // Persist the smaller batch and any GitHub cooldown along with the last
      // successful cursor. A failed request never advances the scan watermark.
      try { if (meta && scan) await this.saveMetadata({ ...meta, complete: false, scan, retryAt: error.retryAt || null }); }
      catch { /* Observed pages are still saved; do not claim a complete scan. */ }
      this.update(repo, { busy: false, error: error.message, retry: 0,
        retryAt: error.retryAt || (error.retryable ? Date.now() + 30000 : null) });
    }
  }
}
