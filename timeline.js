"use strict";

// GitHub history is a cache, separate from personal workflow/credited activity.
// https://docs.github.com/en/graphql/reference/pulls#pullrequest
const TIMELINE_QUERY = `query PingboardTimeline($id: ID!, $since: DateTime!, $cursor: String) {
  node(id: $id) { ... on PullRequest {
    timelineItems(first: 50, after: $cursor, since: $since, itemTypes: [
      CLOSED_EVENT, MERGED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT,
      CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_DISMISSED_EVENT,
      PULL_REQUEST_REVIEW, ISSUE_COMMENT, PULL_REQUEST_COMMIT,
      HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT
    ]) {
      nodes {
        __typename
        ... on ClosedEvent { id createdAt actor { login } }
        ... on MergedEvent { id createdAt actor { login } }
        ... on ReopenedEvent { id createdAt actor { login } }
        ... on ReadyForReviewEvent { id createdAt actor { login } }
        ... on ConvertToDraftEvent { id createdAt actor { login } }
        ... on ReviewRequestedEvent { id createdAt actor { login } }
        ... on ReviewDismissedEvent { id createdAt actor { login } }
        ... on HeadRefForcePushedEvent { id createdAt actor { login } }
        ... on LabeledEvent { id createdAt actor { login } label { name } }
        ... on UnlabeledEvent { id createdAt actor { login } label { name } }
        ... on IssueComment { id createdAt author { login } bodyText url }
        ... on PullRequestReview { id submittedAt author { login } state bodyText url }
        ... on PullRequestCommit { id commit { committedDate messageHeadline url author { name user { login } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const TIMELINE_CLOSED_QUERY = `query PingboardTimelineClosed($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 20, after: $cursor, states: [CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { id number title url state isDraft createdAt updatedAt closedAt mergedAt author { login } mergedBy { login } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const Timeline = {
  day: 86400000,
  range(days, now = Date.now()) {
    const end = new Date(now); end.setHours(24, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - days);
    const weeks = [], tick = new Date(start);
    while (+tick < +end) { if (tick.getDay() === 1) weeks.push(tick.toISOString()); tick.setDate(tick.getDate() + 1); }
    return { start: +start, end: +end, now, days, width: days * 22, weeks };
  },
  normalize(node) {
    const types = {
      ClosedEvent: ["closed", "Closed"], MergedEvent: ["merged", "Merged"], ReopenedEvent: ["reopened", "Reopened"],
      ReadyForReviewEvent: ["ready", "Ready for review"], ConvertToDraftEvent: ["draft", "Converted to draft"],
      ReviewRequestedEvent: ["review", "Review requested"], ReviewDismissedEvent: ["review", "Review dismissed"],
      HeadRefForcePushedEvent: ["commit", "Force-pushed"], LabeledEvent: ["label", "Label added"], UnlabeledEvent: ["label", "Label removed"],
      IssueComment: ["comment", "Comment"], PullRequestReview: ["review", { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Reviewed", DISMISSED: "Dismissed review" }[node.state] || "Review"],
      PullRequestCommit: ["commit", "Commit"]
    };
    const type = types[node.__typename];
    const at = node.submittedAt || node.createdAt || node.commit?.committedDate;
    if (!type || !node.id || !Number.isFinite(Date.parse(at)) || node.state === "PENDING") return null;
    return { id: node.id, kind: type[0], label: type[1], at, actor: node.actor?.login || node.author?.login || node.commit?.author?.user?.login || node.commit?.author?.name || "",
      message: (node.bodyText || node.label?.name || (node.commit ? `${node.commit.messageHeadline}\nCommit timestamp; may precede its push to this PR.` : "")).slice(0, 700), url: node.url || node.commit?.url || "" };
  },
  events(item, history, localEvents = [], currentDecision = null) {
    const events = new Map((history?.events || []).map((event) => [event.id, event]));
    events.set(`${item.id}:opened`, { id: `${item.id}:opened`, kind: "opened", label: "Opened", at: item.createdAt, actor: item.author });
    const end = item.mergedAt || item.closedAt;
    const kind = item.state === "MERGED" ? "merged" : "closed";
    if (item.state !== "OPEN" && end && ![...events.values()].some((event) => event.kind === kind && event.at === end)) {
      events.set(`${item.id}:end`, { id: `${item.id}:end`, kind, label: kind === "merged" ? "Merged" : "Closed", at: end, actor: item.mergedBy });
    }
    // These are private decisions made in Pingboard, never inferred from GitHub.
    const latestLocal = [...localEvents]
      .filter((event) => event.itemId === item.id && !event.reverted && event.source !== "github" && ["triage", "followup", "restore"].includes(event.kind))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
      .at(-1);
    const waitingLabels = { author: "Author", reviewer: "Reviewer", ci: "CI" };
    for (const event of localEvents) {
      if (event.itemId !== item.id || event.reverted || event.source === "github" || !["triage", "followup", "restore"].includes(event.kind)) continue;
      const rawDetails = (event.message || "").split(" · ").slice(1).join(" · ");
      const additions = latestLocal?.id === event.id && currentDecision ? [
        currentDecision.status === "waiting" && currentDecision.waitingFor ? `Waiting for ${waitingLabels[currentDecision.waitingFor] || currentDecision.waitingFor}` : null,
        currentDecision.dueAt ? `Follow up ${new Date(currentDecision.dueAt).toLocaleString()}` : null
      ].filter((detail) => detail && !rawDetails.includes(detail)) : [];
      const details = [rawDetails, ...additions].filter(Boolean).join(" · ");
      events.set(event.id, { id: event.id, kind: "local", label: event.kind === "restore" ? "Restored to inbox" : `Triage: ${event.message?.split(" · ")[0] || "follow-up"}`,
        at: event.at, actor: event.actor, message: details || event.message || "Personal Pingboard decision" });
    }
    return [...events.values()].filter((event) => Number.isFinite(Date.parse(event.at)) && (event.kind !== "commit" || Date.parse(event.at) >= Date.parse(item.createdAt))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  },
  position(at, range) { return Math.max(0, Math.min(range.width, (Date.parse(at) - range.start) / (range.end - range.start) * range.width)); },
  clusters(events, range) {
    const clusters = [];
    for (const event of events) {
      if (Date.parse(event.at) < range.start || Date.parse(event.at) > Math.min(range.end, range.now)) continue;
      const x = this.position(event.at, range);
      const last = clusters.at(-1);
      if (last && x - last.x < 18) last.events.push(event);
      else clusters.push({ x, events: [event] });
    }
    return clusters;
  },
  segments(item, events, range) {
    const end = item.state === "OPEN" ? range.now : Date.parse(item.mergedAt || item.closedAt || item.updatedAt);
    const start = Math.max(Date.parse(item.createdAt), range.start);
    const changes = events.filter((event) => ["closed", "merged", "reopened"].includes(event.kind) && Date.parse(event.at) >= start && Date.parse(event.at) <= end);
    let active = changes[0]?.kind !== "reopened";
    let from = start;
    const segments = [];
    for (const event of [...changes, { at: new Date(end).toISOString(), kind: "end" }]) {
      const to = Math.min(Date.parse(event.at), range.end);
      if (to > from) segments.push({ x: this.position(new Date(from).toISOString(), range), width: (to - from) / (range.end - range.start) * range.width, active });
      from = to; active = event.kind === "reopened";
    }
    return segments;
  }
};

class TimelineSync {
  constructor({ reader, records, save, observe, changed, active }) {
    Object.assign(this, { reader, records, save, observe, changed, active });
    this.errors = new Map();
    this.desired = { items: [], repos: [], since: "" };
    this.busy = false;
    this.stopped = false;
  }
  stop() { this.stopped = true; }
  ensure(desired) {
    this.desired = desired;
    const { items, repos, since } = desired;
    const pending = items.some((item) => !this.errors.has(item.id) && !this.fresh(this.records().get(item.id), since, item))
      || repos.some((repo) => !this.errors.has(`repo:${repo}`) && !this.fresh(this.records().get(`repo:${repo}`), since));
    if (pending && !this.busy && !this.stopped) this.task = this.run();
  }
  retry() { this.errors.clear(); this.ensure(this.desired); }
  fresh(record, since, item) {
    return record?.complete && Date.parse(record.since) <= Date.parse(since)
      && Date.now() - Date.parse(record.syncedAt) < 10 * 60000
      && (!item || record.sourceUpdatedAt === item.updatedAt);
  }
  async run() {
    this.busy = true;
    try {
      while (!this.stopped && this.active()) {
        const { items, repos, since } = this.desired;
        const item = items.find((item) => !this.errors.has(item.id) && !this.fresh(this.records().get(item.id), since, item));
        const repo = repos.find((repo) => !this.errors.has(`repo:${repo}`) && !this.fresh(this.records().get(`repo:${repo}`), since));
        if (!item && !repo) break;
        const id = item?.id || `repo:${repo}`;
        this.current = item ? `${item.repo}#${item.number}` : repo;
        this.changed();
        try { await this.page(item, repo, since); }
        catch (error) { if (!this.stopped) this.errors.set(id, { message: error.message, retryAt: error.retryAt || 0 }); }
      }
    } finally { this.busy = false; this.current = ""; if (!this.stopped) this.changed(); }
  }
  async page(item, repo, since) {
    const id = item?.id || `repo:${repo}`;
    repo = item?.repo || repo;
    const old = this.records().get(id);
    // Resume incomplete pages; refresh complete histories from the start to also
    // reconcile edited/deleted comments. A wider range needs a new scan.
    const resume = old && !old.complete && old.since === since && Date.now() - Date.parse(old.updatedAt) < Timeline.day;
    const record = resume ? { ...old } : { id, repo, kind: item ? "pr" : "inventory", since, cursor: null, complete: false, events: [] };
    const [owner, name] = repo.split("/");
    const { data } = await this.reader.read(`timeline:${id}`, item ? TIMELINE_QUERY : TIMELINE_CLOSED_QUERY,
      () => item ? { id, since: record.since, cursor: record.cursor } : { owner, name, cursor: record.cursor }, { pageSize: 20 });
    if (this.stopped) return;
    const connection = item ? data.node?.timelineItems : data.repository?.pullRequests;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error("GitHub returned incomplete timeline data.");
    const { hasNextPage, endCursor } = connection.pageInfo;
    if (hasNextPage && (!endCursor || endCursor === record.cursor)) throw new Error("GitHub did not advance the timeline page.");
    let done = !hasNextPage;
    if (item) {
      const events = new Map(record.events.map((event) => [event.id, event]));
      for (const node of connection.nodes) { const event = node && Timeline.normalize(node); if (event) events.set(event.id, event); }
      record.events = [...events.values()];
      record.sourceUpdatedAt = item.updatedAt;
    } else {
      const nodes = connection.nodes.filter(Boolean);
      done ||= nodes.some((node) => Date.parse(node.updatedAt) < Date.parse(since));
      await this.observe(nodes.filter((node) => Date.parse(node.mergedAt || node.closedAt) >= Date.parse(since)).map((node) => inventoryItem(node, repo)));
    }
    const now = new Date().toISOString();
    Object.assign(record, { cursor: done ? null : endCursor, complete: done, syncedAt: done ? now : null, updatedAt: now });
    await this.save(record);
    this.changed();
  }
}
