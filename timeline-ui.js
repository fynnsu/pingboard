"use strict";

const TimelineUI = {
  rows: new Map(), list: [], nearby: [], scopeKey: "", rangeKey: "", windowKey: "", tip: null,
  reset() {
    this.hideTip(); this.resizeObserver?.disconnect(); cancelAnimationFrame(this.windowFrame);
    this.windowFrame = null;
    this.rows.clear(); this.list = this.nearby = []; this.scopeKey = this.rangeKey = this.windowKey = "";
    document.querySelector("#timeline")?.replaceChildren();
  },
  set(values) { Object.assign(state.prefs, values); persistPrefs(); render(); },
  items(range) {
    const query = state.query.trim().toLowerCase();
    return Work.inboxItems().filter((item) => {
      const queue = Workflow.queue(item, Work.decision(item));
      const scope = state.prefs.timelineScope;
      if ((queue === "purgatory") !== (scope === "purgatory")) return false;
      if (scope === "board" && !pinByKey(item.key)) return false;
      if (scope === "open" && item.state !== "OPEN") return false;
      if (scope === "resolved" && item.state === "OPEN") return false;
      if (Date.parse(item.createdAt) > range.end || (item.state !== "OPEN" && Date.parse(item.mergedAt || item.closedAt || item.updatedAt) < range.start)) return false;
      return !query || `${item.title} ${item.key} ${item.author} ${(item.labels || []).map((label) => label.name).join(" ")} ${Work.decision(item)?.note || ""}`.toLowerCase().includes(query);
    }).sort((a, b) => Workflow.compare(a, b, state.prefs.timelineSort));
  },
  eventDetails(event, includeTime = true) {
    const meta = [
      includeTime ? new Date(event.at).toLocaleString() : null,
      event.actor || null
    ].filter(Boolean).join(" · ");
    return [
      el("strong", { class: `event-text-${event.kind}`, text: event.label }),
      meta ? el("div", { class: "small muted", text: meta }) : null,
      event.message ? el("p", { text: event.message }) : null,
      event.url?.startsWith("https://github.com/") ? el("a", { href: event.url, target: "_blank", rel: "noopener noreferrer", text: "View on GitHub ↗" }) : null
    ];
  },
  mount(host) {
    const select = (label, options, change) => el("label", { class: "small" }, [label, el("select", { "aria-label": label, onchange: (event) => change(event.target.value) }, options.map(([value, text]) => el("option", { value, text })))]);
    host.append(
      el("div", { class: "timeline-heading" }, [
        el("div", {}, [el("h1", { text: "PR timeline" }), el("p", { class: "muted", text: "From opened to done. Hover or focus a circle to explore what changed." })]),
        el("div", { class: "timeline-controls" }, [
          select("Time range", [[30, "Last month"], [90, "Last 3 months"], [180, "Last 6 months"]], (value) => this.set({ timelineDays: Number(value) })),
          select("Timeline PRs", [["all", "All PRs"], ["board", "On CI board"], ["open", "Open"], ["resolved", "Merged / closed"], ["purgatory", "Purgatory"]], (value) => this.set({ timelineScope: value })),
          select("Timeline sort", Object.entries(Workflow.sorts), (value) => this.set({ timelineSort: value })),
          el("label", { class: "check-row small" }, [el("input", { type: "checkbox", "aria-label": "Timeline include drafts", onchange: (event) => this.set({ includeDrafts: event.target.checked }) }), "Include drafts"]),
          WorkUI.button("Today →", () => { const scroller = host.querySelector(".timeline-scroll"); scroller.scrollLeft = scroller.scrollWidth; })
        ])
      ]),
      el("div", { class: "timeline-legend small" }, [
        ...[["opened", "Open"], ["review", "Review / draft"], ["comment", "Comment / commit / label"], ["merged", "Merged"], ["closed", "Closed"], ["local", "Your triage"]].map(([kind, label]) => el("span", {}, [el("i", { class: `timeline-dot event-${kind}`, "aria-hidden": "true" }), label])),
        el("span", { class: "muted", text: "Dashed = temporarily closed · times are local" })
      ]),
      el("div", { class: "timeline-status small", role: "status", "aria-live": "polite" }),
      el("div", { class: "timeline-scroll", tabindex: "0", role: "region", "aria-label": "PR lifecycle table. Scroll down for more PRs or horizontally for earlier dates." }, [
        el("table", { class: "timeline-table" }, [el("caption", { class: "sr-only", text: "Pull request lifecycles and notable updates" }), el("thead"), el("tbody")])
      ]),
      el("div", { class: "timeline-footer" }, [el("span", { class: "small muted timeline-count" })])
    );
    host.querySelector(".timeline-scroll").addEventListener("scroll", (event) => {
      const node = event.target;
      this.atEnd = node.scrollWidth - node.clientWidth - node.scrollLeft < 4;
      this.hideTip();
      this.scheduleWindow();
    });
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.scheduleWindow());
    this.resizeObserver.observe(host.querySelector(".timeline-scroll"));
  },
  scheduleWindow() {
    cancelAnimationFrame(this.windowFrame);
    this.windowFrame = requestAnimationFrame(() => { this.windowFrame = null; this.updateWindow(); });
  },
  updateWindow() {
    if (state.page !== "timeline" || !Work.ready) return;
    const scroller = document.querySelector(".timeline-scroll");
    if (!scroller?.clientHeight) return;
    const body = scroller.querySelector("tbody");
    // Rows have a fixed-height lane. Measure it rather than duplicating CSS
    // dimensions, and reserve the space covered by the sticky date header.
    const rowHeight = body.firstElementChild?.getBoundingClientRect().height || 54;
    const headerHeight = scroller.querySelector("thead").getBoundingClientRect().height;
    const bodyTop = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const first = Math.max(0, Math.floor((scroller.scrollTop + headerHeight - bodyTop) / rowHeight));
    const end = Math.min(this.list.length, Math.ceil((scroller.scrollTop + scroller.clientHeight - bodyTop) / rowHeight));
    const nearby = this.list.slice(first, end);
    // Actual visible rows take priority; then prefetch five rows either side.
    for (let offset = 0; offset < 5; offset += 1) {
      if (this.list[end + offset]) nearby.push(this.list[end + offset]);
      if (this.list[first - offset - 1]) nearby.push(this.list[first - offset - 1]);
    }
    this.nearby = nearby;
    const key = JSON.stringify(nearby.map((item) => item.id));
    if (key !== this.windowKey) { this.windowKey = key; render(); }
    const repos = Work.repositories().filter((repo) => !Work.repo || Work.repo === repo);
    Work.timeline?.ensure({ items: nearby, repos: ["open", "board", "purgatory"].includes(state.prefs.timelineScope) ? [] : repos,
      since: new Date(Timeline.range(state.prefs.timelineDays).start).toISOString() });
  },
  render() {
    const host = document.querySelector("#timeline");
    if (!host.children.length) { this.rows.clear(); this.rangeKey = ""; this.mount(host); }
    const range = Timeline.range(state.prefs.timelineDays);
    const scope = JSON.stringify([Work.repo, state.query, state.prefs.timelineScope, state.prefs.timelineSort, state.prefs.includeDrafts, state.prefs.timelineDays]);
    const changedScope = scope !== this.scopeKey;
    this.scopeKey = scope;
    const items = this.items(range);
    const since = new Date(range.start).toISOString();
    const repos = Work.repositories().filter((repo) => !Work.repo || Work.repo === repo);
    for (const [label, value] of [["Time range", state.prefs.timelineDays], ["Timeline PRs", state.prefs.timelineScope], ["Timeline sort", state.prefs.timelineSort]]) {
      const control = host.querySelector(`[aria-label="${label}"]`);
      if (control.value !== String(value)) control.value = value;
    }
    host.querySelector('[aria-label="Timeline include drafts"]').checked = state.prefs.includeDrafts;
    const key = `${range.start}:${range.days}`;
    const newRange = key !== this.rangeKey;
    if (newRange) {
      this.rangeKey = key;
      host.style.setProperty("--timeline-width", `${range.width}px`);
      host.querySelector("thead").replaceChildren(el("tr", {}, [el("th", { class: "timeline-label timeline-corner", scope: "col", text: "Pull request" }), el("th", { scope: "col", class: "timeline-axis", "aria-label": "Dates" }, [this.axis(range)])]));
    }
    this.renderRows(items, range, changedScope);
    this.list = items;
    this.updateWindow();
    const errors = [...(Work.timeline?.errors || [])].filter(([id]) => this.nearby.some((item) => item.id === id) || repos.some((repo) => id === `repo:${repo}`));
    const complete = this.nearby.filter((item) => Work.timeline?.fresh(Work.history.get(item.id), since, item)).length;
    const archives = repos.every((repo) => Work.timeline?.fresh(Work.history.get(`repo:${repo}`), since));
    const status = host.querySelector(".timeline-status");
    status.replaceChildren(el("span", { text: Work.error || (!Work.ready ? "Opening saved history…" : errors.length ? `${errors.length} histories incomplete. ${errors[0][1].message}`
      : Work.timeline?.busy ? `Loading history · ${complete}/${this.nearby.length} nearby rows ready · ${Work.timeline.current}`
        : `${complete}/${this.nearby.length} nearby rows ready${archives ? " · recent merged and closed PRs included" : ""}. ${WorkUI.complete() ? "" : "Inbox discovery is still incomplete."}`) }),
      ...(errors.length ? [WorkUI.button("Retry history", () => Work.timeline?.retry())] : []));
    status.classList.toggle("t-bad", Boolean(errors.length || Work.error));
    host.querySelector(".timeline-count").textContent = items.length ? `${items.length} PRs · scroll for more · history loads as you browse · titles open the inbox` : "No PRs match this range and filter.";
    if (newRange) { host.querySelector(".timeline-scroll").scrollLeft = range.width; this.atEnd = true; }
  },
  renderRows(items, range, changedScope) {
    const scroller = document.querySelector(".timeline-scroll"), body = scroller.querySelector("tbody");
    const rowHeight = body.firstElementChild?.getBoundingClientRect().height || 54;
    const anchor = body.children[Math.floor(scroller.scrollTop / rowHeight)];
    const anchorOffset = anchor?.getBoundingClientRect().top;
    const active = document.activeElement?.dataset.timelineFocus;
    const local = new Map();
    for (const event of Work.events.values()) {
      if (!local.has(event.itemId)) local.set(event.itemId, []);
      local.get(event.itemId).push(event);
    }
    const ids = new Set(items.map((item) => item.id));
    for (const [id, entry] of this.rows) if (!ids.has(id)) { if (entry.node.contains(this.anchor)) this.hideTip(); entry.node.remove(); this.rows.delete(id); }
    let next = body.firstElementChild;
    for (const item of items) {
      const signature = JSON.stringify([this.scopeKey, this.rangeKey, item, Work.decision(item), Work.history.get(item.id)?.updatedAt,
        Work.timeline?.errors.get(item.id), Boolean(pinByKey(item.key)), local.get(item.id), Math.floor(range.now / 60000)]);
      let entry = this.rows.get(item.id);
      if (!entry || entry.signature !== signature) {
        const node = this.row(item, range);
        if (entry) {
          if (entry.node.contains(this.anchor)) this.hideTip();
          entry.node.replaceChildren(...node.childNodes);
          entry.node.dataset.key = item.key;
          entry.signature = signature;
        } else { entry = { node, signature }; this.rows.set(item.id, entry); }
      }
      // Keep unchanged rows mounted: history arriving elsewhere must not drop
      // keyboard focus, tooltips, or the user's place in a long list.
      if (entry.node !== next) body.insertBefore(entry.node, next);
      else next = next.nextElementSibling;
    }
    if (changedScope) scroller.scrollTop = 0;
    else if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
    if (active && document.activeElement?.dataset.timelineFocus !== active) [...body.querySelectorAll("[data-timeline-focus]")].find((node) => node.dataset.timelineFocus === active)?.focus({ preventScroll: true });
  },
  axis(range) {
    const track = el("div", { class: "timeline-axis-track" });
    const date = new Date(range.start);
    let month = "";
    while (+date < range.end) {
      const x = Timeline.position(date.toISOString(), range);
      const name = date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
      if (name !== month) { if (range.width - x > 90) track.append(el("span", { class: "timeline-month", style: `left:${x + 6}px`, text: name })); month = name; }
      if (date.getDay() === 1) track.append(el("span", { class: "timeline-tick", style: `left:${x}px`, text: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) }));
      date.setDate(date.getDate() + 1);
    }
    track.append(el("span", { class: "timeline-today-label", style: `left:${Timeline.position(new Date(range.now).toISOString(), range)}px`, text: "Today" }));
    return track;
  },
  row(item, range) {
    const record = Work.history.get(item.id);
    const events = Timeline.events(item, record, [...Work.events.values()], Work.decision(item));
    const status = item.state === "OPEN" ? item.isDraft ? "Draft" : "Open" : item.state === "MERGED" ? "Merged" : "Closed";
    const ready = Work.timeline?.fresh(record, new Date(range.start).toISOString(), item);
    const lane = el("div", { class: `timeline-lane state-${item.state.toLowerCase()}`, "data-state": item.state });
    for (const at of range.weeks) lane.append(el("span", { class: "timeline-week", style: `left:${Timeline.position(at, range)}px`, "aria-hidden": "true" }));
    lane.append(el("span", { class: "timeline-today", style: `left:${Timeline.position(new Date(range.now).toISOString(), range)}px`, "aria-hidden": "true" }));
    for (const segment of Timeline.segments(item, events, range)) lane.append(el("span", { class: `timeline-life${segment.active ? "" : " inactive"}`, style: `left:${segment.x}px;width:${segment.width}px`, "aria-hidden": "true" }));
    if (Date.parse(item.createdAt) < range.start) lane.append(el("span", { class: "timeline-before", title: `Opened ${new Date(item.createdAt).toLocaleDateString()} · continues from before this range`, text: "‹" }));
    for (const cluster of Timeline.clusters(events, range)) {
      const last = cluster.events.at(-1);
      const button = el("button", { class: `timeline-marker event-${cluster.events.length > 1 ? "cluster" : last.kind}`, type: "button", style: `left:${cluster.x}px`,
        "aria-label": `${item.repo}#${item.number}: ${cluster.events.length > 1 ? `${cluster.events.length} events, ` : ""}${cluster.events.slice(0, 3).map((event) => event.label).join(", ")} · ${new Date(last.at).toLocaleDateString()}`,
        "aria-haspopup": "dialog", "aria-expanded": "false", "data-timeline-focus": `${item.id}:${cluster.events[0].id}`,
        onmouseenter: () => this.showTip(button, item, cluster.events), onmouseleave: () => this.scheduleHide(),
        onfocus: () => this.showTip(button, item, cluster.events), onblur: (event) => { if (!this.tip?.contains(event.relatedTarget)) this.scheduleHide(); },
        onclick: () => { this.showTip(button, item, cluster.events); this.tip?.querySelector("button")?.focus({ preventScroll: true }); }
      }, cluster.events.length > 1 ? [el("span", { text: cluster.events.length > 99 ? "99+" : String(cluster.events.length) })] : []);
      lane.append(button);
    }
    return el("tr", { "data-key": item.key }, [
      el("th", { scope: "row", class: "timeline-label" }, [
        el("button", { class: "timeline-title", title: item.title, "data-timeline-focus": item.id, onclick: () => Work.openItem(item, "inbox") }, [el("span", { class: "timeline-number", text: `#${item.number}` }), el("span", { text: item.title })]),
        el("div", { class: "timeline-meta" }, [el("span", { text: `${Work.repo ? item.author : item.repo} · ${status}` }),
          ...(pinByKey(item.key) ? [el("button", { class: "link-btn", text: "CI board ↗", "aria-label": `Open ${item.key} on CI board`, onclick: () => Work.openItem(item, "board") })] : []),
          ...(!ready ? [el("span", { class: "timeline-coverage", title: Work.timeline?.errors.get(item.id)?.message || "The line shows this PR's lifetime; activity markers are still loading.", text: record?.events.length ? "Partial history" : "History pending" })] : [])
        ])
      ]), el("td", { class: "timeline-cell" }, [lane])
    ]);
  },
  scheduleHide() {
    clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => { if (!this.tip?.contains(document.activeElement) && document.activeElement !== this.anchor) this.hideTip(); }, 250);
  },
  hideTip() { clearTimeout(this.tipTimer); this.tip?.remove(); this.tip = null; this.anchor?.setAttribute("aria-expanded", "false"); this.anchor = null; },
  showTip(anchor, item, events) {
    clearTimeout(this.tipTimer);
    if (this.anchor === anchor && this.tip) return;
    this.hideTip();
    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    const close = () => { this.hideTip(); anchor.focus({ preventScroll: true }); this.hideTip(); };
    const tip = el("div", { class: "timeline-popover", role: "dialog", "aria-label": `Events for ${item.key}`, onmouseenter: () => clearTimeout(this.tipTimer), onmouseleave: () => this.scheduleHide(),
      onfocusout: (event) => { if (!tip.contains(event.relatedTarget) && event.relatedTarget !== anchor) this.scheduleHide(); },
      onkeydown: (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }
    }, [el("div", { class: "split" }, [el("strong", { text: `#${item.number} · ${events.length === 1 ? events[0].label : `${events.length} updates`}` }), el("button", { class: "link-btn", text: "Close", onclick: close })]),
      el("ol", {}, events.map((event) => el("li", {}, this.eventDetails(event))))
    ]);
    this.tip = tip;
    document.body.append(tip);
    const box = anchor.getBoundingClientRect();
    const width = tip.offsetWidth, height = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.left - width / 2))}px`;
    tip.style.top = `${Math.max(8, box.bottom + height + 12 < window.innerHeight ? box.bottom + 8 : box.top - height - 8)}px`;
  }
};
document.addEventListener("keydown", (event) => { if (event.key === "Escape") TimelineUI.hideTip(); });
document.addEventListener("pointerdown", (event) => { if (TimelineUI.tip && !TimelineUI.tip.contains(event.target) && !TimelineUI.anchor?.contains(event.target)) TimelineUI.hideTip(); });
window.addEventListener("resize", () => {
  TimelineUI.hideTip();
  const scroller = document.querySelector(".timeline-scroll");
  if (TimelineUI.atEnd && scroller) scroller.scrollLeft = scroller.scrollWidth;
  TimelineUI.scheduleWindow();
});
