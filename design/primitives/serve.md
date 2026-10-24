---
audience: operator, maintainer
last-verified: 2026-10-23 @ 268af553
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
operation, `putIfAbsent`, is optional on the interface, and every serve consumer
degrades gracefully without it. Workflow signal waits do not: a workflow that
contains one is refused on a datastore whose store lacks it (see
[workflows §Wait for Signal](workflows.md#wait-for-signal-wait_for_signal)).

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
`KNOWN_AUTH_KEYS`, `KNOWN_TLS_KEYS`). A known key of the wrong type — a scalar
where a list or mapping belongs, or a list entry that is not a string — stops
`serve` and `serve check-config` with an error naming the key
(`validateConfigValues`); an empty key is unset. `--config` names another file;
without it the default file is optional.

| Option (flag / yaml key) | Env var | Default | Notes |
| --- | --- | --- | --- |
| `--config` | — | `.swamp/serve.yaml` | Alternative config file; a relative path resolves against the repository (`resolveServePath`) |
| `--port` / `port` | — | `9090` | |
| `--host` / `host` | — | `127.0.0.1` | Off-loopback needs TLS and an auth mode (`assertOffLoopbackSecurity`) |
| `--cert-file`, `--key-file` / `tls.*` | `SWAMP_SERVE_CERT_FILE`, `_KEY_FILE` | unset | Both set ⇒ TLS; `ws://` becomes `wss://`; relative paths resolve against the repository, from any source (`resolveServeTlsPaths`) |
| `--auth-mode` / `auth.mode` | — | `none` | `none` \| `token` \| `oauth`; `none` logs a deprecation warning |
| `--admins`, `--allowed-collectives`, `--allowed-users` / `auth.*` | — | unset | See [Identity and access](#identity-and-access) |
| `--oauth-provider` / `auth.oauth-provider` | — | `https://swamp-club.com` | Must be HTTPS unless localhost (`src/domain/access/serve_auth_config.ts`) |
| `--oauth-client-id`, `--oauth-client-name` / `auth.oauth-client-{id,name}` | `SWAMP_OAUTH_CLIENT_NAME` (name only) | unset, `swamp-serve-{repo}-{host}` | Client id auto-registered on first start if omitted |
| `--groups-field` / `auth.groups-field` | — | `collectives` | Userinfo field holding group/collective memberships |
| `--restricted-model-types`, `--restricted-commands` / `auth.restricted-*` | — | unset | Comma lists needing admin authority; need mode `token` or `oauth`. A restricted behavior type needs admin to create, run, edit or delete a behavior of it, delete or rename its data, or add or change a workflow step running it. A behavior type matches in any spelling: a leading `@` is ignored on the entry, the request and the stored type. Command names match exactly. serve warns at startup about an entry that can match nothing; an entry naming no type (`@`, `::`) stops it starting |
| `--approve-requires-explicit-grant` / `auth.approve-requires-explicit-grant` | `SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT` | `false` | Opt-in |
| `--signal-requires-explicit-grant` / `auth.signal-requires-explicit-grant` | `SWAMP_SIGNAL_REQUIRES_EXPLICIT_GRANT` | `false` | Opt-in |
| `--tag-requires-explicit-grant` / `auth.tag-requires-explicit-grant` | `SWAMP_TAG_REQUIRES_EXPLICIT_GRANT` | `false` | Opt-in |
| `--group-refresh-interval` / `auth.group-refresh-interval` | `SWAMP_GROUP_REFRESH_INTERVAL` | 4 h | OAuth only; `0` disables |
| `--grants-file`, `--grants-dir`, `--grant-reload` | `SWAMP_GRANTS_FILE`, `_DIR` | unset, unset, `manual` | Relative paths resolve against the repository, from any source; `auto` starts a `GrantsDirectoryPoller` (30 s); a source startup would refuse (invalid, unreadable or missing) keeps its stored grants |
| `--no-schedule` / `schedule` | — | `true` | Disables cron triggers |
| `--max-concurrent-scheduled-runs` / `max-concurrent-scheduled-runs` | `SWAMP_MAX_CONCURRENT_SCHEDULED_RUNS` | `1` | Scheduled runs in flight at once; a workflow never overlaps itself. Separate from `--max-concurrent-runs`. Set at startup, not on reload |
| `--webhook <route:workflow:secret[:scheme[:header[:prefix]]]>` / `webhooks[]` | — | none | Flags replace the file list entirely |
| `--max-concurrent-webhook-runs` / `max-concurrent-webhook-runs` | `SWAMP_MAX_CONCURRENT_WEBHOOK_RUNS` | `1` | Webhook runs in flight at once, across all routes; deliveries to the same route may overlap. Separate from `--max-concurrent-runs`. Set at startup, not on reload |
| `triggers.<workflow>.{schedule,inputs}` | — | none | yaml only; overrides a workflow's own trigger |
| `--trust-proxy`, `--trusted-hosts` | `SWAMP_TRUSTED_HOSTS` | `false`, unset | `X-Forwarded-For` and WebSocket `Origin` handling |
| `--ws-idle-timeout`, `--queue-timeout` | `SWAMP_WS_IDLE_TIMEOUT`, `SWAMP_QUEUE_TIMEOUT` | unset | Worker-facing |
| `--verify-on-enroll` | `SWAMP_VERIFY_ON_ENROLL` | `false` | Fleet probe on each enrolling worker; failures marked unverified |
| `--dispatch-env-allow` / `dispatch-env-allow` | `SWAMP_DISPATCH_ENV_ALLOW` | unset | Only these variables ship in the environment snapshot (case-insensitive, denylist still applies); an empty list (`[]` in serve.yaml, or an empty env var; the flag needs a value) ships none; unset ships the whole environment. See [remote execution](../enablers/remote-execution.md#the-execution-environment) |
| `--heartbeat-interval`, `--stale-ttl`, `--reconciliation-interval` | `SWAMP_HEARTBEAT_INTERVAL`, `SWAMP_STALE_TTL`, `SWAMP_RECONCILIATION_INTERVAL` | 30 s, 90 s, 60 s | `stale-ttl` must be ≥ 2× heartbeat; no effect without a remote control plane |
| `--hydration-timeout` | `SWAMP_HYDRATION_TIMEOUT` | 60 s | Startup pull of the remote datastore |
| `--shutdown-drain-timeout` | `SWAMP_SHUTDOWN_DRAIN_TIMEOUT` | 30 s | How long shutdown waits for in-flight runs; `0` aborts at once; in serve.yaml quote the value (`"0"`) |
| `--datastore-poll-interval` | `SWAMP_DATASTORE_POLL_INTERVAL` | 30 s | Config, access and runtime pollers; min 1 s; no effect without a remote datastore or managedConfig |
| `--continuation-sweep-interval` | `SWAMP_CONTINUATION_SWEEP_INTERVAL` | 30 s | How often serve looks for suspended runs that need no further decision and continues them; `0` disables; whole seconds or larger; in serve.yaml quote the value (`"0"`) |
| `--max-signal-wait-timeout` | `SWAMP_MAX_SIGNAL_WAIT_TIMEOUT` | 1 y | Longest `timeout` a `wait_for_signal` step may ask for on this server; at most one year; a step that asks for more fails when it would start waiting |
| `--token-gc-interval`, `--token-gc-grace-period` | `SWAMP_TOKEN_GC_INTERVAL`, `SWAMP_TOKEN_GC_GRACE_PERIOD` | 1 h, 1 h | Server token GC (see Tokens below); interval `0` disables, grace `0` collects at expiry; whole seconds or larger; in serve.yaml quote the value (`"0"`) |
| `--max-concurrent-runs`, `--max-runs-per-principal`, `--max-run-duration` | `SWAMP_MAX_*` | `100`, unset, unset | Enforced by `ActiveRunRegistry` |
| `--hot-reload` | — | `false` | Writes `.swamp/serve.pid`; an extension pull, update, install or rm made through serve reloads it (swamp-club#3594); not supported on Windows |
| `--enable-internal-api` | `SWAMP_ENABLE_INTERNAL_API` | `false` | Exposes `/internal/runs` (`limit` default 100, clamped 1–10 000) |
| `--remote-only` | `SWAMP_REMOTE_ONLY` | `false` | User steps run only on workers |
| `--dashboard` | `SWAMP_DASHBOARD` | `false` | Serves `/dashboard/*` when the build embeds the SPA |
| `--auto-resume` | `SWAMP_AUTO_RESUME` | `false` | Resumes a run once every approval gate is decided and every wait for a signal is settled |
| `--detach-runs` | — | `false` | Deprecated, no effect: runs are always detached |

Table notes:

- `--approve-requires-explicit-grant`: deciding an approval gate needs a grant
  naming `approve` (see "Actions" in access-control.md). Every replica must
  share the value.
- `--signal-requires-explicit-grant`: delivering a signal to a wait needs a
  grant naming `signal`; a `run` grant alone no longer passes. Every replica
  must share the value.
- `--tag-requires-explicit-grant`: an edit that changes a behavior's or
  workflow's tags or name needs a grant naming `tag`; a `write` grant alone no longer
  passes (swamp-club#3085, see "Actions" in access-control.md). Turn it on
  when grants read tags in conditions and members may write the resources
  they cover. Every replica must share the value.
- The worker timeouts are covered in remote-execution. Related built-in
  defaults: 60 s reconnection grace (`DEFAULT_GRACE_WINDOW_MS`,
  `src/serve/worker_gateway.ts`) and 600 s queue ceiling
  (`DEFAULT_QUEUE_TIMEOUT_MS`, `src/serve/dispatch_service.ts`).
- The run limit's `100` is the registry's own fallback
  (`src/serve/active_run_registry.ts`).
- Durations that drive a timer (`--heartbeat-interval`,
  `--reconciliation-interval`, `--group-refresh-interval`,
  `--hydration-timeout`, `--shutdown-drain-timeout`,
  `--datastore-poll-interval`, `--continuation-sweep-interval`,
  `--max-run-duration`)
  are capped at 2 147 483 647 ms, about 24.8 days (`parseTimerDuration`,
  `src/cli/duration_parser.ts`). Deno fires a longer timer after 1 ms.
- Without `--hot-reload`, SIGHUP is a shutdown signal
  (`src/infrastructure/process/shutdown_handlers.ts`).
- `--remote-only` never moves built-in `swamp/*` control-plane behaviors (server
  tokens, enrollment tokens, workers, step leases, etc.) off the orchestrator
  (`src/domain/remote/remote_dispatch.ts`).
- `--auto-resume` applies to workflows that declare no inputs and leave
  `autoResume` unset (see "Manual Approval" in workflows.md). The same policy,
  read from the parent's workflow, decides whether serve resumes a parent
  once the nested run it waits on finishes ("Gates inside a nested workflow"
  in workflows.md).
- `--continuation-sweep-interval` sets how often the continuation sweep runs
  after its pass at boot (`ContinuationSweepService`,
  `src/serve/continuation_sweep_service.ts`). The sweep continues a suspended
  run whose gates are all decided and whose waits for a signal are all
  settled, under the workflow's auto-resume policy, and is what retries a
  launch that was lost. It also settles a wait past its deadline as timed
  out, so the run's `failed` handlers run without a client (see "Timing out"
  in workflows.md). On a synced datastore it does not start when the boot
  hydration failed, and it runs only its boot pass when the sync service has
  no `fetchContent` to compare a run record with the remote one. Two instances never resume the same run: see
  "Continuation claims" in workflows.md. The sweep of pending signals rides
  these passes on its own, longer cadence: at boot, then at most every ten
  minutes whatever this interval is (see "Early signals" in workflows.md).
- `--max-signal-wait-timeout` is not a timer and is not capped at 24.8 days:
  it is compared with a step's `timeout` when the step would open its wait
  (`parseMaxSignalWaitTimeout`, `src/cli/commands/serve.ts`). Waits already
  open keep their deadline.
- Once shutdown begins the active-run registry refuses every new run
  (`ActiveRunRegistry.beginDraining`, called first by `runShutdownDrain`), so
  a resume chained after another cannot start on an instance that is going
  away.

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

On a v3 filesystem datastore a run survives a crash as well as a restart: it
checkpoints as it saves its record, so the boot reaper settles it from
its last checkpoint (swamp-club#3587).

"Remote control plane" means the datastore extension advertises
`capabilities().controlPlane` and exposes `controlPlaneStore()`. Otherwise serve
uses `FileSystemControlPlaneStore` under the repository's `.swamp/_control/`
(`src/infrastructure/persistence/fs_control_plane_store.ts`), whatever the
datastore. It keeps the same key layout and `putIfAbsent` (the record is written
in full and hard-linked into place, so a reader never sees half of one) but is
visible to one machine only. The two wait key families below are the exception:
they always live with the datastore, never in this fallback.

## Surface

Everything below shares the one listener, dispatched in table order
(`src/cli/commands/serve.ts`, request handler).

| Transport | Route(s) | Auth | Purpose |
| --- | --- | --- | --- |
| WebSocket | any path with `Upgrade: websocket` | token (bearer header, `bearer.<token>` subprotocol, `?token=`, or an origin-bound dashboard session cookie) unless mode `none` | Serve protocol: 121 request types in `ServerRequest` (`src/serve/protocol.ts`), handled in `src/serve/connection.ts` and `src/serve/handlers/*` |
| HTTP | `/data/*`, `/bundle/*` | worker session bearer | Remote-execution data plane (`src/serve/data_plane.ts`); see [remote-execution §Data plane](../enablers/remote-execution.md#data-plane-two-transports) |
| HTTP POST | configured webhook routes | HMAC per scheme | `src/serve/webhook.ts` |
| HTTP POST | `/api/v1/cancel/{workflow-run\|method-run}/{id}`, `/api/v1/cancel` (bulk) | token + admin (IP burst and per-token rate limits) | `cancelExecution` (see below) |
| HTTP POST | `/api/v1/signal/{waitId}`, `/api/v1/signal` (by workflow and key, in the body) | token + `signal` on the wait's workflow (IP burst and per-token rate limits) | Delivers a signal to a `wait_for_signal` step (`src/serve/signal_http.ts`; see "Signal" below) |
| HTTP GET | `/api/v1/health` | any valid bearer token or dashboard session (`authenticateToken`, `src/serve/admin_auth.ts`) | Health snapshot (`src/serve/health_collector.ts`). Admins get it whole; other tokens get it narrowed by `healthSnapshotFor` (`src/serve/health_snapshot_view.ts`) to the runs, schedules and webhooks of workflows and behaviors they may `read`, decided on each resource's resolved name, tags and behavior type (entries that do not resolve are hidden), without run principals, workers or component detail |
| SSE | `/api/v1/health/stream?interval=` | any valid bearer token or dashboard session; at most 10 open streams per token, else 429 | The same narrowed snapshot every 1–60 s (default 5 s), resumable via `Last-Event-ID` (`src/serve/health_stream.ts`). The stream is a token session: when its token is revoked, rotated or expires, or its principal loses access, it ends with a `session-ended` event carrying the close code and reason. A change to the principal's collectives or groups ends it with 4004 so the client reconnects under the new access |
| HTTP GET | `/api/v1/cluster/instances`, `/api/v1/serve/config` | admin (`authenticateAdmin`, `src/serve/admin_auth.ts`) | Heartbeat roster, redacted merged options |
| HTTP GET | `/internal/runs?limit=&offset=` | admin; 404 unless `--enable-internal-api` | Full run-tracker history |
| HTTP POST | `/auth/device`, `/auth/device/token` | none (IP burst limit) | OAuth device grant, mode `oauth` only (`src/serve/device_auth_handler.ts`) |
| HTTP | `/auth/dashboard/session` | same-origin browser session | Dashboard session status, manual-token exchange and logout. It sets or clears the host-only `HttpOnly`, `SameSite=Strict`, `Path=/` cookie, which holds an opaque control-plane session id; TLS deployments also set `Secure`. |
| HTTP POST | `/auth/dashboard/device`, `/auth/dashboard/device/token` | same-origin browser session (IP burst limit) | Browser OAuth device grant. Completion sets the dashboard session cookie and returns no server token; the CLI device-auth JSON contract remains unchanged. |
| HTTP GET | `/auth/info` | none | `{ mode, verificationBaseUri? }` so clients pick a login flow |
| HTTP GET | `/ready`, `/` and `/health` | none | `/ready` is 503 until startup completes and again (`shutting_down`) once shutdown begins; `/health` lists schedules and webhook endpoints, each with its queue state (see Cron and Webhooks below) |
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
needs the full list. `workflow.run.search` also filters, before paging, by
`until` (exclusive), `workflows` (exact names) and `triggerSource`; `since` and
`until` take a duration back from now or an ISO time. `statuses` and
`triggerSources` take several values and keep runs matching any of them
(ignoring case; an empty list filters nothing); beside `status` or
`triggerSource`, both filters must hold.

`workflow.run.summary` counts runs instead of listing them: totals, per-workflow
counts with each workflow's newest runs (`recentLimit`, default 20, clamped to
0..100) and, with `timeline`, hourly UTC buckets. It takes the same `since`,
`until`, `workflows`, `triggerSource` and `triggerSources` filters. The counts
are taken after the per-workflow read filter
(`src/libswamp/workflows/run_search.ts` gets it as `isReadable`, asked once per
recorded workflow id and name), so an unreadable workflow never reaches totals
or the timeline.

Both list workflows through their kept listings and read each workflow's run
index snapshot, which serve keeps in memory and checks with two stats on each
read. The filters, the read filter, `offset`
and `limit` are applied while selecting from the snapshots, and search items
are built for the page only, so a request costs the runs it matches rather than
the whole run history. Once serve is listening, it reads every workflow's
snapshot in the background, so the dashboard's first requests find the cache
warm (swamp-club#3443; see
[workflows](workflows.md#run-index-and-run-search)). `failed` includes interrupted runs and `running` pending ones; a
status in no bucket counts in `runs` only.

## Identity and access

Serve has three auth modes (`src/domain/access/serve_auth_config.ts`):

- `none`: no principal; every request is anonymous. Deprecated and loopback
  only. `--restricted-*` options are ignored with a warning. Its HTTP API
  rejects a browser Origin outside the loopback or configured trusted-host
  authorities, and checks Host on every API request to prevent DNS rebinding.
  Native clients without an Origin remain supported. Signal and cancel HTTP
  requests must declare `Content-Type: application/json`; this makes them
  non-simple browser requests, so a cross-origin browser must pass the same
  origin check before sending one.
- `token`: clients present `<name>.<secret>`. `--admins` is required, and each
  entry must parse as `user:<id>`, `group:<name>` or `idp-group:<name>`.
- `oauth`: clients log in through the swamp-club device grant. Requires
  `--admins` and at least one of `--allowed-collectives` / `--allowed-users`
  (otherwise "any swamp-club user can connect"). At startup a username the
  provider does not know is skipped with an ERROR log rather than stopping
  serve. `swamp serve check-config` finds such names before a deploy, and
  reports `restricted-commands` entries that are not server commands and
  `restricted-model-types` entries that name no type; it does not load the
  behavior registry, so it checks a bare type (no leading `@`) against the
  built-in types only and warns about any other, including a bare extension
  type, which should be written with its `@`. serve checks bare types against
  every registered type at startup. It also reads the grant files serve reads
  (`grants/`, `--grants-file`, `--grants-dir`) through the loader startup
  uses: a file startup would refuse fails the check (in OAuth mode it looks
  every grant-file `username:` up afresh; outside it a `username:` subject
  fails), while a grant type spelling that
  matches no type as written, or an external source absent where the check
  runs, is a warning. Stored grants are in the datastore, which it never
  reads; serve reports their spellings at startup. See
  "Username resolution" in
  [remote execution](../enablers/remote-execution.md).

Grant, group, token, worker and lease records are stored as behavior data but
owned by the `access` kind: every request that reaches one needs `admin` on
`access:swamp/<type>`, and a `data:*` or `model:*` grant never does. See
"Control-plane records" in
[access control](../enablers/access-control.md#control-plane-records).

**Operator gate.** In `token` and `oauth` mode the serve process must itself be
logged in to swamp-club with the `serve:*` scope (`requireAuthenticated` /
`requireScope` in `src/cli/commands/serve.ts`). `swamp serve daemon enable`
applies the same gate, keyed on the auth mode the daemon will resolve
(including one set in `serve.yaml`). OAuth mode also reads the collective
API key to register the instance with the provider and resolve admin
usernames. The key comes from `--club-api-key-file`, then
`SWAMP_API_KEY_FILE`, then `SWAMP_API_KEY`
(`src/infrastructure/persistence/api_key_source.ts`). Setting both env vars is
an error. The flag is read from argv before Cliffy parses, so the operator
gate, telemetry and extension pulls use the same key as the OAuth calls.

**Tokens.** A token is split on the first `.`; the name resolves a
`swamp/server-token` lifecycle resource and its vault secret. Serve applies the
same pure lifecycle and timing-safe credential check as explicit `redeem`, but
ingress auth is read-only: no `lastUsedAt` write and no behavior run
(`src/serve/token_auth.ts`). Explicit `redeem` stays a behavior action and still
updates usage.

Secrets live in the encrypted control-plane vault (`ControlPlaneVaultProvider`,
`src/domain/vaults/control_plane_vault_provider.ts`), not the user's vault, so
they replicate with the control-plane store and can be deleted immediately. At
boot, right after that vault registers, `checkTokenHealth` reports secrets that
no longer decrypt, and `sweepTokenConsistency` reports token records missing
their secret and secrets or data with no definition. Neither deletes anything
(`src/serve/boot_reconciliation.ts`). The CLI token commands (`access token
mint`, `rotate` and `reveal`, and `worker token create`) register the same vault
through `initializeControlPlaneVault`
(`src/domain/vaults/control_plane_vault_init.ts`). Like serve, they stop with
the initialization error if it fails; they never fall back to a user vault.

A token's record and its secret sit in two stores with no shared transaction:
the secret is written straight to the control-plane store, the record to the
local cache and pushed later. Two things keep one mint's record from being used
with another mint's secret (swamp-club#2482):

- **The name lock.** Mint, rotate, revoke and the secret migration each hold a
  datastore lock keyed by token name (`createServerTokenLock`,
  `src/infrastructure/persistence/server_token_lock.ts`) across their pull,
  their writes and their push. It is keyed by name, not behavior id, so it
  covers a first mint, which has no definition yet. A writer takes it before any
  per-behavior lock. In serve it is taken at the dispatch site, around the sync
  gate (`withServerTokenWriteLock`, `src/serve/handlers/access_handlers.ts`), so
  a replica never waits on it while holding the gate, and only for a caller the
  handler will authorize. A caller may name the token by definition id; the lock
  is taken on the name it resolves to (`serverTokenLockName`). A lock that times
  out is the client error `lock_timeout`, retryable like serve's other lock
  timeouts, with a message naming the token; one that cannot be taken at all is
  `access_token_lock_failed`. The secret migration re-reads each record under
  the lock and skips one that changed since it was listed, so it cannot restore
  a rotated token's old secret.
- **The secret fingerprint.** The record stores `secretFingerprint`, the
  SHA-256 of the secret it was minted with. Authentication, `redeem` and
  `access token reveal` check the vault secret against it
  (`verifyServerTokenSecret`). A mismatch fails closed, with the rejection
  reason `mispaired-secret` in the log, and `rotate` repairs it by writing a
  new pair. Records minted before the field existed carry no fingerprint and
  skip the check until they are rotated or re-minted; no migration adds one,
  since hashing the current secret would bless a pairing that may already be
  wrong.

The token GC takes the name lock too, around each token it collects (see
below). One writer does not. The OAuth login mint names each token
`oauth-<random>`, so it only shares a name with another mint by chance; it
records the fingerprint, so a collision fails closed. A binary from before the
lock takes neither precaution, and drops the fingerprint from a record it
rewrites.

Serve garbage-collects server tokens in every auth mode
(`ServerTokenGcService`, `src/serve/server_token_gc_service.ts`, wired by
`src/serve/server_token_gc_deps.ts`). The first sweep runs just after boot,
after token secret migration in OAuth mode (the only mode that migrates), then
one runs every `--token-gc-interval`. A sweep deletes revoked tokens at once,
and expired tokens once `--token-gc-grace-period` has passed since `expiresAt`,
so both drop out of `access token list`.

A sweep stops after `MAX_TOKENS_PER_SWEEP` (100) tokens that it collected or
failed to collect; a token skipped on re-read does not count. Each collection
holds the sync gate for a push, so without the cap the first sweep after an
upgrade, which finds every revoked or expired token ever minted, would hold
the gate for a long time. A larger backlog drains over later sweeps. Tokens
that failed in the last sweep are tried after the others, so a block of tokens
that keep failing cannot use up the cap (swamp-club#2535).

Each token is collected as one unit holding the token's name lock and, inside
it, the sync gate exclusively. The lock is taken first, as the token handlers
take it, so the GC never waits on it while holding the gate; a lock it cannot
take fails the collection, and the token is retried next sweep. Inside the
unit the GC first pulls, when serve has a remote datastore, as the token
handlers do before they write; a failed pull fails the collection. It then
re-reads the token's `token-main` and skips the token if it is gone or no
longer eligible. Then:

1. It deletes the secret. A failure keeps the token for the next sweep, so a
   stale copy of the records, such as an HA peer's local cache, can never
   authenticate.
2. It deletes the OAuth access token, best effort.
3. It deletes the definition, data and outputs through `modelDelete`, and
   pushes the deletes. The workflow reference check is skipped, since it
   matches by name and a server-token definition is never a step's behavior.

The secret key is always `server-token-<name>`, never the key the persisted
record names, so a tampered record cannot make serve delete an unrelated
secret.

That key is shared by every definition that has carried the name. So when a
record outlives its definition, and the name now belongs to another definition
or to none, the GC deletes only that record's data and leaves the secret.

The GC looks up the definition that owns the name through the shared
definition repository, the one authentication reads through, so the two
always agree. It searches `models/` first, then `.swamp/auto-definitions/`, so
a server-token definition the boot migration left in `models/` is collected
rather than treated as an orphan.

For a token minted before swamp-club#1511, the GC also deletes the canonical
key from the vault the record names, but only when that vault supports deletes
and its listing holds the key. Anyone who can write the datastore can change
the recorded vault, so a vault that does not hold the key is never touched.
When the listing fails, the GC leaves that vault alone, logs the vault and key
so an operator can remove it, and still collects the token: with its records
and `_token-secrets` copy gone, the leftover secret cannot authenticate, and a
vault whose credentials allow deletes but not listing would otherwise keep the
token forever. A failed delete still keeps the token for the next sweep. Each
such vault is listed at most once per sweep; a failed listing is not cached. The
`_token-secrets` deletes do not match error messages: the control-plane
store's delete of a missing key is a no-op, so any error is a real failure.

Every replica sweeps on its own, and a token another replica already deleted
is skipped.

The re-read protects against token writes because the GC holds the same name
lock as the writers. Mint, rotate and revoke, in serve and in the CLI, hold it
across their writes, so a write lands either before the re-read or after the
unit, with or without a remote datastore (swamp-club#2534). Serve only creates
the sync gate with a remote datastore, so the lock, not the gate, is what
serialises them. The OAuth login mint holds the gate but not the lock; its
random names make a clash with a collected token a chance collision.

Across replicas the lock is the datastore's distributed lock, so it orders
the GC after another replica's re-mint or rotation of the same name, and the
pull before the re-read brings that write into the local copy the GC reads.

The lock and the pull have a cost. With a remote datastore each collection
takes a distributed lock and pulls, on top of its push, and holds the gate for
the pull. A token whose lock another writer holds can make a sweep wait up to
the lock timeout (`SWAMP_LOCK_TIMEOUT_MS`, 60 s by default), without holding
the gate. `MAX_TOKENS_PER_SWEEP` caps the collections that succeed or fail,
and a lock timeout is a failure. A token skipped on re-read still costs a lock
and a pull but does not count toward the cap, so skips are bounded only by the
number of tokens the sweep listed as eligible.

**Server token secrets.** Serves before swamp-club#1511 stored each server
token's secret, and an OAuth login's `oauth-access-token-<name>`, in a user
vault (the default, else the first) and named that vault on the token record.
On an OAuth-mode start, and from `access token mint` and `rotate`, each such
token is migrated under its name lock (`src/serve/token_secret_migration.ts`):
its secret is read, its vault is listed, and an access token the listing holds
is read too. Both are written to `_token-secrets`, the record is repointed, and
the user-vault copies are deleted when the vault supports deletes. A secret
that cannot be read skips the token. A listing that fails, or a listed access
token that fails to copy, fails the token before the record is repointed, and
the next run retries. Only a key the listing lacks counts as absent: repointing
a token whose access token stayed behind would hide it from the collective
refresh, which reads only `_token-secrets` for such a record, so the token
would never be refreshed or revoked on a userinfo 401 (swamp-club#3136).

Earlier builds repointed in that case. So once per repo, serve lists the
default user vault and copies the access token of each active record that
names `_token-secrets` but lacks it there, under the token's name lock.
`_token-secrets` is listed too, so a key there that fails to read is not
overwritten. Token names come from the records, not from the vault's keys.
When the listing succeeds and every key moves, serve records
`oauth-access-tokens-recovered` in `_token-secrets` and never lists the vault
for this again; otherwise the next start retries. A start with no such record
records the marker without listing. The recovery trusts the user vault's value
as the migration does, searches only the default user vault (else the first
user vault), and does not repair a token an older binary sharing the datastore
half-migrates after the marker exists.

**OAuth bootstrap secrets.** Older serves stored `oauth-client-id`,
`oauth-client-secret`, `oauth-bootstrap-access-token` and
`oauth-resolved-admins` in the default user vault. On start, serve lists that
vault once, moves any of the four that `_token-secrets` lacks, and deletes them
from the user vault when it supports deletes. When the listing succeeds and
every key moves, serve records `oauth-secrets-migrated` in `_token-secrets`, and
the migration never touches the user vault again. A key that is legitimately
absent, such as the bootstrap access token after an API-key registration,
therefore costs the migration nothing after the first start. Credential
resolution, which runs before the migration, falls back to the user vault for a
key `_token-secrets` lacks only while the marker is unset; once it exists, such
a key is absent and the user vault is not read (swamp-club#3127). Resolution
asks for the bootstrap access token only while `oauth-resolved-admins` is unset.
A user vault that
cannot be listed, or a key that fails to move, leaves the marker unset and the
next start retries. Once the marker exists, an `oauth-*` item added to the user
vault is neither moved nor deleted (swamp-club#2471).

**Token secrets key.** By default the AES-256-GCM key that encrypts
`_token-secrets` is generated on first use and stored beside the ciphertext, at
`token-secrets/encryption-key` in the same control-plane store. With a remote
control plane that means read access to the datastore decrypts every token
secret: the encryption adds nothing beyond the bucket's own access control.
Operators opt in to a key held elsewhere with a `serve.yaml` block:

```yaml
token-secrets:
  vault: prod-secrets # any user vault except _token-secrets
  key: swamp-token-secrets-key
```

The operator generates the key (32 bytes, hex or base64, e.g.
`openssl rand -base64 32`) and stores it in that vault. Swamp never generates
it or writes it to the datastore; keys with the same value in every byte are
rejected. The rules (`src/domain/vaults/token_secrets_key.ts`,
`ControlPlaneVaultProvider`):

- The key comes only from local `serve.yaml`: serve's `--config` file, and
  `.swamp/serve.yaml` for the local token commands. It is read once at startup;
  changing it needs a restart. `swamp serve check-config` reads it and reports
  whether it is usable, without printing it; it does not compare it with the
  fingerprint of a control plane already moved to an external key, which serve
  checks at startup.
- The vault must keep its storage outside the datastore. `local_encryption`
  keeps its key in the always-local `.swamp/secrets/`, so it works on one host;
  in HA every instance, and every host that runs `access token` commands
  locally, needs the same key, which fits a shared external vault.
- Serve refuses to start (and the token commands fail) if the vault or secret is
  missing, the value is not a usable key, or it is not the key the control plane
  was moved to.
- The first opted-in serve start re-encrypts every entry under
  `token-secrets/values/` with the external key. Only then does it overwrite
  `encryption-key` with a marker: the vault reference and an HMAC fingerprint of
  the key, which decrypts nothing. A crash before that leaves the old key in
  place, and the next start resumes. Entries neither key decrypts are left as
  they are and logged by name. The token commands never migrate (the provider's
  `migrate: false`): they refuse until serve has, because migrating from a CLI
  process would change the key under running instances that still hold the old
  one.
- Serve migrates whenever it finds a co-located key, so restoring a backup of
  `_control/token-secrets/` from before the move makes the next start migrate
  again from that backup. The same applies to anyone with datastore write
  access, who could plant a key and ciphertext of their choosing: the external
  key protects against datastore read access, not write access.
- The marker is not a valid AES key, so a swamp release without this support
  refuses to start rather than generating a new co-located key. A process with
  no `token-secrets` block also refuses, naming the vault and key recorded in
  the marker, but never reads the key from that reference: the marker is
  datastore content and must not choose the key source. There is no way back to
  a co-located key.
- Restart every instance with the block together. An instance still on the old
  key while another migrates can write a secret neither key opens. Opted-in
  instances may migrate at the same time: each re-reads an entry just before
  writing it back and skips it if a peer changed or deleted it since (a
  rotation after the peer finished, say). The store has no compare-and-swap,
  so a change inside that one round-trip can still be overwritten.
- The token commands read `.swamp/serve.yaml` only for this block. A file that
  cannot be read or parsed is skipped with a warning, so the default path keeps
  working; a control plane already moved to an external key still refuses.
- Moving to the external key cannot reach copies made before the move: datastore
  backups, noncurrent object versions on a versioned bucket, and root-level
  `_control/token-secrets/` left by the namespace migration (see High
  availability) still hold the old key. Serve logs a warning for the first two
  after migrating, and an error on every namespaced start while a co-located key
  remains at the root. Rotate tokens minted before the move and delete those
  copies.

**Grants.** Each request is authorized against an in-memory `PolicySnapshot`
built from grant and group data (`src/domain/access/policy_snapshot_loader.ts`).
An `AccessDataPoller` reloads the snapshot when another process changed
`data/swamp/grant` or `data/swamp/group`, checking every
`--datastore-poll-interval` (default 30 s)
(`src/serve/access_data_poller.ts`). With a remote datastore it pulls them; on
a v2 filesystem datastore it fingerprints the shared directories and ignores
the instance's own writes (swamp-club#3371). In OAuth mode, a `CollectiveRefreshService`
re-fetches each logged-in user's collectives from the provider every
`--group-refresh-interval`. It closes connections whose admission lapsed
(`src/serve/collective_refresh_service.ts`). It applies a userinfo answer only
when its subject matches the token's principal, and otherwise keeps the token's
snapshot and logs a warning, so whoever can write a stored access token cannot
choose whose collectives a token gets. A token is refreshed only when an
OAuth login stored an access token for it. The lookup reads `_token-secrets`,
and reads a user vault only for a token whose record still names one, so a
manually minted or worker server token costs no user-vault read
(`src/serve/oauth_access_token_lookup.ts`). The token secret migration keeps
a record naming `_token-secrets` only once its access token is there (see
**Server token secrets** above). See
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

`swamp workflow run --server <url> --detach` uses that on purpose
(swamp-club#1090). The client reads the stream up to the run's own `started`
event, prints the run id, and closes its socket without sending `cancel`
(`runWorkflowOverServer` with `detach`, `src/cli/remote_run.ts`). The execution
service saves the run record before it yields `started`, so the id names a
recorded run by the time the command returns. A request refused before that
(unknown workflow, invalid inputs, no `run` grant, over `--max-concurrent-runs`,
shutting down) fails the command as it does without `--detach`.

What a detached caller does not get:

- A result. The exit code says the run started, not how it ended. Follow it
  with `swamp workflow history get <run-id>` or `run.attach`.
- Backpressure beyond the run limits. Each accepted run holds a slot in the
  `ActiveRunRegistry` until it ends, so a caller that submits faster than runs
  finish is refused with `Too many concurrent runs` and must handle it.
- A guarantee across a crash. A detached run is an API run: it is not a pending
  run and is not replayed. If its instance dies, reconciliation marks it
  `interrupted` like any other (see [High availability](#high-availability)).
- `--timeout` or `--junit`, which the command refuses: the deadline would be
  enforced by a client that has already left, and there is no result to
  report. `--max-run-duration` limits the run on the server.

The request's audit `response` event is written when the client leaves, as it
is for any subscriber that drops, so it records that the run was accepted, not
how it ended.

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

**Signal.** A signal for a `wait_for_signal` step arrives as the WebSocket
request `workflow.signal { waitId, payload }` or as
`POST /api/v1/signal/{waitId}` with the JSON body `{ "payload": { ... } }`
(swamp-club#3094). Both call `deliverSignalForCaller`
(`src/serve/signal_delivery.ts`), which runs the one acceptance use case,
`workflowSignal`; `integration/signal_wait_records_rules_test.ts` holds both
transports to that. What it does, in order:

- The wait ID must be a UUID (the request schema and the route pattern accept
  nothing else), and a payload over 16 KiB is refused, before any record is
  read.
- The wait's registration says which workflow and run it belongs to. The caller
  needs `signal` on that workflow, resolved as a run's workflow is
  (`CanonicalResources.workflowOwners`). The registration is trusted for this:
  it is a plaintext record in a store other writers can reach, and a writer who
  can alter it can also create the wait's outcome directly, so authorizing on
  it gives away nothing more. One inconsistency is caught along the way. When
  this instance finds the run record, the workflow name recorded on the run
  must equal the registration's, and a signal for a registration whose name was
  changed is refused and logged. A registration whose workflow ID was changed
  is not caught: runs are stored per workflow, so the run is looked for under
  the altered ID, is not found, and there is nothing to compare.
- **An unknown wait ID and a wait the caller may not signal get the same
  answer**: `not_found` over WebSocket, 404 over HTTP, with one fixed message.
  The denial is audited with the workflow's name; the reply never carries it.
  Nothing is stored for a refused caller.
- Serve never scans run records for a wait with no readable registration, as
  the local command does: one request would otherwise read every run. Such a
  wait (a run suspended by the swamp-club#3068 build, or a damaged
  registration) is answered `not_found` until a waits listing registers it.
- The receipt's `submittedBy` is the authenticated principal, never a request
  field. With auth mode `none` there is no principal and the serve process's
  user is recorded, as for a local signal. The submitter is an audit actor; it
  is never the identity a later step runs as.
- The reply carries the wait ID and the receipt. The workflow, run, job and
  step, `awaitingResume`, `runRecordAvailable` and the resume command are added
  only for a caller who may also `read` the workflow. The same split applies to
  refusals: a reader gets the use case's message and, for an already settled
  wait, the earlier receipt; a caller with `signal` alone gets a fixed sentence
  per refusal. So a signal-only caller that retries after a lost reply learns
  the wait is settled but not by which signal; a retry is idempotent only
  under an idempotency key (below).
- A delivery emits the audit event `workflow.signal.delivered` with the wait
  ID, the receipt ID and the run ID. The payload is never logged or audited.

| Outcome | WebSocket error | HTTP status |
| --- | --- | --- |
| delivered | — (`workflow.signal` reply) | 200 |
| by key: held as the key's pending signal (the reply carries the receipt and `heldUntil`, and no wait or run) | — (`workflow.signal` reply, `status: pending`) | 202 |
| by key, on a step with `acceptEarly`, for a caller with `signal` and not `read`: received, delivered or held alike (the reply carries the receipt alone) | — (`workflow.signal` reply, `accepted`) | 202, `status: accepted` |
| by key, the same caller, from a WebSocket client that does not set `acceptsReceipt` (nothing is delivered or stored) | `workflow_signal_refused`, `refusal: upgrade_required` | — |
| a retry under the idempotency key of a signal already received (the reply is that signal's, with `duplicate: true`; nothing is delivered or stored) | — (`workflow.signal` reply) | 200, or 202 while that signal is held |
| unknown wait, unknown workflow or undeclared key, or not allowed | `not_found` | 404 |
| by key: an earlier signal is pending for the key (the earlier receipt and `pending.heldUntil` for a caller who may read the workflow) | `workflow_signal_refused`, `refusal: already_pending` | 409 |
| by key: the key is declared and no open wait holds it (`lastWait` says how its last wait was settled) | `workflow_signal_refused`, `refusal: no_open_wait` | 409 |
| payload refused (errors listed) | `workflow_signal_refused`, `refusal: invalid_payload` | 422 |
| already settled | `workflow_signal_refused`, `refusal: already_settled` | 409 |
| expired, or closed before a signal | `workflow_signal_refused`, `refusal: expired` / `closed` | 410 |
| datastore cannot hold wait records | `workflow_signal_refused`, `refusal: unsupported` | 501 |
| stored record unreadable, or an internal failure | `workflow_signal_refused` / `workflow_signal_failed` | 500 |

**By workflow and key** (swamp-club#3211). A signal can name a workflow and a
key one of its `wait_for_signal` steps declares, in place of the wait ID: the
WebSocket request `workflow.signal { workflow, key, payload }`, or
`POST /api/v1/signal` with the JSON body
`{ "workflow": "...", "key": "...", "payload": { ... } }`. The workflow travels
in the body, never the path, because a workflow name may hold `@` and `/`. It
is for a caller that was never told a wait ID: a credential granted only
`signal` cannot list waits, and a fixed key lets it signal anyway. Both forms
reach `deliverSignalForCaller`, and so the same use case, receipt, audit event
and continuation as a signal by ID.

**A wait ID, when a request carries one, is the address.** A `workflow.signal`
request with a `waitId` is authorized and delivered by that ID, and a
`workflow` or `key` beside it is dropped like any unknown field, as a server
from before the key form drops them; so a client that sends extra context with
a wait ID keeps working. Only a request with no `waitId` is read as a key
address, and a `waitId` that is not a UUID is malformed whatever is beside it.
Over HTTP the path says which form a request is: `/api/v1/signal/{waitId}`
ignores a `workflow` or `key` in the body, and `/api/v1/signal`, which has no
earlier contract to keep, answers 400 to a body that carries a `waitId`.

What differs by key, in order:

- The workflow is at most 256 characters and the key at most 64
  (`SIGNAL_WORKFLOW_MAX_LENGTH`, `SIGNAL_KEY_MAX_LENGTH`); the payload cap is
  checked as by ID.
- **Authorization comes first, on the workflow the request names.** It is
  resolved as every request that names a workflow is (`resolveWorkflowTarget`:
  by name, then by ID) and the caller needs `signal` on what it resolves to, so
  a deny by name reaches a request by ID and a rule on tags sees the tags
  (access-control.md, "Requests by id match the resource's name"). A string
  that matches nothing is authorized as sent. Reading the workflow's definition
  is the only lookup before the decision: no claim, registration or key
  declaration is read for a caller who is refused.
- **The caller also needs `signal` on every workflow that shares the named
  one's ID.** Key claims are kept per workflow ID and IDs are not unique (a
  copied file keeps its ID). A caller allowed on a copy and not on the original
  would otherwise learn, from `no_open_wait` against `not_found`, whether the
  original has a wait open under the key. This costs one listing of the
  workflow files, made only for a caller who may signal the workflow they
  named. It asks the repository for the workflows with that ID
  (`WorkflowRepository.findAllById`): the YAML repository reads every file
  but parses only those whose text holds the ID or a backslash, since without
  an escape sequence a scalar equal to the ID has the ID in the text.
  Extension workflows are still all parsed, as is every workflow when the one
  named is an extension workflow. The cost still grows with the number of
  workflow files, by a read each. The reverse holds too: a caller allowed on the original and denied on
  a copy that shares its ID is refused by key, and signals by wait ID.
- **A caller who may not signal the workflow, an unknown workflow, a key the
  workflow does not declare and a string that is not in the form of a key get
  the same answer**: the `not_found` an unknown wait ID gets, with the same
  fixed message. The denial is audited with the workflow's canonical name, or
  the string as sent when nothing matched; the reply never carries it.
- The use case is then handed exactly the authorized workflow: it is found by
  its ID and accepted only under the authorized name, so a workflow named with
  that ID, or a copy that shares it, is not reached instead.
- **The wait the key resolved to is authorized again, as a wait named by ID
  is**: the caller needs `signal` on every workflow its registration belongs
  to. This is what covers a workflow renamed since the wait was opened, whose
  wait is still authorized under the name the run recorded. A refusal here is
  `not_found` too.
- A declared key that no open wait holds, on a step that sets `acceptEarly`,
  holds the signal as the key's pending signal (swamp-club#3212, "Early
  signals" in [workflows](workflows.md)). It is stored only after the caller
  was authorized for `signal` on the workflow, under the workflow ID that was
  authorized, and it records the authorized workflow name: only a wait whose
  run recorded that name takes it, which keeps the second authorization of a
  signal by key (a workflow renamed since the wait's run started) for a
  signal that arrived before the wait did. The reply is `pending`; no run is continued, since none took the
  signal yet. It is audited as `workflow.signal.pending` with the receipt ID,
  the key and until when it is held, never the payload. A second signal while
  one is held is refused `already_pending` with `pending.heldUntil`, and the
  earlier receipt for a caller who may read the workflow. Over the WebSocket
  a signal is held only for a request that sets `acceptsPending`: a client
  from before the pending reply reads `data` of every reply, so it is refused
  `no_open_wait` as it was before, and nothing is stored. The HTTP route
  always holds.
- **On a key whose step sets `acceptEarly`, a caller with `signal` and not
  `read` is not told whether a run is waiting** (swamp-club#3213). A device
  that reports an event should not learn from the answer whether a run is
  under way. Whether the rule applies is decided once per request, after the
  caller is authorized and before any wait record is read, from the definition
  of the authorized workflow (`declaredEarlyWait`) and whether the caller may
  read the workflow they named. The use case is handed that same definition,
  so the reply's shape and what is done with the signal never come from two
  readings of it. For such a request:
  - A signal a wait took and a signal that is held get one reply: `accepted`,
    202 over HTTP with `status: accepted`, carrying the receipt (`id`,
    `receivedAt`, `submittedBy`, and the idempotency key if one was sent) and
    `duplicate` for a retry under an idempotency key. It names no wait, key,
    workflow or run, and carries no `heldUntil` and no `lastWait`. When a wait
    took the signal the server still continues its run, as after any signal.
  - The signal is held whatever `acceptsPending` says: `no_open_wait` would say
    that no run is waiting.
  - `already_pending` carries no `pending`, so not until when the earlier
    signal is held. The refusal itself says a signal is held and so that no
    wait is open; refusing a second early signal cannot hide that. A refused
    payload reads `Payload refused:` with the errors, in place of the
    sentences that say whether a wait stays open or nothing was stored.
  - Over the WebSocket the reply is the `accepted` member of the
    `workflow.signal` reply, and is sent only to a request that sets
    `acceptsReceipt`. A client that does not is refused `upgrade_required`
    before any wait record is read, with one fixed message, and nothing is
    delivered or stored: a client from before this reply reads `data` or
    `pending`, and either would have to say which it was. The HTTP route
    always answers `accepted`.
  - A sender loses `lastWait`, which told a retry after a lost reply that the
    first signal landed. An idempotency key is what makes a retry safe here.

  A caller who may read the workflow is answered as before: `delivered` with
  the wait and the run, or `pending` with `heldUntil`. So is every signal by
  wait ID, and a key whose step sets no `acceptEarly`, where `no_open_wait`
  already says no wait is open. What is left: over HTTP the run of a wait
  that took the signal is launched before the reply is sent, so the time a
  reply takes can still hint that a run was waiting; and a sender whose
  signal races another's for one open wait can get `already_settled`.
- **A wait that takes a pending signal is audited** as
  `workflow.signal.taken`, with the receipt ID, the key, the wait, the run
  and the workflow ID, and never the payload (swamp-club#3213). Every take
  goes through `takePendingSignal`, which tells the listener serve sets on
  its wait store (`auditTakenSignals`), so the step that opens its wait, a
  signaller that finds the key claimed and the continuation sweep are all
  recorded. No request made the take, so it is a system event. It is recorded
  at least once: two instances that take one signal at the same moment both
  record it, under one receipt ID. A take made by a local command on the same
  datastore is not audited, as a local signal is not. A signaller's own
  request that made the take also marks its `workflow.signal.delivered` event
  `taken=true`.
- A request may carry an idempotency key: `idempotencyKey` over the WebSocket,
  the `Idempotency-Key` header over HTTP (400 for one not in the form
  `isIdempotencyKey` accepts). One that matches a signal the same principal
  already sent for the wait or its key is answered with that signal's receipt
  and `duplicate: true`, and nothing is delivered or stored; a key another
  principal used is not a match, so no caller is shown a receipt that is not
  their own; the audit detail carries `duplicate=true`. See "Idempotency keys" in
  [workflows](workflows.md) for where it is looked for and for how long.
- A declared key that no open wait holds is otherwise refused `no_open_wait`. Only a
  caller who may signal the workflow gets this far, and such a caller already
  learns whether a wait is open from whether a delivery succeeds. A caller who
  may also read the workflow gets the use case's message; one with `signal`
  alone gets a fixed sentence.
- **`no_open_wait` says what happened to the key's last wait**, in `lastWait`
  (the error's details over WebSocket, the body over HTTP):
  `{ waitId, settledAs, settledAt }`, with `settledAs` one of `accepted`,
  `timed_out` or `cancelled`, and the earlier `receipt` for a caller who may
  read the workflow. A sender that retries after a lost reply gets
  `no_open_wait`, not the `already_settled` a retry by ID gets, because the key
  is free once its wait is settled; so does a sender that is early for the next
  run. `lastWait` tells them apart: `accepted` with a `settledAt` after the
  first attempt means the signal landed. The server cannot tell them apart
  and does not try: the same answer also reaches a sender whose wait another
  principal's signal settled. It is present while that wait's claim
  is still the key's highest record (until a later wait claims the key or the
  run's records are removed), and only when the caller may signal that wait.
  The message says how the last wait was settled and at what time, without
  the receipt for a caller who may not read the workflow, and draws no
  conclusion for the sender. `swamp workflow signal --json` carries `refusal`
  and `lastWait` in its error, locally and with `--server`.
  A reader's message names `swamp workflow waits --server <server>`: the
  server does not know the address a client reached it by.
  Several senders racing for one open wait can still get `already_settled`
  instead: each resolved the key while the wait was open. Both are 409, and
  neither makes a retry idempotent; a sender that needs that sends an
  idempotency key, or sends one signal and reads `lastWait` before sending
  again.
  On a step with `acceptEarly` a retry by key with no idempotency key is not
  refused: it is held as a second signal for the next run (202). The pending reply carries the same
  `lastWait`, with the earlier `receipt` only for a caller who may read the
  workflow, so the sender can still tell that the first signal landed.
- The key is resolved from claim records only (`findKeyHolder`). Run records
  are not scanned, as they are not for a wait ID.
- The reply is the by-ID reply: the wait ID and the receipt, and for a caller
  who may read the workflow the key, workflow, run, job, step, `awaitingResume`
  and the resume command. The audit event `workflow.signal.delivered` carries
  `key=<key>` for a wait that holds one, taken from the wait's registration.
- The request's own audit events (`workflow.signal`, request and response) are
  recorded under the workflow's canonical name as soon as it resolves, so they
  name the same resource as a denial does when the workflow was named by its
  ID. A string that matches nothing is audited as sent.

A server from before swamp-club#3211 answers the WebSocket key form
`invalid_request`, which the CLI reports as a server that needs an upgrade. It
has no `POST /api/v1/signal` route and answers that path with a plain 404,
which an HTTP client can tell from `not_found` only by the missing JSON body.

The HTTP routes pass the two gates every WebSocket request passes before
dispatch: with audit in fail-secure mode and the log unable to record durably
it answers 503, and when `workflow.signal` is named in `--restricted-commands`
it answers 403 to a caller who is not an admin. Both are decided before the
wait is looked up, so they say nothing about a wait. The HTTP route also
answers 401 (no token, or one that does not authenticate),
429 (rate limited), 400 (the body is not a JSON object with a `payload` field, or, by key, does not name a workflow and a key within their bounds or also carries a `waitId`)
and 413 (the body is over `MAX_SIGNAL_BODY_BYTES`, six times the payload limit
plus 1 KiB). That cap only bounds the read: a client may escape non-ASCII
characters or indent its JSON, so a body is allowed to be several times its
payload, and a payload over 16 KiB is refused 422 whatever the body's size. The
token is checked before the body is read. With auth mode `none` the route takes a signal from
anyone who can reach the listener, as the cancel routes take a cancel; that mode
is only permitted on loopback.

A signal writes one control-plane record and nothing else: no run is saved, no
run claim or registry reservation is taken, nothing is pushed, and the request
is not sync-gated. The run continues only when someone resumes it; serve does
not resume a signalled run by itself (swamp-club#3108).

**A delivered signal is not a promise that the run will use it.** "Delivered"
means the wait's outcome is the caller's signal. If the run is cancelled at
about the same moment, the signal can win the wait's outcome and the cancel
still ends the run: the caller holds a receipt, the outcome record says
accepted, and no resume will apply it. A caller that must know what the run
did has to read the run, which needs `read`.

**Rate limits.** The route shares serve's two limits with WebSocket logins and
the cancel routes (`src/serve/rate_limiter.ts`): 50 requests per source address
per minute, counting successful deliveries, and 5 attempts per token name per
minute, counted before the token is checked and cleared when it authenticates.
A caller that sends many signals at once on one token, such as one answering
every wait of a `forEach`, can therefore be answered 429 while earlier requests
are still authenticating, and should retry. Behind a proxy without
`--trust-proxy` every caller shares one source address.

`workflow.waits` lists open waits to a caller with `read`, filtered to the
workflows they may read. With the optional payload `{ includeSignalled: true }`
the reply also carries `signalled`, the waits a signal has settled whose run has
not been resumed, each with its receipt, under the same filter; without it the
reply is as before, so a client that predates the option sees no change. With
`{ includePending: true }` it also carries `pending`, the signals held for a key
no wait has taken (swamp-club#3214), each with its workflow, key, receipt ID,
received time, `heldUntil` and sender and never the payload. It is filtered on
`read` of the signal's workflow, resolved from the workflow id and the name
the sender was authorized under, so of two workflows that share an id a signal
is listed only to a reader of the one it was held for; one sent through the
local command, which records no name, is listed only when one workflow
declares its id. `pending` is sent only when asked for. An open wait with a key
carries `signalByKeyCommand` beside `nextCommand`, which still signals it by
wait ID. A caller with no `read` grant on any workflow, such as one granted
`signal` alone, is refused as unauthorized. It is the same use case as
`swamp workflow waits` and, like it, not read-only: see "Listing" under Wait
for Signal in [workflows](workflows.md).

**Signal waits in a run stream.** `signal_wait_requested` is never sent to a
client (`LOCAL_ONLY_EVENT_KINDS`, `src/serve/serializer.ts`): a released client
dispatches each event by kind and fails on one it does not know. A client learns
of a wait from fields of the `suspended` event, which it already handles and
whose unknown fields it ignores: `wait` for the run's own wait, and
`nestedSignalWaits` for the open waits of nested runs (swamp-club#3110). Both
carry the wait's `key` when its step declares one (swamp-club#3214). New
information for clients goes in such a field, never in a new event kind;
`src/serve/serializer_test.ts` pins which kinds are sent. `redactStreamEvent`
(`src/serve/handlers/nested_run_redaction.ts`) keeps a `nestedSignalWaits`
entry only for a caller who may read the workflow the wait belongs to, which
can be a grandchild's and differ from the nested run the step waits on. Every
path that sends run events applies it: a run, a buffered run, a resume, a
buffered resume, and `run.attach`. A `step_failed` for a step refused
`wait_key_held` carries `waitKeyHolder`, the workflow, key, run, step and wait
ID of the wait that holds the key, and `redactStreamEvent` drops it for a
caller who may not read the holder's workflow (`canRead(waitKeyHolder)`),
which can differ from the run's. For a run on a server the CLI prints the
signal command, and for a keyed wait the command by key beside it, with the
`--server` it was given.

`swamp workflow signal` and `swamp workflow waits` take `--server`, and
`swamp workflow waits --pending --server` asks for `includePending`; a server
that predates it replies without `pending`, and the command warns that the
server needs an upgrade. A signal
through a server names a wait ID, or `--workflow` with `--key`
(swamp-club#3211). An address the server would refuse as malformed (a wait ID
that is not a UUID, a key not in the form of one) is answered by the command as
a wait that is not found, so it is never mistaken for an old server. Against a
server that predates these requests, or the key form, they report that the
server needs an upgrade (`requestNewerServerResponse`,
`src/cli/remote_run.ts`).

**Cancel.** There are two paths:

- HTTP cancel routes (admin only) call `cancelExecution`. It aborts the run's
  controller and waits up to `CANCEL_GRACE_MS = 5_000` for completion. It
  returns `cancelled` if the run left the registry in time, otherwise
  `cancellation_requested` (`src/cli/commands/serve.ts`). A workflow run that
  no registry holds is looked up among the scheduled runs, then the webhook
  runs (`WebhookService.cancelByRunId`); either is aborted without a grace wait
  and answered `cancellation_requested`. The bulk route (`cancelAllExecutions`)
  counts the same holders (swamp-club#3740). A run it cannot find gets 404
  `No cancellable <type> with id <id>`. The single-run route takes an
  optional JSON body `{"reason": "..."}` (at most `MAX_CANCEL_REASON_LENGTH`
  characters, read after auth with an 8 KiB cap), recorded through
  `cancelReasonFor` as `<reason> (cancelled by <principal>)`. A workflow-run
  response carries that `reason`; a method-run response does not, because
  method runs record no cancel reason.
- The WebSocket `cancel` request is keyed by request id. If that id is an
  in-flight request, its controller is aborted. Otherwise `handleCancelRun`
  checks for a `run` grant on the run's resource and calls
  `activeRunRegistry.cancel(requestId)`, with no grace wait and no
  `cancellation_requested` result (`src/serve/connection.ts`). A caller
  without the grant gets no reply, as for an unknown id, so a refusal never
  confirms the run exists or names its resource. The denial is audited, and
  so is a refusal for a missing policy snapshot or principal, which on this
  path also sends no reply.
- The WebSocket `workflow.cancel` request cancels a run by id: one this
  instance is driving through the registry, otherwise a persisted suspended
  run (`handleWorkflowCancel` in `src/serve/handlers/workflow_handlers.ts`).
  For a persisted run, `cancelSuspendedRunAndPush`
  (`src/serve/suspended_run_cancel.ts`) first locates the run and checks a
  `run` grant on the workflow it belongs to, holding neither the sync gate
  nor the run id's reservation. A run id that is not a UUID is not found
  before any repository read. Otherwise the run is found by its own run file
  (`findGlobalById`), with no scan of other runs, and a `workflowIdOrName` is
  only checked against the workflow of the run found, never looked up on its
  own (swamp-club#2729). A missing, mismatched or refused run gets the
  same `No cancellable run with id <id>` reply, and never holds the gate or
  blocks another operation on the run. Only an allowed cancel takes the gate
  and the reservation, then re-reads, saves and pushes the run.
- A cancel or reject of a run that waited on nested runs cancels those runs
  in the same gated unit of work, so one push carries the parent and its
  children (`serveNestedCascade` in `src/serve/nested_run_cascade.ts`; see
  "Gates inside a nested workflow" in
  [workflows](./workflows.md)). The cascade runs under the caller's grant on
  the parent's workflow, as the cancel of a running nested step does; no
  grant on the child's workflow is asked. Each child is reserved in the
  registry while it is cancelled. A child this instance is running is asked
  to abort and is not waited for: its final push needs the sync gate the
  handler holds, and an awaited one would stall until the gate's wait times
  out. A record this instance lacks is fetched with `hydrateFile` directly,
  since the gate is not reentrant. Each cascaded cancel emits a
  `workflow.nested_run_cancelled` (or `workflow.nested_run_stop_requested`)
  audit event naming the parent run and the reason. A run this instance was
  driving when it was aborted settles itself; the cancel then runs the
  cascade for it in a gated unit of its own (`cascadeEndedRunAndPush`).
  Serve's bulk cancel and its supersede do not cascade: the children are
  cancelled when next touched.

Serve's `CANCEL_GRACE_MS` is not the 30 s constant of the same name in
`src/domain/remote/rpc_channel.ts`, which bounds RPC cancel confirmation.

**Cron.** With scheduling enabled, `ScheduledExecutionService`
(`src/libswamp/workflows/scheduled_execution.ts`) registers every workflow with
a `schedule` and applies `triggers.*` overrides from `serve.yaml`. Each fire
calls its injected `executeWorkflow`, which serve wires to
`executeWorkflowWithLocks` with `triggerSource: "schedule"`
(`src/cli/commands/serve.ts`). A fire is skipped with a `schedule_skipped` event
while the workflow's previous run is still in progress. Each run acts as the
built-in `service:scheduler` principal, recorded as its `initiatedBy`, and is
authorized when it starts executing (a refusal emits `schedule_denied` and the
run never starts); see
[access-control](../enablers/access-control.md#service-principals). Starts and
skips are audited as `workflow.schedule.fire` and `workflow.schedule.skipped`
([serve-audit](../enablers/serve-audit.md#trigger-events)).

**Schedule pauses.** `swamp workflow schedule pause|resume|list`
(`workflow.schedule.*` over WebSocket) pause a workflow's cron fires without
editing its definition or `serve.yaml` (swamp-club#3522). A pause is a
`SchedulePause` record (`src/domain/workflows/schedule_pause.ts`) in the
control-plane store, at `schedule-pauses/<workflow id>`
(`ControlPlaneSchedulePauseRepository`), so every instance sharing the
datastore sees it, and it survives `workflow edit` (a rename keeps the id),
`serve reload` and restarts. It records the reason (at most 500 characters, no
control characters), who paused it, when, and an optional `until`: a duration
or an ISO-8601 time with `Z` or an offset (a zone-less time would be read in
whichever process parses it, the server's with `--server`), up to year 9999.

Before each fire, and before a replayed cron run starts, the service reads the
workflow's pause; while it is in force the fire is skipped with a
`schedule_skipped` event carrying `paused`, logged as
`Skipped scheduled workflow "<name>": paused ("<reason>")`. Manual and webhook
runs never read it. `until` is enforced at the fire: a lapsed pause is ignored
and replaced by the next pause or removed by resume, so no timer can be lost
across a restart. A record that does not parse, or cannot be read, counts as
an open-ended pause: `list` shows it and `resume` removes it. Each pause read
is bounded by a 5 s deadline (`SCHEDULE_PAUSE_READ_TIMEOUT_MS`), so a slow
control plane delays a fire by at most that.
When the store cannot be read, the pause last read for that workflow decides;
with none read yet (a cold boot during a datastore outage) the fire runs and a
warning names the workflow, since failing closed would stop every schedule.

Pause and resume authorize `write` on the resolved workflow and store under
its id, the identity authorized; they are audited as `admin` requests. `list`
shows each schedule a caller may `read`, with its pause state and next fire,
plus pauses whose workflow is gone or unscheduled (orphaned; resumed by id,
authorized on the bare id). A pulled extension workflow whose release changes
its id loses its pause, which `list` then shows as orphaned. Without
`--server`, the commands open the repository read-only (serve holds the
writer lease) and write the filesystem store serve uses for a filesystem
datastore, `.swamp/_control`, with no grant check, as local `trigger set`
writes `serve.yaml`; a custom datastore's pauses are set through serve.

Fires that are not skipped join one queue. Up to
`--max-concurrent-scheduled-runs` entries run at once (default 1: one at a
time, in fire order). The service starts the first queued entry whose workflow
is not already in flight, so different workflows run together and a workflow
never overlaps itself. A fired entry is keyed by workflow id and a replayed one
by name; both resolve to the same workflow. A fire that arrives while the same
workflow is still queued (not yet running) is queued too. Two workflows that
touch the same behavior still exclude each other through the per-behavior lock.

Each schedule in the health snapshot, `/health` and the dashboard reports its
queue state (`queueStatus`): `queued` (fires waiting to start),
`oldestQueuedAt` (the oldest waiting fire's time, so a growing wait is
visible) and `lastQueueDelayMs` (fire-to-start delay of the last run that
started). `schedule_started` carries the same delay as `queueDelayMs`. Queue
state is per schedule, so the per-token health view filters it with its
schedule. `scheduling.timeZone` names the IANA zone the scheduler evaluates
crons in; the per-token view includes it only for a reader who sees at least
one schedule.

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

Verified requests on every route join one queue (`WebhookService.processQueue`).
Up to `--max-concurrent-webhook-runs` entries run at once (default 1: one at a
time, in arrival order, so a delivery waits for every run queued ahead of it to
complete or suspend). Above 1, the service starts queued entries in arrival
order until the limit is reached, and each run that settles (succeeded, failed,
refused, suspended or cancelled) frees its slot for the next. Unlike the
scheduler there is no per-workflow exclusion: two deliveries to the same route
run together (swamp-club#3665), since holding back a run that is already
isolated from its sibling only adds delay. Shared state is still guarded where
it is mutated, by the per-step model lock, so two runs whose steps touch the
same behavior take turns at that step. A waiting step gives up after the lock
timeout (`SWAMP_LOCK_TIMEOUT_MS`, 60 s by default) and its run fails, so a
route whose step holds a behavior longer than that needs a higher timeout
before it is given a limit above 1. Raising the limit gives up arrival-order
execution; a workflow that relies on it (for example, publishing releases in
merge order) needs the default or its own ordering. Under the default, a
workflow that must start long work without holding the queue submits it with
`swamp workflow run --server --detach` and returns (swamp-club#1090).

Each launch starts detached from the request span and outside any vault
scope, whether it comes from a delivery, boot replay or a run that just
settled, so no run inherits another's trace or principal. Each webhook entry in
the health snapshot, `/health` and the dashboard reports its queue state
(`WebhookService.queueStatus`): `active` (runs of that route in flight,
including ones waiting on a model lock), `queued` (deliveries waiting for a
slot), `oldestQueuedAt` and `lastQueueDelayMs` (enqueue-to-start delay of the
last run that started). A growing `queued` means the limit is the bottleneck;
a high `active` with slow progress means the runs themselves are waiting. The
state is per route, so the per-token health view filters it with its webhook;
the unauthenticated `/health` exposes it as it does schedule queue state. The
admin serve config reports the limit as `maxConcurrentWebhookRuns`.

A verified request becomes a pending run before it executes, so a crash between
receipt and completion is replayed at next boot (`src/serve/webhook.ts`). Each
run acts as the built-in `service:webhook` principal, recorded as its
`initiatedBy`, and is authorized when it starts executing. The sender's
response does not change: a refused run was already acknowledged as queued, and
emits `webhook_denied`. Starts and pre-queue rejections are audited as
`workflow.webhook.fire` and `workflow.webhook.rejected`.
Secrets may be `@env=VAR`, `@file=/path` or `@vault=<vault>:<key>` references,
resolved at startup and again on hot-reload.

**Workers.** Steps whose behavior type cannot load locally, or every step under
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
| `waits/<waitId>`                            | The executor, when a `wait_for_signal` step starts waiting      | `workflow signal`, `workflow waits`; removed when the run ends            |
| `wait-outcomes/<waitId>`                    | `putIfAbsent` by whichever of a signal, a timeout or a cancel settles the wait first | The resume that applies it; removed with the run record |
| `wait-keys/<workflowId>/<key>/<generation>` | `putIfAbsent` by a `wait_for_signal` step that declares a `key`, before it registers its wait; a release by whoever removes the highest claim | The next step that claims the key; removed with the run record, or with the workflow |
| `wait-pending/<workflowId>/<key>/<slot>/<number>` | `putIfAbsent` by a signal by key that finds no open wait on a step with `acceptEarly`; a lapse by the sweep over one no wait took | The step that claims the slot, and whoever settles its wait; removed with the claim, or with the workflow |
| `token-secrets/*`                           | `ControlPlaneVaultProvider`; `encryption-key` is the co-located key, or a marker with `token-secrets` set | Token auth on every instance                                               |

**Boot.** Before accepting traffic an instance
(`src/serve/boot_reconciliation.ts`):

1. Pulls the remote datastore into its local cache (`hydrateLocalCache`,
   bounded by `--hydration-timeout`). A failed pull is logged and the instance
   starts on what its cache holds, except under `managedConfig`: there it is
   tried three times, each with the full timeout and resuming from the files
   already downloaded, and a third failure stops startup.
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

The run tracker is local and a run record is not pushed until the run ends, so
the claiming peer finds nothing to interrupt for a run that crashed mid-step,
and still deletes the heartbeat. Each pass, at boot and in steady state,
therefore also interrupts the local runs of an instance that has no heartbeat at
all (`goneInstanceIds`). Such an instance counts as gone when every `running`
tracker row it left is either owned on this host by a dead pid, or has not been
refreshed for longer than `--stale-ttl` (or 60 s, two refreshes of a tracker
row, if that is longer). A row is judged on its age when its pid cannot be
checked: it is owned on another host, or it carries this process's own pid. A
restarted container reuses its pid, but so does a live sibling container with
the same hostname, so the pid alone decides nothing; such a run is interrupted
once the wait has passed, not at boot. The wait also covers a live instance that
shares the tracker and has started listening but not yet written its first
heartbeat. Nothing is claimed or deleted for a gone instance. A pid that is not
this process's own is checked against this host's process table, so containers
that share a tracker volume should still have distinct hostnames.

For a dead instance's method-run rows, claimed or gone, the pass cancels the
method run's output record before it settles the row. A row whose output could
not be cancelled is marked `interrupted` but left unsettled.

When the datastore manages config, a `ConfigPoller` pulls `.swamp/config/` every
`--datastore-poll-interval` (default 30 s) and checks the extension lockfile. The `AccessDataPoller` pulls grants
and groups at the same interval, or on a v2 filesystem datastore checks the
shared grant and group directories for peers' changes.

**What does not replicate.** The `ActiveRunRegistry`, its event buffers, the
worker session pool, rate-limiter buckets and the policy snapshot are
per-process memory. Clients can attach to a run's events only on the executing
instance. The control plane records which instance owns a run, not its events.
Grants replicate as data, but each instance loads its snapshot on its own poll.
Instances may therefore see a grant change up to one poll interval apart (30 s
by default).

Extension registries are indexed at startup. With `--hot-reload`, an
extension pull, update, install or rm made through serve (`--server`) reloads
the instance that ran it once the change is on disk, and the response reports
the outcome (swamp-club#3594). Without `--hot-reload`, that instance keeps
running the old code until it restarts, and a dispatch of a changed type is
refused rather than shipping workers code serve does not run (see
[remote-execution](../enablers/remote-execution.md#shipping-extension-code)).
With `managedConfig` active, the
config poller runs even without a sync service. After each pull of `config/` it
hashes the config-tier lockfile and calls `performServeReload` when the hash
differs from the last one it acted on. The baseline is the hash at boot. So a
peer's `extension pull`, `update`, `rm` or pin reloads every instance within one
poll interval. So does a CLI extension write on the same host, or the
instance's own extension handler. Definition-only changes (e.g. a behavior YAML
edit) invalidate catalogs but do not reload extension registries. A reload that
overlaps another (`Reload already in progress`) is retried on the next poll. A
failed reload is retried up to three times per lockfile version.

Every reload first unregisters the types of pulled extensions that are no longer
installed (swamp-club#2742). Serve records which types each installed pulled
extension registered, at boot and after every reload, because on the instance
that ran `rm` the catalog rows and files are already gone. The boot record is
taken at the poller's lockfile baseline and again after the startup registry
load, which is when an extension-backed datastore repairs the catalog. A pulled
extension counts as installed when the config-tier lockfile or the transitional
in-repo lockfile lists it, or, on an extension-backed datastore, when it is a
datastore extension found on disk. This follows the startup reconcile's orphan
rule, except that the reconcile spares on-disk datastore sources by directory
and the sweep spares the whole extension. Only sources under the extension's own
directory in the pulled root are considered, so local and source-mounted
extensions are never swept, whatever their name. A missing lockfile skips the
sweep until the next poll, because it reads as no entries and removing the last
extension leaves an empty file. On a peer, the reload also retires the removed
extension's catalog rows, so the loader cannot register them again. The peer's
files stay in its pulled root until swamp-club#2612. A type that another
extension or a local source still provides stays registered. The record also
lists the behavior types each extension's add-ons extend, and the sweep detaches
the members those add-ons attached to built-in and local types, which the
reload never re-registers (swamp-club#2745). Only the removed extension's
members go; the base type and other add-ons stay, and a member name the removed
add-on had won is attached again from the add-on that ranks next. If one
extension
fails to unregister (for example, the pulled-extensions lock times out), the
next reload retries it. `sweepRemovedPulledExtensions` in
`src/serve/extension_reload.ts` implements this.

Built-in types are never touched by either step (swamp-club#2746). A pulled row
whose type has the name of a built-in behavior, vault, datastore or report type
is skipped when the reload re-registers pulled types, with a warning, so the
built-in and the add-ons attached to it stay in place. The sweep never
unregisters a built-in type, since built-ins have no catalog rows to show that
something still provides them. Control-plane types are built in, so a pulled
extension can never replace them either. The loader likewise never stamps a
pulled source's fingerprint onto a built-in behavior type, so provenance always
names the code that ran.

Installed add-ons go the other way. After re-registering pulled types, the
reload attaches every pulled add-on whose target behavior type is registered
(`attachPulledAddOns`). A built-in or local type the reload never re-registers
gains the add-on's members without a restart, even if serve had already used
that type (swamp-club#2846). Lazy targets attach their add-ons when they load,
control-plane types are never extended, and add-ons already attached are
skipped.

The reload re-bundles from the instance's own pulled root. Extension sources are
not pushed (each repo keeps them in its own pulled root until swamp-club#2612),
so a peer's new extension registers only after `extension install` on each
instance, followed by `swamp serve reload` or a restart (see Known limits).

**Rolling restart.** On SIGTERM an instance stops accepting triggers: `/ready`
returns 503 `shutting_down`, webhook deliveries get 503 with `Retry-After: 5`,
and the scheduler stops. Queued webhook and cron runs stay in the run tracker
for the next boot to replay. In-flight webhook (every in-flight
run, up to `--max-concurrent-webhook-runs`), cron (every in-flight
scheduled run, up to `--max-concurrent-scheduled-runs`) and API runs then drain
together against one `--shutdown-drain-timeout` deadline (default 30 s,
`runShutdownDrain` in `src/serve/shutdown_drain.ts`); whatever is left is
aborted and gets 5 s more. It marks aborted API workflow runs
`interrupted("server_shutdown")` in the run repository (aborted webhook and cron
runs end `cancelled`) and, on a remote datastore, pushes those records under the
shared sync gate (`interruptShutdownRuns` in `src/serve/shutdown_interrupt.ts`,
swamp-club#3252). One 5 s deadline bounds the gate wait and the push together;
a push that fails or misses it is logged as a warning, and the datastore keeps
the run's last pushed status. A step the abort stopped in flight is recorded
`unknown` on the interrupted run, so `swamp workflow recover` reopens it
(swamp-club#3369). It then deletes its heartbeat and exits. Set the pod's
`terminationGracePeriodSeconds` above the drain timeout plus about 10 s (the 5 s
abort grace and the 5 s interrupt push), and
use a `preStop` sleep so traffic leaves the Service endpoints before SIGTERM:
senders that do not retry on 503 lose deliveries that arrive while the
instance drains. Peers see no stale heartbeat, so nothing is reaped.
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
  overrides and `webhooks` from the config file serve was started with (the
  resolved `--config` path, carried as `ConnectionContext.serveConfigPath`, or
  `.swamp/serve.yaml`). Webhook route changes (added, removed or modified
  bindings) apply on the next request; in-flight runs finish against the
  endpoint they matched. Webhook reload is skipped if `--webhook`
  CLI flags were used at startup, since flags are process arguments, not
  hot-reloadable config.

  `workflow.trigger.set` and `workflow.trigger.remove` over WebSocket apply
  trigger overrides directly: the handlers call `updateTriggerOverrides` on the
  `ScheduledExecutionService` after writing, so no full reload or `--hot-reload`
  flag is needed (`src/serve/handlers/workflow_handlers.ts`). They read and
  write the same config file as the reload; writing rewrites it (YAML comments
  are lost, permission bits are kept), through the real path of a symlinked
  `--config` file. When the file cannot be written, such as a read-only
  ConfigMap mount, they refuse and leave the scheduler unchanged; the client
  message names no server path (the log does) and points at `swamp serve
  reload` or, without `--hot-reload`, a restart. `workflow.trigger.get` reports
  the override the scheduler holds (`getTriggerOverride`), or the file's entry
  when serve runs without `--schedule`.

  Pulled extensions live under `.swamp/pulled-extensions/`, or
  `.swamp/config/pulled-extensions/` when the datastore manages config
  (`src/infrastructure/persistence/paths.ts`).
  [remote-execution §Hot-Reload](../enablers/remote-execution.md#hot-reload-for-pulled-extension-bundles)
  covers the mechanism and its catalog constraint. Edited repo-local models
  need no reload: serve checks them before every run
  ([remote-execution §Refresh of Edited Local Models](../enablers/remote-execution.md#refresh-of-edited-local-models)).

  Use `--hot-reload` for `managedConfig` deployments where pods must recover
  from datastore-only state without `kubectl exec`. Without it, `swamp serve
  reload --server` fails and new extensions need a full pod restart. The
  `ConfigPoller` refreshes definitions (behaviors, workflows, vaults) every
  `--datastore-poll-interval` (default 30 s) and reloads extension type
  registries when the config-tier lockfile changes. Sources a peer added still
  need `extension install` on each pod while they stay in each repo
  (swamp-club#2612; see [High availability](#high-availability)). SIGHUP (`swamp
  serve reload`) remains available for manual reloads. See [datastores §Managed
  Config](../enablers/datastores.md#managed-config-deployment-architecture) for
  the full deployment guide.
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
  `service_scheduler_factory.ts`). Before writing the unit, enable resolves
  the options as the daemon will see them (the flags written into the unit,
  `serve.yaml` with a relative `--config` resolved against the repository,
  and the unit's environment only, never the enabling shell's) and runs
  serve's argument checks on them (`validateServeDaemonArgs`,
  `resolveServeStartupSettings`). Arguments serve would reject at startup are
  refused with the same error instead of producing a unit that restarts every
  10s. Checks that need I/O or runtime state (grants files, certificate
  contents, webhook secrets, datastore-dependent limits) still run only when
  the daemon starts. Linux without `systemctl` is refused with a
  pointer to file a feature request. Worker daemons have parallel schedulers.

  **User vs system scope:** system services (`multi-user.target`) start at
  boot. User services (`default.target`, launchd agents) run only while the
  user is logged in. To start a user service at boot, enable systemd lingering
  (`loginctl enable-linger $USER`) or install system-wide.
- **Dashboard.** The same bundle also runs with no serve, on local repos: see
  [local dashboard](../surfaces/local-dashboard.md). Serve never sends its
  `local` flag, so everything below is unchanged by it.
  `--dashboard` serves the Vite SPA in `packages/dashboard`
  (overview, behaviors, workflows, executions, approvals, data, vaults,
  extensions, schedules, webhooks, workers and system views) from
  `packages/dashboard/dist`. `scripts/compile.ts` embeds it only if pre-built
  before compile. The SPA uses the same WebSocket protocol and logs in through
  `/auth/info` plus the browser session routes. In token and OAuth modes,
  manual-token exchange or browser device-flow completion creates a
  server-managed, opaque session and sets its host-only `HttpOnly`,
  `SameSite=Strict` cookie. Page JavaScript never reads or stores a server
  token, and the cookie never contains one. The session is bound to the exact
  origin that created it, including port, before it can authenticate the
  dashboard status check or a WebSocket; this prevents a page on another
  same-site port from using an ambient authenticated session. Cookie-backed
  status and health fetches send a same-origin-only `X-Swamp-Dashboard-Origin`
  header because browsers need not attach `Origin` to same-origin GETs; a
  cross-origin page cannot set it without a CORS preflight, which serve does not
  authorize. The cookie has no `Domain` attribute, so it is shared by tabs on
  the same host but not subdomains.

  A dashboard opened in another tab, including a deep link, restores the cookie
  session before rendering Login. Existing `sessionStorage` credentials are
  intentionally ignored, so deployment requires one fresh dashboard login;
  already-loaded tabs remain active until their next reload or session end.
  Sessions are control-plane records shared by every serve replica in a
  namespace, so a load balancer may route a tab's requests to different
  instances. A record contains the origin plus the server-token name and mint
  timestamp, never its bearer secret; it expires after eight hours, is deleted
  on logout or a permanently failed token check, and the control plane admits
  at most 10,000 active records through fixed shared slots. A token may retain
  at most 100 sessions; creating another evicts its oldest session rather than
  consuming the shared capacity. Logout clears the server record and broadcasts a
  credential-free signal that closes live dashboard sockets in cooperating tabs.
  Successful reauthentication broadcasts the same kind of state change, so
  other tabs reconnect using the replacement cookie rather than retaining an
  older live socket. Local HTTP development omits `Secure` only because browsers
   reject `Secure` cookies over HTTP. Behind a trusted TLS-terminating proxy,
   serve uses `X-Forwarded-Proto` and `X-Forwarded-Host` to enforce the public
   origin and set `Secure`. A proxy that does not preserve those headers must
   configure its full public HTTPS authority with `--trusted-hosts`; serve then
   recognizes that exact configured browser origin and sets `Secure`.
   Direct TLS deployments do the same from their listener configuration.

  After an unexpected close it reconnects with jittered exponential backoff
  (0.5 s up to 30 s), and retries `/auth/info` the same way while serve is
  unreachable. It returns to login on close `4003`, when a failed reconnect's
  token probe of `/api/v1/health` answers 401 (a browser hides the upgrade's
  own status), or when serve comes back in a different auth mode. Views
  refetch once reconnected (`packages/dashboard/src/client/connection.ts`).
  Navigation state is in the URL path (`/dashboard/behaviors/<name>`,
  `/dashboard/workflows/<name>/runs/<runId>`, etc.), so views are linkable. The
  server falls back to `index.html` for any `/dashboard/` sub-path to support
  client-side routing. Links from before the behavior rename keep working:
  `/dashboard/models/...` (and the `/dashboard/behaviours/...` spelling)
  resolves to the same page, and the dashboard rewrites the address to its
  `/dashboard/behaviors/...` form in place, keeping the query and hash. The
  dashboard only ever builds `/dashboard/behaviors/...` links.
- **Workers view.** `/dashboard/workers` draws the remote-execution workers as a
  live host map (`packages/dashboard/src/views/Workers.tsx`,
  `components/HostMap.tsx`). Workers are grouped by the `fleet` label (the
  enrollment token name), any other label key, or platform/arch, in a treemap
  weighted by slot capacity. Each worker is a square sized by its `capacity`,
  with one cell per dispatch slot showing that slot's step-lease state. The
  header and each group card lead with the connected count (every status but
  disconnected), kept apart from slot use, so disconnected records never count
  as workers that are down. A disconnected record — a replaced or stopped worker
  — is drawn hollow, with a muted outline, starting half faded, and it fades
  further until its visibility TTL ends. The view reads two admin-only requests:
  `worker.list` with `disconnectedWithinMs` (disconnected workers stay visible
  for the viewer's visibility TTL, at most the worker GC's default 24 h grace
  period), and `worker.lease.list` (the step leases behind the listed
  `activeDispatchIds` plus leases written in the last few seconds, read by lease
  name and version time without loading other leases' attributes). Both are
  audited reads, so the view refetches only when the health stream shows a
  worker change on this instance, plus a 60 s fallback while the tab is visible.
  A hidden tab reads nothing and the map draws nothing: browsers pause animation
  frames there, so transitions scheduled while hidden would pile up unstarted.
  On coming back into view the view refetches once and the map snaps to the
  current layout without animating what changed. A placement selector dims
  workers a step's `labels:`/`platform:`/`target:` would not reach, using the
  scheduler's own eligibility rules
  (`integration/host_map_placement_parity_test.ts` pins the two together).

  Individual data items and reports have shareable deep links:
  - `/dashboard/behaviors/<behavior>/data/<dataName>`: the latest version.
  - `/dashboard/behaviors/<behavior>/data/<dataName>/versions/<n>`: the
    permalink for one version. A step's output, including its method-scope
    reports, links here through the owning behavior (`tags.modelName`), since
    several steps in one run can write the same name.
  - `/dashboard/behaviors/<behavior>/reports/<reportName>[/variants/<variant>]`:
    the latest report, found under the data name the report is persisted as
    (`report-<sanitised name>[-<variant>]`) and checked against its tags.
  - `/dashboard/workflows/<wf>/runs/<runId>/reports/<reportName>`: a run's
    workflow-scope report, fetched at the exact artifact versions the run
    recorded. The page shows "no longer available" rather than a later run's
    content.

  Each path segment is percent-encoded with `@` left readable, so `/` in
  scoped names is `%2F` (`/reports/@swamp%2Fworkflow-summary`). Names
  containing `..` cannot be deep-linked because the static handler rejects
  them. A malformed escape lands on the nearest valid parent route. The item
  page offers "Copy link" and, for a latest view, "Copy permalink" pinned to
  the version on screen. `index.html` carries only static Open Graph
  metadata, so link unfurls never disclose data or report names.

  `data.get`, `data.versions`, `data.list` and `workflow.history.get` errors
  keep their top-level codes (`data_get_failed` etc.) and add
  `details: { reason, entityType }`. `reason` is one of `not_found`,
  `validation_failed` or `data_pending`; `entityType` is the fixed label from
  libswamp's `notFound()` (`Model`, `Workflow`, `Workflow run`, `Data`, …).
  Identifiers are never included. The dashboard uses these to tell an expired
  version from a missing behavior; access denials stay top-level `unauthorized`.

  On desktop the sidebar collapses to an icon-only rail
  (remembered in `localStorage`); at 768px and below it becomes an off-canvas
  drawer opened from a top-bar menu button.

  The dashboard is a complete approval surface. Approve and reject address the
  gate's run by `runId`. The sidebar, overview and Approvals page share one
  approvals listing per connected dashboard. Concurrent reloads join the read
  in flight; a completed decision, cancellation or resume starts a fresh read
  and retires older replies. Disconnecting or replacing the socket clears the
  listing, including when reauthentication changes the principal. A page
  entered later shows only a listing read after it opened. Expiration appears
  when the next server listing reports it, updating the badge and any page
  that has loaded together (`packages/dashboard/src/client/useApprovals.ts`).
  An approved but still suspended run (`awaitingResume` on
  `workflow.run.search`) shows a Resume action and the equivalent
  `swamp workflow resume` command. Resume sends `workflow.resume`, then a
  `cancel` carrying the request id, which detaches the dashboard from the
  serve-driven run without cancelling it
  (`packages/dashboard/src/client/stream.ts`). A run suspended on a nested
  workflow run has no gate of its own: its detail page names the nested run it
  waits on, and Resume appears once that run finished (`awaitingResume` is
  derived from the nested runs). A nested run's approval row names its
  parent. Fields that link a run to another run (`parentRun`, `nestedWaits`,
  a step's `nestedRun`, and the cancelled, stop-requested and detached nested
  runs on cancel and reject results)
  are returned only when the caller may read the other run's workflow
  (`src/serve/handlers/nested_run_redaction.ts`). The same holds for run and
  resume streams, redacted per attached client, for the error of a step
  whose nested run is hidden, and for the refusals to approve, reject or
  resume a run waiting on a nested run, or a nested run whose parent ended,
  which then name no other run. A nested
  run's own events, forwarded into its parent's stream while the parent runs
  it, are not redacted; they name the nested run, and its
  `approval_requested` event names its workflow.
- **Club heartbeat.** In OAuth mode serve registers with swamp-club at startup
  and sends a heartbeat hourly (`src/serve/club_heartbeat_service.ts`,
  `src/serve/oauth_client.ts`). This needs a resolved OAuth client id, a
  non-empty `--allowed-collectives` and a collective API key
  (`--club-api-key-file`, `SWAMP_API_KEY_FILE` or `SWAMP_API_KEY`); otherwise
  registration is silently skipped.

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
- The config poller reloads extension type registries when the config-tier
  lockfile changes, but only from the instance's own pulled root: sources stay
  in each repo (swamp-club#2612). Extension types a peer added need
  `extension install` on each instance, then `swamp serve reload` or a restart
  (`src/cli/commands/serve.ts`, `ConfigPoller` wiring). After a successful
  `--server` operation, state-modifying extension commands (`pull`, `install`,
  `rm`, `update`) warn that `swamp serve reload` is needed
  (`src/cli/remote_run.ts`, `warnServerReloadNeeded`). The client cannot tell
  whether the instance manages config. When it does, the instance's config
  poller already reloads within one poll interval of the handler's lockfile
  write, so the manual reload only makes the change take effect sooner.
- Built-in webhook verification schemes are a closed set; other providers need
  a webhook extension (`src/serve/webhook_verifiers.ts`, #2204). Extension
  handlers are resolved per request, but the endpoint list is fixed at startup.
- Auth mode `none` is deprecated and only permitted on loopback.
- **Audit**: when configured, serve emits audit events for authorization
  denials and high-value operations, including successful server-token ingress
  (without the credential secret). → [serve-audit](../enablers/serve-audit.md).
  This is separate from the CLI audit subsystem (`src/domain/audit/`), which
  tracks local command history.
