---
audience: maintainer, operator
enables: [serve]
last-verified: 2026-08-28 @ 3d5955a9
---

# Remote Execution

Remote execution lets one **orchestrator** spread a workflow or method run
across many **workers**. A worker is a disposable swamp process: a binary, a
token and a URL, with no repository, datastore, vault or extension state of its
own. It connects to the orchestrator, enrolls, and runs what it is sent.
Extension code ships with each dispatch. Every side-effecting call a method
makes (reading or writing data, resolving a secret, loading a definition) is
proxied back to the orchestrator, which owns all stored state.

Remote execution **replaces** execution drivers (removed; see
[No execution drivers](#no-execution-drivers)). There is no `raw` / `docker`
selection and no driver abstraction. Every method runs in-process in whichever
executor holds it. Isolation and environment are a deployment property of the
worker, not a per-step field.

## Why this shape

Three properties drove the design:

- **Workers connect to the orchestrator, never the reverse.** Workers run in
  CI, short-lived cloud instances, containers and behind NAT, where only
  outbound connections work. So they pass firewalls with no service discovery
  or inbound ports, and provisioning is one command
  (`swamp worker connect <url> --token <token>`). The control socket is the
  liveness signal: connected means enrolled, disconnected means deregistered.

- **The orchestrator holds all state; the worker is pure compute.** Datastore
  reads and writes, vault secrets, definition loads, catalog lookups and all
  extension code come from the orchestrator. A worker has no credentials,
  repository, datastore config or pre-installed extensions, and can touch
  nothing it was not handed. So the orchestrator
  is the single point for authorization and audit, and having one durable
  authority gives read-your-own-writes and cross-worker data visibility.

- **The injection seam already exists.** libswamp operations are pure functions
  over injected `*Deps` structs, and a method gets its world through
  `MethodContext` (`src/domain/models/model.ts`). Remote execution swaps the
  leaves of that tree (repositories, vault service, data writers) for proxy
  adapters that call the orchestrator over RPC. Method code and libswamp code
  do not change. A remote adapter is one more implementation of the same port.

## Ubiquitous language

| Term                     | Meaning                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator**         | The control-plane websocket server and data-plane HTTP/2 endpoint. Owns DAG and run state, the datastore, vaults, the catalog, definitions, extension bundles, locks, the scheduler, token issuance and audit.                                   |
| **Worker**               | A disposable swamp process that connects to the orchestrator, enrolls, and runs dispatched steps with a remote `MethodContext`.                                                                                                                 |
| **Executor**             | Where a dispatch runs: the **local loopback** (in-process on the orchestrator, no socket) or a **remote worker**. Methods run in-process either way.                                                                                            |
| **Enrollment**           | The first-connect handshake: redeem the token, bind it to the worker instance UUID, exchange version and labels, issue a session credential, admit the worker to the pool.                                                                      |
| **Enrollment token**     | A named, time-boxed credential that enrolls one or more workers (`maxEnrollments`), then re-authenticates each bound instance for its lifetime. A built-in model.                                                                              |
| **Session credential**   | Short-lived credential issued at enrollment. Authenticates the worker's HTTP/2 data-plane requests.                                                                                                                                             |
| **Dispatch**             | The orchestrator → worker request to run one `ExecutionRequest`. The unit of fan-out.                                                                                                                                                           |
| **Capability**           | A side-effecting function a method reaches through its context, proxied to the orchestrator. A fixed, closed set.                                                                                                                              |
| **Step lease**           | The orchestrator's record that a step is in flight on a worker. A built-in model.                                                                                                                                                               |
| **Environment snapshot** | The orchestrator's full process environment, shipped with each dispatch and kept in worker memory only while the step runs.                                                                                                                    |
| **Spool file**           | The worker-local file behind `getFilePath()` on a remote executor. Uploaded to the orchestrator as one streamed `POST` on `finalize()`.                                                                                                         |
| **Fleet probe**          | Built-in model (`swamp/fleet-probe`). Its one `verify` method tests every seam between worker and orchestrator: dispatch metadata (`probeMarker`), capability RPC (`queryData`), and the HTTP data plane (`writeResource`/`readResource`). Used by `swamp worker verify` and `--verify-on-enroll`. |
| **Probe marker**         | A dispatch-level string (`probeMarker` on `DispatchParams`) merged into the method's args. Confirms dispatch metadata arrives intact. Sent in `DispatchParams`, not the environment snapshot, which denylists `SWAMP_*` variables.              |
| **Verify-on-enroll**     | Opt-in orchestrator flag (`--verify-on-enroll`). Sends the fleet probe to each enrolling worker before it can be scheduled. Workers that fail get `unverified` status and are not scheduled.                                                    |
| **Unverified**           | Worker status after the enrollment probe fails. Shown in `swamp worker list`; excluded from label/platform scheduling.                                                                                                                         |

For an unverified worker, the failure reason is only in the `--json` record
(`src/presentation/output/worker_output.ts`). A step that pins a `target:` by
name bypasses the scheduling filter (`eligibleWorkers` in
`src/domain/remote/scheduler.ts`).

The worker pool, token lifecycle and step leases are **stored as swamp data**
by built-in models, written the way any method writes output (see
[Worker state is swamp data](#worker-state-is-swamp-data)). "Executor" means
where a dispatch runs. It is not the in-process services
(`DefaultMethodExecutionService`, `WorkflowExecutionService`) that run inside
an executor. The domain roles are still **orchestrator** and **worker**.

## Topology

A worker opens both connections outbound. On the two-way control socket, the
orchestrator sends work down and the worker proxies metadata calls up. Bulk
bytes use a separate HTTP/2 data plane, also opened by the worker.

```
        ┌──────────────────────────────────────────────┐
        │                ORCHESTRATOR                    │
        │  control: websocket server                     │
        │  data:    HTTP/2 endpoint                      │
        │                                                │
        │  DAG + run state · datastore · vaults ·        │
        │  catalog · definitions · extension bundles ·   │
        │  locks · scheduler · tokens · audit            │
        └───▲───────────────▲───────────────▲────────────┘
            │ ws (control)   │               │
            │ + h2 (data),   │               │
            │ both worker-   │               │
            │ initiated      │               │
       ┌────┴────┐      ┌────┴────┐     ┌────┴────┐
       │ WORKER  │      │ WORKER  │     │ WORKER  │
       │ compute │      │ compute │     │ compute │
       │ no state│      │ no state │    │ no state│
       └─────────┘      └─────────┘     └─────────┘
```

To provision a worker, mint a token and run one command (from cloud-init, a
k8s Job, or an ssh one-liner):

```bash
swamp worker token create ci-runner-3 --duration 1h    # on/near the orchestrator
swamp worker connect wss://orchestrator.internal:4000 --token <token>   # on the worker
```

With `--auth-mode token`, the worker also needs a server access token for the
WebSocket upgrade, passed with `--server-token` (or the `SWAMP_SERVER_TOKEN`
env var). The server token authenticates the transport connection; the
enrollment token authenticates the worker inside the RPC handshake:

```bash
swamp worker connect wss://orch:9090 \
  --server-token admin.secret \
  --token worker-pool.enrollment-secret \
  --label tier=ci
```

The CLI sends the server token in the `Authorization: Bearer` header of the
upgrade request, not as a URL query parameter, which reverse proxies and load
balancers would log.

### A symmetric control protocol, two handler registries

`src/serve/` has two roles on one listener. It is the websocket server for
client requests such as `model.method.run` / `workflow.run`
(`src/serve/connection.ts`, `src/serve/protocol.ts`). It is also the
orchestrator that decides where each step runs. Remote execution keeps these
apart:

- The **orchestrator** is the server but dispatches work.
- The **worker** is the client but executes work.

`src/serve/protocol.ts` is the client protocol (below).
`src/domain/remote/protocol.ts` is the worker control protocol: a generic
`rpc.request` / `rpc.response` / `rpc.error` / `rpc.stream` / `rpc.cancel`
frame set carried by `RpcChannel` (`src/domain/remote/rpc_channel.ts`), with a
**handler registry on each side**:

| Direction             | Methods the receiver handles                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| orchestrator → worker | `WorkerMethod.dispatch` (`worker.dispatch`); cancellation is the `rpc.cancel` frame                                                         |
| worker → orchestrator | `RemoteMethod`: `worker.enroll`, `worker.session.refresh`, `worker.drain`, and the nine `capability.*` verbs; run events ride `rpc.stream` |

Both sides share the framing, error envelope and `serializeEvent()`. Bulk bytes
do not use this socket; they go over the HTTP/2 data plane (see
[Data plane](#data-plane-two-transports)). Worker verbs are separate message
types that require enrollment, so an ordinary client and an enrolling worker
share one listener without ambiguity.

The client protocol has two interaction patterns:

- **Streaming operations** (`workflow.run`, `model.method.run`,
  `workflow.resume`, and `run.attach`, which replays and follows a live run's
  buffer) send an event stream, then a final `done` frame, so clients can tell
  "run ended" from "stream stalled".
- **Request-response operations** (everything else) send one response frame
  with a `payload` field, matching the request's `type`.

The `ServerRequest` union in `src/serve/protocol.ts` is the full list of client
request types (107 members at last verification). The table shows only the
families and the verb each handler asks `authorizeOrReject` for:

| Family (`type` prefix)                                                       | Typical auth verb                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `data.*`                                                                     | `read` for lookups; `write` for `delete` / `rename`                                                                     |
| `model.*` (incl. `model.output.*`, `model.method.history.*`)                 | `read`; `write` for create/delete; `run` for `model.method.run`; conditional `admin` on some handlers                   |
| `workflow.*` (incl. history, approvals)                                      | `read` for lookups and `workflow.approvals`; `run` for run/resume/approve/reject                                        |
| `vault.*`                                                                    | `read` / `write`; conditional `admin` on some handlers                                                                  |
| `access.*`                                                                   | `read` for `grant.list` / `group.list`; `access.can-i` needs an authenticated principal but no verb; the rest `admin` |
| `audit.*`, `summarise`, `report.*`                                           | `read`                                                                                                                  |
| `extension.*`, `doctor.*`, `worker.*`, `datastore.*`, `cluster.*`, `serve.*` | `read` for listings (`cluster.instances`, `serve.config`); `admin` for mutations and `serve.reload`                     |
| `run.*` (`history`, `doctor`, `gc`, `attach`)                                | `admin` for history/doctor; `write` for `run.gc`; `run` on the attached resource for `run.attach`                       |
| `cancel`                                                                     | `run` on the active run's resource (`src/serve/connection.ts`)                                                          |

Any type named in `--restricted-commands` needs `admin`, whatever its handler's
own verb (`isRestrictedCommand` in `src/serve/connection.ts`).

The CLI uses this protocol through `--server <url>` on each command. It needs
no repo and renders streamed run events with the same renderers as a local run.
The wire codec is lossless for run events; `deserializeEvent` in
`src/serve/serializer.ts` is the anti-corruption seam. Without the flag, remote
commands fall back to `SWAMP_SERVE_URL`, then `SWAMP_SERVER_URL` (precedence:
`--server` flag > `SWAMP_SERVE_URL` > `SWAMP_SERVER_URL`), so
`export SWAMP_SERVE_URL=wss://demo.swamp-club.ai` saves repeating the URL.
Before the first network I/O, a remote command writes a `Remote   <url>` line
to stderr, so the user always knows it targets a server, not the local
repository. The line, and every other message that names the server, shows
the URL without userinfo, query string or fragment (`redactServerUrl` in
`src/domain/auth/server_url.ts`), so a `?token=` credential never reaches
stderr or logs.

With `--auth-mode token`, the server checks the upgrade token by a read-only
lookup of its `swamp/server-token` lifecycle record and vault secret, using the
model's shared timing-safe validation. It does not call `redeem`, create a
model run, or update `lastUsedAt`. It accepts the token via
`Authorization: Bearer`, the `Sec-WebSocket-Protocol` subprotocol, or a
`?token=` query parameter, in that priority order; the CLI uses the
`Authorization` header. Unauthenticated connections get HTTP 401.

A token's authority ends for sessions that are already open, not just for new
connections. Each session is bound to the token name and the record's
`createdAt` (rotation rewrites it) it was opened with (`setConnectionToken` in
`src/serve/handlers/shared.ts`). The `access.token.revoke` and
`access.token.rotate` handlers close the token's sessions on their own instance
once they reply; rotate keeps sessions already opened with the new credential.
`TokenSessionRevalidationService` (`src/serve/token_session_revalidation_service.ts`)
re-reads the record of every open session's token every 30s and closes sessions
whose token is revoked (4003), rotated (4003), deleted (4003) or expired (4002).
That pass covers revokes made from the CLI or on an HA peer, whose record
arrives through the runtime data poller, so a peer ends the session within the
poll interval plus 30s. A record that exists but no longer parses closes its
sessions (4003), as it would be rejected at upgrade; a read that fails for any
other reason, such as I/O, keeps the session until the next pass. Revoke and
rotate close sessions even when the request was cancelled after the change was
saved. `terminateTokenSessions` is the one path that closes them,
and it records an `auth.session.terminated` audit event per session (see
[serve-audit.md](serve-audit.md)). The 8-hour session cap still applies.

The client looks for the token in this order:

1. the `--token` flag;
2. the `--token-file` flag (read from that path);
3. the `SWAMP_SERVER_TOKEN_FILE` env var (read from a file);
4. the `SWAMP_SERVER_TOKEN` env var, scoped by `SWAMP_SERVER_URL` (both must be
   set; both accept `ws(s)://` or `http(s)://` URLs);
5. stored credentials in `~/.config/swamp/servers.json` (managed by
   `swamp auth server-login`).

`--token` and `--token-file` are mutually
exclusive. The file-based options (`--token-file`, `SWAMP_SERVER_TOKEN_FILE`)
keep tokens out of environment variables, which shortens their time in process
memory. Tokens are managed with `swamp access token mint/list/revoke`.

With `--auth-mode oauth`, users log in with the OAuth device grant flow (RFC
8628) against swamp-club. Serve is an OAuth client relay. It holds client
credentials (auto-registered on first start, or supplied via
`--oauth-client-id` or headless API key bootstrap) and proxies the device
authorization flow:

1. User runs `swamp auth server-login --server <url>`
   (`src/cli/commands/auth_server_login.ts`). `swamp auth login --server` is a
   different command, the swamp-club registry login.
2. CLI calls `GET /auth/info` on the serve instance to find the auth mode.
3. CLI calls `POST /auth/device`. Serve starts a device grant against
   swamp-club and returns a user code and verification URL.
4. User visits the URL, signs in to swamp-club, enters the code and approves.
5. CLI polls `POST /auth/device/token`. Serve polls swamp-club's token
   endpoint, gets an access token, and calls the userinfo endpoint for `sub`,
   `email`, `name` and `collectives`.
6. Serve applies the admission policy: the user must be in
   `--allowed-collectives` or `--allowed-users`, or admission is rejected.
7. On admission, serve mints a `swamp/server-token` with the user's collectives
   snapshotted on the token record, and returns `<name>.<secret>` to the CLI.
8. CLI stores the server token via `ServerCredentialRepository` and uses it
   automatically for later commands.

After the device flow, OAuth-minted tokens are no different from manually
minted ones. The WebSocket upgrade, cancel endpoint and all handler
authorization use the same `<name>.<secret>` token and
`authenticateServerToken` path. The one difference is collectives:
`authorizeOrReject` reads them from the token record (via a per-connection
WeakMap set at upgrade time), so `idp-group:` grants can match OAuth users.

Auto-registration: on first start with `--auth-mode oauth` and no stored client
credentials, serve registers an OAuth client via
`POST /api/auth/oauth2/register`. It stores the returned `client_id` and
`client_secret` in the vault (keys `oauth-client-id`, `oauth-client-secret`)
for later starts. There are two registration paths:

- **Headless (SWAMP_API_KEY)**: if the `SWAMP_API_KEY` env var is set (a
  collective API token with `oauth:manage` scope), serve validates it against
  `/api/whoami`. It then uses it as the bearer token for client registration
  and for resolving admin and allowed-user usernames. The key is never stored in
  the vault; it is read from the environment on each boot, so rotating it needs
  no other step.
- **Interactive (device grant)**: otherwise, serve starts a device grant flow
  (RFC 8628) and waits for an admin to approve in a browser. The device grant
  access token is stored in the vault for later admin resolution.

Username resolution: at startup serve turns each `--admins` and
`--allowed-users` username into the provider's `sub`
(`src/serve/oauth_access_list_resolution.ts`). Results are cached in the
`oauth-resolved-admins` vault key, and a start whose names are all cached makes
no lookups. The rules for a name that does not resolve:

- **Not found (HTTP 404), name resolved before**: serve keeps the cached `sub`
  and logs a WARN. One wrong answer from the provider must not revoke an
  existing grant. The `sub` still identifies the original account, so whoever
  registers the name afterwards does not inherit it. Remove the name to drop it.
- **Not found (HTTP 404), name never resolved**: the name is skipped with an
  ERROR log, and serve starts with the rest. The failure is recorded in the
  cache, and the name
  stays skipped: restarts and edits to other entries never look it up again.
  Removing the name drops its record, so adding it back later looks it up
  fresh. Fixing a typo therefore takes one deploy; an account created after
  the name was added takes two (remove, then add back). Any automatic re-check
  would promote the name as soon as someone registered it, so a typo in
  `--admins` could be claimed by someone else and become an admin. One case
  remains: if the cache itself is lost (a new host or a rebuilt
  `_token-secrets` vault), every name is looked up again, including old typos.
- **Any other lookup error** (5xx, timeout, network): startup aborts. Dropping
  an existing admin would make `materializeAdmins` revoke their grant, so a
  provider outage must never shrink the list.
- **Fail closed**: serve refuses to start if no admin resolves, or if every
  allowed-user was skipped and no `--allowed-collectives` are set.
  `checkAdmission` admits everyone when both lists are empty.

`swamp serve check-config` runs the same lookups without starting the server or
writing the cache. It reads the auth settings the way serve does (flags, env
vars, then the config file) and looks up every name, including ones serve has
recorded as not found. It exits non-zero on any unknown name, so a typo is
caught before a deploy. It uses `SWAMP_API_KEY` or the
`swamp auth login` credential, and sends it only when the provider has the same
origin as the swamp-club server that issued it (`SWAMP_CLUB_URL` for a custom
provider). The command is meant for configs that are not yet deployed, possibly
written by someone else, so a crafted `oauth-provider` must not receive the
token.

Collectives are snapshotted at login. The `CollectiveRefreshService`
(`src/serve/collective_refresh_service.ts`) re-resolves them for active tokens
every `--group-refresh-interval` (default 4 h, `0` to disable;
`src/cli/commands/serve.ts`), so swamp-club membership changes apply within one
interval.

v1 is specific to swamp-club. The OAuth client endpoint paths
(`/api/auth/device/code`, `/api/auth/device/token`,
`/api/auth/oauth2/userinfo`, `/api/auth/oauth2/register`) are hardcoded.
`--oauth-provider` accepts a custom URL, but only swamp-club is tested.

The `Sec-WebSocket-Protocol` and `?token=` transports remain for backward
compatibility with older clients. The header is preferred because reverse
proxies and CDNs log URL paths. Use TLS (`wss://`) for non-loopback
deployments.

### Extra headers for reverse proxies and tunnels

If `swamp serve` sits behind a reverse proxy or tunnel that needs custom HTTP
headers (e.g. `Tunnel-Token`, provider-specific access headers), clients can
add pass-through headers with the `SWAMP_SERVE_EXTRA_HEADERS` environment
variable. The format is newline-separated `Name: value` entries:

```
export SWAMP_SERVE_EXTRA_HEADERS=$'Tunnel-Token: abc123\nX-Proxy-Auth: def456'
```

The headers go on the WebSocket upgrade request (via Deno 2.x's non-standard
`WebSocket({ headers })` extension) and, for workers, on every HTTP data-plane
request. They are pure pass-through: `swamp serve` does not read or require
them. Values may contain secrets and are never logged.

Reserved names (`Authorization`, `Host`, `Upgrade`, `Connection`) are rejected
so they cannot clash with swamp's protocol headers. Values with control
characters are rejected to prevent header injection.

## No execution drivers

There is no driver abstraction. The `ExecutionDriver` interface,
`raw`/`docker`/custom selection, the driver type registry and docker bundle
mounting were removed. So were the `driver:`/`driverConfig:` fields in the
workflow, job, step and definition schemas, `defaultDriver`/
`defaultDriverConfig` in `.swamp.yaml`, the `--driver` CLI flags, the serve
protocol payloads, and `driver` fields on run events. (`ExecutionRequest` never
carried them.) YAML that still uses those fields fails loudly with an actionable
message instead of being silently stripped
(`src/domain/removed_driver_fields.ts`). Two execution paths remain:

- **Execute in-process** on the orchestrator's loopback executor: the
  single-host case, with no socket and no forced websockets. This is the old `raw`
  path, now called "the execution path".
- **Dispatch to a worker**, which also runs the method in-process, in its own
  swamp process.

Isolation and environment used to come from `docker` and custom drivers. They
now come from **how a worker is deployed**: a container for container
isolation, a GPU host for GPU access, a locked-down VM for a strong sandbox.
Labels describe the deployment and the scheduler matches on them. The only
behavior lost
is isolating locally on one host without a worker. Running a local
containerized worker beside the orchestrator brings it back.

## Enrollment

On first connect, the worker redeems its token, binds it to the machine's
durable id and receives a session credential. The orchestrator then admits it
into the pool:

```
worker → orchestrator   enroll {
  token,                       // enrolls one machine; then re-auths that machine for its lifetime
  instanceUuid,                // per-instance UUID generated at worker startup (in-memory only)
  machineId,                   // durable machine id persisted in the worker's cache directory
  protocolVersion,             // reuse the version on ExecutionRequest
  swampVersion,
  platform, arch,              // e.g. linux/x86_64
  labels: { region: "us-east", gpu: "true" },   // scheduling selectors
  resourceLimits: { ... },
}

orchestrator → worker   enrolled { workerId, sessionCredential, sessionExpiresAtMs, protocolVersion }   |   error { ... }
```

(`EnrollParamsSchema` / `EnrollResult` in `src/domain/remote/protocol.ts`. The
session credential TTL is 15 min, `DEFAULT_SESSION_TTL_MS` in
`src/domain/remote/session_credential.ts`, refreshed at 2/3 of the TTL.)

A worker advertises **labels** and platform/arch; there is no runtime to
negotiate. Shipping the swamp binary is meant to keep orchestrator and worker in
version lockstep, so the capability interfaces match. Enrollment enforces only
`protocolVersion` (already on `ExecutionRequest`), which rejects an
incompatible worker at enrollment rather than mid-run; `swampVersion` is
recorded but not compared (`src/serve/worker_gateway.ts`). The
`sessionCredential` is the short-lived bearer token for the worker's
data-plane HTTP/2 requests. The pool addresses a worker by its token name (the
positional `<name>` given to `swamp worker token create`) and its
`instanceUuid`, and a step may target either (see
[Scheduling](#scheduling-fan-out-and-provisioning)).

### Enrollment tokens

A token admits a worker into the system; it is the unit of _logical
provisioning_. Each token is:

- **Named**: for audit and identification, and as the worker's handle in the
  pool (`ci-runner-3`).
- **Time-boxed**: `--duration` is a hard deadline for enrollment and
  reconnection. When it passes, the orchestrator disconnects a connected
  worker. Continuing needs a new token.
- **Controlled enrollment**: `maxEnrollments` (default `1`) caps how many
  distinct machines a token can bind. A single-enrollment token binds the first
  `machineId` and rejects any other machine. A fleet token
  (`maxEnrollments > 1` or `"unlimited"`) appends each machine to a `bindings`
  list until the allowance runs out. Each fleet member gets its own pool name
  (`<tokenName>-<suffix>`) from a stable hash of its `machineId`.
- **Reconnect-for-lifetime**: any bound machine can re-authenticate with
  `{token, machineId}` as often as needed until the lifetime ends. This
  survives a broken control socket and a process restart or reboot: the
  worker returns as the same pool member without a new token.

The token is a built-in **enrollment-token** model whose instances are swamp
data. Its states are `unused → enrolled → expired`, plus `revoked` from any
non-terminal state via `swamp worker token revoke`. The `unused → enrolled`
transition appends a binding (`machineId` + `enrolledAt`) to `bindings`. The
datastore has no compare-and-swap (concurrent saves to one item become
successive versions), so the **orchestrator process serializes all token and
lease transitions in memory**, including concurrent enrollment attempts. It is
the only writer of these models, and enrollment for a given token is a
critical section. (If orchestrators ever scale out, the future primitive is a
conditional save that rejects unless `latest` matches an expected version.) The
CLI:

```bash
swamp worker token create <name> --duration <dur>   # mint; prints the credential once
swamp worker token list                             # NAME, STATE, EXPIRES, ENROLLMENTS
swamp worker token revoke <name>                    # invalidate before expiry
```

The printed credential is **`<name>.<secret>`**. The name half finds the token
aggregate at enrollment without scanning the pool. The secret half is compared
in constant time with the plaintext stored in the vault.

The `instanceUuid` lives in memory only. It separates a _socket blip_ (process
alive, same UUID, same pool member) from a _process restart_ (new UUID, fresh
enrollment of the same machine). The token binds to the `machineId`, kept in a
`machine-id` file in the worker's cache directory. With a stable `--cache-dir`,
a worker keeps its original token across restarts and reboots while the token
lives. The default fresh temp cache directory gives a new machine identity per
process. When the lifetime ends, the token is dead for everyone: the
orchestrator disconnects the worker and rejects re-enrollment. A replacement
machine, or a worker that outlives its token, needs a new token. Trust is bound
to the machine, not the process.

## Worker state is swamp data

The orchestrator does not keep the worker pool, token lifecycle or step leases
in a private in-memory registry. **Built-in models** store them as **swamp
data**, through the same datastore and catalog as any method's output:

- a **worker** model: one artifact per enrolled worker, with name,
  `instanceUuid`, labels, platform/arch, resource limits, connection status and
  current load. Definitions are named `worker-<name>` because tokens and
  workers share one definition-name namespace; the pool-addressable `name`
  inside the data has no prefix.
- an **enrollment-token** model: the token lifecycle above.
- a **step-lease** model: which step is in flight on which worker.
- a **pending-dispatch** model (`swamp/pending-dispatch`): queued steps waiting
  for a matching worker, with states
  `waiting → dispatched | timed_out | cancelled | orphaned`.
- a **fleet-probe** model (`swamp/fleet-probe`): the probe described in the
  table above, used by `swamp worker verify` and `--verify-on-enroll`.

They ship with swamp and register at startup like its other built-ins. Because
worker state is ordinary data:

- **Provisioning and autoscaling become workflows.** A workflow can run
  `data.query('modelType == "swamp/worker" && attributes.status == "idle"')`,
  count busy workers or filter by label, then decide whether to mint a token
  and launch another host. Filter on `modelType`, because definitions are named
  `worker-<name>`; content fields sit under `attributes` and load on demand.
  The control plane is visible through the primitive workflows already use.
- **Lifecycle history is built in.** Data is versioned-immutable (see
  [Data semantics](#data-semantics)), so each status change is a new version. A
  worker's full enroll → busy → idle → expire history can be queried for audit
  and debugging.
- **Reports and the CLI already work.** `swamp data query`, reports and any CEL
  helper read worker state like any model output. No separate "pool status"
  surface is needed.

The scheduler reads and writes this data as its source of truth, so there is no
second store to drift out of sync.

The cost is churn. Every busy/idle flip and lease change is a new version, and
garbage collection (`swamp data gc`) is manual. So the built-in
models **declare retention up front**: bounded `garbageCollection` version
counts (worker 20; token, lease, pending-dispatch 10; fleet-probe 1), with
`lifetime: "infinite"` on all but the fleet probe
(`src/domain/models/worker/*_model.ts`).

**Worker and token reaping:** `WorkerGcService` runs periodically on the serve
side (default interval 1 h, default grace period 24 h). It prunes worker records
disconnected for longer than the grace period, then removes their stale
bindings from enrollment tokens with the `prune_bindings` model method.
`swamp worker prune` is the CLI equivalent. Step-lease and pending-dispatch
records are not reaped automatically yet, so their count grows without limit;
the declared counts only cap each record's version history.

### Boot reconciliation

When `swamp serve` starts, it sweeps the three bookkeeping models for records
left stale by a crash or unclean shutdown:

- **Step leases** in `active` state → `expired` (the worker is gone; no step is
  running).
- **Pending dispatches** in `waiting` state → `orphaned` (no in-memory queue
  episode exists to fulfill them).
- **Workers** not in `disconnected` status → `disconnected` (no live WebSocket
  session backs them).

The sweep runs through the model-method runner (`createWorkerModelRunDeps` +
`modelMethodRun` with `skipAllReports`), so transitions go through the
transition tail rather than direct datastore writes, keeping the sole-writer
invariant. A failed transition logs a warning and startup continues; one
corrupted record cannot stop the orchestrator from serving.

The sweep finishes before `Deno.serve` accepts traffic. A worker that
reconnects during the sweep re-enrolls normally afterwards: the sweep
transitions its stale record, and re-enrollment creates a new one. On a clean
boot nothing matches and nothing changes, but the
`"Boot: sweeping stale records"` line is logged either way
(`src/cli/commands/serve.ts`).

## The remote `MethodContext`

On a worker, the injected `MethodContext`
(interface in `src/domain/models/model.ts`) is built from **proxy adapters**
(`createRemoteMethodContext` in `src/worker/remote_method_context.ts`). Each
capability call becomes a request that the orchestrator runs against the real
repository, returning the result.

```
WORKER                                  ORCHESTRATOR
──────                                   ────────────

method code (unchanged)
  ├─ context.queryData(expr) ──ws────▶   dataQueryService.query(expr)
  │                          ◀──────────  records
  ├─ context.writeResource(...) ─h2──▶   dataRepository.save(...)   (durable now)
  │                          ◀──────────  DataHandle
  ├─ vault secret resolution ──ws────▶   vaultService.resolve(...)
  │                          ◀──────────  secret (scoped to this step)
  └─ emits run events ─────────ws────▶   persisted + streamed to client
```

The method author API (`context.writeResource`, `context.createFileWriter`,
`context.queryData`) is unchanged. Only what sits behind it differs: local
in-process repositories on the loopback executor, and on a worker, remote
proxies (control-plane RPCs for metadata, the HTTP/2 data plane for bytes).

Not every injected dependency is an RPC stub. `createCelEnvironment` is a
factory. On a worker it is the plain local `createExtensionCelEnvironment`
(`src/infrastructure/cel/cel_evaluator.ts`), which registers arithmetic
overloads only and has no data-access leaves to proxy. A method that wants data
inside a CEL expression fetches it first through `context.queryData` /
`readResource`.

## The capability protocol

The proxied calls must be a **closed, named set of verbs**, because any
capability that is not proxied is a method that silently fails on a worker.
The inventory below walks the `MethodContext`
(`src/domain/models/model.ts`), the `DataWriter` interface and the injected
service ports (`UnifiedDataRepository`, `VaultService`, `DefinitionRepository`,
`OutputRepository`, `DataQueryService`). Each context member is a proxy verb, a
data-plane route, worker-local, or shipped state. There are nine control-plane
verbs (`RemoteMethod.capability.*` in `src/domain/remote/protocol.ts`, served by
`src/serve/capability_service.ts`) plus the data-plane routes
(`src/serve/data_plane.ts`):

| Operation          | Backed by                                                                                                                | Transport | Notes                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------ |
| `getData`          | repo reads (`findByName`/`findById`/`getContent`/`stream`), `context.readResource`                                       | ws + h2   | ws resolves `latest`→version; `GET /data/{type}/{modelId}/{dataName}/{version}` streams bytes    |
| `queryData`        | `dataQueryService` / `context.queryData` / `context.readModelData`, attribute loading                                    | ws        | CEL predicate over the catalog; always live. `select` projection rejected (bypasses denylist)    |
| `listVersions`     | `repo.listVersions`                                                                                                      | ws        | Version history for one item. The only verb without a dispatch-scope assertion                  |
| `deleteData`       | `repo.delete`, `repo.removeLatestMarker`                                                                                 | ws        | Used by lifecycle/GC-aware methods                                                               |
| `resolveSecret`    | `vaultService.get` / `getAnnotation`                                                                                     | ws        | Authorized per step: denylist + allowlist (below)                                                |
| `putSecret`        | `vaultService.put` / `putAnnotation` / `deleteAnnotation`                                                                | ws        | Denylist only (below)                                                                            |
| `readDefinition`   | `definitionRepository.findByName`                                                                                        | ws        | Lazy-load; no cache                                                                              |
| `readOutput`       | `outputRepository` execution-history reads                                                                               | ws        | Optional context member                                                                          |
| `resolveModel`     | `findDefinitionByIdOrName` over the definition repository                                                                | ws        | Workflow step model resolution                                                                   |
| resource write     | `POST /data/resource` → `writeResource`                                                                                  | h2        | Durable immediately                                                                              |
| resource delete    | `DELETE /data/resource`                                                                                                  | h2        |                                                                                                  |
| file write         | `POST /data/writers` (open) → `/content` (stream + finalize) or `/line` + `/finalize`                                    | h2        | `writeLine` is durable per request (live logs)                                                   |
| extension assets   | `GET /bundle/{fingerprint}`, `GET /bundle/{fingerprint}/file/{relPath}`                                                  | h2        | Cacheable by fingerprint                                                                         |
| `log` / `event`    | run-event stream                                                                                                         | ws        | `rpc.stream` frames; flows to client                                                             |

`resolveSecret` checks the infrastructure denylist and an expression-based
allowlist taken from the dispatched step's args. The allowlist is disabled when
the step has dynamic vault references. `putSecret` checks only the denylist,
because write targets are not declared in vault expressions. The denylist
(`src/serve/capability_service.ts`) covers the `server-token-*` and
`worker-token-*` key prefixes, `oauth-client-secret`, `oauth-access-token-*`,
`oauth-bootstrap-access-token`, `oauth-resolved-admins`, and the control-plane
token-secrets vault by name.

The inventory must be complete for correctness. Re-walk it against
`MethodContext` whenever a context member is added; it is pinned behind the
negotiated `protocolVersion`. Workers still hold no datastore. Artifact bytes
use the HTTP data plane, which
also ends at the orchestrator; everything else is control-plane metadata.

Implementation note: the data-repository port has members the verbs
do not cover. These are synchronous members (`listVersionsSync`,
`findAllGlobalSync`, ...) that cannot make a network round-trip, whole-store
enumeration (`findAllGlobal`, `findAllForModel`), and raw write and maintenance
members (`save`, `allocateVersion`, `rename`, `collectGarbage`, path
accessors). Writes go only through the remote writers. On a worker, each of
these fails loudly with an `UnsupportedOnRemoteWorkerError` that names the
member and points to the loopback executor.

The remaining context members do not proxy:

- **`repoDir`** points to a per-dispatch scratch directory on the worker.
  Workers have no repository checkout, so reading repo contents through it is
  unsupported remotely. A method that needs repo files runs on the loopback
  executor, or on a worker deployed with a checkout and labeled to match.
- **Local compute stays local.** Subprocesses (`Deno.Command`, used by the
  shell model) and outbound network calls run on the worker, which is what remote
  execution is for. Their credentials and environment come from the shipped
  environment (below) or vault-resolved inputs.
  `cloudControlClientFactory` is `undefined` on a worker
  (`src/worker/remote_method_context.ts`); a method that needs it runs on the
  orchestrator.
- **`createCelEnvironment`** is the local extension environment (above), with
  no data-access leaves.
- **Not available on a worker.** `context.runModel()`,
  `context.approveWorkflowGate()` and `context.rejectWorkflowGate()` return
  `{ ok: false }` with an error naming the call
  (`src/worker/remote_method_context.ts`). Nested runs and gate control stay on
  the orchestrator.
- **Provider code never ships.** Vault and datastore providers run on the
  orchestrator behind `resolveSecret`/`putSecret` and the data verbs; a worker
  speaks verbs, never providers. Report providers do not ship either: checks
  are skipped for remote steps and reports run at the orchestrator (see
  [Checks and reports](#pre-flight-checks-are-skipped-for-remote-steps-reports-run-at-the-orchestrator)).
- **`followUpActions`** returned by a method are serialized on the dispatch
  result, and the orchestrator performs them. Only
  `methodName`/`delayMs`/`maxRetries` are sent (`serializeFollowUpActions` in
  `src/worker/exec_dispatch.ts`). **Known divergence:** the `continueCondition`
  function cannot cross the wire and is **dropped**, so the orchestrator's
  follow-up loop (`src/domain/models/method_execution_service.ts`) never sees
  it. A remote step's follow-ups always run, where the same method run locally
  would stop once its condition returned false.

## The execution environment

Methods read environment variables (`Deno.env`), and their subprocesses inherit
them. On one host that is the orchestrator's environment; a worker host's own
environment is an accident of deployment. To keep remote runs the same as local
ones, **the orchestrator snapshots its full environment and ships it with every
dispatch**. The worker holds the snapshot in memory for the step, applies it to
the method's execution context and any subprocesses it spawns, and drops it
when the step ends. Nothing is stored on the worker, and an idle worker holds
no environment.

The snapshot **overlays** the worker's base environment rather than replacing
it. A small fixed denylist of process-identity and host-runtime variables is
never shipped. The worker host keeps its own `HOME`, `USER`, `USERNAME`,
`USERPROFILE`, `LOGNAME`, `SHELL`, `PATH`, `PWD`, `TMPDIR`/`TEMP`/`TMP`,
`HOSTNAME`, `TERM`, `XDG_*`, `DENO_*`, and swamp's own `SWAMP_*` runtime
variables (matched case-insensitively;
`src/domain/remote/environment_snapshot.ts`). These describe where the process
is running, which is what remote execution changes. Shipping the
orchestrator's `HOME` or `PATH` would silently break the worker's tool
resolution, cache and config locations, and subprocess lookup. The denylist is
fixed in code and versioned with the `protocolVersion`, so both sides agree on
it.

This is also how ambient credentials reach a worker. Cloud SDKs built by
extension code, CLIs run by the shell model, and anything else that
authenticates from the environment work on a worker as on the orchestrator
host. `env.*` runtime expressions are unaffected: like `vault.get(...)`, they
already resolve on the orchestrator at dispatch time. The snapshot covers the
ambient reads inside method code and its subprocesses.

As a trade-off, every dispatched step sees the orchestrator's
whole environment, the same ambient access as running on the orchestrator host.
Scoping the snapshot (allowlists per token or per label) is a later refinement.
v1 prefers single-host fidelity over a new partial-environment failure mode.

### Method-to-child env scrubbing (third boundary)

The layers above protect the orchestrator→worker and worker→dispatch-runner
boundaries. A third protects the **method→child** boundary. When the shell
model (`command/shell`) or extension code spawns an external subprocess, the
child must not inherit swamp's own auth tokens (`SWAMP_SERVER_TOKEN`,
`SWAMP_API_KEY`, etc.) from the host process. An external tool (an LLM CLI, a
cloud SDK, kubectl) with these tokens in its `/proc/<pid>/environ` could leak
them.

The shell model builds the child's environment with `createSafeMethodEnv`
(`src/domain/remote/environment_snapshot.ts`): a copy of the host env with
every `SWAMP_*` variable removed (case-insensitive prefix match).
Process-identity vars (`HOME`, `PATH`, `SHELL`, …) stay, because the child runs
on the same host. The env is passed with `clearEnv: true` so Deno does not
re-inherit the parent's `SWAMP_*` vars behind the filter. A per-variable
allowlist on `createSafeMethodEnv` lets a method pass specific vars through
when a child needs them.

The three boundaries form a defense-in-depth chain:

| Boundary                 | Mechanism                             | What is stripped                                                     |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| orchestrator → worker    | `captureEnvironmentSnapshot` denylist | `HOME`, `PATH`, `SWAMP_*`, `DENO_*`, `XDG_*`, …                      |
| worker → dispatch runner | `stripWorkerCredentials`              | `SWAMP_WORKER_TOKEN`, `SWAMP_SERVER_TOKEN`, `SWAMP_ORCHESTRATOR_URL` |
| method → child process   | `createSafeMethodEnv` + `clearEnv`    | all `SWAMP_*` variables                                              |

A worker accepts up to `capacity` concurrent dispatches (`--concurrency N` on
`worker connect`, default 1). When all slots are full, a further dispatch is
rejected with `worker_busy` and the orchestrator re-queues it.

### Dispatch runners (phase 4a)

Each dispatch runs in a **dispatch runner**: a child process of the same swamp
binary (`swamp worker exec-dispatch`, a hidden subcommand). Its spawn
environment is the snapshot overlaid on the worker's own environment by
`overlayEnvironment`, without mutating the global `Deno.env`
(`src/worker/dispatch_handler.ts`). W3C trace context headers are overlaid on
top at spawn time. `stripWorkerCredentials` removes the worker control-plane
credentials (`SWAMP_WORKER_TOKEN`, `SWAMP_SERVER_TOKEN`,
`SWAMP_ORCHESTRATOR_URL`) before the child starts. The runner does not need
them: it gets its data-plane credential in `RunnerBootstrapParams` over stdio.

The supervisor (the worker process) talks to the runner over length-prefixed
stdio frames (`StdioTransport`), using the same `RpcChannel` as the
orchestrator–worker control socket. A capability bridge forwards the 9
metadata-RPC capability verbs (`getData`, `queryData`, `listVersions`,
`deleteData`, `resolveSecret`, `putSecret`, `readDefinition`, `readOutput`,
`resolveModel`) from the runner to the orchestrator. Data-plane HTTP requests
go straight from the runner to the orchestrator with a per-dispatch credential.

The runner's first stdin frame is `RunnerBootstrapParams`. It carries a
per-dispatch session credential, the data-plane URL, the cache directory path,
the full `DispatchParams`, and the worker's `--ca-cert` PEM certificates when
set, which the runner's data-plane requests trust. The certificates ride this
frame rather than the spawn environment, because the orchestrator's snapshot
can overlay that environment. The credential is issued by
`SessionCredentialService.issueForDispatch` and encodes the `dispatchId`.
Control-channel session refreshes do not invalidate it. The data plane checks
`credential.dispatchId` against the authenticated dispatch to prevent spoofing.

**Cancel propagation** is nested. The RPC channel's `CANCEL_GRACE_MS` (30 s,
`src/domain/remote/rpc_channel.ts`, shared by the control socket and the stdio
channel) bounds the supervisor. The supervisor forwards `rpc.cancel` to the
runner at once and kills the child after `RUNNER_CANCEL_GRACE_MS` (~10 s) if it
does not respond, leaving ~20 s for cleanup and the response frame. (The
`CANCEL_GRACE_MS` in `src/cli/commands/serve.ts` is a different constant with
the same name: 5 s, for the serve run-cancel endpoint.)

**Crash isolation**: a runner crash (non-zero exit or stdio channel close)
fails only that dispatch. The worker stays enrolled and takes the next one.

Phase 4a shipped at capacity 1: the same behavior as the earlier in-process
path, plus crash isolation and clean environment handling.

### Concurrent dispatch (phase 4b)

Phase 4b adds `--concurrency N` (or `"auto"` for CPU count) to
`worker connect`. The worker advertises its capacity in
`resourceLimits.capacity` at enrollment (protocol version 4). The scheduler
picks the worker with the most free slots, then by name for determinism
(`scheduleStep` in `src/domain/remote/scheduler.ts`). The `DispatchRegistry`
tracks N active dispatches per worker, keyed by `(workerName, dispatchId)`.

**Per-dispatch credentials**: each runner has its own credential from
`SessionCredentialService.issueForDispatch(workerId, dispatchId)`, separate
from the control-channel credential (above). The service refreshes it
internally: a timer slides the expiry forward every 2/3 TTL, so it stays valid
for the whole dispatch however long it runs. The string does not change, so the
runner needs no notice. Credentials are revoked when the dispatch completes.
The capability bridge overrides `dispatchId` in every RPC verb so the
`CapabilityService` can find the right dispatch for model-type scope isolation.

**Idle semantics**: a worker is "idle" when `activeDispatchIds.length === 0`.
The idle timeout starts only when all slots are empty. `maxDispatches` counts
total completed dispatches, not concurrent ones. Drain waits for all active
runners to finish (`activeRunners === 0`).

## Shipping extension code

A worker resolves no extensions of its own. The dispatch names the extension
bundle by fingerprint. On a cache miss the worker fetches it from the
orchestrator's HTTP/2 data plane (`GET /bundle/{fingerprint}`) and loads it
**in-process** in its own swamp runtime. The bundle is what the existing
`bundleSourceFactory` builds (see the removed execution-drivers design), so the
worker needs nothing pre-installed.

The fingerprint is `sha256Hex(js)` over the bundled source, computed inline at
dispatch time (see `DispatchService.#ensureBundle`). A worker caches what it
has fetched, so a bundle ships at most once per worker per version. This
mirrors the versioned-handle data cache: code and data both cache by content or
version identity and travel over the same h2 data plane.

Built-in models ship **no bundle**. The dispatch carries a `builtin:<type>`
sentinel, and the worker resolves the model from its own binary's registry.
Orchestrator and worker are expected to run the same version (enrollment checks
only `protocolVersion`), so a sentinel for a type the worker does not know is a
loud error that the binaries disagree.

Co-located extension assets (files resolved through
`context.extensionFile(relPath)`) are not inlined into the single-file JS
bundle. `extensionFile()` is synchronous and must resolve a local path, so
before running, the worker prefetches only the files declared in the manifest's
`additionalFiles`, via `GET /bundle/{fingerprint}/files` +
`GET /bundle/{fingerprint}/file/{relPath}`. Both routes serve only the declared
set. Undeclared files under the extension's `filesRoot` are never listed or
served, so unrelated repository content is not exposed to remote workers.
Assets are cached under the fingerprint like the bundle.

### Pre-flight checks are skipped for remote steps; reports run at the orchestrator

Pre-flight checks are **skipped** for steps placed on remote workers. Checks
run on the orchestrator, which cannot see a worker's filesystem. For example,
`@swamp/git`'s `repo-initialized` runs `git rev-parse` against a worker-local
path, which would always fail on the orchestrator where that path does not
exist. On the worker, the method body fails on its own if a filesystem
precondition is unmet.

Post-run **reports** keep their place in the pipeline: **after the execution
seam, at the orchestrator**. That is where they have always run for
out-of-process execution, and report-provider bundles never need to ship. (The
dispatch protocol reserves `reportBundleFingerprints` should that change.)
Output records, deletion markers and follow-up actions also still run at the
orchestrator with local repositories. Control-plane bookkeeping runs (worker,
token and lease transitions) skip per-run report artifacts so pool churn stays
bounded.

## Data semantics

Two facts about swamp's data model, both verified against the current code,
shape the contract.

### Writes are immediately durable, not staged

`context.writeResource` / `createFileWriter` call `repo.save()`
(`src/domain/models/data_writer.ts`, `unified_data_repository.ts`). It writes
the version directory, metadata, content, `latest` marker and catalog entry
before the `await` resolves. Nothing is buffered to commit at the end, and
`method_execution_service.ts` relies on that: it collects handles for data
written before a throw. So a method that writes and then
throws (e.g. a code-review `verdict=FAIL`, the issue-lifecycle model) leaves
its data visible.

For the proxy model, a `persistResource` / `persistFile` is an HTTP/2 `POST`
that completes only once `repo.save()` has persisted at the orchestrator. There
is no staging layer to build. A worker that writes 3 of 5 outputs then dies
leaves 3 durable writes, as a local process crash does today.

Two `DataWriter` modes need their own remote shape:

- **`writeLine` (append)** promises per-line durability via `repo.append` (the
  live-log contract). Remotely it maps to `POST /data/writers/{id}/line` on the
  data plane. Each request is durable at the orchestrator once acknowledged, so
  a worker crash loses at most the unacknowledged tail, as today.
- **`getFilePath` (direct file I/O)** gives the method a real path, typically
  for a subprocess to write to. A worker has no orchestrator path, so remotely
  it is a **worker-local spool file** that `finalize()` uploads as one streamed
  `POST`. For this mode only, durability moves from write time to finalize
  time. A worker that dies mid-spool leaves no write rather than a partial
  file, the safer of the two divergences. Local behavior is unchanged.

### Data is versioned-immutable, not content-addressed

`DataId` is a random UUID (`src/domain/data/data_id.ts`), not a content hash. A
`DataHandle` is identified by the `(dataId, version)` tuple
(`src/domain/models/model.ts`). A pinned `(dataId, version)` never changes. A
bare `dataId` resolves to `latest`, which changes when a new version is
written.

This sets the **worker cache rule**:

- **Cacheable:** artifact bytes keyed by `(dataId, version)`. That version
  never changes, so it is safe to cache for the worker's life. A strong `ETag`
  on `GET /data/{type}/{modelId}/{dataName}/{version}` lets the runtime honor
  this with no extra code.
- **Always live:** `latest` resolution and `queryData` results. `latest`
  resolution is a small control-plane RPC that returns a concrete version,
  which the worker then fetches (and caches) over h2.

So "lazy-load" means lazy-load and cache by versioned handle, which cuts
the round-trip cost of hot, immutable reads. The same immutability gives
worker-state data (above) its lifecycle history.

## Data plane: two transports

A worker never holds datastore configuration; all data still flows to the
orchestrator. Rather than hand-build chunking and flow control over one socket,
the orchestrator offers **two transports, both opened by the worker**. This
works because **the whole data plane is worker-initiated**: a running method
only pulls its inputs and pushes its outputs, and even the bundle is pulled
on a cache miss. Plain request/response is enough, with no server push.

- **Control plane: WebSocket** (worker-initiated, two-way, small messages):
  enrollment, dispatch, cancel, streamed run events, and the metadata
  capability verbs (`queryData`, `latest` resolution, `resolveSecret`,
  `readDefinition`, `resolveModel`, `log`). This is the symmetric two-registry
  protocol above.
- **Data plane: HTTP/2** (worker-initiated, streamed request/response): only
  the byte-heavy work. That is reading artifact content
  (`GET /data/{type}/{modelId}/{dataName}/{version}`), writing it
  (`POST /data/resource` → `repo.save()`), and fetching a bundle on a cache
  miss (`GET /bundle/{fingerprint}`). HTTP/2's multiplexing and per-stream flow
  control replace the chunking, credit accounting and priority queues we would
  otherwise hand-write. Deno streams request and response bodies, so memory
  stays bounded on both ends.

Implementation note: Deno negotiates HTTP/2 only via ALPN over TLS. The data
plane runs h2 under `wss://`/`https://` deployments and HTTP/1.1 over plain
TCP; the handlers are identical, and one listener serves both the control
socket and the data plane. The worker derives the data-plane base URL from its
connect URL (`ws → http`, `wss → https`) unless a dispatch overrides it for
split deployments.

Both connections are **outbound from the worker**, so NAT is not a problem.
Ideally they would be one connection: a WebSocket over an HTTP/2 stream via
extended `CONNECT` (RFC 8441). But Deno's WebSocket is HTTP/1.1-based on both
the server-upgrade and outbound-client sides and does not implement RFC 8441
today. So v1 uses two worker-initiated connections that can share one port via
ALPN, and can merge them if Deno gains RFC 8441 support. Versioned-immutable
data suits h2: `GET /data/{type}/{modelId}/{dataName}/{version}` is an
immutable, strongly-`ETag`'d resource that the worker and any intermediary can
cache.

### Authenticating the data plane

The two transports share one identity. At enrollment (over the control socket)
the orchestrator issues a short-lived **bearer token** as the session
credential, and the worker presents it on every HTTP/2 request. The worker
refreshes it over the control socket a set interval before it expires, so the
window **slides** forward and an active worker never hits a hard cutoff. A
control-socket reconnect also re-issues it.

Authorization on top is thin to start. It mirrors single-host
semantics and needs almost no new code:

- **Writes are limited to the step's declared output specs.** The data writer
  already enforces this: `createResourceWriter` / `createFileWriter` throw on an
  undeclared spec (`Undeclared resource spec '<name>'`, `data_writer.ts`).
  Schema validation in the writer is warn-only today (it emits a
  `schema_validation_warning` event), so spec names, not schemas, scope writes.
  The orchestrator persists a worker's `POST` through that same writer, so a
  worker can only write specs its model declares, with no new authorization
  layer.
- **Reads are dispatch-scoped.** `getData` is refused for a model type outside
  the active dispatch's scope (`#assertDispatchScope` in
  `src/serve/capability_service.ts`). `queryData` caps predicate length and
  post-filters results, rejecting outright any query that touches
  access-control or infrastructure model data. `listVersions` is the one verb
  with no scope assertion.

## Scheduling, fan-out, and provisioning

The orchestrator owns the DAG (`WorkflowExecutionService`,
`src/domain/workflows/execution_service.ts`) and the worker pool, whose state is
swamp data ([above](#worker-state-is-swamp-data)). Logical provisioning
(admitting workers into the pool) is in v1 scope: token issuance, enrollment,
the data-backed pool and label dispatch.

Dispatch matches a ready step against the pool:

1. **Direct target (optional)**: a step may pin to a worker by token name or
   `instanceUuid`. The scheduler routes only there, queuing until that worker
   is free or failing if it is not connected.
2. **Label selectors**: otherwise, does the worker match the step's required
   labels (`region=us-east`, `gpu`, a container/sandbox tag, etc.)? Isolation
   and environment requirements go here, since there is no runtime axis.
3. **Platform/arch**: does the worker meet any platform constraint?
4. **Tiebreak**: among matching workers, most free slots, then worker name
   (`src/domain/remote/scheduler.ts`; there is no round-robin). If all are
   busy, queue for up to `queueTimeout` (default `DEFAULT_QUEUE_TIMEOUT_MS` =
   600 s, `src/serve/dispatch_service.ts`).

### Disconnected-worker early warning

If a step targets a worker by name that is in the live pool but disconnected
(within the grace window), the dispatch service emits a `target_disconnected`
event before entering the queue loop (`src/serve/dispatch_service.ts`). Run
consumers see it as `step_target_disconnected`
(`src/domain/models/method_execution_service.ts`). This is a backstop. The main
guard is `workers.connected()` (see
[expressions.md](./expressions.md#workers-namespace)), which drops disconnected
workers at query time so fleet fan-out workflows never create steps for them.
The warning only covers workers still in the in-memory grace window; workers
already removed from the pool are not checked.

Label + platform matching, direct targeting and **worker affinity** cover
placement and co-location. Data-locality affinity is not pursued. Every
capability goes to the orchestrator, so compute location and state location are
decoupled. A step's data lives at the orchestrator whichever worker runs it. v1
dispatches per **step**, which is what gives fan-out across workers. Sending a
whole workflow to one worker is the single-worker special case.

#### Worker affinity

`affinity: true` at the **workflow** or **job** level pins all remote steps in
that scope to one worker. The first step picks a worker through normal
label/platform matching, and later steps in the group are forced there by an
internal target override. Workflow-level affinity covers the whole run;
job-level covers the job.

If the pinned worker disconnects mid-group, between steps or during a dispatch,
the step fails with a `WorkerAffinityLostError` rather than re-dispatching.
Silent re-dispatch to another worker would break the co-location the author
opted into.

The dispatch service keeps pins in an in-memory `affinityKey → worker` map,
keyed by `runId` (workflow-level) or `runId:jobName` (job-level). Pins are
released when the group completes.

A step declares its requirements in workflow YAML with four placement fields
(`PlacementFieldsSchema` in `src/domain/workflows/placement.ts`): `target:`
(worker name or `instanceUuid`), `labels:` (selector map), `platform:`, and
`queueTimeout:` (seconds to wait for a matching worker). They can be set at the
**workflow**, **job** or **step** level. Workflow-level placement is the default
for all steps, job-level overrides workflow, step-level overrides job, and an
omitted field inherits from the parent. An explicit `labels: {}` clears the
inherited labels; the step then runs locally only if no `target` or `platform`
remains in effect (`src/serve/dispatch_service.ts`).

**`forEach` is the fan-out construct.** It already expands one step template
into N parallel instances (`ForEachExpansionService`), so `forEach` over a list
plus a label selector is "fan out across the fleet". The existing step-level
`concurrency` field now caps in-flight dispatches rather than in-process method
runs.

v1 dispatch fits the existing execution loop. Jobs and steps already run
concurrently within each topological level (`mergeWithConcurrency` from
`src/infrastructure/stream/merge.ts`, used by
`src/domain/workflows/execution_service.ts`). A step executor that awaits a
worker instead of running in-process therefore fans out naturally: N ready
steps in a level become N concurrent dispatches, which queue (not fail) when no
matching worker is free. As a result, fan-out breadth at any moment is bounded
by the steps ready in the current level and their concurrency caps. A
free-running ready-step queue that dispatches across level boundaries is future
work.

### Host launching is a swamp workflow

Launching worker hosts is a swamp workflow, not a custom provider plugin. This
is why it matters that worker state lives in swamp data. There are two pieces:

- **Token minting is a built-in model.** Its `mint` method records the
  enrollment-token data and writes the token secret into a vault, returning a
  vault reference (not the secret). A provisioning workflow calls it and passes
  the reference downstream.
- **Worker-launch models are ordinary user extensions**, such as a model
  wrapping a k8s Job or a cloud VM API. It reads the token with a
  `${{ vault.get(...) }}` expression and boots the swamp binary with the token
  and orchestrator URL. The worker then connects back. swamp ships the
  mechanism; cloud and k8s integrations are written as extension models.

The token's plaintext lives only in the vault, so it never lands in stored
workflow run data. A provisioning workflow can `data.query` the pool, decide how
many workers to add, mint that many tokens and fan out launch steps; an
autoscaler is that workflow on a schedule. Bootstrapping works because the
provisioning workflow runs on the orchestrator's **loopback executor**, so
the first workers launch with an empty pool. Once they enroll, later
provisioning can fan out across them.

## Failure, reconnection, and retry

Immediate writes make naive retry unsafe. Writes are **not idempotent**:
`dataId` is a fresh UUID and each save bumps a version counter, so re-running a
step that already wrote creates duplicate versions and orphaned artifacts. This
one constraint governs both reconnection and retry.

Liveness is the **control socket**. A failed data-plane HTTP/2 request affects
only that request: a failed read is retried (reads are idempotent), and a failed
write is the ambiguous case below. If the control socket drops with a step in
flight, the orchestrator holds the step lease through a **reconnection grace
window** (`DEFAULT_GRACE_WINDOW_MS` = 60 s, `src/serve/worker_gateway.ts`)
before giving up. This stops reconnection and re-dispatch from racing into
double execution. Token expiry is a separate timer that disconnects the worker
when its token lifetime ends.

- **Worker reconnects within the window** (same `{token, machineId}`): it stays
  the same pool member, with a fresh session credential. As built, the
  in-flight dispatch does not survive the drop. The RPC pending state dies
  with the socket on both ends, and the worker aborts its in-flight execution
  when the channel closes, so a reconnected worker can never double-execute. A
  step that had **not written** is re-dispatched to the reconnected worker or
  any other match, which looks the same as resuming. If a **write** had landed,
  the step fails the run under the write-then-fail rule below.
- **Worker does not reconnect within the window:** the lease ends the same way.
  A **no-write** step re-dispatches to another matching worker. A
  **write-bearing** step fails the run and surfaces the partial state, as a
  local mid-method crash does today. swamp does not auto-retry crashed methods
  locally either, so this is not a regression.

### Write-bearing classification

Two mechanisms decide whether a dispatch is write-bearing:

- **Runtime inference (default):** the `DispatchService` records whether a
  dispatch made any durable data-plane write, via `recordFirstWrite`. This is
  automatic; workflow authors do nothing. The data plane marks the dispatch on
  `POST /data/resource` and on a file writer's `line`, `content` and `finalize`
  requests (`src/serve/data_plane.ts`). Merely opening a writer
  (`POST /data/writers`) does not mark it.

- **Declared at the step level (`writes: true`):** a step, job or workflow may
  set `writes: true` in the workflow YAML. The dispatch is then marked
  write-bearing **before the method body runs**, so a worker disconnect fails
  the run immediately instead of re-dispatching, even with no data-plane write.
  Steps that change external systems (API calls, `kubectl apply`, SSH commands)
  without calling `writeResource` need this, because the orchestrator cannot
  observe those side effects. Inheritance is child-wins: step overrides job, job
  overrides workflow.

With both `writes: true` and runtime writes, `recordFirstWrite` is a no-op on
the already-marked dispatch.

Transparent re-dispatch (or mid-step resume) of a write-bearing step is a later
feature that must first solve write idempotency. v1 does not promise it.

### Pre-enrollment failure handling

If the control socket closes before enrollment completes (e.g. HTTP 401/403
from token auth, or a network-level rejection), the worker treats it as a
connection error with two guards:

- **Permanent failure detection.** `isPermanentEnrollmentFailure`
  (`src/worker/connect.ts`) checks the error message against seven permanent
  patterns: `revoked`, `expired`, `does not match`, `already bound`,
  `protocol version`, `does not exist` and `allowance exhausted`. On a match the
  worker stops at once with a clear error, because retrying cannot fix these.

- **Consecutive failure cap.** Otherwise the worker counts the failure and
  throws on the third in a row (`MAX_PRE_ENROLL_FAILURES`). The count resets
  whenever a `connectOnce` attempt returns normally (after an enrolled session
  ends), so blips during an established session do not accumulate.

Socket drops after enrollment, while the worker is running dispatches, still
use exponential backoff and reconnect normally. A brief network interruption
during a session should not end the worker.

## Security and trust

Proxying everything and shipping code is a net security gain over provisioning
credentials and extensions onto workers:

- A worker holds **no datastore or vault credentials, no datastore config and
  no pre-installed extensions**. It touches only what the orchestrator hands it
  and runs only the dispatched bundle. The one exception is the
  per-dispatch environment snapshot (see
  [The execution environment](#the-execution-environment)), held in memory
  only while its step runs. The orchestrator sees every capability call and
  authorizes every data-plane request against the step lease, so it is the
  single point for authorization and audit. Per-step secret
  scoping is the orchestrator refusing a `resolveSecret` outside the step's
  allowed set. Secrets are resolved on the orchestrator and sent only for the
  step that needs them, as in the out-of-process resolution pattern of the
  removed execution-drivers design.

  **Secret redaction.** Vault-derived values must be scrubbed from all persisted
  output (log resources, result resources and workflow-run records) before they
  reach durable storage or the WS event stream. Two layers enforce this:

  1. **Worker-side (source redaction):** the orchestrator extracts resolved
     secret values from sensitive argument fields and ships them in the
     dispatch params (`secretValues`). The worker registers them with its
     `SecretRedactor` before running the method, so `stdout`/`stderr` and any
     `writeResource` data are redacted at the source.
  2. **Data plane (defense in depth):** the orchestrator stores a per-dispatch
     `SecretRedactor` on the `ActiveDispatch` registration. When the data plane
     persists a worker's `writeResource` call, it passes this redactor to
     `createResourceWriter`, catching any value the worker side missed.
     **Known limit:** the file-writer path (`POST /data/writers` and its
     `line`/`content` requests) does not get the redactor (`#openWriter` in
     `src/serve/data_plane.ts`), so file outputs rely on the worker-side layer
     alone.

  Both layers use the same `SecretRedactor` class and
  `extractSensitiveFieldValues` utility that local execution has always used;
  the invariant is the same, extended across the dispatch boundary.

- The **enrollment token** binds up to `maxEnrollments` machines by their
  durable `machineId`. The `{token, machineId}` pair is a bearer reconnection
  secret, not proof of possession. The client asserts the machine id, so the
  binding stops accidental reuse (one token pasted onto a second box) but not
  an attacker who holds the plaintext. That is acceptable because the pair travels
  over authenticated, encrypted `wss://`. Capturing it takes a TLS MITM or a
  compromised worker host, which already grants code execution there.

  TLS uses standard trust-anchor verification. `--ca-cert` / `SWAMP_CA_CERT`
  adds a PEM CA to trust (`src/cli/commands/worker_connect.ts`) for the control
  socket and each dispatch runner's data-plane requests, so `DENO_CERT` is not
  needed. Certificate **pinning is not implemented**.

  The data-plane **session credential** is short-lived and lease-scoped. Token
  lifetimes should be short too: a token leaked before enrollment is the main
  exposure, since an attacker could enroll first. The orchestrator disconnects
  a worker when its token lifetime ends, and `revoke` cuts a token off early.

- Conversely, a worker tricked into connecting to the wrong URL hands code
  execution on its host to that URL's owner, the same trust model as a
  self-hosted CI runner. Both channels are authenticated and encrypted under
  `wss://`. For a stronger binding than CA trust, front the orchestrator with a
  private CA supplied via `--ca-cert`.

## What is reused vs. new

| Concern                           | Status                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Control protocol + multiplexing   | **Reuse** `src/serve/protocol.ts`, `connection.ts`, `serializer.ts`                                                                          |
| Serializable execution envelope   | **Reuse** `ExecutionRequest` / `ExecutionResult` (serialize `followUpActions`; the envelope never carried driver fields)                     |
| Extension bundle + fingerprint    | **Reuse** `bundleSourceFactory` + inline `sha256Hex` fingerprint; fetched over h2 on a miss; co-located assets ship the same way (see below) |
| Checks and reports pipeline       | **Reuse** at the orchestrator: checks skipped for remote steps; reports run after the execution seam                                        |
| Pure injectable operations        | **Reuse** libswamp `*Deps` + `MethodContext` injection seam                                                                                  |
| Worker/token/lease persistence    | **Reuse** the datastore + catalog: built-in models, not a private registry                                                                   |
| Out-of-process secret resolution  | **Reuse** the resolve-before-dispatch pattern                                                                                                |
| Run-event serialization           | **Reuse** `serializeEvent()`; worker → orchestrator events ride `rpc.stream` frames                                                          |
| Driver abstraction                | **Remove** `ExecutionDriver`, raw/docker/custom drivers, registry, `driver:` fields                                                          |
| Role split (server ≠ executor)    | **New**: request-dispatch handling moves to the worker side; two handler registries                                                          |
| Enrollment handshake              | **New**: token redemption, machine binding, label exchange, session-credential issue                                                         |
| Built-in worker-management models | **New**: `worker`, `enrollment-token`, `step-lease`; `swamp worker token` + mint model                                                       |
| Remote `MethodContext` adapters   | **New**: proxy implementations of the repository/vault/data-writer ports                                                                     |
| Capability protocol verbs         | **New**: nine `capability.*` verbs over ws (metadata) plus the h2 data-plane routes (bytes)                                                  |
| Environment shipping              | **New**: per-dispatch orchestrator env snapshot, worker-memory only                                                                          |
| Spool + append write modes        | **New**: worker-local spool for `getFilePath`; `POST /data/writers/{id}/line` for `writeLine`                                                |
| HTTP/2 data plane + auth          | **New**: worker-initiated bulk transfer; bearer-token auth, existing spec-write enforcement                                                   |
| Label scheduler + direct target   | **New**: data-backed pool, label/platform matching, target by name/uuid; step-level `target:`/`labels:`/`platform:` YAML fields             |
| Lease + reconnection + failure    | **New**: grace window, full re-dispatch of no-write steps after a drop, write-then-fail                                                      |
| `swamp worker connect` command    | **New**: the CLI command a worker runs to connect                                                                                            |

Report bundles do not ship: `reportBundleFingerprints` is always `[]`
(`src/serve/dispatch_service.ts`).

## v1 scope and non-goals

In scope:

- Enrollment over `wss://` with a named, time-boxed token that binds one or
  more machines. Each machine reconnects as `{token, machineId}` for the
  token's lifetime. `swamp worker token` commands and a mint model that writes
  the token to a vault.
- No drivers: isolation is a worker deployment property; the loopback executor
  covers single-host.
- One dispatch runner process per dispatch, for crash isolation and a clean
  environment; extension code fetched on a cache miss and loaded in the runner.
- Remote `MethodContext`: nine capability verbs plus data-plane routes,
  spool-on-finalize `getFilePath`, per-request-durable line appends. Checks
  skipped for remote steps; reports at the orchestrator.
- The orchestrator's full env snapshot per dispatch, in worker memory only,
  applied to the method and its subprocesses.
- A WebSocket control plane and a worker-initiated HTTP/2 data plane with
  native multiplexing and flow control.
- Worker/token/lease state as queryable swamp data with declared retention
  (`garbageCollection`/`lifetime`); token/lease transitions serialized in the
  orchestrator process.
- Versioned-handle read caching on the worker.
- Label + platform scheduling and direct targeting by name/uuid over the
  data-backed pool; step-level `target:`/`labels:`/`platform:` fields; `forEach`
  fan-out within the existing level-parallel loop.
- Reconnection grace window; a drop after a write fails the run.
- The mint model and connect contract, so host launching is a swamp workflow
  (mint model → vault → launch model → worker connects), bootstrapped on the
  loopback executor.

Non-goals for v1:

- **Remote datastore configuration for workers.** All data ends at the
  orchestrator. Revisit only if that limit becomes a problem.
- **Data-locality scheduler affinity.** Worker affinity (`affinity: true`)
  gives explicit co-location instead.
- **Shipping cloud/k8s launch integrations.** Launch models are user-written
  extensions.

## Known limits

- **Latency amplification.** In-process capability calls take nanoseconds;
  over the wire each is a round-trip. Versioned-handle caching, the h2 data
  plane and concurrent control RPCs reduce this. The write path stays
  synchronous by contract.
- **Orchestrator as the data plane and SPOF.** All data, secrets, definitions,
  catalog lookups and worker bookkeeping go through the orchestrator and its one
  datastore, so total throughput and availability are bounded by it, not by
  worker count. This
  is the accepted cost of credential-free workers and one durable authority.
- **Two-transport correlation.** Until Deno supports RFC 8441, control (ws) and
  bulk (h2) are two worker-initiated connections sharing one identity via the
  session bearer token: a little new surface, in return for HTTP/2 framing.
- **Level-bounded dispatch.** Fan-out breadth at any moment is bounded by the
  steps ready in the current topological level and their concurrency caps, not
  by fleet size. A cross-level ready-step queue is future work.
- **Whole-environment dispatch.** Every dispatched step gets the full
  orchestrator environment snapshot; per-token or per-label scoping is a later
  refinement.
- **No periodic bookkeeping GC for leases and pending dispatches.** These
  records build up until an operator runs `swamp data gc`; only the boot sweep
  is automatic. Worker and enrollment-token records are pruned by
  `WorkerGcService` (periodic, serve side) and `swamp worker prune` (manual).
  See `src/serve/worker_gc_service.ts` and `src/libswamp/worker/prune.ts`.
- **No in-flight resume.** A dispatch that loses its control socket is
  re-dispatched from scratch if no write had landed
  (`src/serve/dispatch_service.ts`); partial progress on the worker is lost.
- **No certificate pinning.** Worker TLS trust is CA-based (`--ca-cert`).
- **Report bundles do not ship.** Reports run at the orchestrator only.
- **`continueCondition` is dropped for remote steps** (see
  [The capability protocol](#the-capability-protocol)).
- **HTTP/2 is whatever Deno negotiates.** The listener passes no
  `alpnProtocols`; h2 on the data plane relies on Deno's TLS defaults.

## Hot-Reload for Pulled Extension Bundles

`swamp serve` loads extension bundles at startup and keeps them for the process
lifetime. The `--hot-reload` flag enables SIGHUP-based hot-reload, following
the nginx pattern.

### User Flow

1. Start serve with `swamp serve --hot-reload`
2. Push updated extension code, then pull it
   (`swamp extension pull @name --force`)
3. Trigger a reload:
   - **Local**: `swamp serve reload` reads `.swamp/serve.pid` and sends SIGHUP
   - **Remote**: `swamp serve reload --server wss://host:port` sends a
     `serve.reload` WebSocket request (requires admin authorization)
4. Serve reloads all pulled extension types. In-flight requests finish on the
   old code; new requests use the new code.

### Mechanism

The SIGHUP handler and the `serve.reload` WebSocket handler both call the
shared `performServeReload()` function in `src/serve/extension_reload.ts`. A
module-level reloading guard (`isReloading()`) rejects a concurrent reload from
either trigger. `serve.reload` on a server started without `--hot-reload` is
refused with `hot_reload_disabled` (`src/serve/handlers/admin_handlers.ts`).
Besides extension types, a reload re-reads the `.swamp/serve.yaml` trigger
overrides and refreshes the extension trust list.

`reloadPulledExtensions()`:

1. Opens a fresh `ExtensionCatalogStore` (reads `_extension_catalog.db`)
2. Reads the lockfile via `LockfileRepository` for extension names/versions
3. Queries `catalog.findBySourcePathPrefix(sourcePrefix)` for type rows
4. Re-bundles any source whose fingerprint changed, writing the new bundle
   file and recording the fingerprint with `catalog.updateSourceFingerprint()`
5. For each type across all four kinds (model, vault, datastore, report):
   - `invalidateType()` removes it from the registry's loaded and lazy maps
   - `registerLazy()` re-adds it with the updated `source_fingerprint`
   - `ensureTypeLoaded()` triggers `loadSingleType()` →
     `importBundleByPath()`, which imports
     `bundle?fp=<fingerprint>&h=<sha256 of bundle>` (`bundleImportUrl` in
     `src/domain/extensions/extension_loader.ts`). An unchanged bundle maps
     to the same URL and reuses its cached module; a re-bundled one maps to a
     new URL and its new code runs

### Catalog Safety Constraint

The reload path never calls `ExtensionCatalogStore.invalidate()`,
`ExtensionLoader.buildIndex()`, or `ensureLoaded()`. Only the per-type path
(`loadSingleType` and its sub-calls) is allowed. Its writes are the re-bundled
bundle file and `catalog.updateSourceFingerprint()`, so later reloads skip
unchanged sources. If a type does not fully load, it also calls
`catalog.removeBySourcePath()` (`src/domain/extensions/extension_loader.ts`).

### Concurrency

During the reload window, a type is briefly in `lazyTypes` (not yet imported).
Serve execution paths resolve types through
`resolveModelType()`/`resolveVaultType()`/`resolveDatastoreType()`, or call
`ensureTypeLoaded()` directly (e.g. `src/cli/repo_context.ts`,
`src/cli/resolve_datastore.ts`, the datastore health check in
`src/cli/commands/serve.ts`) before `get()`. Concurrent callers share one load
promise via `typeLoadPromises` and wait rather than fail.

### Known Limitations

- **SIGHUP carries no payload**: a single extension cannot be targeted; all
  pulled extensions are reloaded, at a cost proportional to their number.
- **Windows**: SIGHUP is not available. `--hot-reload` fails with a clear
  message on Windows.
- **V8 module cache**: import URLs are content-addressed
  (`?fp=<source_fingerprint>&h=<sha256 of bundle>`). V8 never evicts an ES
  module, so each bundle version loaded stays in memory for the life
  of the process. Heap grows once per changed bundle, not per reload;
  reloading unchanged extensions costs no heap (swamp-club#2340).
