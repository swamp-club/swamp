---
audience: operator, maintainer
last-verified: 2026-08-28 @ ce0ca66b
---

# Serve

Serve is a long-running swamp that others run primitives through. `swamp serve`
is the same binary as the CLI: it opens one listener on one port
(`src/cli/commands/serve.ts`, the single `Deno.serve` call) and every request it
accepts — a workflow run, a method run, a data query, a vault read — is routed
to the same libswamp use case the CLI would have called in-process
(`src/serve/deps.ts` builds `WorkflowRunDeps` / `ModelMethodRunDeps` from a
`RepositoryContext`; `src/serve/handlers/workflow_handlers.ts` calls
`executeWorkflowWithLocks`, `src/serve/handlers/model_handlers.ts` calls
`modelMethodRun`). It is not a scheduler daemon (cron is one trigger among
several), not a message broker (there is no queue between client and executor),
and not a cluster: instances never open connections to each other. When more
than one instance runs, they coordinate only through small records in the
datastore's control-plane store (`src/domain/datastore/control_plane_store.ts`).

The subsystems serve depends on have their own docs:
[remote-execution](../enablers/remote-execution.md) (workers, leases, runners,
the data plane), [run-tracker](../enablers/run-tracker.md) (the SQLite run
ledger and `run doctor`), and — not yet written — `enablers/serve-protocol.md`
(the WebSocket request/response catalogue) and `enablers/access-control.md`
(principals, grants, tokens).

## Why

**One port, four transports.** WebSocket upgrades, the worker data plane,
plain JSON routes and SSE all share the listener and are told apart by request
shape, in that order (`src/cli/commands/serve.ts`, the request handler passed
to `Deno.serve`). One port means one TLS certificate, one firewall rule, one
reverse-proxy stanza, and one `--server` URL for every client, whether it is an
operator's laptop, a CI worker or the dashboard.

**A control-plane store instead of gossip.** Instances share nothing in memory.
Anything two instances must agree on — who is alive, which runs are in flight
where, which cron fire has already been claimed — is a slash-keyed record in
the datastore's `_control/` prefix (`src/domain/datastore/control_plane_store.ts`).
The datastore is already the durable, shared thing every instance has
credentials for, so reusing it avoids a second network surface, service
discovery, and leader election. The one primitive that needs atomicity,
`putIfAbsent`, is optional on the interface and every consumer degrades
gracefully without it.

**Workers dial out.** Remote workers open both their control socket and their
data-plane connection outbound to serve; serve never dials a worker
(`src/serve/worker_gateway.ts` header; the rationale lives in
[remote-execution §Why this shape](../enablers/remote-execution.md#why-this-shape)).

## Configuration

Options are resolved by `mergeServeOptions` in `src/serve/serve_config.ts` with
the precedence **explicit flag > environment variable > `.swamp/serve.yaml` >
built-in default**. Only options listed in `SERVE_ENV_MAP` have an environment
variable; `port` and `host`, for example, do not. An explicit flag is detected
from `Deno.args`, so a flag set to its default still wins over the file
(`parseExplicitFlags`). Unknown keys in the YAML are rejected
(`KNOWN_TOP_LEVEL_KEYS`, `KNOWN_AUTH_KEYS`, `KNOWN_TLS_KEYS`). `--config` names
an alternative file; without it the default path is optional.

| Option (flag / yaml key)                      | Env var                          | Default                     | Notes                                                                    |
| --------------------------------------------- | -------------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| `--port` / `port`                             | —                                | `9090`                      |                                                                          |
| `--host` / `host`                             | —                                | `127.0.0.1`                 | Off-loopback requires TLS and an auth mode (`assertOffLoopbackSecurity`) |
| `--cert-file`, `--key-file` / `tls.*`         | `SWAMP_SERVE_CERT_FILE`, `_KEY_FILE` | unset                   | Both present ⇒ TLS; `ws://` becomes `wss://`                              |
| `--auth-mode` / `auth.mode`                   | —                                | `none`                      | `none` \| `token` \| `oauth`; `none` logs a deprecation warning          |
| `--admins`, `--allowed-collectives`, `--allowed-users` / `auth.*` | —            | unset                       | See [Identity and access](#identity-and-access)                          |
| `--oauth-provider` / `auth.oauth-provider`    | —                                | `https://swamp-club.com`    | Must be HTTPS unless localhost (`src/domain/access/serve_auth_config.ts`) |
| `--group-refresh-interval`                    | `SWAMP_GROUP_REFRESH_INTERVAL`   | 4 h                         | OAuth only; `0` disables                                                 |
| `--grants-file`, `--grants-dir`, `--grant-reload` | `SWAMP_GRANTS_FILE`, `_DIR`  | unset, unset, `manual`      | `auto` starts a `GrantsDirectoryPoller` (30 s)                           |
| `--no-schedule` / `schedule`                  | —                                | `true`                      | Disables cron triggers                                                   |
| `--webhook <route:workflow:secret[:scheme]>` / `webhooks[]` | —                  | none                        | Flags replace the file list entirely                                     |
| `triggers.<workflow>.{schedule,inputs}`       | —                                | none                        | yaml only; overrides a workflow's own trigger                            |
| `--trust-proxy`, `--trusted-hosts`            | `SWAMP_TRUSTED_HOSTS`            | `false`, unset              | `X-Forwarded-For` and WebSocket `Origin` handling                        |
| `--ws-idle-timeout`, `--queue-timeout`        | `SWAMP_WS_IDLE_TIMEOUT`, `SWAMP_QUEUE_TIMEOUT` | unset          | Worker-facing; see remote-execution                                      |
| `--heartbeat-interval`, `--stale-ttl`, `--reconciliation-interval` | `SWAMP_HEARTBEAT_INTERVAL`, `SWAMP_STALE_TTL`, `SWAMP_RECONCILIATION_INTERVAL` | 30 s, 90 s, 60 s | `stale-ttl` must be ≥ 2× heartbeat; no effect without a remote control plane |
| `--hydration-timeout`                         | `SWAMP_HYDRATION_TIMEOUT`        | 60 s                        | Startup pull of the remote datastore                                     |
| `--max-concurrent-runs`, `--max-runs-per-principal`, `--max-run-duration` | `SWAMP_MAX_*` | `100`, unset, unset | Enforced by `ActiveRunRegistry` (`src/serve/active_run_registry.ts`)    |
| `--hot-reload`                                | —                                | `false`                     | Writes `.swamp/serve.pid`; not supported on Windows                      |
| `--enable-internal-api`                       | `SWAMP_ENABLE_INTERNAL_API`      | `false`                     | Exposes `/internal/runs`                                                 |
| `--remote-only`                               | `SWAMP_REMOTE_ONLY`              | `false`                     | Steps run only on workers (`src/domain/remote/remote_dispatch.ts`)       |
| `--dashboard`                                 | `SWAMP_DASHBOARD`                | `false`                     | Serves `/dashboard/*`                                                    |
| `--detach-runs`                               | —                                | `false`                     | Deprecated, no effect: runs are always detached                          |

### Deployment mode

At startup serve classifies the datastore and vault and derives a mode
(`resolveDeploymentMode`, `src/domain/serve/deployment_mode.ts`; the probe is in
`src/cli/commands/serve.ts` just after the registries load). The mode is
reported on `/ready`, in the `--json` listening line, and to swamp-club on
OAuth registration.

| Datastore                           | Vault                                  | Mode                | Meaning                                                              |
| ----------------------------------- | -------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| filesystem                          | any                                    | `local`             | Runs survive a process restart                                       |
| remote, no `controlPlane` capability | any                                   | `local`             | Warns: "Update <type> for cross-machine durability"                  |
| remote with control plane           | none                                   | `durable`           | Warns that secret-dependent workflows fail after instance replacement |
| remote with control plane           | `local_encryption` only                | `durable (limited)` | Runs survive; secrets do not travel                                   |
| remote with control plane           | at least one non-local vault           | `durable`           | Runs survive instance replacement                                    |

"Remote control plane" below means the datastore extension advertises
`capabilities().controlPlane` and exposes `controlPlaneStore()`; otherwise serve
falls back to `FileSystemControlPlaneStore` under `.swamp/_control/`
(`src/infrastructure/persistence/fs_control_plane_store.ts`), which keeps the
same key layout and `putIfAbsent` (via `createNew`) but is visible to one
machine only.

## Surface

Everything below shares the one listener. Dispatch order is the order of the
table (`src/cli/commands/serve.ts`, request handler).

| Transport   | Route(s)                                                                         | Auth                                              | Purpose                                                                                                |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| WebSocket   | any path with `Upgrade: websocket`                                               | token (bearer header, `bearer.<token>` subprotocol, or `?token=`) unless mode `none` | The serve protocol: 107 request types in `ServerRequest` (`src/serve/protocol.ts`), handled in `src/serve/connection.ts` and `src/serve/handlers/*` |
| HTTP        | `/data/*`, `/bundle/*`                                                           | worker session bearer                             | Remote-execution data plane (`src/serve/data_plane.ts`); see [remote-execution §Data plane](../enablers/remote-execution.md#data-plane-two-transports) |
| HTTP POST   | configured webhook routes                                                        | HMAC per scheme                                   | `src/serve/webhook.ts`                                                                                 |
| HTTP POST   | `/api/v1/cancel/{workflow-run\|method-run}/{id}`, `/api/v1/cancel` (bulk)         | token + `run` grant                               | `cancelExecution` (see below)                                                                          |
| HTTP GET    | `/api/v1/health`, `/api/v1/cluster/instances`, `/api/v1/serve/config`             | admin (`src/serve/admin_auth.ts`)                 | Health snapshot (`src/serve/health_collector.ts`), heartbeat roster, redacted merged options           |
| SSE         | `/api/v1/health/stream?interval=`                                                 | admin                                             | Health snapshot every 1–60 s (default 5 s), resumable via `Last-Event-ID`                              |
| HTTP GET    | `/internal/runs?limit=&offset=`                                                   | admin; 404 unless `--enable-internal-api`         | Full run-tracker history                                                                               |
| HTTP POST   | `/auth/device`, `/auth/device/token`                                             | none (IP burst limit)                             | OAuth device grant, mode `oauth` only (`src/serve/device_auth_handler.ts`)                             |
| HTTP GET    | `/auth/info`                                                                      | none                                              | `{ mode, verificationBaseUri? }` so clients pick a login flow                                          |
| HTTP GET    | `/ready`, `/` and `/health`                                                       | none                                              | `/ready` is 503 until startup completes; `/health` lists schedules and webhook endpoints               |
| HTTP GET    | `/dashboard`, `/dashboard/*`                                                     | none for assets (the SPA logs in itself)          | Static files from `packages/dashboard/dist`, SPA fallback to `index.html`                              |

Before any authenticated WebSocket upgrade the origin is validated against the
bind host and `--trusted-hosts` (`validateWebSocketOrigin`), and two rate
limiters apply: 50 upgrades per IP per minute and 5 failed auth attempts per
minute keyed by token name (falling back to IP when the token is malformed);
the key is cleared on success (`src/serve/rate_limiter.ts`).

## Identity and access

Serve has three auth modes (`src/domain/access/serve_auth_config.ts`):

- `none` — no principal; every request is anonymous. Deprecated, only allowed
  on loopback, and `--restricted-*` options are ignored with a warning.
- `token` — clients present `<name>.<secret>`. `--admins` is required and each
  entry must parse as `user:<id>`, `group:<name>` or `idp-group:<name>`.
- `oauth` — clients log in through the swamp-club device grant. `--admins` is
  required, plus at least one of `--allowed-collectives` / `--allowed-users`
  (otherwise "any swamp-club user can connect").

**Operator gate.** In `token` and `oauth` mode the serve process itself must be
logged in to swamp-club with the `serve:*` scope (`requireAuthenticated` /
`requireScope` in `src/cli/commands/serve.ts`; the same gate is applied by
`swamp serve daemon enable`). OAuth mode additionally reads `SWAMP_API_KEY` to
register the instance with the provider and resolve admin usernames.

**Tokens.** A presented token is split on the first `.`; the name addresses a
ServerToken model and the secret is verified by running that model's `redeem`
method — authentication is itself a method run (`src/serve/token_auth.ts`).
Secrets live in the encrypted control-plane vault (`ControlPlaneVaultProvider`,
`src/domain/vaults/control_plane_vault_provider.ts`) rather than the user's
vault, so they replicate with the control-plane store and can be deleted
immediately. Revoked tokens are garbage-collected hourly after a one-hour grace
(`src/serve/server_token_gc_service.ts`).

**Grants.** Authorization is evaluated per request against an in-memory
`PolicySnapshot` built from grant and group data
(`src/domain/access/policy_snapshot_loader.ts`). With a remote datastore an
`AccessDataPoller` pulls `data/swamp/grant` and `data/swamp/group` every 30 s and
reloads the snapshot when anything changed (`src/serve/access_data_poller.ts`).
In OAuth mode a `CollectiveRefreshService` re-fetches each logged-in user's
collectives from the provider every `--group-refresh-interval` and closes
connections whose admission lapsed (`src/serve/collective_refresh_service.ts`).
Principals, grants, subjects and the `can-i` request will be covered in
`enablers/access-control.md`.

## Running primitives through serve

A `--server` invocation on the CLI opens a WebSocket, sends one request, and
consumes the event stream (`src/cli/remote_run.ts`). The server URL comes from
the flag, then `SWAMP_SERVE_URL`, then `SWAMP_SERVER_URL`; the token from
`--token`, then `SWAMP_SERVER_TOKEN`, then `~/.config/swamp/servers.json`
(written by `swamp auth server-login`). Server-side, the handler builds deps
from the shared `RepositoryContext` and drives the identical libswamp generator
the local command would (`src/serve/deps.ts`), serialising each yielded event
back over the socket (`src/serve/serializer.ts`).

**Every run is detached.** `workflow.run` and `model.method.run` register the
run in the `ActiveRunRegistry` with its own `AbortController` and a
`RunEventBuffer` of 10 000 events (`src/serve/handlers/*`, `DEFAULT_BUFFER_CAPACITY`).
The requesting socket is just a subscriber; the run continues if it drops.
A client resumes with `run.attach { runId, afterSeq }` and the buffer replays
every event with `seq > afterSeq` before streaming live ones
(`src/serve/run_event_buffer.ts`); the CLI retries this up to 5 times with
linear backoff after a drop. If the run is not local, serve consults
`active-runs/*` in the control-plane store: a live owner yields
`run.elsewhere { instanceId }` (the CLI retries up to 10 times, 1.5 s apart —
it does not redirect, so a load balancer must route it to the right instance
or the run must finish), a stale owner yields
`run.interrupted { reason: "instance_dead" }` (`handleRunAttach`,
`src/serve/connection.ts`). The registry also enforces `--max-concurrent-runs`
(default 100), `--max-runs-per-principal` and `--max-run-duration`.

**Cancel.** `cancelExecution` aborts the run's controller, then waits up to
`CANCEL_GRACE_MS = 5_000` for completion; the response is `cancelled` if the
run left the registry in time, otherwise `cancellation_requested`
(`src/cli/commands/serve.ts`). The WebSocket `cancel` request and the HTTP
cancel routes share this path.

**Cron.** With scheduling enabled, `ScheduledExecutionService`
(`src/libswamp/workflows/scheduled_execution.ts`) registers every workflow with
a `schedule`, applies `triggers.*` overrides from `serve.yaml`, and on each fire
calls `executeWorkflowWithLocks` with `triggerSource: "schedule"`. When the
control-plane store supports `putIfAbsent`, each fire first races to create
`fire-records/<workflowId>/<fireTime>` (second-truncated ISO time,
`normalizeFireTime`); the loser records a `dedupSkip` and does nothing. Fire
records older than 4 h are reaped every 10 min. Each fire is also enqueued as a
pending run (see [High availability](#high-availability)).

**Webhooks.** A `--webhook` or `webhooks[]` entry binds a POST route to a
workflow. Signatures are verified by a closed set of schemes — `github`,
`jira`, `linear`, `stripe`, `slack`, `generic` (header + prefix) — with a
300 s replay window for the timestamped ones (`src/serve/webhook_verifiers.ts`).
A verified request becomes a pending run before it is executed, so a crash
between receipt and completion is replayed at next boot (`src/serve/webhook.ts`).
Secrets may be `@file=` or `@vault=` references resolved at startup.

**Workers.** Steps whose model type is not loadable locally — or every step,
under `--remote-only` — are dispatched to enrolled workers by the worker
gateway (`src/serve/worker_gateway.ts`, `src/serve/dispatch_service.ts`). The
lease, capability and data-plane contracts are specified in
[remote-execution](../enablers/remote-execution.md).

## High availability

HA is not a mode you switch on; it is what serve does whenever the datastore
offers a remote control plane. Instances are identified by a fresh
`crypto.randomUUID()` per process. The coordination records:

| Key                                         | Writer / cadence                                                | Reader                                                                     |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `heartbeats/<instanceId>`                   | `InstanceHeartbeatService` every 30 s; deleted on clean stop    | Reconciliation (stale after 90 s), `run.attach`, `/api/v1/cluster/instances` |
| `active-runs/<instanceId>/<runId>`          | `writeActiveRun` on run start, deleted on finish                | `run.attach` from another instance; swept when the owner is declared dead |
| `pending-runs/<id>`                         | Cron and webhook triggers, dual-written with the SQLite tracker | `replayPendingRuns` at boot                                                |
| `fire-records/<workflowId>/<time>`          | `putIfAbsent` by whichever instance wins the cron fire          | Reaper (4 h TTL)                                                           |
| `claims/reconcile-instance/<instanceId>`    | `putIfAbsent` by the instance that will reap a dead peer        | `cleanupExpiredClaims` (5 min TTL)                                         |
| `token-secrets/*`                           | `ControlPlaneVaultProvider`                                     | Token auth on every instance                                               |

**Boot.** Before accepting traffic an instance pulls the remote datastore into
its local cache (`hydrateLocalCache`, bounded by `--hydration-timeout`),
migrates root-level control records into the configured namespace once, sweeps
stale worker leases and dispatches, reaps runs whose owning PID or heartbeat is
gone (`RunTrackerStore.reapStaleRuns` / `reapDeadProcessRuns`), and replays
pending runs whose trigger is still configured (`src/serve/boot_reconciliation.ts`).
Only then does `/ready` return 200.

**Steady state.** Every 60 s (+ up to 500 ms jitter) `reconcileRemoteInterruptedRuns`
lists heartbeats, claims each stale peer, marks that peer's `running` tracker
rows `failed` with reason `remote_instance_dead`, deletes its `active-runs/`
records, and only then removes the heartbeat — so a crash mid-reconcile leaves
the heartbeat for another instance to pick up when the claim expires. A
`ConfigPoller` pulls `.swamp/config/` every 30 s when the datastore manages
config, and the `AccessDataPoller` pulls grants and groups on the same cadence.

**What does not replicate.** The `ActiveRunRegistry`, its event buffers, the
worker session pool, rate-limiter buckets and the policy snapshot are all
per-process memory. A run's events can only be attached to on the instance
executing it; the control plane records _where_ it is, not _what happened_.
Grants replicate as data, but each instance loads its own snapshot on its own
poll, so a grant change is visible on different instances up to 30 s apart.
Extension registries are indexed at startup and the config poller deliberately
does not reload them (`extensionCatalogInvalidate` is a documented no-op in
`src/cli/commands/serve.ts`); use hot reload or a restart.

**Rolling restart.** On SIGTERM an instance stops accepting triggers, drains
active runs for 30 s, aborts what remains and waits 5 s more, marks those
workflow runs `interrupted("server_shutdown")` in the run repository, deletes
its heartbeat and exits. A peer sees no stale heartbeat, so nothing is reaped;
clients attached to the interrupted runs get the terminal frame and resume via
`swamp run history`. A crash instead of a clean stop is handled by the
reconciliation loop after `--stale-ttl`.

## Lifecycle and operations

- **Process guards.** `installUnhandledRejectionGuard` swallows unhandled
  rejections and uncaught errors from extension code so the daemon stays up
  (`src/serve/unhandled_rejection_guard.ts`); the open-file limit is raised at
  startup.
- **PID file and hot reload.** With `--hot-reload` serve writes `Deno.pid` to
  `.swamp/serve.pid` and installs a SIGHUP handler; `swamp serve reload` sends
  the signal locally or, with `--server`, issues the `serve.reload` request.
  `performServeReload` re-bundles pulled extensions whose source fingerprint
  changed, bumps the reload generation so in-flight runs keep their old
  bundles, and re-reads `triggers.*` overrides from `serve.yaml`
  (`src/serve/extension_reload.ts`). Concurrent SIGHUPs are ignored while a
  reload is in progress. The mechanism and its catalog constraint are detailed
  in [remote-execution §Hot-Reload](../enablers/remote-execution.md#hot-reload-for-pulled-extension-bundles).
- **Graceful shutdown.** SIGINT/SIGTERM run the sequence above, then stop the
  heartbeat, worker gateway, pollers and telemetry, remove the PID file and
  abort the listener. In `--json` mode each phase is emitted as a
  `{ status: "stopping" | "aborting" | "interrupted" | "stopped" }` line.
- **Telemetry flush.** The CLI flushes telemetry at process exit, which a daemon
  never reaches; `DaemonTelemetryFlushService` flushes every 60 s, at most 20
  batches per tick, isolates a batch after 5 consecutive failures and
  quarantines an entry after 3 more (`src/serve/telemetry_flush.ts`). Serve logs
  the identity it reports under so a mis-set `HOME` is visible.
- **Run tracker.** All runs — local, detached, cron, webhook — are recorded in
  the SQLite tracker with PID, hostname and instance id; `run.history` and
  `run.doctor` read it and `/internal/runs` pages it. See
  [run-tracker](../enablers/run-tracker.md).
- **Daemon units.** `swamp serve daemon enable|disable|status` installs a
  launchd agent (`~/Library/LaunchAgents/club.swamp.serve.plist`) or daemon, or
  a systemd unit `swamp-serve.service` (user or system scope, `Restart=always`,
  `RestartSec=10`, `ExecReload` sends SIGHUP) that runs
  `swamp serve --repo-dir … --port … --host …` plus any extra flags given at
  enable time (`src/infrastructure/daemon/*_service_scheduler.ts`,
  `service_scheduler_factory.ts`). Linux without `systemctl` is refused with a
  pointer to file a feature request. Worker daemons have parallel schedulers.
- **Dashboard.** `--dashboard` serves the Vite SPA in `packages/dashboard`
  (views for overview, models, workflows, executions, approvals, data, vaults,
  extensions, schedules, webhooks and system) from `packages/dashboard/dist`;
  the SPA talks to the same WebSocket protocol and logs in through
  `/auth/info` + device auth.
- **Club heartbeat.** In OAuth mode serve registers itself with swamp-club at
  startup and sends a heartbeat hourly (`src/serve/club_heartbeat_service.ts`,
  `src/serve/oauth_client.ts`).

## Known limits

- `--hot-reload` is unavailable on Windows because SIGHUP is
  (`src/cli/commands/serve.ts`).
- `run.elsewhere` tells the client which instance owns the run but the CLI can
  only retry the same URL; cross-instance attach depends on the operator's
  routing (`src/cli/remote_run.ts`).
- Without `putIfAbsent` on the control-plane store, cron fire dedup and
  reconciliation claims are skipped; with two instances on such a store a
  schedule can fire twice (`src/cli/commands/serve.ts`,
  `src/serve/boot_reconciliation.ts`).
- The config poller does not reload extension type registries; new or changed
  extension types need `swamp serve reload` or a restart
  (`src/cli/commands/serve.ts`, `ConfigPoller` wiring).
- Webhook verification schemes are a closed set; a provider that changes its
  signing convention needs a swamp release (`src/serve/webhook_verifiers.ts`,
  tracked in #723).
- Auth mode `none` is deprecated and only permitted on loopback.
