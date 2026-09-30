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
| `--grants-file`, `--grants-dir`, `--grant-reload` | `SWAMP_GRANTS_FILE`, `_DIR` | unset, unset, `manual` | `auto` starts a `GrantsDirectoryPoller` (30 s); a source startup would refuse (invalid, unreadable or missing) keeps its stored grants |
| `--no-schedule` / `schedule` | — | `true` | Disables cron triggers |
| `--webhook <route:workflow:secret[:scheme[:header[:prefix]]]>` / `webhooks[]` | — | none | Flags replace the file list entirely |
| `triggers.<workflow>.{schedule,inputs}` | — | none | yaml only; overrides a workflow's own trigger |
| `--trust-proxy`, `--trusted-hosts` | `SWAMP_TRUSTED_HOSTS` | `false`, unset | `X-Forwarded-For` and WebSocket `Origin` handling |
| `--ws-idle-timeout`, `--queue-timeout` | `SWAMP_WS_IDLE_TIMEOUT`, `SWAMP_QUEUE_TIMEOUT` | unset | Worker-facing |
| `--verify-on-enroll` | `SWAMP_VERIFY_ON_ENROLL` | `false` | Fleet probe on each enrolling worker; failures marked unverified |
| `--heartbeat-interval`, `--stale-ttl`, `--reconciliation-interval` | `SWAMP_HEARTBEAT_INTERVAL`, `SWAMP_STALE_TTL`, `SWAMP_RECONCILIATION_INTERVAL` | 30 s, 90 s, 60 s | `stale-ttl` must be ≥ 2× heartbeat; no effect without a remote control plane |
| `--hydration-timeout` | `SWAMP_HYDRATION_TIMEOUT` | 60 s | Startup pull of the remote datastore |
| `--shutdown-drain-timeout` | `SWAMP_SHUTDOWN_DRAIN_TIMEOUT` | 30 s | How long shutdown waits for in-flight runs; `0` aborts at once; in serve.yaml quote the value (`"0"`) |
| `--datastore-poll-interval` | `SWAMP_DATASTORE_POLL_INTERVAL` | 30 s | Config, access and runtime pollers; min 1 s; no effect without a remote datastore or managedConfig |
| `--token-gc-interval`, `--token-gc-grace-period` | `SWAMP_TOKEN_GC_INTERVAL`, `SWAMP_TOKEN_GC_GRACE_PERIOD` | 1 h, 1 h | Server token GC (see Tokens below); interval `0` disables, grace `0` collects at expiry; whole seconds or larger; in serve.yaml quote the value (`"0"`) |
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
  `--hydration-timeout`, `--shutdown-drain-timeout`,
  `--datastore-poll-interval`, `--max-run-duration`)
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
| HTTP GET | `/api/v1/health` | any valid token (`authenticateToken`, `src/serve/admin_auth.ts`) | Health snapshot (`src/serve/health_collector.ts`). Admins get it whole; other tokens get it narrowed by `healthSnapshotFor` (`src/serve/health_snapshot_view.ts`) to the runs, schedules and webhooks of workflows and models they may `read`, decided on each resource's resolved name, tags and model type (entries that do not resolve are hidden), without run principals, workers or component detail |
| SSE | `/api/v1/health/stream?interval=` | any valid token; at most 10 open streams per token, else 429 | The same narrowed snapshot every 1–60 s (default 5 s), resumable via `Last-Event-ID` (`src/serve/health_stream.ts`). The stream is a token session: when its token is revoked, rotated or expires, or its principal loses access, it ends with a `session-ended` event carrying the close code and reason. A change to the principal's collectives or groups ends it with 4004 so the client reconnects under the new access |
| HTTP GET | `/api/v1/cluster/instances`, `/api/v1/serve/config` | admin (`authenticateAdmin`, `src/serve/admin_auth.ts`) | Heartbeat roster, redacted merged options |
| HTTP GET | `/internal/runs?limit=&offset=` | admin; 404 unless `--enable-internal-api` | Full run-tracker history |
| HTTP POST | `/auth/device`, `/auth/device/token` | none (IP burst limit) | OAuth device grant, mode `oauth` only (`src/serve/device_auth_handler.ts`) |
| HTTP GET | `/auth/info` | none | `{ mode, verificationBaseUri? }` so clients pick a login flow |
| HTTP GET | `/ready`, `/` and `/health` | none | `/ready` is 503 until startup completes and again (`shutting_down`) once shutdown begins; `/health` lists schedules and webhook endpoints |
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
applies the same gate, keyed on the auth mode the daemon will resolve
(including one set in `serve.yaml`). OAuth mode also reads `SWAMP_API_KEY` to register the
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
no longer decrypt, and `sweepTokenConsistency` reports token records missing
their secret and secrets or data with no definition. Neither deletes anything
(`src/serve/boot_reconciliation.ts`). The CLI token commands (`access token
mint`, `rotate` and `reveal`, and `worker token create`) register the same vault
through `initializeControlPlaneVault`
(`src/domain/vaults/control_plane_vault_init.ts`). Like serve, they stop with
the initialization error if it fails; they never fall back to a user vault.

Serve garbage-collects server tokens in every auth mode
(`ServerTokenGcService`, `src/serve/server_token_gc_service.ts`, wired by
`src/serve/server_token_gc_deps.ts`). The first sweep runs just after boot,
once token secret migration is done, then one runs every `--token-gc-interval`.
A sweep deletes revoked tokens at once, and expired tokens once
`--token-gc-grace-period` has passed since `expiresAt`, so both drop out of
`access token list`.

Each token is collected as one unit holding the sync gate exclusively. Inside
the unit the GC re-reads the token's `token-main` and skips the token if it is
gone or no longer eligible. Then:

1. It deletes the secret. A failure keeps the token for the next sweep, so a
   stale copy of the records, such as an HA peer's local cache, can never
   authenticate.
2. It deletes the OAuth access token, best effort.
3. It deletes the definition, data and outputs through `modelDelete`, and
   pushes the deletes. The workflow reference check is skipped, since it
   matches by name and a server-token definition is never a step's model.

The secret key is always `server-token-<name>`, never the key the persisted
record names, so a tampered record cannot make serve delete an unrelated
secret.

That key is shared by every definition that has carried the name. So when a
record outlives its definition, and the name now belongs to another definition
or to none, the GC deletes only that record's data and leaves the secret.

Every replica sweeps on its own, and a token another replica already deleted
is skipped.

The re-read protects against token writes only where the gate covers them.
Serve's own token mint, rotate and revoke, and the OAuth login mint, hold the
gate while they write. So with a remote datastore, a write in the same process
lands either before the re-read or after the unit. The gap is in two places:

- **No remote datastore.** Serve creates no gate at all, so a rotation or
  re-mint can land between the re-read and the deletes (swamp-club#2534).
- **Across replicas.** The gate is in-process only. A replica whose copy of a
  record is older than another replica's re-mint or rotation of the same name
  can still collect the new token.

Both fail closed: the token has to be minted again.

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
  `cancellation_requested` (`src/cli/commands/serve.ts`). A run it cannot find
  gets 404 `No cancellable <type> with id <id>`. The single-run route takes an
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
receipt and completion is replayed at next boot (`src/serve/webhook.ts`). Each
run acts as the built-in `service:webhook` principal, recorded as its
`initiatedBy`, and is authorized when it starts executing. The sender's
response does not change: a refused run was already acknowledged as queued, and
emits `webhook_denied`. Starts and pre-queue rejections are audited as
`workflow.webhook.fire` and `workflow.webhook.rejected`.
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
| `token-secrets/*`                           | `ControlPlaneVaultProvider`; `encryption-key` is the co-located key, or a marker with `token-secrets` set | Token auth on every instance                                               |

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
`--datastore-poll-interval` (default 30 s) and checks the extension lockfile. The `AccessDataPoller` pulls grants
and groups at the same interval.

**What does not replicate.** The `ActiveRunRegistry`, its event buffers, the
worker session pool, rate-limiter buckets and the policy snapshot are
per-process memory. Clients can attach to a run's events only on the executing
instance. The control plane records which instance owns a run, not its events.
Grants replicate as data, but each instance loads its snapshot on its own poll.
Instances may therefore see a grant change up to one poll interval apart (30 s
by default).

Extension registries are indexed at startup. With `managedConfig` active, the
config poller runs even without a sync service. After each pull of `config/` it
hashes the config-tier lockfile and calls `performServeReload` when the hash
differs from the last one it acted on. The baseline is the hash at boot. So a
peer's `extension pull`, `update`, `rm` or pin reloads every instance within one
poll interval. So does a CLI extension write on the same host, or the
instance's own extension handler. Definition-only changes (e.g. a model YAML
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
extension or a local source still provides stays registered. If one extension
fails to unregister (for example, the pulled-extensions lock times out), the
next reload retries it. `sweepRemovedPulledExtensions` in
`src/serve/extension_reload.ts` implements this.

The reload re-bundles from the instance's own pulled root. Extension sources are
not pushed (each repo keeps them in its own pulled root until swamp-club#2612),
so a peer's new extension registers only after `extension install` on each
instance, followed by `swamp serve reload` or a restart (see Known limits).

**Rolling restart.** On SIGTERM an instance stops accepting triggers: `/ready`
returns 503 `shutting_down`, webhook deliveries get 503 with `Retry-After: 5`,
and the scheduler stops. Queued webhook and cron runs stay in the run tracker
for the next boot to replay. In-flight webhook, cron and API runs then drain
together against one `--shutdown-drain-timeout` deadline (default 30 s,
`runShutdownDrain` in `src/serve/shutdown_drain.ts`); whatever is left is
aborted and gets 5 s more. It marks aborted API workflow runs
`interrupted("server_shutdown")` in the run repository (aborted webhook and cron
runs end `cancelled`), deletes its heartbeat and exits. Set the pod's
`terminationGracePeriodSeconds` above the drain timeout plus about 10 s, and
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
  every `--datastore-poll-interval` (default 30 s) and reloads extension type
  registries when the config-tier lockfile changes. Sources a peer added still
  need `extension install` on each pod while they stay in each repo
  (swamp-club#2612; see [High availability](#high-availability)). SIGHUP (`swamp serve reload`) remains
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
- **Dashboard.** `--dashboard` serves the Vite SPA in `packages/dashboard`
  (overview, models, workflows, executions, approvals, data, vaults, extensions,
  schedules, webhooks and system views) from `packages/dashboard/dist`.
  `scripts/compile.ts` embeds it only if pre-built before compile. The SPA uses
  the same WebSocket protocol and logs in through `/auth/info` + device auth.
  After an unexpected close it reconnects with jittered exponential backoff
  (0.5 s up to 30 s), and retries `/auth/info` the same way while serve is
  unreachable. It returns to login on close `4003`, when a failed reconnect's
  token probe of `/api/v1/health` answers 401 (a browser hides the upgrade's
  own status), or when serve comes back in a different auth mode. Views
  refetch once reconnected (`packages/dashboard/src/client/connection.ts`).
  Navigation state is in the URL path (`/dashboard/models/<name>`,
  `/dashboard/workflows/<name>/runs/<runId>`, etc.), so views are linkable. The
  server falls back to `index.html` for any `/dashboard/` sub-path to support
  client-side routing.

  Individual data items and reports have shareable deep links:
  - `/dashboard/models/<model>/data/<dataName>`: the latest version.
  - `/dashboard/models/<model>/data/<dataName>/versions/<n>`: the permalink
    for one version. A step's output, including its method-scope reports,
    links here through the owning model (`tags.modelName`), since several
    steps in one run can write the same name.
  - `/dashboard/models/<model>/reports/<reportName>[/variants/<variant>]`: the
    latest report, found under the data name the report is persisted as
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
  version from a missing model; access denials stay top-level `unauthorized`.

  On desktop the sidebar collapses to an icon-only rail
  (remembered in `localStorage`); at 768px and below it becomes an off-canvas
  drawer opened from a top-bar menu button.

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
- The config poller reloads extension type registries when the config-tier
  lockfile changes, but only from the instance's own pulled root: sources stay
  in each repo (swamp-club#2612). A removed extension's types are unregistered,
  but methods it added to a built-in or local model type stay attached until a
  restart (swamp-club#2745). Extension types a peer added need
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
