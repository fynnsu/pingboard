# Pingboard

Give every pull request a next step. Pingboard discovers your repositories’ PRs, helps you triage them quickly, brings follow-ups back when they need attention, and tracks your daily progress. The CI board remains your working set for shepherding selected PRs through checks, review, and merge.

<img width="1668" height="1027" alt="Screenshot 2026-10-08 at 12 57 06 PM" src="https://github.com/user-attachments/assets/458d4cbf-d81b-4962-937f-36c99a792ed9" />

It is a static page that talks to the GitHub API from your browser: no server, no build step, no dependencies. It is tuned for [vllm-project/vllm](https://github.com/vllm-project/vllm) and works for any repository.

## PR inbox

Choose **Repositories to discover** in Settings. The inbox automatically loads every open PR across all pages. Choose **Oldest first**, **Newest first**, or **Most recent changes**, and toggle **Include drafts**; both preferences survive reloads. **Take on** moves a PR to **Needs me** and adds it to your CI board. **Waiting** and **Later** also add it to their board groups. Both views share triage, notes, and reminders. Existing pinned boards and settings load unchanged; existing open PRs start as an untriaged backlog rather than being counted as new arrivals.

| Queue | What belongs here |
| --- | --- |
| **New** | Open PRs without an explicit personal decision. Reading a PR does not triage it. |
| **Needs me** | PRs you took on, due reminders, or waiting PRs with a relevant update. |
| **Waiting** | Waiting for an author, reviewer, or CI, with a fallback reminder. |
| **Later** | Deliberately deferred until a revisit date. A note is optional. |
| **Resolved** | PRs observed merged or closed on GitHub. Reopened PRs return to attention. |
| **All** | Every discovered PR except those in Purgatory, subject to the draft filter. |
| **Purgatory** | Set aside indefinitely without closing on GitHub. Hidden from other inbox tabs and the CI board; updates do not resurface it. Restore it to New when you want to reconsider it. |

Select a PR to see its description, linked issues, change size, checks, and personal activity history. **Take on** (`t`), **Waiting** (`w`), and **Later** (`s`) save personal decisions. Waiting and Later work with empty notes and offer default reminders you can adjust. **Purgatory** saves an indefinite local decision with Undo. **Route** (`d`) requests a reviewer on GitHub, **Respond** (`n`) posts a comment and waits for a reply, and **Close PR** (`x`) posts a reason and closes the PR. Public actions have an explicit submit dialog. Failed actions keep the dialog and do not mark the PR handled; retrying a partially completed close does not post its reason twice.

Use `j` / `k` to move, `1`–`7` to switch queues, and `/` to search. Successful decisions advance to the next PR. Local decisions offer Undo, including removal of their progress credit and any pin introduced by triage. Existing pins and subsequent changes are preserved. Background changes keep the current selection stable until you navigate or act.

The repository selector applies to the inbox, CI board, and progress, and survives reloads. **All repositories** combines them. Pinned repositories are selectable even without full discovery; add them in Settings to discover their entire backlog. **View on CI board** and **Open in PR inbox** open the same PR across views, clearing filters that would hide it.

An author’s reply or new commits, a submitted review, a draft becoming ready, or a relevant CI completion can bring waiting work back. Reminder deadlines are checked while the app is open and on return. Bot comments and your own replies do not trigger a response notification. Personal notes and reminders stay in Pingboard; GitHub labels and assignments are not used to store them.

## Progress

The daily goal counts **distinct PRs moved forward**, not clicks. Triage decisions, follow-ups, substantive comments, reviews, review requests, branch updates, merges, and reasoned closures qualify. Repeated actions on one PR count once per local calendar day. CI retries, label toggles, merely viewing a PR, and undone decisions do not earn progress.

Work continuously through the inbox at your own pace. Configure the daily goal in Settings.

**Progress** shows daily activity over the last 14 days, the untriaged backlog and its oldest item, work needing you now, and repository arrivals/merges/closures. Personal activity and repository outcomes have separate attribution. Tracking starts when a repository is added: Pingboard does not invent historical triage. Recent GitHub comments and reviews can be recognized during sync, but only the latest five of each are fetched per PR, so this is not a complete audit of activity outside Pingboard. All confirmed actions performed in Pingboard are recorded.

## CI board

The board follows PRs you took on, marked Waiting/Later, or manually pinned through CI, review, and merge. By default it groups them into **Updated**, **In progress**, **Waiting**, **Later**, **Untriaged pins**, and **Resolved**. Waiting, Later, untriaged pins, and resolved PRs start collapsed. A due reminder or relevant update moves a follow-up into Updated automatically. Taking it on acknowledges that update and puts it in In progress. Newly discovered PRs do not enter the board until you triage or pin them.

Choose **Group by → My groups** to use your existing manual organization; switching views preserves those groups and their order. Filter by triage status alongside the CI filters. Notes and reminders can be updated from either view. Unpinning removes a PR from this working set while preserving its inbox decision and history. Purgatory hides a PR from either board view without discarding its old pin or group.

Each row shows both personal triage and CI status and, where there is an obvious next step, a button for it.

| Status | Meaning | Button |
| --- | --- | --- |
| **CI not started** | no build on the latest commit | Run CI, or Update branch & run CI when the branch is behind |
| **CI running** | jobs in progress, with any failures so far | — |
| **N failures to look at** | failing jobs not seen failing anywhere else | — |
| **N failures, likely unrelated** | every failing job also fails on the base branch or on other pinned PRs | Retry failed jobs |
| **CI passed · needs review** | green, waiting on a review | — |
| **Ready to merge** | green and approved | Merge… |
| **Merge conflicts** | the author has to resolve them | — |

A blue dot marks a PR that changed since you last selected it. In My groups, drag rows to reorder them or move them between groups. Drag the divider to resize the list.

Selecting a row opens the detail pane: the status with a one-line explanation, the failing and running jobs (each links to its Buildkite job), branch freshness, reviews, labels, and the latest comments — which is where the CI bot answers `/ci` commands.

**+ Pin PRs** searches open pull requests in your default repository (yours, review requested, reviewed, involved, `ready`, all recent). Click to pin; pasting PR numbers or URLs works too. Type `@name` to see one author's PRs. This quick picker shows up to 30 matches; use the inbox for complete discovery. To keep an eye on particular people, **Follow** them from a PR (or list them in Settings): their names are highlighted everywhere and the picker gets a **Following** list.

## Related or unrelated failures

Pingboard does not read logs — Buildkite logs are not reachable from a static page. It sorts failing jobs using what GitHub already knows:

- **N/M on base** — the same job failed on N of the last M base-branch commits that ran CI.
- **also #123 #456** — the same job is failing on other PRs on your board.

A job with either kind of evidence is listed as "likely unrelated". Everything else is "to look at".

## Actions

Everything is done as you, with your token.

- **Comments** (`/ci run`, `/ci retry`, `/ci cancel`) and **branch updates** wait three seconds behind an Undo bar before they are sent.
- **Update branch & run CI** merges the base branch in, waits for the new commit, then posts `/ci run`.
- **Approve** and **Merge** ask for confirmation. **Labels** apply immediately.

Keyboard shortcuts exist for all of it; press `?` for the list.

## Token

Pingboard takes a **classic** personal access token with the `repo` scope (`public_repo` is enough for public repositories). It is sent only from your browser to `api.github.com`, and is kept in `sessionStorage` — or `localStorage` if you tick "Keep token after closing this tab".

Pins, groups, and preferences live in `localStorage`; repository items, personal decisions, and activity live in IndexedDB, scoped to your GitHub login. Data belongs to one browser and one site address. Tabs share updates. Unpinning a PR, clearing completed pins, or removing a tracked repository preserves its history. A storage failure is shown explicitly and cannot earn progress for an unsaved decision.

Settings has **Export board + settings** and **Import board + settings** buttons that include the full workspace and activity history. Backups never include the token. Older board backups are still accepted and preserve existing activity history; newer workspace backups can merge into or replace saved data. Back up before clearing browser data or moving to another browser.

## Refresh and rate limits

Repository discovery runs every two minutes while visible, every ten minutes in background tabs. It enumerates all open PRs, scans recently updated PRs of every state, and reconciles missing open items. This catches PRs that opened and closed between visits. Requests use 20 PRs per page, serialize across repositories, and automatically retry temporary network/server failures up to three times with smaller batches and increasing delays. Progress is saved after each page, so retrying or reloading resumes an interrupted scan instead of reloading the first pages. Checkpoints older than a day restart safely, retaining saved PRs and history.

An incomplete scan retains saved data and shows its count and retry status; the inbox never claims you are caught up. After repeated connection failures it tries again after a short pause, or when the browser reconnects. GitHub rate-limit cooldowns are respected across retries and reloads. Refresh retries immediately when GitHub permits it. Only discovery reads are automatically retried; GitHub mutations are not.

Pinned and selected PRs load full CI detail, refreshing every 60 seconds by default (configurable). Pinned PRs refresh five times slower in background tabs. The base-branch baseline covers the last 30 commits and is re-read every 10 minutes. Remaining API quota is shown in the top bar, and polling pauses if it runs low. Discovery and reminders run while Pingboard is open; there is no background server.

## Code layout

- `workflow.js`: pure attention, attribution, and daily progress rules.
- `workspace-store.js`: versioned IndexedDB storage, atomic decisions/events, import validation, and undo.
- `repository-sync.js`: paginated repository enumeration and reconciliation.
- `workspace.js`: synchronization, persistence, workflow commands, and cross-tab coordination.
- `workspace-ui.js`: inbox, shared triage controls, and progress views.
- `app.js`: existing GitHub transport, CI model, pinned board, actions, and shared UI.

The item model includes a kind and a stable GitHub ID so an Issues page can share workflow and history later. This release handles PRs.

## Other repositories

`owner/repo#123` or a URL pins a PR from anywhere. The Settings button also lets you configure a repository's workflow directly in the browser: which checks count as CI, the gating pipeline, comment commands, quick labels, and merge method. Profiles are selectable from a dropdown and can be deleted; deleting a built-in profile override restores its built-in defaults. These overrides are cached in `localStorage` with the rest of that GitHub user's preferences, so they work on the published site and survive reloads. Built-in defaults live in `REPO_PROFILES` at the top of `app.js`; repositories without a saved or built-in profile start with every check treated as CI and no CI commands.

## Run it

Serve the folder for a stable browser storage address:

```bash
python3 -m http.server 8080
```

The included workflow publishes the folder to GitHub Pages on every push to `main`.

## Tests

```bash
./tests/run
```

Runs saved-board compatibility, workflow rules, and browser integration checks. Uses Bun when available, otherwise Node and npm. GitHub is mocked; tests never use your token or mutate a real repository.

To use an already installed Chrome instead of downloading Chromium:

```bash
PINGBOARD_BROWSER_CHANNEL=chrome ./tests/run
```

For a credential-free manual preview in any installed browser:

```bash
node tests/support/preview.mjs
# Open http://127.0.0.1:8083 — all PRs and GitHub actions are mocked.
```

An optional read-only smoke test uses the GitHub CLI's existing login and prints counts and timings:

```bash
node tests/support/check-live-sync.mjs vllm-project/speculators
```
