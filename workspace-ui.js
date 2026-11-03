"use strict";

const WorkUI = {
  button(text, action, primary = false) {
    return el("button", { class: `btn${primary ? " primary" : ""}`, type: "button", text, onclick: action });
  },
  renderHeader() {
    const nav = document.querySelector("#workspace-nav");
    keepFocus(nav, () => nav.replaceChildren(...[["inbox", "PR inbox"], ["board", "CI board"], ["timeline", "Timeline"], ["progress", "Progress"]].map(([page, label]) => el("button", {
      class: `nav-btn${state.page === page ? " active" : ""}`, "aria-pressed": String(state.page === page), text: label, onclick: () => Work.setPage(page)
    }))));
    const bar = document.querySelector("#workspace-toolbar");
    const progress = Workflow.progress(Work.scopedEvents(), Work.login);
    // Keep native controls mounted while discovery and CI refresh in the background.
    if (!bar.children.length) bar.append(
      el("div", { class: "workspace-scope" }, [el("select", { "aria-label": "Repository", onchange: (event) => Work.setRepo(event.target.value) })]),
      el("div", { class: "inbox-options" }, [
        el("label", { class: "small" }, ["Sort ", el("select", { "aria-label": "Inbox sort order", onchange: (event) => Work.setInboxOptions({ inboxSort: event.target.value }) },
          Object.entries(Workflow.sorts).map(([value, text]) => el("option", { value, text })))]),
        el("label", { class: "check-row small" }, [el("input", { type: "checkbox", "aria-label": "Include draft PRs", onchange: (event) => Work.setInboxOptions({ includeDrafts: event.target.checked }) }), "Include drafts"])
      ]),
      el("div", { class: "daily-progress" }, [el("span", { id: "daily-progress-label" }), el("progress", { "aria-labelledby": "daily-progress-label" })])
    );
    const repoSelect = bar.querySelector('[aria-label="Repository"]');
    const repos = Work.repositories();
    if (repoSelect.dataset.repos !== JSON.stringify(repos)) {
      repoSelect.replaceChildren(el("option", { value: "", text: "All repositories" }), ...repos.map((repo) => el("option", { value: repo, text: repo })));
      repoSelect.dataset.repos = JSON.stringify(repos);
    }
    if (repoSelect.value !== Work.repo) repoSelect.value = Work.repo;
    bar.querySelector(".inbox-options").hidden = state.page !== "inbox";
    const sort = bar.querySelector('[aria-label="Inbox sort order"]');
    if (sort.value !== state.prefs.inboxSort) sort.value = state.prefs.inboxSort;
    bar.querySelector('[aria-label="Include draft PRs"]').checked = state.prefs.includeDrafts;
    const goal = state.prefs.dailyGoal;
    const current = progress.moved;
    const label = bar.querySelector("#daily-progress-label");
    label.className = current >= goal ? "t-good" : "";
    label.textContent = `${current >= goal ? "✓ " : ""}${current} / ${goal} moved forward today`;
    bar.querySelector("progress").max = goal;
    bar.querySelector("progress").value = Math.min(current, goal);
    const filter = document.querySelector("#filter");
    filter.placeholder = state.page === "board" ? "Filter pinned PRs" : "Search PRs, authors, labels";
    filter.setAttribute("aria-label", filter.placeholder);
    filter.hidden = state.page === "progress";
  },
  renderChips() {
    const counts = Work.counts();
    document.querySelector("#chips").replaceChildren(...Object.entries(Workflow.queues).map(([queue, label]) => el("button", {
      class: `chip-btn${Work.queue === queue ? " active" : ""}`,
      "aria-pressed": String(Work.queue === queue), onclick: () => Work.setQueue(queue)
    }, [label, el("span", { class: "count", text: String(counts[queue]) })])));
  },
  syncStatus() {
    if (Work.error) return el("div", { class: "workspace-warning", role: "alert" }, [
      el("span", { text: Work.error }), this.button("Retry local storage", () => Work.retryStorage())
    ]);
    if (!Work.ready) return el("p", { class: "sync-note", text: "Opening your saved inbox…" });
    const repos = state.prefs.trackedRepos.filter((repo) => !Work.repo || Work.repo === repo);
    if (!repos.length) return el("p", { class: "sync-note", text: "Showing saved and pinned PRs. Add this repository in Settings to discover every PR." });
    return el("div", { class: "sync-notes" }, repos.map((repo) => {
      const meta = Work.meta.get(`repo:${repo}`);
      const status = Work.syncer?.status.get(repo);
      const count = status?.count || meta?.scan?.openIds?.length || 0;
      const loaded = `${count}${Number.isInteger(status?.total) ? ` of ${status.total}` : ""} open PRs loaded`;
      const retry = status?.retryAt > Date.now() ? ` Retrying in ${Math.max(1, Math.ceil((status.retryAt - Date.now()) / 1000))}s.` : "";
      const text = status?.error ? `${repo}: ${status.error} ${loaded}; discovery is incomplete. Saved progress will resume.${retry}`
        : status?.busy ? `${repo}: ${loaded} · ${status.retry ? `connection interrupted; retrying this page (${status.retry}/3)` : status.stage === "open" ? "discovering PRs…" : "checking recent updates…"}${retry}`
          : meta?.complete ? `${repo} · synced ${ago(meta.lastSync)} ago` : `${repo}: discovery has not finished yet`;
      return el("div", { class: `sync-note${status?.error ? " t-bad" : ""}`, role: status?.error ? "alert" : null }, [
        el("span", { text }), status?.error ? this.button("Retry discovery", () => Work.tick(true)) : null
      ]);
    }));
  },
  complete() {
    const repos = Work.repositories().filter((repo) => !Work.repo || repo === Work.repo);
    return Work.ready && !Work.error && repos.length > 0 && repos
      .every((repo) => state.prefs.trackedRepos.includes(repo) && Work.meta.get(`repo:${repo}`)?.complete && !Work.syncer?.status.get(repo)?.error && !Work.syncer?.status.get(repo)?.busy);
  },
  renderList() {
    const board = document.querySelector("#board");
    const items = Work.visible();
    const title = `${Workflow.queues[Work.queue]}${Work.queue === "needs_me" ? "" : " PRs"}`;
    const empty = state.query ? "No PRs match your search." : Work.queue === "purgatory" ? "No PRs in purgatory." : this.complete() ? Work.queue === "new" ? `All caught up${state.prefs.includeDrafts ? "" : " for non-draft PRs"}. Every open PR in this view has a next step.` : "Nothing in this queue." : "Waiting for complete discovery. Your inbox may still change.";
    board.replaceChildren(
      el("div", { class: "inbox-heading" }, [el("h2", { text: title }), el("span", { class: "muted small", text: `${items.length} shown · ${Workflow.sorts[state.prefs.inboxSort].toLowerCase()} · drafts ${state.prefs.includeDrafts ? "included" : "hidden"}` })]),
      ...(Work.queue === "purgatory" ? [el("p", { class: "sync-note", text: "Set aside without closing on GitHub. Hidden from the other inbox tabs and the CI board until you restore them." })] : []),
      this.syncStatus(),
      items.length ? el("div", { class: "inbox-list", "aria-label": title }, items.map((item) => {
        const decision = Work.decision(item);
        const queue = Workflow.queue(item, decision);
        const due = decision?.dueAt && new Date(decision.dueAt) <= new Date();
        return el("button", { class: `inbox-row${item.key === state.cursor ? " cursor" : ""}`, type: "button", "data-key": item.key,
          "aria-current": item.key === state.cursor ? "true" : null, onclick: () => Work.select(item.key) }, [
          el("span", { class: "inbox-row-title", text: item.title }),
          el("span", { class: "row-meta" }, [
            el("span", { class: "num", text: shortRef(item.repo, item.number) }), authorName(item.author),
            el("span", { text: `${ago(item.createdAt || item.firstSeenAt)} old` }),
            item.isDraft ? el("span", { class: "badge", text: "Draft" }) : null,
            el("span", { class: `queue-label q-${queue}`, text: item.state !== "OPEN" ? item.state.toLowerCase() : Workflow.queues[queue] }),
            pinByKey(item.key) && queue !== "purgatory" ? el("span", { class: "badge", text: "On CI board" }) : null
          ]),
          el("span", { class: "inbox-row-context", text: decision?.reason || (due ? "Follow-up due" : decision?.note) || (item.state !== "OPEN" ? `${item.state === "MERGED" ? "Merged" : "Closed"} on GitHub` : decision?.triagedAt ? "Ready for your next action" : item.origin === "backlog" ? "Existing backlog · awaiting your decision" : "New arrival") }),
          el("span", { class: "row-meta" }, [
            el("span", { text: `+${item.additions || 0} −${item.deletions || 0} · ${item.files || 0} files` }),
            el("span", { text: item.rollup ? `Checks ${item.rollup.toLowerCase()}` : "No checks yet" }),
            ...(item.labels || []).slice(0, 3).map(labelChip)
          ])
        ]);
      })) : el("div", { class: "empty inbox-empty" }, [el("p", { text: empty }),
        !state.query && Work.queue === "new" && Work.counts().needs_me > 0 ? this.button("Continue with Needs me", () => Work.setQueue("needs_me"), true) : null])
    );
  },
  triagePanel(item, compact = false) {
    const decision = Work.decision(item);
    const queue = Workflow.queue(item, decision);
    const btn = (label, type) => el("button", { class: "btn", disabled: !Work.ready || Work.saving || Boolean(Work.error), text: label, onclick: () => this.action(type, item) });
    if (queue === "purgatory") return el("section", { class: "triage-panel", "aria-label": "Personal triage" }, [
      el("h3", { text: "Purgatory" }), el("p", { class: "small muted", text: "This PR stays hidden until you choose to bring it back. GitHub updates and reminders will not resurface it." }),
      decision?.note ? el("p", { class: "triage-note", text: decision.note }) : null,
      btn("Restore to inbox", "restore")
    ]);
    const node = el("section", { class: "triage-panel", "aria-label": "Personal triage" }, [
      el("div", { class: "split" }, [el("h3", { text: `Personal triage · ${Workflow.queues[queue]}` }), el("span", { class: "small muted", text: "Notes & reminders are private" })]),
      decision?.note ? el("p", { class: "triage-note", text: decision.note }) : null,
      decision?.reason ? el("p", { class: "t-warn", text: decision.reason }) : null,
      decision?.dueAt && item.state === "OPEN" ? el("p", { class: "small muted", text: `Follow up ${new Date(decision.dueAt).toLocaleString()}` }) : null,
      item.state === "OPEN" ? el("div", { class: "btn-row triage-actions" }, [
        ...(compact ? [queue !== "needs_me" || Workflow.boardLane(item, decision) === "updated" ? btn("Take on", "take") : null, btn("Waiting…", "wait"), btn("Later…", "later"), btn("Purgatory", "purgatory")]
          : [btn("Take on · t", "take"), btn("Waiting · w", "wait"), btn("Later · s", "later"), btn("Purgatory", "purgatory"), btn("Route · d", "route"), btn("Respond · n", "comment"), btn("Close PR… · x", "close")])
      ]) : el("p", { class: "small muted", text: "Resolved on GitHub. Your decisions and activity remain saved." }),
      compact ? this.button("Open in PR inbox", () => Work.openItem(item, "inbox"))
        : pinByKey(item.key) ? this.button("View on CI board", () => Work.openItem(item, "board"))
          : el("p", { class: "small muted", text: "Take on, Waiting, and Later add this PR to the matching CI board group." })
    ]);
    return node;
  },
  renderBoardDetail(index) {
    renderDetail(index);
    const item = Work.ref(state.cursor);
    const detail = document.querySelector("#detail");
    if (item) detail.insertBefore(this.triagePanel(item, true), detail.children[1] || null);
  },
  renderDetail(index) {
    const detail = document.querySelector("#detail");
    const item = Work.ref(state.cursor);
    if (!item) {
      detail.replaceChildren(el("div", { class: "detail-empty" }, [el("h2", { text: "Give every PR a next step" }),
        el("p", { text: "Select a PR to read its description, assess the change, and decide what happens next." }),
        el("p", { class: "small muted", text: "j / k to move · t take on · w wait · s defer · d route · n respond · x close" })]));
      return;
    }
    const pr = state.data.get(item.key);
    if (pr) renderDetail(index);
    else detail.replaceChildren(el("div", { class: "detail-head" }, [
      el("a", { href: safeUrl(item.url), target: "_blank", rel: "noopener", text: `${item.repo}#${item.number}` }),
      el("h2", { text: item.title }),
      el("p", { class: "muted", text: `${item.author} · +${item.additions} −${item.deletions} in ${item.files} files` }),
      el("p", { class: "small muted", text: state.status.get(item.key)?.error || "Loading description and CI details…" }),
      state.status.get(item.key)?.error ? this.button("Retry details", () => queueRefresh(item, { force: true })) : null
    ]));
    const fragment = document.createDocumentFragment();
    fragment.append(this.triagePanel(item));
    const body = pr?.body ?? item.body;
    fragment.append(el("details", { class: "pr-description", open: true }, [
      el("summary", { text: "Description" }), el("div", { class: "description-text", text: body ?? "Loading description…" })
    ]));
    const issues = pr?.linkedIssues || item.linkedIssues || [];
    if (issues.length) fragment.append(el("div", { class: "linked-issues" }, [el("strong", { text: "Linked issues " }), ...issues.map((issue) => el("a", { href: safeUrl(issue.url), target: "_blank", rel: "noopener", text: `#${issue.number} ${issue.title}` }))]));
    detail.insertBefore(fragment, detail.children[1] || null);
    const history = [...Work.events.values()].filter((event) => event.itemId === item.id).sort((a, b) => new Date(b.at) - new Date(a.at));
    detail.append(el("details", { class: "activity-history" }, [el("summary", { text: `Activity history · ${history.length}` }),
      history.length ? el("ol", {}, history.slice(0, 100).map((event) => el("li", {}, [
        el("span", { text: `${event.message || this.eventName(event)}${event.reverted ? " · undone" : ""}` }),
        el("span", { class: "muted small", text: ` ${event.actor || "GitHub"} · ${new Date(event.at).toLocaleString()}` })
      ]))) : el("p", { class: "muted", text: "No decisions recorded yet. Reading a PR does not mark it triaged." })]));
  },
  eventName(event) {
    if (event.kind === "restore") return "Restored to inbox";
    return ({ triage: "Triaged", followup: "Followed up", comment: "Commented", review: "Reviewed", route: "Requested review", merge: "Merged", close: "Closed", branch: "Updated branch", label: "Changed label", ci: "Requested CI", arrival: "PR opened", resolved: event.state === "MERGED" ? "PR merged" : "PR closed", resurfaced: "Needs attention again", reopened: "PR reopened" })[event.kind] || event.kind;
  },
  action(type, item = Work.ref(state.cursor)) {
    if (type === "restore" && Work.decision(item)?.status === "purgatory") return Work.decide(item, { status: "new" });
    if (!item || item.state !== "OPEN" || !Work.ready || Work.saving || Work.error) return;
    if (type === "take") return Work.decide(item, { status: "needs_me" }, { track: true });
    if (type === "purgatory") return Work.decide(item, { status: "purgatory" });
    const labels = { wait: "Wait for a response", later: "Revisit later", route: "Request a reviewer", comment: "Respond on GitHub", close: "Close pull request" };
    const decision = Work.decision(item);
    const due = new Date();
    due.setDate(due.getDate() + (type === "later" ? 1 : 7));
    due.setHours(9, 0, 0, 0);
    const localDate = new Date(due.getTime() - due.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const note = el("textarea", { rows: 3, placeholder: "Optional — what needs to happen next?" });
    note.value = decision?.note || "";
    const body = el("textarea", { rows: 5, placeholder: type === "close" ? "Explain why this PR is being closed, with a duplicate link if applicable." : "Your response to the contributor…" });
    const reviewer = el("input", { type: "text", placeholder: "GitHub username", autocomplete: "off" });
    const waitingFor = el("select", { "aria-label": "Waiting for" }, [["author", "Author"], ["reviewer", "Reviewer"], ["ci", "CI"]].map(([value, text]) => el("option", { value, text })));
    waitingFor.value = decision?.waitingFor || "author";
    const when = el("input", { type: "datetime-local", value: localDate });
    const error = el("p", { class: "t-bad", role: "alert" });
    const modal = {};
    const generation = Work.generation;
    let commentSent = false;
    let routed = false;
    let closed = null;
    let sending = false;
    const sendText = ({ wait: "Save waiting state", later: "Defer PR", route: "Request review & wait", comment: "Post response & wait", close: "Post reason & close PR" })[type];
    const send = el("button", { class: `btn ${type === "close" ? "danger" : "primary"}`, text: sendText, onclick: async () => {
      if (sending) return;
      const publicBody = body.value.trim();
      const privateNote = note.value.trim();
      const target = reviewer.value.trim().replace(/^@/, "");
      const dueAt = new Date(when.value);
      if (["close", "comment"].includes(type) && !publicBody) { error.textContent = "Write a comment before sending."; return; }
      if (type === "route" && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(target)) { error.textContent = "Enter one GitHub username."; return; }
      if (type !== "close" && (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date())) { error.textContent = "Choose a follow-up time in the future."; return; }
      sending = true;
      send.disabled = true;
      send.textContent = "Saving…";
      error.textContent = "";
      try {
        if (generation !== Work.generation) throw new Error("Your session changed. Reopen this action.");
        if (["comment", "close"].includes(type) && !commentSent) {
          const result = await rest("POST", `/repos/${item.repo}/issues/${item.number}/comments`, { body: publicBody });
          commentSent = true;
          await Work.record(item, "comment", { id: result.node_id ? `comment:${result.node_id}` : undefined, at: result.created_at });
        }
        if (type === "route" && !routed) {
          await rest("POST", `/repos/${item.repo}/pulls/${item.number}/requested_reviewers`, { reviewers: [target] });
          routed = true;
          await Work.record(item, "route", { message: `Requested review from ${target}` });
        }
        if (type === "close" && !closed) {
          closed = await rest("PATCH", `/repos/${item.repo}/pulls/${item.number}`, { state: "closed" });
          if (closed.state !== "closed") { closed = null; throw new Error("GitHub did not confirm that the PR closed."); }
        }
        if (generation !== Work.generation) return;
        const saved = await Work.decide(item, { status: type === "later" ? "later" : type === "close" ? "needs_me" : "waiting",
          dueAt: type === "close" ? null : dueAt.toISOString(), waitingFor: type === "route" ? "reviewer" : waitingFor.value,
          note: type === "close" ? publicBody : type === "route" ? `Review requested from ${target}${privateNote ? ` · ${privateNote}` : ""}` : privateNote
        }, { undo: !["route", "comment", "close"].includes(type), announce: type !== "close", track: type !== "close" });
        if (!saved) throw new Error("The local decision was not saved. Retry to save it; confirmed GitHub actions will not be sent again.");
        if (closed) {
          await Work.observe([{ ...item, state: "CLOSED", closedAt: closed.closed_at || new Date().toISOString(), updatedAt: closed.updated_at || new Date().toISOString() }]);
          await Work.record(item, "close", { message: "Closed with a reason" });
          toast(`${shortRef(item.repo, item.number)} closed with a reason`, "ok");
        }
        refreshSoon(item.key);
        if (state.modal === modal) closeModal();
      } catch (problem) {
        error.textContent = `${commentSent ? "Your comment was posted. " : ""}${routed ? "The review was requested. " : ""}${closed ? "The PR was closed. " : ""}${problem.message}`;
      } finally {
        sending = false;
        send.disabled = false;
        send.textContent = sendText;
      }
    } });
    mountModal(modal, el("div", { class: "modal triage-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "triage-title" }, [
      el("h2", { id: "triage-title", text: `${labels[type]} · #${item.number}` }), el("p", { class: "muted", text: item.title }),
      type === "route" ? el("label", { class: "field" }, ["Reviewer · sends a GitHub review request", reviewer]) : null,
      ["comment", "close"].includes(type) ? el("label", { class: "field" }, [type === "close" ? "Reason · posted publicly on GitHub" : "Comment · posted publicly on GitHub", body]) : null,
      type !== "close" ? el("label", { class: "field" }, ["Private note · optional", note]) : null,
      type === "wait" ? el("label", { class: "field" }, ["Waiting for", waitingFor]) : null,
      type !== "close" ? el("label", { class: "field" }, ["Remind me if still waiting", when]) : null,
      el("p", { class: "muted small", text: ["wait", "later"].includes(type) ? "This saves a personal decision. It does not post to GitHub. Relevant replies and updates can bring the PR back sooner." : type === "close" ? "This posts your reason, then closes the PR on GitHub." : "The PR returns to Needs me when a response arrives or the reminder is due." }),
      error, el("div", { class: "choices" }, [send, this.button("Cancel", closeModal)])
    ]));
    (type === "route" ? reviewer : ["comment", "close"].includes(type) ? body : note).focus();
  },
  renderProgress() {
    const container = document.querySelector("#progress");
    const events = Work.scopedEvents();
    const today = Workflow.progress(events, Work.login);
    const counts = Work.counts();
    const days = Array.from({ length: 14 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - 13 + index); return { date, ...Workflow.progress(events, Work.login, Workflow.day(date)) }; });
    const max = Math.max(state.prefs.dailyGoal, ...days.map((day) => day.moved));
    const recent = events.filter((event) => !event.reverted && Workflow.sameLogin(event.actor, Work.login) && Workflow.creditKinds.has(event.kind)).sort((a, b) => new Date(b.at) - new Date(a.at));
    const oldest = Work.inboxItems().filter((item) => Workflow.queue(item, Work.decision(item)) === "new").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    container.replaceChildren(
      el("div", { class: "progress-heading" }, [el("div", {}, [el("h1", { text: "Steady progress" }), el("p", { class: "muted", text: "Useful decisions, visible progress, and nothing forgotten." })]), this.button("Back to the inbox", () => Work.setPage("inbox"), true)]),
      this.syncStatus(),
      el("div", { class: "progress-stats" }, [
        this.stat("Moved forward today", `${today.moved} / ${state.prefs.dailyGoal}`, "Distinct PRs you triaged, responded to, reviewed, routed, or resolved"),
        this.stat("Still need a first decision", counts.new, oldest ? `Oldest: #${oldest.number} · ${ago(oldest.createdAt)} old` : this.complete() ? "Every open PR has a next step" : "Discovery is still incomplete"),
        this.stat("Need you now", counts.needs_me, `${counts.waiting} waiting · ${counts.later} deferred`)
      ]),
      el("section", { class: "progress-chart", "aria-label": "Daily distinct PRs moved forward over the last 14 days" }, [
        el("h2", { text: "Your last 14 days" }),
        el("p", { class: "muted small", text: "Distinct PRs moved forward per day · dates use this browser’s time zone" }),
        el("div", { class: "activity-bars" }, days.map((day) => el("div", { class: "activity-day", title: `${day.date.toLocaleDateString()}: ${day.moved} PRs moved forward` }, [
          el("span", { class: "activity-value", text: String(day.moved) }),
          el("div", { class: "activity-track" }, [el("div", { class: "activity-fill", style: `height:${day.moved / max * 100}%` })]),
          el("span", { class: "small", text: `${day.date.getMonth() + 1}/${day.date.getDate()}` })
        ])))
      ]),
      el("div", { class: "progress-columns" }, [
        el("section", {}, [el("h2", { text: "Repository outcomes today" }),
          el("p", { class: "outcome-line", text: `${today.arrivals} arrived · ${today.triaged} triaged by you · ${today.merged} merged · ${today.closed} closed` }),
          el("p", { class: "muted small", text: "Merge and closure counts include observed repository outcomes, whoever performed them. Existing backlog is not counted as new arrivals." }),
          el("p", { class: "muted small", text: "Activity starts when tracking begins. Recent GitHub comments and reviews are recognized when synced; this is not a complete historical audit. CI retries and label toggles do not earn progress." })]),
        el("section", {}, [el("h2", { text: "Recent work" }),
          recent.length ? el("ol", { class: "recent-work" }, recent.slice(0, 12).map((event) => el("li", {}, [
            this.button(`#${event.number} · ${this.eventName(event)}`, () => { const item = Work.items.get(event.itemId); if (item) Work.openItem(item, "inbox"); }),
            el("span", { class: "muted small", text: ago(event.at) + " ago" })
          ]))) : el("p", { class: "muted", text: "Your first decision starts the story." })])
      ])
    );
  },
  stat(label, value, detail) {
    return el("div", { class: "progress-stat" }, [el("span", { class: "muted", text: label }), el("strong", { text: String(value) }), el("span", { class: "small muted", text: detail })]);
  }
};
