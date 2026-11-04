"use strict";

/* Pure workflow rules. GitHub state, personal decisions, and activity are separate.
   Shared by the browser and the regression tests; no DOM or storage dependencies. */
const Workflow = (() => {
  const queues = { new: "New", needs_me: "Needs me", waiting: "Waiting", later: "Later", resolved: "Resolved", all: "All", purgatory: "Purgatory" };
  const sorts = { oldest: "Oldest first", newest: "Newest first", updated: "Most recent changes" };
  const creditKinds = new Set(["triage", "followup", "comment", "review", "route", "merge", "close", "branch"]);
  const time = (value) => Number(new Date(value || 0));
  const sameLogin = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  // randomUUID requires HTTPS; getRandomValues also works on a local HTTP host.
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const day = (value = Date.now()) => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  function queue(item, decision, now = Date.now()) {
    if (decision?.status === "purgatory") return "purgatory";
    if (item.state !== "OPEN") return "resolved";
    if (!decision?.triagedAt) return "new";
    if (decision.dueAt && time(decision.dueAt) <= now) return "needs_me";
    return decision.status || "needs_me";
  }
  function wakeReason(before, after, decision, login) {
    if (!before || !decision?.triagedAt || decision.status === "purgatory") return null;
    if (before.state !== "OPEN" && after.state === "OPEN") return "PR reopened";
    if (after.state !== "OPEN" || !["waiting", "later"].includes(decision.status)) return null;
    const since = time(decision.updatedAt);
    const waitingFor = decision.waitingFor || "author";
    if (!before.reviewRequested && after.reviewRequested) return "Review requested";
    const comments = after.comments || [];
    if (comments.some((comment) => time(comment.at) > since && !comment.bot && !sameLogin(comment.login, login)
      && (waitingFor !== "author" || sameLogin(comment.login, after.author)))) return "New reply";
    if (before.headOid && after.headOid !== before.headOid && waitingFor !== "reviewer") return "New commits";
    if (before.isDraft && !after.isDraft) return "Ready for review";
    if ((after.reviews || []).some((review) => time(review.at) > since && !sameLogin(review.login, login))) return "Review received";
    if (waitingFor === "ci" && before.rollup !== after.rollup && ["SUCCESS", "FAILURE", "ERROR"].includes(after.rollup)) return "CI finished";
    return null;
  }
  function credited(events, login, date = day()) {
    return events.filter((event) => !event.reverted && sameLogin(event.actor, login) && creditKinds.has(event.kind) && day(event.at) === date);
  }
  function progress(events, login, date = day()) {
    const activity = credited(events, login, date);
    const distinct = (kind) => new Set(activity.filter((event) => !kind || event.kind === kind).map((event) => event.itemId)).size;
    const outcomes = events.filter((event) => !event.reverted && event.kind === "resolved" && day(event.at) === date);
    return {
      moved: distinct(), triaged: distinct("triage"),
      merged: new Set(outcomes.filter((event) => event.state === "MERGED").map((event) => event.itemId)).size,
      closed: new Set(outcomes.filter((event) => event.state === "CLOSED").map((event) => event.itemId)).size,
      arrivals: new Set(events.filter((event) => event.kind === "arrival" && day(event.at) === date).map((event) => event.itemId)).size
    };
  }
  function boardLane(item, decision, now = Date.now()) {
    const status = queue(item, decision, now);
    if (status !== "needs_me") return status;
    return decision?.reason || (decision?.dueAt && time(decision.dueAt) <= now) ? "updated" : "working";
  }
  function compare(a, b, sort = "oldest") {
    const field = sort === "updated" ? "updatedAt" : "createdAt";
    const difference = time(a[field] || a.firstSeenAt) - time(b[field] || b.firstSeenAt);
    return (sort === "oldest" ? difference : -difference) || a.repo.localeCompare(b.repo) || a.number - b.number;
  }
  return { queues, sorts, creditKinds, time, sameLogin, id, day, queue, boardLane, compare, wakeReason, credited, progress };
})();
globalThis.Workflow = Workflow;
