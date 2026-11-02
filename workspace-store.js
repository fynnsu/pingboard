"use strict";

/* Versioned, per-login IndexedDB persistence. Decisions and their events commit
   together; read-modify-write transactions also serialize changes across tabs. */
class WorkspaceStore {
  static names = ["items", "decisions", "events", "meta", "history"];
  constructor(login) { this.name = `pingboard.workspace.v1.${login.toLowerCase()}`; }
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = () => {
        for (const name of WorkspaceStore.names) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other Pingboard tabs to upgrade local storage."));
    });
    this.db.onversionchange = () => this.db.close();
    return this;
  }
  transaction(names, operation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(names, "readwrite");
      const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Local storage could not be saved."));
      const guard = (handler) => (...args) => {
        try { handler(...args); }
        catch (error) { tx.abort(); reject(error); }
      };
      try { operation(stores, (value) => { result = value; }, guard); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async read() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(WorkspaceStore.names, "readonly");
      const result = {};
      for (const name of WorkspaceStore.names) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { result[name] = request.result; };
      }
      tx.oncomplete = () => resolve({ version: 1, ...result });
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  put(name, record) {
    return this.transaction([name], (stores) => stores[name].put(record));
  }
  observe(items, reduce) {
    return this.transaction(["items", "decisions", "events"], (stores, done, guard) => {
      const results = [];
      done(results);
      for (const item of items) {
        const previous = stores.items.get(item.id);
        previous.onsuccess = guard(() => {
          const request = stores.decisions.get(item.id);
          request.onsuccess = guard(() => {
            const result = reduce(previous.result, item, request.result);
            stores.items.put(result.item);
            if (result.decision) stores.decisions.put(result.decision);
            for (const event of result.events || []) stores.events.put(event);
            results.push(result);
          });
        });
      }
    });
  }
  decide(id, reduce) {
    return this.transaction(["decisions", "events"], (stores, done, guard) => {
      const request = stores.decisions.get(id);
      request.onsuccess = guard(() => {
        const result = reduce(request.result);
        if (!result) return done(null);
        stores.decisions.put(result.decision);
        stores.events.put(result.event);
        done(result);
      });
    });
  }
  undo(id, revision, previous, eventId) {
    return this.transaction(["decisions", "events"], (stores, done) => {
      const request = stores.decisions.get(id);
      request.onsuccess = () => {
        if (request.result?.revision !== revision) return done(false);
        if (previous) stores.decisions.put(previous);
        else stores.decisions.delete(id);
        const event = stores.events.get(eventId);
        event.onsuccess = () => {
          if (event.result) stores.events.put({ ...event.result, reverted: true });
        };
        done(true);
      };
    });
  }
  async restore(snapshot, replace = false) {
    const clean = WorkspaceStore.validate(snapshot);
    return this.transaction(WorkspaceStore.names, (stores) => {
      for (const name of WorkspaceStore.names) {
        if (replace) stores[name].clear();
        for (const record of clean[name]) {
          if (replace) { stores[name].put(record); continue; }
          const existing = stores[name].get(record.id);
          existing.onsuccess = () => {
            const old = existing.result;
            if (name === "events" && old && (old.reverted || record.reverted)) { stores[name].put({ ...old, reverted: true }); return; }
            if (!old || (name !== "meta" && new Date(record.updatedAt || record.at || 0) > new Date(old.updatedAt || old.at || 0))) stores[name].put(record);
          };
        }
      }
    });
  }
  static validate(snapshot) {
    if (snapshot?.version !== 1 || !["items", "decisions", "events", "meta"].every((name) => Array.isArray(snapshot[name])) || (snapshot.history !== undefined && !Array.isArray(snapshot.history))) throw new Error("Unsupported workspace backup.");
    const clean = { version: 1 };
    for (const name of WorkspaceStore.names) {
      // Older backups may contain the retired fixed-batch feature.
      clean[name] = (snapshot[name] || []).filter((record) => name !== "meta" || record?.id !== "session").map((record) => {
        if (!record || typeof record.id !== "string" || !record.id || record.id.length > 500) throw new Error("Invalid workspace record.");
        // Whitelists keep tokens and unexpected backup properties out of storage/exports.
        const fields = {
          items: ["id", "kind", "key", "repo", "number", "title", "url", "state", "isDraft", "author", "createdAt", "updatedAt", "closedAt", "mergedAt", "mergedBy", "headOid", "rollup", "reviewDecision", "labels", "comments", "reviews", "additions", "deletions", "files", "body", "linkedIssues", "firstSeenAt", "origin"],
          decisions: ["id", "revision", "status", "triagedAt", "updatedAt", "dueAt", "waitingFor", "note", "reason"],
          events: ["id", "itemId", "repo", "number", "kind", "actor", "at", "observedAt", "source", "state", "message", "reverted"],
          meta: ["id", "repo", "startedAt", "lastSync", "complete", "updatedAt", "scan", "retryAt"],
          history: ["id", "repo", "kind", "since", "syncedAt", "updatedAt", "sourceUpdatedAt", "cursor", "complete", "events"]
        }[name];
        const value = Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));
        for (const field of ["createdAt", "updatedAt", "closedAt", "mergedAt", "firstSeenAt", "triagedAt", "dueAt", "at", "observedAt", "startedAt", "lastSync", "since", "syncedAt", "sourceUpdatedAt"]) {
          if (value[field] != null && (typeof value[field] !== "string" || !Number.isFinite(Date.parse(value[field])))) throw new Error("Invalid date in backup.");
        }
        for (const field of ["title", "url", "author", "body", "note", "reason", "message", "actor", "repo"]) {
          if (value[field] != null && typeof value[field] !== "string") throw new Error("Invalid text in backup.");
        }
        if (name === "items" && (value.kind !== "pr" || !/^[\w.-]+\/[\w.-]+$/.test(value.repo) || !Number.isInteger(value.number) || value.number <= 0 || value.key !== `${value.repo}#${value.number}` || !["OPEN", "CLOSED", "MERGED"].includes(value.state) || typeof value.title !== "string")) throw new Error("Invalid PR in backup.");
        if (name === "items") {
          for (const field of ["labels", "comments", "reviews", "linkedIssues"]) {
            if (value[field] === undefined) value[field] = [];
            if (!Array.isArray(value[field]) || value[field].some((entry) => !entry || typeof entry !== "object")) throw new Error("Invalid PR details in backup.");
          }
          if (value.labels.some((label) => typeof label.name !== "string" || !/^[0-9a-f]{6}$/i.test(label.color))) throw new Error("Invalid label in backup.");
        }
        if (name === "decisions" && !["new", "needs_me", "waiting", "later", "purgatory"].includes(value.status)) throw new Error("Invalid triage decision in backup.");
        if (name === "events" && (typeof value.itemId !== "string" || typeof value.kind !== "string" || !Number.isFinite(Date.parse(value.at)))) throw new Error("Invalid activity in backup.");
        if (name === "history") {
          if (!["pr", "inventory"].includes(value.kind) || !/^[\w.-]+\/[\w.-]+$/.test(value.repo) || !Number.isFinite(Date.parse(value.since)) || typeof value.complete !== "boolean" || (value.cursor != null && typeof value.cursor !== "string") || !Array.isArray(value.events)) throw new Error("Invalid timeline history in backup.");
          value.events = value.events.map((event) => {
            if (!event || !["id", "kind", "label"].every((field) => typeof event[field] === "string") || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid timeline event in backup.");
            if (["actor", "message", "url"].some((field) => event[field] != null && typeof event[field] !== "string")) throw new Error("Invalid timeline event details in backup.");
            return Object.fromEntries(["id", "kind", "label", "at", "actor", "message", "url"].filter((field) => event[field] !== undefined).map((field) => [field, event[field]]));
          });
        }
        if (name === "meta" && value.retryAt != null && (!Number.isFinite(value.retryAt) || value.retryAt < 0)) throw new Error("Invalid discovery retry time in backup.");
        if (name === "meta" && value.scan != null) {
          const scan = value.scan;
          if (scan.version !== 1 || !["open", "updated", "reconcile"].includes(scan.stage)
            || !Number.isFinite(Date.parse(scan.startedAt)) || (scan.cursor !== null && typeof scan.cursor !== "string")
            || !Number.isInteger(scan.pageSize) || scan.pageSize < 5 || scan.pageSize > 20
            || !["openIds", "reconciledIds", "cursors"].every((field) => Array.isArray(scan[field]) && scan[field].every((id) => typeof id === "string"))
            || (scan.total !== null && (!Number.isInteger(scan.total) || scan.total < 0))) throw new Error("Invalid discovery checkpoint in backup.");
          value.scan = Object.fromEntries(["version", "startedAt", "stage", "cursor", "cursors", "openIds", "reconciledIds", "pageSize", "total"].map((field) => [field, scan[field]]));
        }
        return value;
      });
    }
    return clean;
  }
  close() { this.db?.close(); }
}
