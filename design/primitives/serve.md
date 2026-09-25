---
audience: operator, maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Serve

Serve is a long-running swamp that others run primitives through. `swamp serve`
is the CLI binary with one listener on one port (`src/cli/commands/serve.ts`,
the single `Deno.serve` call). Each request (workflow run, method run, data
query, vault read) reaches the libswamp use case the CLI would call in-process.
`src/serve/deps.ts` builds `WorkflowRunDeps` / `ModelMethodRunDeps` from a
`RepositoryContext`, and the handlers call `executeWorkflowWithLocks`
(`src/serve/handlers/workflow_handlers.ts`) or `modelMethodRun`
(`src/serve/handlers/model_handlers.ts`).

Serve is not a scheduler daemon (cron is one trigger of several), a message
broker (no queue between client and executor) or a cluster (instances never
connect to each other). When more than one instance runs, they coordinate only
through small records in the
datastore's control-plane store (`src/domain/datastore/control_plane_store.ts`).

[remote-execution](../enablers/remote-execution.md) covers workers, leases,
runners and the data plane; [run-tracker](../enablers/run-tracker.md) covers the
SQLite run ledger and `run doctor`. The `ServerRequest` union in
`src/serve/protocol.ts` is the authoritative WebSocket request list. Principals,
grants and tokens are under [Identity and access](#identity-and-access).

## Why

**One port, four transports.** WebSocket upgrades, the worker data plane, plain
JSON routes and SSE share the listener. They are told apart by request shape, in
that order (`src/cli/commands/serve.ts`, the request handler passed to
`Deno.serve`). One port means one TLS certificate, firewall rule, reverse-proxy
entry and `--server` URL for every client: an operator's laptop, a CI worker or
the dashboard.

**A control-plane store instead of gossip.** Instances share nothing in memory.
What they must agree on (who is alive, which runs are in flight where, which
cron fire is claimed) is a slash-keyed record under the datastore's `_control/`
prefix (`src/domain/datastore/control_plane_store.ts`). Every instance already
has credentials for this durable, shared store, so reusing it avoids a second
network surface, service discovery and leader election. The one atomic
operation, `putIfAbsent`, is optional on the interface, and every consumer
degrades gracefully without it.

**Workers connect out.** Workers open their control socket and data-plane
connection outbound; serve never connects to a worker
(`src/serve/worker_gateway.ts` header). See
[remote-execution §Why this shape](../enablers/remote-execution.md#why-this-shape).

## Configuration

`mergeServeOptions` (`src/serve/serve_config.ts`) resolves options by
precedence: **explicit flag > environment variable > `.swamp/serve.yaml` >
built-in default**. Only options in `SERVE_ENV_MAP` have an env var (`port` and
`host` do not). Explicit flags are read from `Deno.args`, so a flag set to its
default still beats the file (`parseExplicitFlags`). Unknown YAML keys are
warned about and ignored (`warnUnknownKeys` against `KNOWN_TOP_LEVEL_KEYS`,
`KNOWN_AUTH_KEYS`, `KNOWN_TLS_KEYS`). `--config` names another file; without
it the default file is optional.

| Option (flag / yaml key) | Env var | Default | Notes |
| --- | --- | --- | --- |
| `--config` | — | `.swamp/serve.yaml` | Alternative config file |
| `--port` / `port` | — | `9090` | |
| `--host` / `host` | — | `127.0.0.1` | Off-loopback needs TLS and an auth mode (`assertOffLoopbackSecurity`) |
| `--cert-file`, `--key-file` / `tls.*` | `SWAMP_SERVE_CERT_FILE`, `_KEY_FILE` | unset | Both set ⇒ TLS; `ws://` becomes `wss://` |
| `--auth-mode` / `auth.mode` | — | `none` | `none` \| `token` \| `oauth`; `none` logs a deprecation warning |
| `--admins`, `--allowed-collectives`, `--allowed-users` / `auth.*` | — | unset | See [Identity and access](#identity-and-access) |
| `--oauth-provider` / `auth.oauth-provider` | — | `https://swamp-club.com` | Must be HTTPS unless localhost (`src/domain/access/serve_auth_config.ts`) |
| `--oauth-client-id`, `--oauth-client-name` / `auth.oauth-client-{id,name}` | `SWAMP_OAUTH_CLIENT_NAME` (name only) | unset, `swamp-serve-{repo}-{host}` | Client id auto-registered on first start if omitted |
| `--groups-field` / `auth.groups-field` | — | `collectives` | Userinfo field holding group/collective memberships |
| `--restricted-model-types`, `--restricted-commands` / `auth.restricted-*` | — | unset | Comma lists needing admin authority; need mode `token` or `oauth` |
| `--approve-requires-explicit-grant` / `auth.approve-requires-explicit-grant` | `SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT` | `false` | Opt-in |
| `--group-refresh-interval` / `auth.group-refresh-interval` | `SWAMP_GROUP_REFRESH_INTERVAL` | 4 h | OAuth only; `0` disables |
| `--grants-file`, `--grants-dir`, `--grant-reload` | `SWAMP_GRANTS_FILE`, `_DIR` | unset, unset, `manual` | `auto` starts a `GrantsDirectoryPoller` (30 s) |
| `--no-schedule` / `schedule` | — | `true` | Disables cron triggers |
| `--webhook <route:workflow:secret[:scheme[:header[:prefix]]]>` / `webhooks[]` | — | none | Flags replace the file list entirely |
| `triggers.<workflow>.{schedule,inputs}` | — | none | yaml only; overrides a workflow's own trigger |
| `--trust-proxy`, `--trusted-hosts` | `SWAMP_TRUSTED_HOSTS` | `false`, unset | `X-Forwarded-For` and WebSocket `Origin` handling |
| `--ws-idle-timeout`, `--queue-timeout` | `SWAMP_WS_IDLE_TIMEOUT`, `SWAMP_QUEUE_TIMEOUT` | unset | Worker-facing |
| `--verify-on-enroll` | `SWAMP_VERIFY_ON_ENROLL` | `false` | Fleet probe on each enrolling worker; failures marked unverified |
| `--heartbeat-interval`, `--stale-ttl`, `--reconciliation-interval` | `SWAMP_HEARTBEAT_INTERVAL`, `SWAMP_STALE_TTL`, `SWAMP_RECONCILIATION_INTERVAL` | 30 s, 90 s, 60 s | `stale-ttl` must be ≥ 2× heartbeat; no effect without a remote control plane |
| `--hydration-timeout` | `SWAMP_HYDRATION_TIMEOUT` | 60 s | Startup pull of the remote datastore |
| `--datastore-poll-interval` | `SWAMP_DATASTORE_POLL_INTERVAL` | 30 s | Config, access and runtime pollers; min 1 s; no effect without a remote datastore |
| `--max-concurrent-runs`, `--max-runs-per-principal`, `--max-run-duration` | `SWAMP_MAX_*` | `100`, unset, unset | Enforced by `ActiveRunRegistry` |
| `--hot-reload` | — | `false` | Writes `.swamp/serve.pid`; not supported on Windows |
| `--enable-internal-api` | `SWAMP_ENABLE_INTERNAL_API` | `false` | Exposes `/internal/runs` (`limit` default 100, clamped 1–10 000) |
| `--remote-only` | `SWAMP_REMOTE_ONLY` | `false` | User steps run only on workers |
| `--dashboard` | `SWAMP_DASHBOARD` | `false` | Serves `/dashboard/*` when the build embeds the SPA |
| `--auto-resume` | `SWAMP_AUTO_RESUME` | `false` | Resumes a run once every approval gate is decided |
| `--detach-runs` | — | `false` | Deprecated, no effect: runs are always detached |

Table notes:

- `--approve-requires-explicit-grant`: deciding an approval gate needs a grant
  naming `approve` (see "Actions" in access-control.md). Every replica must
  share the value.
- The worker timeouts are covered in remote-execution. Related built-in
  defaults: 60 s reconnection grace (`DEFAULT_GRACE_WINDOW_MS`,
  `src/serve/worker_gateway.ts`) and 600 s queue ceiling
  (`DEFAULT_QUEUE_TIMEOUT_MS`, `src/serve/dispatch_service.ts`).
- The run limit's `100` is the registry's own fallback
  (`src/serve/active_run_registry.ts`).
- Durations that drive a timer (`--heartbeat-interval`,
  `--reconciliation-interval`, `--group-refresh-interval`,
  `--hydration-timeout`, `--datastore-poll-interval`, `--max-run-duration`)
  are capped at 2 147 483 647 ms, about 24.8 days (`parseTimerDuration`,
  `src/cli/duration_parser.ts`). Deno fires a longer timer after 1 ms.
- Without `--hot-reload`, SIGHUP is a shutdown signal
  (`src/infrastructure/process/shutdown_handlers.ts`).
- `--remote-only` never moves built-in `swamp/*` control-plane models (server
  tokens, enrollment tokens, workers, step leases, etc.) off the orchestrator
  (`src/domain/remote/remote_dispatch.ts`).
- `--auto-resume` applies to workflows that declare no inputs and leave
  `autoResume` unset (see "Manual Approval" in workflows.md).

### Deployment mode

At startup serve classifies the datastore and vault into a mode
(`resolveDeploymentMode`, `src/domain/serve/deployment_mode.ts`). The probe runs
in `src/cli/commands/serve.ts` right after the registries load. The mode is
reported on `/ready`, in the `--json` listening line, and to swamp-club on OAuth
registration.

| Datastore                           | Vault                                  | Mode                | Meaning                                                              |
| ----------------------------------- | -------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| filesystem                          | any                                    | `local`             | Runs survive a process restart                                       |
| remote, no `controlPlane` capability | any                                   | `local`             | Warns: "Update <type> for cross-machine durability"                  |
| remote with control plane           | none                                   | `durable`           | Warns that secret-dependent workflows fail after instance replacement |
| remote with control plane           | `local_encryption` only                | `durable (limited)` | Runs survive; secrets do not travel                                   |
| remote with control plane           | at least one non-local vault           | `durable`           | Runs survive instance replacement                                    |

"Remote control plane" means the datastore extension advertises
`capabilities().controlPlane` and exposes `controlPlaneStore()`. Otherwise serve
uses `FileSystemControlPlaneStore` under `<datastore path>/_control/`
(`.swamp/_control/` for the default datastore,
`src/infrastructure/persistence/fs_control_plane_store.ts`). It keeps the same
key layout and `putIfAbsent` (via `createNew`) but is visible to one machine
only.

## Surface

Everything below shares the one listener, dispatched in table order
(`src/cli/commands/serve.ts`, request handler).

| Transport | Route(s) | Auth | Purpose |
| --- | --- | --- | --- |
| WebSocket | any path with `Upgrade: websocket` | token (bearer header, `bearer.<token>` subprotocol, or `?token=`) unless mode `none` | Serve protocol: 117 request types in `ServerRequest` (`src/serve/protocol.ts`), handled in `src/serve/connection.ts` and `src/serve/handlers/*` |
| HTTP | `/data/*`, `/bundle/*` | worker session bearer | Remote-execution data plane (`src/serve/data_plane.ts`); see [remote-execution §Data plane](../enablers/remote-execution.md#data-plane-two-transports) |
| HTTP POST | configured webhook routes | HMAC per scheme | `src/serve/webhook.ts` |
| HTTP POST | `/api/v1/cancel/{workflow-run\|method-run}/{id}`, `/api/v1/cancel` (bulk) | token + admin (IP burst and per-token rate limits) | `cancelExecution` (see below) |
| HTTP GET | `/api/v1/health`, `/api/v1/cluster/instances`, `/api/v1/serve/config` | admin (`src/serve/admin_auth.ts`) | Health snapshot (`src/serve/health_collector.ts`), heartbeat roster, redacted merged options |
| SSE | `/api/v1/health/stream?interval=` | admin | Health snapshot every 1–60 s (default 5 s), resumable via `Last-Event-ID` |
| HTTP GET | `/internal/runs?limit=&offset=` | admin; 404 unless `--enable-internal-api` | Full run-tracker history |
| HTTP POST | `/auth/device`, `/auth/device/token` | none (IP burst limit) | OAuth device grant, mode `oauth` only (`src/serve/device_auth_handler.ts`) |
| HTTP GET | `/auth/info` | none | `{ mode, verificationBaseUri? }` so clients pick a login flow |
| HTTP GET | `/ready`, `/` and `/health` | none | `/ready` is 503 until startup completes; `/health` lists schedules and webhook endpoints |
| HTTP GET | `/dashboard`, `/dashboard/*` | none for assets (the SPA logs in itself) | Static files from `packages/dashboard/dist`, SPA fallback to `index.html`; without the dist, 404 "Dashboard assets not available in this build" |

Every WebSocket upgrade, even in mode `none`, has its origin checked against the
bind host and `--trusted-hosts` (`validateWebSocketOrigin`). Two rate limits
also apply to every upgrade (`src/serve/rate_limiter.ts`): 50 upgrades per IP
per minute, and 5 failed auth attempts per minute per token name (per IP if the
token is malformed; cleared on success). A connection allows at most
`MAX_ACTIVE_REQUESTS` in-flight requests and rejects an already-active id with
`duplicate_id` (`src/serve/connection.ts`).

Each WebSocket request is checked against a zod schema in
`src/serve/connection.ts` before dispatch. zod strips unknown keys, so a
`ServerRequest` payload field with no schema field silently reaches the handler
as `undefined`. A request type with no schema is refused with `invalid_request`.
`src/serve/connection_schema_parity_test.ts` enforces both at compile time and
pins the allowed exceptions: client `groups` on
`access.check`/`access.can-i`, which handlers take from the authenticated
connection.

Over WebSocket, `cluster.instances` and `serve.config` need `admin` on
`access:*`, like their REST routes.

Deno's `upgradeWebSocket` cannot negotiate `permessage-deflate`, so clients opt
into message-level compression with `?compress=gzip` on the upgrade URL.
`send()` then gzips frames of 16 KiB or more into binary frames. Smaller frames,
clients without the parameter, worker transport frames and audit stream frames
stay text (`src/serve/handlers/shared.ts`). The dashboard and the CLI's
single-request client (`requestServerResponse`) opt in.

`workflow.search` and `workflow.run.search` take `offset` and `limit` and return
`total` beside `data`. Paging is applied after the per-workflow authorization
filter, so
`total` counts only what the principal may read. `workflow.run.search` defaults
to limit 500; `workflow.search` has none, because the CLI's interactive picker
needs the full list.

## Identity and access

Serve has three auth modes (`src/domain/access/serve_auth_config.ts`):

- `none`: no principal; every request is anonymous. Deprecated and loopback
  only. `--restricted-*` options are ignored with a warning.
- `token`: clients present `<name>.<secret>`. `--admins` is required, and each
  entry must parse as `user:<id>`, `group:<name>` or `idp-group:<name>`.
- `oauth`: clients log in through the swamp-club device grant. Requires
  `--admins` and at least one of `--allowed-collectives` / `--allowed-users`
  (otherwise "any swamp-club user can connect"). At startup a username the
  provider does not know is skipped with an ERROR log rather than stopping
  serve. `swamp serve check-config` finds such names before a deploy. See
  "Username resolution" in
  [remote execution](../enablers/remote-execution.md).

**Operator gate.** In `token` and `oauth` mode the serve process must itself be
logged in to swamp-club with the `serve:*` scope (`requireAuthenticated` /
`requireScope` in `src/cli/commands/serve.ts`). `swamp serve daemon enable`
applies the same gate. OAuth mode also reads `SWAMP_API_KEY` to register the
instance with the provider and resolve admin usernames.

**Tokens.** A token is split on the first `.`; the name resolves a
`swamp/server-token` lifecycle resource and its vault secret. Serve applies the
same pure lifecycle and timing-safe credential check as explicit `redeem`, but
ingress auth is read-only: no `lastUsedAt` write and no model run
(`src/serve/token_auth.ts`). Explicit `redeem` stays a model action and still
updates usage.

Secrets live in the encrypted control-plane vault (`ControlPlaneVaultProvider`,
`src/domain/vaults/control_plane_vault_provider.ts`), not the user's vault, so
they replicate with the control-plane store and can be deleted immediately. At
boot, right after that vault registers, `checkTokenHealth` reports secrets that
no longer decrypt and `sweepTokenConsistency` removes token records missing
their secret (`src/cli/commands/serve.ts`). The CLI token commands (`access
token mint`, `rotate` and `reveal`, and `worker token create`) register the same
vault through `initializeControlPlaneVault`
(`src/domain/vaults/control_plane_vault_init.ts`). Like serve, they stop with
the initialization error if it fails; they never fall back to a user vault.
There is no periodic token garbage
collector: `ServerTokenGcService` (`src/serve/server_token_gc_service.ts`)
exists but serve never creates it.

**Grants.** Each request is authorized against an in-memory `PolicySnapshot`
built from grant and group data (`src/domain/access/policy_snapshot_loader.ts`).
With a remote datastore, an `AccessDataPoller` pulls `data/swamp/grant` and
`data/swamp/group` every `--datastore-poll-interval` (default 30 s) and
reloads the snapshot on any change
(`src/serve/access_data_poller.ts`). In OAuth mode, a `CollectiveRefreshService`
re-fetches each logged-in user's collectives from the provider every
`--group-refresh-interval`. It closes connections whose admission lapsed
(`src/serve/collective_refresh_service.ts`). See
[enablers/access-control.md](../enablers/access-control.md) for principals,
grants, subjects and the `can-i` request.

## Running primitives through serve

With `--server`, the CLI opens a WebSocket, sends one request and consumes the
event stream (`src/cli/remote_run.ts`). URL: the flag, then `SWAMP_SERVE_URL`,
then `SWAMP_SERVER_URL`. Token: `--token`, then `SWAMP_SERVER_TOKEN`, then
`~/.config/swamp/servers.json` (written by `swamp auth server-login`). The
server builds deps from the shared `RepositoryContext`, drives the same libswamp
generator as the local command (`src/serve/deps.ts`), and serialises each event
back over the socket (`src/serve/serializer.ts`).

**Every run is detached.** `workflow.run` and `model.method.run` register the
run in the `ActiveRunRegistry` with its own `AbortController` and a 10 000-event
`RunEventBuffer` (`src/serve/handlers/*`, `DEFAULT_BUFFER_CAPACITY`). The
requesting socket is only a subscriber; the run continues if it drops.

A client resumes with `run.attach { runId, afterSeq }`; the buffer replays
events with `seq > afterSeq`, then streams live ones
(`src/serve/run_event_buffer.ts`). `run.attach` needs a `run` grant on the run's
resource, and the CLI retries it up to 5 times with linear backoff after a drop.
For a non-local run, serve checks `active-runs/*` in the control-plane store:

- Live owner: `run.elsewhere { instanceId }`. The CLI retries up to 10 times,
  1.5 s apart, without redirecting, so a load balancer must route it to the
  right instance or the run must finish.
- Stale owner: `run.interrupted { reason: "instance_dead" }`.

All of this is in `handleRunAttach`
(`src/serve/connection.ts`). The registry also enforces `--max-concurrent-runs`
(default 100), `--max-runs-per-principal` and `--max-run-duration`.

**Cancel.** There are two paths:

- HTTP cancel routes (admin only) call `cancelExecution`. It aborts the run's
  controller and waits up to `CANCEL_GRACE_MS = 5_000` for completion. It
  returns `cancelled` if the run left the registry in time, otherwise
  `cancellation_requested` (`src/cli/commands/serve.ts`).
- The WebSocket `cancel` request is keyed by request id. If that id is an
  in-flight request, its controller is aborted. Otherwise `handleCancelRun`
  checks for a `run` grant on the run's resource and calls
  `activeRunRegistry.cancel(requestId)`, with no grace wait and no
  `cancellation_requested` result (`src/serve/connection.ts`).

Serve's `CANCEL_GRACE_MS` is not the 30 s constant of the same name in
`src/domain/remote/rpc_channel.ts`, which bounds RPC cancel confirmation.

**Cron.** With scheduling enabled, `ScheduledExecutionService`
(`src/libswamp/workflows/scheduled_execution.ts`) registers every workflow with
a `schedule` and applies `triggers.*` overrides from `serve.yaml`. Each fire
calls its injected `executeWorkflow`, which serve wires to
`executeWorkflowWithLocks` with `triggerSource: "schedule"`
(`src/cli/commands/serve.ts`). A fire is skipped with a `schedule_skipped` event
while the workflow's previous run is still in progress.

If the control-plane store supports `putIfAbsent`, each fire first races to
create `fire-records/<workflowId>/<fireTime>` (ISO time truncated to the
second, `normalizeFireTime`). The loser records a `dedupSkip` and does nothing.
Fire records older than 4 h are reaped every 10 min. Each fire is also queued as
a pending run (see [High availability](#high-availability)).

**Webhooks.** A
`--webhook <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]` or
`webhooks[]` entry binds a POST route to a workflow. Signatures are verified by
either:

- a built-in scheme: `github`, `jira`, `linear`, `stripe`, `slack` or `generic`
  (header + prefix), with a 300 s replay window for the timestamped ones
  (`src/serve/webhook_verifiers.ts`); or
- a webhook extension type named `@collective/name`, such as `@swamp/telegram`.
  These are resolved (and auto-pulled for trusted collectives) at startup. Their
  `config` (`webhooks[].config`, yaml only) is validated against the type's
  `configSchema`.

An extension handler may also `transform` the payload body and `respond` with a
custom HTTP response, optionally without starting a run. Core keeps every
security decision: hooks run only after verification, `transform` sees only
redacted headers, and a missing type or failing hook returns a generic `500`
before anything is queued. Hooks run inline with no timeout.

A verified request becomes a pending run before it executes, so a crash between
receipt and completion is replayed at next boot (`src/serve/webhook.ts`).
Secrets may be `@env=VAR`, `@file=/path` or `@vault=<vault>:<key>` references,
resolved at startup and again on hot-reload.

**Workers.** Steps whose model type cannot load locally, or every step under
`--remote-only`, go to enrolled workers through the worker gateway
(`src/serve/worker_gateway.ts`, `src/serve/dispatch_service.ts`).
[remote-execution](../enablers/remote-execution.md) specifies the lease,
capability and data-plane contracts.

## High availability

HA is not a mode you switch on. Serve works this way whenever the datastore
offers a remote control plane. Each process gets a fresh `crypto.randomUUID()`
as its instance id. The coordination records:

| Key                                         | Writer / cadence                                                | Reader                                                                     |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `heartbeats/<instanceId>`                   | `InstanceHeartbeatService` every 30 s; deleted on clean stop    | Reconciliation (stale after 90 s), `run.attach`, `/api/v1/cluster/instances` |
| `active-runs/<instanceId>/<runId>`          | `writeActiveRun` on run start, deleted on finish                | `run.attach` from another instance; swept when the owner is declared dead |
| `pending-runs/<id>`                         | Cron and webhook triggers, dual-written with the SQLite tracker | `replayPendingRuns` at boot                                                |
| `fire-records/<workflowId>/<time>`          | `putIfAbsent` by whichever instance wins the cron fire          | Reaper (4 h TTL)                                                           |
| `claims/reconcile-instance/<instanceId>`    | `putIfAbsent` by the instance that will reap a dead peer        | `cleanupExpiredClaims` (5 min TTL)                                         |
| `token-secrets/*`                           | `ControlPlaneVaultProvider`                                     | Token auth on every instance                                               |

**Boot.** Before accepting traffic an instance
(`src/serve/boot_reconciliation.ts`):

1. Pulls the remote datastore into its local cache (`hydrateLocalCache`,
   bounded by `--hydration-timeout`).
2. Migrates root-level control records into the configured namespace, once.
3. Sweeps stale worker leases and dispatches.
4. Reaps runs whose owning PID or heartbeat is gone
   (`RunTrackerStore.reapStaleRuns` / `reapDeadProcessRuns`).
5. Runs one `reconcileRemoteInterruptedRuns` pass if a remote control plane
   exists.
6. Replays pending runs whose trigger is still configured.

Only then does `/ready` return 200.

**Steady state.** Every 60 s (plus up to 500 ms jitter),
`reconcileRemoteInterruptedRuns` lists heartbeats and claims each stale peer. It
marks that peer's `running` tracker rows `interrupted` with reason
`remote_instance_dead`, interrupts its YAML workflow-run records and deletes its
`active-runs/` records. Only then does it remove the heartbeat, so a crash
mid-reconcile leaves the heartbeat for another instance once the claim expires.
When the datastore manages config, a `ConfigPoller` pulls `.swamp/config/` every
`--datastore-poll-interval` (default 30 s). The `AccessDataPoller` pulls grants
and groups at the same interval.

**What does not replicate.** The `ActiveRunRegistry`, its event buffers, the
worker session pool, rate-limiter buckets and the policy snapshot are
per-process memory. Clients can attach to a run's events only on the executing
instance. The control plane records which instance owns a run, not its events.
Grants replicate as data, but each instance loads its snapshot on its own poll.
Instances may therefore see a grant change up to one poll interval apart (30 s
by default).

Extension registries are indexed at startup. With `managedConfig` active, the
config poller pulls extension files (`config/pulled-extensions/`) separately from
definition files (`config/models/`, `config/vaults/`, etc.). It calls
`performServeReload` only when extension files changed. Definition-only changes
(e.g. a model YAML edit) invalidate catalogs but do not reload extension
registries. Extension sources are not pushed today (each repo keeps them in its
own pulled root until swamp-club#2429), so a peer's `extension pull` changes
only the lockfile and does not trigger this reload; each instance runs
`extension install` for its own sources, then `swamp serve reload` or a restart
so the new types register (see Known limits).

**Rolling restart.** On SIGTERM an instance stops accepting triggers, drains
active runs for 30 s, aborts the rest and waits 5 s more. It marks those
workflow runs `interrupted("server_shutdown")` in the run repository, deletes
its heartbeat and exits. Peers see no stale heartbeat, so nothing is reaped.
Attached clients get the terminal frame. Nothing is resumed, but
`swamp run history` shows the final status. If the shutdown handler does not
finish (e.g. SIGKILL before the YAML records are saved), the next instance's
boot reconciliation interrupts runs from foreign instances whose heartbeat is
gone. After a crash, the reconciliation loop handles the dead instance once
`--stale-ttl` passes.

## Lifecycle and operations

- **Process guards.** `installUnhandledRejectionGuard` swallows unhandled
  rejections and uncaught errors from extension code so the daemon stays up
  (`src/serve/unhandled_rejection_guard.ts`). The open-file limit is raised at
  startup.
- **PID file and hot reload.** With `--hot-reload`, serve writes `Deno.pid` to
  `.swamp/serve.pid` and installs a SIGHUP handler. `swamp serve reload` sends
  the signal locally, or issues the `serve.reload` request with `--server`.
  Concurrent SIGHUPs are ignored while a reload is in progress.

  `performServeReload` (`src/serve/extension_reload.ts`) re-bundles pulled
  extensions whose source fingerprint changed and re-imports every pulled type.
  Bundle import URLs are content-addressed (`?fp=…&h=<sha256 of bundle>`,
  `bundleImportUrl` in `src/domain/extensions/extension_loader.ts`): an
  unchanged bundle reuses its cached module, a changed one loads as a new
  module, and in-flight runs keep the old one. It also re-reads `triggers.*`
  overrides and `webhooks` from `serve.yaml`. Webhook route changes (added,
  removed or modified bindings) apply on the next request; in-flight runs finish
  against the endpoint they matched. Webhook reload is skipped if `--webhook`
  CLI flags were used at startup, since flags are process arguments, not
  hot-reloadable config.

  `workflow.trigger.set` and `workflow.trigger.remove` over WebSocket apply
  trigger overrides directly: the handlers call `updateTriggerOverrides` on the
  `ScheduledExecutionService` after writing, so no full reload or `--hot-reload`
  flag is needed (`src/serve/handlers/workflow_handlers.ts`).

  Pulled extensions live under `.swamp/pulled-extensions/`, or
  `.swamp/config/pulled-extensions/` when the datastore manages config
  (`src/infrastructure/persistence/paths.ts`).
  [remote-execution §Hot-Reload](../enablers/remote-execution.md#hot-reload-for-pulled-extension-bundles)
  covers the mechanism and its catalog constraint.

  Use `--hot-reload` for `managedConfig` deployments where pods must recover
  from datastore-only state without `kubectl exec`. Without it,
  `swamp serve reload --server` fails and new extensions need a full pod
  restart. The `ConfigPoller` refreshes definitions (models, workflows, vaults)
  every `--datastore-poll-interval` (default 30 s) and reloads extension type registries only when extension files
  under `config/pulled-extensions/` change, which peers' extension commands do
  not do while sources stay in each repo (swamp-club#2429; see
  [High availability](#high-availability)). SIGHUP (`swamp serve reload`) remains
  available for manual reloads. See
  [datastores §Managed Config](../enablers/datastores.md#managed-config-deployment-architecture)
  for the full deployment guide.
- **Graceful shutdown.** SIGINT/SIGTERM run the sequence above, then stop the
  heartbeat, worker gateway, pollers and telemetry, remove the PID file and
  abort the listener. In `--json` mode each phase is emitted as a
  `{ status: "stopping" | "aborting" | "interrupted" | "stopped" }` line.
- **Telemetry flush.** The CLI flushes telemetry at process exit, which a daemon
  never reaches. `DaemonTelemetryFlushService` flushes every 60 s, at most 20
  batches per tick. It isolates a batch after 5 consecutive failures and
  quarantines an entry after 3 more (`src/serve/telemetry_flush.ts`). Serve logs
  the identity it reports under, so a mis-set `HOME` is visible.
- **Run tracker.** All runs (local, detached, cron, webhook) are recorded in the
  SQLite tracker with PID, hostname and instance id. `run.history` and
  `run.doctor` read it; `/internal/runs` pages it. See
  [run-tracker](../enablers/run-tracker.md).
- **Daemon units.** `swamp serve daemon enable|disable|status` installs a
  launchd agent (`~/Library/LaunchAgents/club.swamp.serve.plist`) or daemon, or
  a systemd unit `swamp-serve.service` (user or system scope, `Restart=always`,
  `RestartSec=10`, `ExecReload` sends SIGHUP). The unit runs
  `swamp serve --repo-dir … --port … --host …` plus any extra flags given at
  enable time (`src/infrastructure/daemon/*_service_scheduler.ts`,
  `service_scheduler_factory.ts`). Linux without `systemctl` is refused with a
  pointer to file a feature request. Worker daemons have parallel schedulers.

  **User vs system scope:** system services (`multi-user.target`) start at
  boot. User services (`default.target`, launchd agents) run only while the
  user is logged in. To start a user service at boot, enable systemd lingering
  (`loginctl enable-linger $USER`) or install system-wide.
- **Dashboard.** `--dashboard` serves the Vite SPA in `packages/dashboard`
  (overview, models, workflows, executions, approvals, data, vaults, extensions,
  schedules, webhooks and system views) from `packages/dashboard/dist`.
  `scripts/compile.ts` embeds it only if pre-built before compile. The SPA uses
  the same WebSocket protocol and logs in through `/auth/info` + device auth.
  Navigation state is in the URL path (`/dashboard/models/<name>`,
  `/dashboard/workflows/<name>/runs/<runId>`, etc.), so views are linkable. The
  server falls back to `index.html` for any `/dashboard/` sub-path to support
  client-side routing.

  The dashboard is a complete approval surface. Approve and reject address the
  gate's run by `runId`. An approved but still suspended run (`awaitingResume`
  on `workflow.run.search`) shows a Resume action and the equivalent
  `swamp workflow resume` command. Resume sends `workflow.resume`, then a
  `cancel` carrying the request id, which detaches the dashboard from the
  serve-driven run without cancelling it
  (`packages/dashboard/src/client/stream.ts`).
- **Club heartbeat.** In OAuth mode serve registers with swamp-club at startup
  and sends a heartbeat hourly (`src/serve/club_heartbeat_service.ts`,
  `src/serve/oauth_client.ts`). This needs a resolved OAuth client id, a
  non-empty `--allowed-collectives` and `SWAMP_API_KEY`; otherwise registration
  is silently skipped.

## Known limits

- `--hot-reload` is unavailable on Windows because SIGHUP is not supported
  there (`src/cli/commands/serve.ts`).
- `run.elsewhere` names the instance that owns the run, but the CLI can only
  retry the same URL. Cross-instance attach depends on the operator's routing
  (`src/cli/remote_run.ts`).
- Without `putIfAbsent` on the control-plane store, cron fire dedup and
  reconciliation claims are skipped. Two instances on such a store can fire a
  schedule twice (`src/cli/commands/serve.ts`,
  `src/serve/boot_reconciliation.ts`).
- The config poller reloads extension type registries only when
  `config/pulled-extensions/` changes, which peers' extension commands do not
  do while sources stay in each repo (swamp-club#2429). New or changed
  extension types need `swamp serve reload` or a restart
  (`src/cli/commands/serve.ts`, `ConfigPoller` wiring). After a successful
  `--server` operation, state-modifying extension commands (`pull`, `install`,
  `rm`, `update`) warn that `swamp serve reload` is needed
  (`src/cli/remote_run.ts`, `warnServerReloadNeeded`).
- Built-in webhook verification schemes are a closed set; other providers need
  a webhook extension (`src/serve/webhook_verifiers.ts`, #2204). Extension
  handlers are resolved per request, but the endpoint list is fixed at startup.
- Auth mode `none` is deprecated and only permitted on loopback.
- **Audit**: when configured, serve emits audit events for authorization
  denials and high-value operations, including successful server-token ingress
  (without the credential secret). → [serve-audit](../enablers/serve-audit.md).
  This is separate from the CLI audit subsystem (`src/domain/audit/`), which
  tracks local command history.
