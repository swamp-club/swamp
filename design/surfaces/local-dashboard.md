---
audience: maintainer
last-verified: 2026-11-04 @ 4b6e263c
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

Both are served by the user's **hub**. When `swampd` sits next to the
swamp executable (or `SWAMPD_BINARY` names it), that is the Go hub, one
long-lived process per user shared by every invocation (see
[The Go hub](#the-go-hub)). Otherwise each invocation runs its own TypeScript
hub inside the [start](./start.md) server, as described from
[Why this shape](#why-this-shape) on. Phase 4 removes the TypeScript hub.

## The Go hub

`swamp start` and `swamp dashboard` find the hub through
`<dataDir>/hub/hub.json`, which the hub writes once it listens (mode 0600,
never through a symlink): its pid, port, admin token and the swamp executable
it runs as its engines. A record whose hub is gone, or that runs another swamp
build, is not reused. A hub that swamp launched for another build is asked to
stop once no page uses it, and a new one is launched. The launch is detached,
on `127.0.0.1:0`, with `--exit-when-idle 60s`, under
`<dataDir>/hub/launch.lock` so two invocations never both launch one. A hub run
by `swamp hub daemon enable` (user service `swamp-hub.service` /
`club.swamp.hub`, fixed address `127.0.0.1:9870`) never exits when idle.

Each invocation takes a **page lease** from the hub's admin API. The lease's
token is the page token in the printed URL, and Ctrl-C (or any exit) revokes
it.

- `swamp start` leases every workspace. Its start server still runs in the
  invoking process, for the `start.*` flows and workspace claims, and is the
  lease's **backend**: the hub bridges `/start/ws` and `/start/ping` to it. The
  hub reports the lease's open dashboard tabs when the invocation renews it,
  and the start server counts them as open pages.
- `swamp dashboard` leases its one workspace and runs no server. A registered
  folder is served under its workspace name. Anything else is bound to the
  lease by its realpath and served under its folder name made routable
  (lowercased, other characters to `-`). It is trusted, since the user ran
  swamp there. The command ends paused after 10 minutes with no tab open.

The hub serves `/` (redirect to `/dashboard/hub`), the bundle under
`/dashboard/` (fetched from the control engine in chunks and kept in memory
when immutable) and `/api/local/workspaces` (every registered workspace for
an all-workspaces lease, else the lease's one, with `switchable: false`). The
`/w/<workspace>/` routes are the hub's page routes
([go-serve](../enablers/go-serve.md#hub-dashboard-pages)): one engine per
workspace, read-only when `local-v1` refuses the repo (any repo with no serve
admins, for instance), so the dashboard child is not used. A lease asking for
a workspace outside its scope gets the same `No workspace named <name>` 404 as
an unknown one. An invocation that stops renewing loses its lease after a
minute. The hub exits a minute after no lease and no engine remain.

On the shared hub, `/` and `/dashboard/start` load for every page, whatever
command opened it. A `swamp dashboard` lease has no backend, so its token
cannot open a start page socket.

**Hub overview.** `swamp hub open` takes an all-workspaces lease with
**manage** and opens `/dashboard/hub`, holding the lease until Ctrl-C. The
page polls `/api/local/hub` every 3 s while visible and shows:
- the hub: version, engine, address, uptime and idle exit
- every workspace: registered, lease-bound (`swamp dashboard`) or registered
  with its folder gone, each with its engine's state, pid, tabs and uptime
- the sessions holding leases, named by command and pid
- the tail of `hub.log`

From the page you can stop one engine (its tabs reconnect to a new one), end
another session (its command exits with "The swamp hub ended this session.")
or stop an auto-launched hub; each asks first. A service hub can't be stopped
there, since its service manager would restart it. Workspace links open that
workspace's dashboard, and its switcher leads back to the overview. A `swamp
start` or `swamp dashboard` token gets 403 on the overview.

## Why this shape

The rest of this page describes the TypeScript hub, which is used when
`swampd` is not installed.

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
- Agent sessions is never "Off": like under serve, its sidebar item is hidden
  until the viewer can read a session ([agent-sessions](./agent-sessions.md#the-page)).
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

Refresh-on-change drives the dashboard's reads; the only clocks are a live
run's poll and the second-by-second clocks beside it. Run summaries, the model
usage summary behind the Models page and the model output search behind a
model's page are re-read when a run starts or stops being driven and when the
tab comes back into view,
at most once per 30 seconds (`RUN_ACTIVITY_REFETCH_MS`) and never while the tab
is hidden. Such a re-read, and the age-out re-read below, does not supersede a
read still in flight: it waits for that read, whose answer is shown, then reads
once more, however many changes came meanwhile (`refresh` in `useRequest`). A
read slower than the throttle is still shown while runs keep starting, and the
re-read after it is sent as soon as it settles, outside the throttle, so a slow
serve has one such read in flight at a time (swamp-club#3960). A payload or
time-range change still supersedes it. A live run's page polls only the run and
its logs; its run-search row is re-read when the run's status or the active runs
change. A poll tick, and the re-read on coming back into view, waits for a read
of the run or its logs still in flight instead of sending another (`reload` in
`useRequest`), so a slow serve sees at most one of each per page rather than one
per tick (swamp-club#3742). There is no client-side request timeout: a read
serve never answers holds the page's live reads until it answers or the socket
closes, which rejects it. A preset time range is sent as a duration
(`since: "7d"`) to the run queries, `model.output.search` and
`model.usage.summary`, so the request does not change as the clock moves.

The Models page reads its counts from `model.usage.summary`, so they are exact
at any volume, and a card's run history is that row's newest outputs. A serve
that refuses the request leaves the cards up without their usage strip. Each read
goes through every output in the window, unlike a search with a `limit`, so on a
busy repo with a wide window run activity can keep one read going at a time.
There is no age-out re-read as run summaries have, which would add a read each
time the oldest output leaves a preset window. Between re-reads the counts can
include an output that has since left the window.

The sidebar, overview and Approvals page share one approvals request owner.
Entering either page or retrying a read joins an in-flight listing. A completed
decision, cancellation or resume starts a fresh listing so an earlier reply
cannot restore stale gates. All consumers share one read and its refresh
state, but a page shows only a listing that settled after it opened: until
then it shows the loading state while the badge keeps the retained listing,
and a failed entry read shows the error and its retry rather than the listing
retained from before. Expiration becomes visible when the next listing reports
it. Each socket gets a new dashboard lifetime, so reconnects and principal
changes discard the previous listing
(`packages/dashboard/src/client/approvals_request.ts`).

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

A hidden tab does next to nothing (swamp-club#3661). It closes its health
stream, keeping the last snapshot, so nothing re-renders and serve's per-token
stream slot is freed; a live run's page stops polling, and the run and
held-signal clocks stop. On coming back into view the stream reconnects — serve
sends a snapshot as soon as a stream opens, and a token refused earlier is
tried again — views re-read their runs as on any return, and a live run is
re-read once.

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
| Go hub discovery and leases | `src/infrastructure/process/hub_binary.ts`, `hub_launcher.ts`, `hub_probe.ts`, `src/infrastructure/persistence/hub_record.ts`, `src/infrastructure/http/hub_admin_client.ts`, `src/serve/local/hub_lease_session.ts` |
| Go hub | `packages/serve-go/internal/hub/` (`admin.go`, `leases.go`, `site.go`), `internal/gateway/local.go` |
| Hub service | `src/cli/commands/hub.ts` |
| TypeScript hub | `src/serve/local/workspace_hub.ts`, mounted by `src/serve/start/start_server.ts` (`hub` option) |
| Child server | `src/serve/local/local_dashboard_server.ts` |
| Actions | `src/serve/local/local_actions.ts` |
| SPA | `packages/dashboard/src/client/workspace_path.ts`, `client/workspace_list.ts`, `components/WorkspaceSwitcher.tsx`, `views/ServeOnlyStates.tsx` |
| Fixed repo | `src/serve/local/fixed_repo.ts` (`resolveFixedRepo`) |
| Tests | `integration/workspace_hub_test.ts`, `integration/local_dashboard_server_test.ts`, `integration/start_server_test.ts` (dashboard tab lifetime, hub-held pages), `integration/hub_launcher_test.ts`, `packages/serve-go/internal/hub/local_test.go`, unit tests beside each file |

## Not yet

- Releases do not ship `swampd`, so an installed swamp uses the TypeScript
  hub unless `SWAMPD_BINARY` names one.
- On the Go hub the workspace switcher lists workspaces in registry order, not
  by most recent task as the TypeScript hub does.
- On a remote datastore a child reads the local cache as CLI read commands do
  (`requireInitializedRepoReadOnly` does not pull); actions sync, reads may lag.
- Windows: the spawns follow the CLI's own patterns but are not exercised.
