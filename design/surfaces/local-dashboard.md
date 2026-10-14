---
audience: maintainer
last-verified: 2026-10-13 @ 1bb4f396
---

# Local dashboard

The local dashboard is the [serve](../primitives/serve.md) dashboard bundle
working on the repos on this machine, with no `swamp serve` running. It is
reached two ways:

- **`swamp start`** — after a workspace is open, "Open dashboard" (header) and
  "Open the dashboard" (after a launch) lead to that workspace's dashboard. The
  sidebar's **Workspace** picker switches between registered workspaces and
  "All workspaces and tasks" goes back to the start page.
- **`swamp dashboard`** — in a repo (or with `--repo-dir`), opens that repo's
  dashboard and only it: no picker, no start-page link, and nothing is added to
  `workspaces.json`. A registered folder keeps its workspace name in the URL,
  anything else uses its folder name. It prints no sign-in line: the auth gate
  has passed before it runs and its page has no login.
- **`--json` is a deliberate exception** to "every command supports log and
  json": `swamp dashboard --json` is refused (`UserError`, exit 1) because the
  command's only result is a page in a browser. `swamp start --json` keeps its
  read-only inspection.

Both run the same loopback server, the [start](./start.md) server, which this
page calls the **hub**.

## Why this shape

**One swamp process serves one repo.** The extension type registries (models,
vaults, datastores, reports, webhooks) are process-wide and bound to one
`repoDir` when the CLI starts (`src/cli/mod.ts`, `setLoader` /
`setTypeLoader`). The hub therefore never answers a workspace's requests
itself: each workspace gets a **child**, `swamp dashboard --child --repo-dir
<folder>`, which runs serve's `handleConnection` in-process for its repo.

**One origin for every workspace.** The browser only ever talks to the hub, so
switching workspace keeps the page's origin (theme, sidebar state, the start
token in `sessionStorage`). The hub forwards `/w/<workspace>/…` to that
workspace's child.

**Children never hold a writer.** A child opens its repo read-only
(`requireInitializedRepoReadOnly`): it never takes a v3 datastore's
writer lease, so CLI commands in the same repo keep working while a
dashboard is open, and it never writes a remote datastore's cache without
syncing. Actions run as CLI commands instead (see [Actions](#actions)).

## Routes

| Path | Answered by | Notes |
| --- | --- | --- |
| `/dashboard/start` | hub | The start page (`start.*` socket at `/start/ws`, token-checked); `swamp start` only, 404 under `swamp dashboard` |
| `/dashboard/w/<workspace>/…` | hub | The dashboard bundle; the SPA reads the workspace from the path |
| `/dashboard/assets/…` | hub | Shared by every page (Vite `base: "/dashboard/"`) |
| `/api/local/workspaces` | hub | `{ workspaces: [{name, path}], switchable }` for the picker |
| `/w/<workspace>/` (WebSocket) | child, through the hub | Only the reads the dashboard makes; four actions are taken by the hub, anything else refused |
| `/w/<workspace>/auth/info` | child | `{ mode: "none", local: true }` |
| `/w/<workspace>/api/v1/health[/stream]` | child | A local snapshot: scheduling off, no workers or webhooks |
| `/w/<workspace>/auth/dashboard/session` | child | 401: there is no login |

Every `/w/…` and `/api/local/…` request needs the hub's token (the start
token) as the `bearer.<token>` subprotocol or the `x-swamp-local-token` header,
checked before anything is listed or started; without it the answer is 401. An
unknown workspace is 404 and starts nothing. In `swamp dashboard` mode only its
one repo resolves. The bundle itself (`/dashboard/…`) needs no token.

## The SPA in local mode

`/auth/info` carries `local: true` only from a child; serve never sends it, and
with no flag and no `/w/<workspace>` segment every path and view is exactly
serve's (`client/workspace_path.ts`, `serverPath`). In local mode:

- Schedules and Webhooks are "Off" ("Needs swamp serve") in the sidebar and
  their pages, deep links included, explain what serve gives and how to run it
  (`views/ServeOnlyStates.tsx`), in the Activity page's audit-off style.
  Activity shows its own audit-off state as under serve.
- There is no Logout, the System page skips Serve Configuration, the loading
  screen says "Connecting to The Swamp", and a run that can't be read says it
  is not recorded in this repo (`views/run_load_error.ts`).
- Both commands hand the token in the URL fragment, never sent to the server
  in the URL. `main.tsx` keeps it (the tab's `sessionStorage` and, so other
  tabs work, the origin's `localStorage`, which is per hub since each binds its
  own port) and strips it; `client/workspace_path.ts` offers it on every
  request. A workspace page with no token says to open it from `swamp start`
  or `swamp dashboard`.

## Actions

The child gets only `FORWARDED_READS`: exactly the reads the dashboard makes.
Every other request (`workflow.run`, `model.method.run`, `vault.put`,
`data.delete`, the schedule writes, and `vault.get`, which the dashboard never
sends) is refused with `not_available_locally` and never reaches it, and a
`cancel` is forwarded only for a read the socket sent there. Approve, reject,
resume and cancel (`src/serve/local/local_actions.ts`) never reach the child
either. The hub reads each browser frame, and for these four runs the
matching CLI command in the workspace's folder (`--repo-dir`), so each takes its
locks and syncs like any CLI write, on every datastore:

| Request | Command | Reply |
| --- | --- | --- |
| `workflow.approve` / `.reject` | `swamp workflow approve\|reject <wf> <step> --run=<id> --json` | The command's JSON as `data`, or an error frame with its message |
| `workflow.cancel` | `swamp workflow cancel <wf> --run=<id> --json` | As above |
| `workflow.resume` | `swamp workflow resume <wf> --run=<id> --json`, **detached** | `event` once the run tracker shows the run running under that pid, then `done` if it ends while the hub is up |

Actions run with `SWAMP_SERVE_URL` and `SWAMP_SERVER_URL` removed from their
environment, so the hub's environment never sends them to a serve: the
dashboard shows the local repo. A repo whose `.swamp.yaml` names a server
(`serverAddress`) still sends them there, as every CLI command in it does. A
name the page sends must not start with `-` and a run id must look like one,
so nothing it sends reads as a flag. A resume runs in its own process group with
no pipes: it outlives the dashboard (Ctrl-C included) and never writes to a
closed pipe. The hub never waits for it, so stopping the dashboard is never held
up by a run. A resume that exits before its run starts is reported with the
command to run by hand. The page's detach (`cancel` with the request id) stays in
the hub.

## Lifetime

- The hub is `swamp start`'s server: a dashboard tab counts as an open page, so
  the server stays up while one is open and follows the start server's usual end
  conditions once none are.
- A child starts on its workspace's first request. With no dashboard socket and
  no HTTP request (the health stream) open it stops after 10 minutes
  (`DEFAULT_CHILD_IDLE_MS`), unless its `/local/busy` says a run it started is
  still going; the next request starts it again. A
  child also stops when the hub closes its stdin, so it never outlives the hub.
- A child's output never reaches the hub's terminal; its last 20 stderr lines
  explain a child that fails to start (502 to the page, a warning in the
  terminal). A child that is not listening within 60 seconds is killed; one
  that does not stop within 10 seconds of its stdin closing gets SIGTERM, then
  SIGKILL.
- The hub stops before the start server does, ends every stream it forwards
  (the health SSE) and stops any action command still running, so neither a
  tab left open nor a stuck action holds a shutdown up. A detached resume is
  never waited for.

## Live runs

A child's health snapshot adds the run tracker's running workflow runs (any
process in the repo, heartbeat within `STALE_TTL_MS`) to its own active runs
(`mergeActiveRuns`, `trackedWorkflowRuns`), so runs started from the CLI show as
live and the views' refresh-on-change covers them. Model-method rows carry no
model name and are left out.

Refresh-on-change is the only clock the dashboard has. Run summaries, and the
model output searches behind the Models page and a model's page, are re-read
when a run starts or stops being driven and when the tab comes back into view,
at most once per 30 seconds (`RUN_ACTIVITY_REFETCH_MS`) and never while the tab
is hidden. A live run's page polls only the run and its logs; its run-search row
is re-read when the run's status or the active runs change. A preset time range
is sent as a duration (`since: "7d"`) to the run queries and to
`model.output.search`, so the request does not change as the clock moves.

A preset's window still moves, so a counted run eventually leaves it. Serve's
run summary reports `oldestStartedAt`, the start of the oldest counted run, and
a run search with a `since` bound reports the resolved `since` and the oldest
match's `oldestStartedAt` beside `total`. On a preset range the dashboard
schedules one refetch for when that run leaves the window: `oldestStartedAt`
minus the echoed `since`, both on serve's clock, so the browser's clock does not
matter. It goes through the same throttle and is held while the tab is hidden;
each answer sets the next deadline. Run summaries, the Executions list and the
schedule and webhook run lists do this. Custom and all-time ranges do not move
and schedule nothing, nor does a serve that predates the fields. Request volume
follows run activity and runs ageing out of the window, not how long a tab stays
open.

## Security

- The hub binds `127.0.0.1` on an ephemeral port and answers any other `Host`
  with 421 (DNS rebinding).
- There is no login, but every workspace route needs the hub's one-time token,
  which only the page `swamp start` or `swamp dashboard` opened holds: another
  process on the machine that finds the port gets 401. A dashboard WebSocket
  must also come from the hub's exact origin (`http://<host>`, port included)
  when it names one.
- The child runs serve's handlers with no auth, so the hub is its gate: only
  the dashboard's reads reach it, and actions run as CLI commands.
- A child takes requests only with the hub's per-child token (header or
  `bearer.` subprotocol); the browser never talks to it.
- The start page keeps its own one-time token, as in [start](./start.md).
- `swamp dashboard` serves no start page: `/`, `/dashboard/start` and the
  `/start/ws` socket answer 404, so its token reaches only the hub routes and
  the `/start/ping` liveness check, and can never add, create or open a
  `swamp start` workspace.

## Where the code lives

| Piece | Path |
| --- | --- |
| Command | `src/cli/commands/dashboard.ts` (hub mode via `runStart`, `--child` mode) |
| Hub | `src/serve/local/workspace_hub.ts`, mounted by `src/serve/start/start_server.ts` (`hub` option) |
| Child server | `src/serve/local/local_dashboard_server.ts` |
| Actions | `src/serve/local/local_actions.ts` |
| SPA | `packages/dashboard/src/client/workspace_path.ts`, `client/workspace_list.ts`, `components/WorkspaceSwitcher.tsx`, `views/ServeOnlyStates.tsx` |
| Fixed repo | `src/serve/local/fixed_repo.ts` (`resolveFixedRepo`) |
| Tests | `integration/workspace_hub_test.ts`, `integration/local_dashboard_server_test.ts`, `integration/start_server_test.ts` (dashboard tab lifetime), unit tests beside each file |

## Not yet

- A second `swamp dashboard` or `swamp start` starts its own hub instead of
  reusing a running one. Two are safe side by side, only redundant.
- On a remote datastore a child reads the local cache as CLI read commands do
  (`requireInitializedRepoReadOnly` does not pull); actions sync, reads may lag.
- Windows: the spawns follow the CLI's own patterns but are not exercised.
