"use strict";

/* Coordinates storage, repository synchronization, and the personal workflow.
   The views in workspace-ui.js only issue commands and render these records. */
const Work = {
  ready: false, error: "", generation: 0, repo: "", queue: "new", boardQueue: "all",
  items: new Map(), decisions: new Map(), events: new Map(), meta: new Map(), unsavedEvents: new Map(),
  async start(login) {
    this.stop();
    const generation = this.generation;
    this.login = login;
    const repos = this.repositories();
    this.repo = state.prefs.workspaceRepo === "" || repos.includes(state.prefs.workspaceRepo) ? state.prefs.workspaceRepo
      : repos.includes(state.prefs.defaultRepo) ? state.prefs.defaultRepo : repos[0];
    this.queue = "new";
    this.boardQueue = "all";
    this.error = "";
    try {
      const storage = await new WorkspaceStore(login).open();
      if (generation !== this.generation) { storage.close(); return; }
      this.storage = storage;
      await this.reload();
      if (generation !== this.generation) return;
      this.ready = true;
      this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(storage.name) : null;
      if (this.channel) this.channel.onmessage = () => this.reload().catch((error) => this.fail(error));
      this.syncer = new RepositorySync({
        query: (query, variables, options = {}) => {
          if (generation !== this.generation) throw new Error("Session changed");
          if (state.rate.retryAt > Date.now()) throw Object.assign(new Error("GitHub asked discovery to wait before retrying."), { retryAt: state.rate.retryAt });
          if (state.rate.remaining !== null && state.rate.remaining < RATE_FLOOR && Date.now() < state.rate.reset) throw Object.assign(new Error("API quota is low. Discovery will resume after the rate limit resets."), { retryAt: state.rate.reset });
          return gql(query, variables, { strict: true, ...options });
        },
        observe: (items, meta) => this.observe(items, meta, generation),
        metadata: (repo) => this.meta.get(`repo:${repo}`),
        saveMetadata: async (record) => {
          if (generation !== this.generation) return;
          await storage.put("meta", record);
          if (generation !== this.generation) return;
          this.meta.set(record.id, record);
          this.channel?.postMessage("changed");
        },
        items: () => [...this.items.values()], changed: () => render()
      });
      navigator.storage?.persist?.().catch(() => {});
      this.tick(true);
    } catch (error) { if (generation === this.generation) this.fail(error); }
    render();
  },
  stop() {
    this.generation += 1;
    this.syncer?.stop();
    this.channel?.close();
    this.storage?.close();
    this.syncer = null;
    this.channel = null;
    this.storage = null;
    this.ready = false;
    this.saving = false;
    for (const name of ["items", "decisions", "events", "meta", "unsavedEvents"]) this[name] = new Map();
  },
  fail(error) {
    this.error = `Local history could not be saved: ${error.message}. Retry or export before closing this tab.`;
    render();
  },
  async reload() {
    const generation = this.generation;
    if (!this.storage) return;
    const data = await this.storage.read();
    if (generation !== this.generation) return;
    for (const name of ["items", "decisions", "events", "meta"]) this[name] = new Map(data[name].map((record) => [record.id, record]));
    render();
  },
  async changed() {
    await this.reload();
    this.channel?.postMessage("changed");
  },
  async retryStorage() {
    if (!this.ready) return this.start(state.user.login);
    try {
      for (const event of this.unsavedEvents.values()) {
        await this.storage.put("events", event);
        this.unsavedEvents.delete(event.id);
      }
      await this.changed();
      this.error = "";
      this.tick(true);
      render();
    } catch (error) { this.fail(error); }
  },
  ref(key) { return [...this.items.values()].find((item) => item.key === key); },
  decision(item) { return this.decisions.get(item?.id); },
  repositories() { return [...new Set([...state.prefs.trackedRepos, ...state.board.pins.map((pin) => pin.repo)])]; },
  matchesRepo(item) { return !this.repo || item.repo === this.repo; },
  inScope(item) { return this.repositories().includes(item.repo) && this.matchesRepo(item); },
  setRepo(repo) {
    this.repo = repo;
    state.prefs.workspaceRepo = repo;
    persistPrefs();
    this.setPage(state.page);
  },
  scopedItems() { return [...this.items.values()].filter((item) => this.inScope(item)); },
  inboxItems() { return this.scopedItems().filter((item) => state.prefs.includeDrafts || !item.isDraft); },
  setInboxOptions(values) {
    Object.assign(state.prefs, values);
    persistPrefs();
    state.cursor = null;
    render();
  },
  scopedEvents() { return [...this.events.values()].filter((event) => this.inScope(event)); },
  counts() {
    const counts = Object.fromEntries(Object.keys(Workflow.queues).map((key) => [key, 0]));
    for (const item of this.inboxItems()) {
      const queue = Workflow.queue(item, this.decision(item));
      counts[queue] += 1;
      if (queue !== "purgatory") counts.all += 1;
    }
    return counts;
  },
  visible() {
    const query = state.query.trim().toLowerCase();
    return this.inboxItems().filter((item) => {
      const queue = Workflow.queue(item, this.decision(item));
      if ((queue === "purgatory") !== (this.queue === "purgatory")) return false;
      const selected = state.page === "inbox" && item.key === state.cursor;
      // Background updates may change a queue, but must never retarget an action
      // beneath the user's pointer. Explicit triage and navigation move selection.
      if (!selected && this.queue !== "all" && queue !== this.queue) return false;
      return !query || `${item.title} ${item.repo}#${item.number} ${item.author} ${(item.labels || []).map((label) => label.name).join(" ")} ${this.decision(item)?.note || ""}`.toLowerCase().includes(query);
    }).sort((a, b) => Workflow.compare(a, b, state.prefs.inboxSort));
  },
  select(key) {
    state.cursor = key;
    const ref = this.ref(key);
    if (ref && (!state.status.get(key)?.at || Date.now() - state.status.get(key).at > state.prefs.interval * 1000)) queueRefresh(ref);
    render();
  },
  setPage(page) {
    const previous = state.cursor;
    state.page = page;
    state.query = "";
    state.cursor = null;
    const input = document.querySelector("#filter");
    if (input) input.value = "";
    const visible = page === "board" ? visiblePins() : this.visible();
    state.cursor = visible.find((item) => item.key === previous)?.key || visible[0]?.key || null;
    if (page === "inbox" && state.cursor) this.select(state.cursor);
    render();
  },
  setQueue(queue) {
    this.queue = queue;
    this.setPage("inbox");
  },
  openItem(item, page) {
    if (!this.matchesRepo(item)) this.setRepo(item.repo);
    if (page === "board") {
      state.filter = "all";
      this.boardQueue = "all";
      const pin = pinByKey(item.key);
      const group = boardGroups().find((entry) => entry.lane ? entry.lane === pinLane(pin) : entry.id === pin?.group);
      if (group) setGroupCollapsed(group, false);
    } else {
      this.queue = this.decision(item)?.status === "purgatory" ? "purgatory" : "all";
      if (item.isDraft && !state.prefs.includeDrafts) { state.prefs.includeDrafts = true; persistPrefs(); }
    }
    this.setPage(page);
    this.select(item.key);
  },
  tick(force = false) {
    if (!this.ready || !this.syncer || this.error) return;
    const ttl = (document.hidden ? 10 : 2) * 60 * 1000;
    for (const repo of state.prefs.trackedRepos) {
      if (this.syncer.running.has(repo)) continue;
      const last = this.meta.get(`repo:${repo}`)?.lastSync;
      const status = this.syncer.status.get(repo);
      const retryAt = status?.retryAt || this.meta.get(`repo:${repo}`)?.retryAt;
      const due = retryAt ? Date.now() >= retryAt : Date.now() - new Date(last || 0).getTime() > ttl && Date.now() - (status?.attempt || 0) > ttl;
      if (force || due) this.syncer.sync(repo);
    }
  },
  async observe(items, meta = {}, generation = this.generation) {
    if (!this.ready || generation !== this.generation) return;
    const now = new Date().toISOString();
    const login = this.login;
    const results = await this.storage.observe(items, (before, next, decision) => {
      if (before && new Date(before.updatedAt) > new Date(next.updatedAt)) return { item: before, decision, events: [] };
      const item = { ...before, ...next, firstSeenAt: before?.firstSeenAt || now,
        origin: before?.origin || (next.createdAt && new Date(next.createdAt) >= new Date(meta.startedAt || now) ? "arrival" : "backlog") };
      const events = [];
      const event = (kind, at, extra = {}) => ({ id: `${item.id}:${kind}:${at}`, itemId: item.id, repo: item.repo, number: item.number, kind, at, observedAt: now, source: "github", ...extra });
      if (!before && item.origin === "arrival") events.push(event("arrival", item.createdAt, { actor: item.author }));
      if (item.state !== "OPEN" && (before?.state === "OPEN" || (!before && item.origin === "arrival"))) {
        events.push(event("resolved", item.mergedAt || item.closedAt || now, { state: item.state, actor: item.mergedBy || null }));
      }
      if (before && before.state !== "OPEN" && item.state === "OPEN") events.push(event("reopened", item.updatedAt || now));
      const reason = Workflow.wakeReason(before, item, decision, login);
      if (reason) {
        decision = { ...decision, status: "needs_me", dueAt: null, reason, updatedAt: now, revision: Workflow.id() };
        events.push(event("resurfaced", now, { message: reason }));
      }
      // Attribute only verifiable recent GitHub activity; never invent old triage.
      const trackingStart = new Date(meta.startedAt || this.meta.get(`repo:${item.repo}`)?.startedAt || now).getTime();
      for (const comment of item.comments || []) {
        const ci = /^\/ci\b/.test(comment.text || "") || Object.values(profileFor(item.repo).ciCommands || {}).includes(comment.text);
        if (comment.id && Workflow.sameLogin(comment.login, login) && new Date(comment.at).getTime() >= trackingStart && !ci) {
          events.push({ ...event("comment", comment.at, { actor: comment.login }), id: `comment:${comment.id}` });
        }
      }
      for (const review of item.reviews || []) {
        if (review.id && review.at && review.state !== "PENDING" && Workflow.sameLogin(review.login, login) && new Date(review.at).getTime() >= trackingStart) {
          events.push({ ...event("review", review.at, { actor: review.login }), id: `review:${review.id}` });
        }
      }
      return { item, decision, events };
    });
    if (generation !== this.generation) return;
    for (const result of results) {
      this.items.set(result.item.id, result.item);
      if (result.decision) this.decisions.set(result.decision.id, result.decision);
      for (const event of result.events) { this.events.set(event.id, event); this.unsavedEvents.delete(event.id); }
      const cached = state.data.get(result.item.key);
      if (cached && state.cursor === result.item.key && (cached.headOid !== result.item.headOid || cached.state !== result.item.state || cached.updatedAt !== result.item.updatedAt)) queueRefresh(result.item);
    }
    this.channel?.postMessage("changed");
    render();
  },
  async observeDetail(pr) {
    if (!this.ready) return;
    const item = { id: pr.id, kind: "pr", key: pr.key, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url,
      state: pr.state, isDraft: pr.isDraft, author: pr.author, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
      closedAt: pr.closedAt, mergedAt: pr.mergedAt, mergedBy: pr.mergedBy, headOid: pr.headOid,
      rollup: pr.rollup, reviewDecision: pr.reviewDecision, labels: pr.labels, comments: pr.comments,
      reviews: pr.activityReviews || [], additions: pr.additions, deletions: pr.deletions, files: pr.files,
      body: pr.body, linkedIssues: pr.linkedIssues || [] };
    await this.observe([item], this.meta.get(`repo:${pr.repo}`));
  },
  async decide(item, values, { advance = true, undo = true, announce = true, track = false } = {}) {
    if (!this.ready || this.saving || !item || (item.state !== "OPEN" && !(values.status === "new" && this.decision(item)?.status === "purgatory"))) return false;
    this.saving = true;
    const generation = this.generation;
    const candidates = this.visible();
    const index = candidates.findIndex((entry) => entry.id === item.id);
    const now = new Date().toISOString();
    let previous;
    try {
      const result = await this.storage.decide(item.id, (before) => {
        previous = before;
        const decision = { id: item.id, revision: Workflow.id(), status: values.status,
          triagedAt: values.status === "new" ? null : before?.triagedAt || now, updatedAt: now, dueAt: values.dueAt || null,
          waitingFor: values.waitingFor || null, note: values.note ?? before?.note ?? "", reason: "" };
        if (before && ["status", "dueAt", "waitingFor", "note"].every((field) => decision[field] === before[field]) && !before.reason) return null;
        const event = { id: Workflow.id(), itemId: item.id, repo: item.repo, number: item.number,
          kind: values.status === "new" ? "restore" : before?.triagedAt ? "followup" : "triage", actor: this.login, at: now, source: "pingboard",
          message: `${Workflow.queues[values.status]}${decision.note ? ` · ${decision.note}` : ""}` };
        return { decision, event };
      });
      if (generation !== this.generation) return false;
      if (result) {
        this.decisions.set(item.id, result.decision);
        this.events.set(result.event.id, result.event);
        this.channel?.postMessage("changed");
        if (!this.unsavedEvents.size) this.error = "";
      }
      // Tracking uses the existing board, preserving its groups and manual pins.
      // Explicit triage adds membership; background sync never creates pins.
      const addedPin = track && addPin(item.repo, item.number) ? pinByKey(item.key) : null;
      const addedGroup = addedPin?.group;
      const addedIndex = state.board.pins.indexOf(addedPin);
      if (result || addedPin) {
        if (announce) toast(`${shortRef(item.repo, item.number)} → ${Workflow.queues[values.status]}${track ? " · on CI board" : ""}`, "ok", undo ? {
          label: "Undo", run: async () => {
            if (generation !== this.generation) return;
            try {
              const restored = result ? await this.storage.undo(item.id, result.decision.revision, previous, result.event.id)
                : this.decisions.get(item.id)?.revision === previous?.revision;
              // A pre-existing pin, or one subsequently moved/replaced, belongs to
              // the user's later intent and must survive undoing this decision.
              if (restored && addedPin && pinByKey(item.key) === addedPin && addedPin.group === addedGroup
                && state.board.pins.indexOf(addedPin) === addedIndex) {
                state.board.pins.splice(addedIndex, 1);
                persistBoard();
              }
              await this.changed();
              if (restored) this.select(item.key);
              else toast("This PR changed again; its newer decision was kept.");
            } catch (error) { this.fail(error); }
          }
        } : null);
      }
      if (advance && state.page === "inbox") {
        const next = candidates[index + 1] || candidates.find((entry) => entry.id !== item.id);
        state.cursor = next?.key || null;
        if (state.cursor) this.select(state.cursor);
      }
      return true;
    } catch (error) { if (generation === this.generation) this.fail(error); return false; }
    finally { if (generation === this.generation) { this.saving = false; render(); } }
  },
  async record(pr, kind, details = {}) {
    if (!this.ready) return;
    const generation = this.generation;
    const event = { id: details.id || Workflow.id(), itemId: pr.id, repo: pr.repo, number: pr.number,
      kind, actor: this.login, at: details.at || new Date().toISOString(), observedAt: new Date().toISOString(), source: "pingboard", message: details.message || "" };
    try {
      await this.storage.put("events", event);
      if (generation !== this.generation) return;
      this.events.set(event.id, event);
      this.unsavedEvents.delete(event.id);
      this.channel?.postMessage("changed");
      render();
    } catch (error) {
      if (generation === this.generation) { this.unsavedEvents.set(event.id, event); this.fail(error); }
    }
  },
  async export() {
    if (!this.storage) throw new Error("Workspace storage is unavailable; reload before exporting.");
    const snapshot = await this.storage.read();
    const events = new Map(snapshot.events.map((event) => [event.id, event]));
    for (const event of this.unsavedEvents.values()) events.set(event.id, event);
    return { ...snapshot, meta: snapshot.meta.filter((record) => record.id !== "session"), events: [...events.values()] };
  },
  async import(snapshot, replace) {
    if (!this.storage) throw new Error("Workspace storage is unavailable.");
    WorkspaceStore.validate(snapshot);
    const login = this.login;
    this.syncer?.stop();
    await Promise.allSettled([...this.syncer?.running.values() || []]);
    try {
      await this.storage.restore(snapshot, replace);
      this.channel?.postMessage("changed");
    } finally { await this.start(login); }
  }
};
