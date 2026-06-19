# Remote Execution

Remote execution lets a single **orchestrator** fan a workflow or method run out
across many **workers** — disposable swamp processes that carry no repository,
datastore, vault, or extension state of their own. A worker is just a swamp
binary plus a token and a URL. It dials home, enrolls, and runs whatever the
orchestrator dispatches; the extension code it needs is shipped with the
dispatch, and every side-effecting capability the running method touches —
reading data, writing data, resolving a secret, loading a definition — is
proxied back to the orchestrator, which owns the durable world.

Remote execution **replaces** [execution drivers](./execution-drivers.md)
entirely. There is no `raw` / `docker` driver selection and no driver
abstraction: every method runs in-process inside whichever executor holds it.
Isolation and environment become a *deployment property of the worker* — if you
want a container, you run a containerized worker — not a per-step configuration
field.

## Why this shape

Three properties drove the design:

- **Workers dial the orchestrator, never the reverse.** Workers live in CI,
  ephemeral cloud instances, containers, behind NAT — places that cannot accept
  inbound connections but can always open an outbound one. Every worker
  connection is worker-initiated and outbound, so they traverse firewalls for
  free and make provisioning a one-liner (`swamp worker connect <url> --token
  <token>`), with no service discovery and no inbound ports. The control socket
  *is* the liveness signal: connected ⇒ enrolled; disconnect ⇒ deregistered.

- **The orchestrator is the world; the worker is pure compute.** Every durable
  capability — datastore reads and writes, vault secrets, definition loads,
  catalog lookups — and every piece of extension *code* originates at the
  orchestrator. A worker holds no credentials, no repository, no datastore
  config, and no pre-installed extensions, and can touch nothing it was not
  handed. This makes the orchestrator a natural authorization and audit
  chokepoint, and gives read-your-own-writes and cross-worker data visibility
  for free, because there is a single durable authority.

- **The injection seam already exists.** libswamp operations are pure functions
  over injected `*Deps` structs, and a method receives its world through
  `MethodContext` (`src/domain/models/model.ts`). Remote execution swaps the
  *leaves* of that dependency tree — repositories, vault service, data writers —
  for remote proxy adapters that RPC home. Method code and libswamp operation
  code do not change at all. This is the repository/ports-and-adapters
  abstraction paying off: a remote adapter is just another implementation of the
  same port.

## Ubiquitous language

| Term                 | Meaning                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator**     | The control-plane websocket server and data-plane HTTP/2 endpoint. Owns DAG and run state, the datastore, vaults, the catalog, definitions, extension bundles, locks, the scheduler, token issuance, and audit. |
| **Worker**           | A disposable swamp process that dials the orchestrator, enrolls, and executes dispatched steps with a remote `MethodContext`. |
| **Executor**         | What a dispatch actually runs on: the **local loopback** (in-process on the orchestrator, no socket) or a **remote worker**. Either way, methods run in-process. |
| **Enrollment**       | The first-connect handshake: redeem the token, bind it to the worker instance UUID, exchange version/labels, issue a session credential, admit the worker into the pool. |
| **Enrollment token** | A named, time-boxed credential that enrolls exactly one worker once, then re-authenticates that same instance for the rest of its lifetime. A built-in model. |
| **Session credential** | The short-lived credential issued at enrollment that authenticates the worker's HTTP/2 data-plane requests.                |
| **Dispatch**         | The orchestrator → worker request to run one `ExecutionRequest`. The unit of fan-out.                                       |
| **Capability**       | A side-effecting function a running method reaches through its context, proxied back to the orchestrator. A finite, closed set. |
| **Step lease**       | The orchestrator's record that a given step is in flight on a given worker. A built-in model.                               |
| **Environment snapshot** | The orchestrator's full process environment, shipped with each dispatch and held in worker memory only for the step's duration. |
| **Spool file**       | The worker-local file backing `getFilePath()` on a remote executor; uploaded to the orchestrator as one streamed `PUT` on `finalize()`. |

The orchestrator's own bookkeeping — the worker pool, token lifecycle, and step
leases — is **persisted as swamp data** by first-class built-in models, written
exactly as a model method writes its output (see
[Worker state is swamp data](#worker-state-is-swamp-data)). "Executor" here is the
deployment target of a dispatch, distinct from the in-process services
(`DefaultMethodExecutionService`, `WorkflowExecutionService`) that run *inside* an
executor. The two domain roles remain **orchestrator** and **worker**.

## Topology

A worker opens both connections outbound. The control socket is bidirectional —
the orchestrator dispatches work down it, the worker proxies metadata capabilities
back up it — and the data plane is a separate worker-initiated HTTP/2 channel for
bulk bytes.

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

A worker is provisioned by minting a token and running one command (cloud-init,
a k8s Job, an ssh one-liner):

```bash
swamp worker token create ci-runner-3 --duration 1h    # on/near the orchestrator
swamp worker connect wss://orchestrator.internal:4000 --token <token>   # on the worker
```

### A symmetric control protocol, two handler registries

Today `src/serve/` couples two roles: the websocket *server* is also the
*executor* — it listens, receives `model.method.run` / `workflow.run`, and runs
the work locally (`src/serve/connection.ts`, `src/serve/protocol.ts`). Remote
execution splits those apart:

- The **orchestrator** is the server but *dispatches* work.
- The **worker** is the client but *executes* work.

Because the control protocol is already request/response with a client-assigned
`id` for multiplexing, the clean framing is a single protocol module with **two
handler registries**, symmetric in both directions over the control socket:

| Direction               | Messages the receiver handles                                                |
| ----------------------- | ---------------------------------------------------------------------------- |
| orchestrator → worker   | `dispatch` (run an `ExecutionRequest`), `cancel`                             |
| worker → orchestrator   | `enroll`, the metadata capability verbs, and streamed run events             |

The request-dispatch half of `connection.ts` moves to the dial-*out* side; both
sides share the framing, error envelope, and `serializeEvent()` machinery that
already exists. Byte-heavy transfers do *not* go over this socket — they ride the
HTTP/2 data plane (see [Data plane](#data-plane-two-transports)).

The serve endpoint keeps its existing client protocol (`workflow.run` /
`model.method.run` / `cancel`, spoken today by the published
`@swamp-club/swamp-lib` client) unchanged and side by side with the worker
messages: worker verbs are new message types gated on enrollment, so an
ordinary client and an enrolling worker share one listener without ambiguity.
The client protocol gains one additive frame — a terminal `done` after a
run's event stream completes — so clients can distinguish "run ended" from
"stream stalled". The CLI consumes this protocol via
`swamp workflow run --server <url>` / `swamp model ... method run --server`:
repo-less, streaming the run's events through the same renderers as a local
run (the wire codec is lossless for run events; `deserializeEvent` in
`src/serve/serializer.ts` is the anti-corruption seam).

When `--auth-mode token` is active, the server validates a `?token=name.secret`
query parameter at WebSocket upgrade time via the `swamp/server-token` model's
`redeem` method (timing-safe, vault-backed). Unauthenticated connections receive
HTTP 401. The client resolves the token from (in precedence order) the
`--token` flag, the `SWAMP_SERVER_TOKEN` + `SWAMP_SERVER_URL` env vars, or
stored credentials in `~/.config/swamp/servers.json` (managed by
`swamp auth server-login`). Token management is through
`swamp access token mint/list/revoke`.

The token travels as a `?token=` query parameter on the WebSocket upgrade URL.
This is the standard WebSocket auth pattern (the browser WebSocket API does not
support custom headers on upgrade requests), but the plaintext will appear in
any reverse proxy or load balancer access logs that capture the full request
URL. Use TLS (`wss://`) for non-loopback deployments and configure access-log
redaction on any intermediary that fronts the server.

## No execution drivers

There is no driver abstraction. The `ExecutionDriver` interface,
`raw`/`docker`/custom selection, the driver type registry, and the docker
bundle-mounting machinery are all removed. The `driver:`/`driverConfig:` fields
live in the workflow, job, step, and definition schemas, plus
`defaultDriver`/`defaultDriverConfig` in `.swamp.yaml`, the `--driver` CLI
flags, the serve protocol payloads, and `driver` fields on run events — *not*
on `ExecutionRequest`, which never carried them. Removing the axis is a
user-facing schema deprecation across all of those surfaces, scoped as part of
this work. Execution reduces to two code paths:

- **Execute in-process** on the orchestrator's loopback executor — the
  single-host case, no socket, no websockets forced. This is the old `raw` path,
  now simply "the execution path."
- **Dispatch to a worker**, which also runs the method in-process in its own
  swamp process.

Isolation and environment, which `docker` and custom drivers used to provide, are
now expressed by **how a worker is deployed**: run a worker in a container for
container isolation, on a GPU host for GPU access, in a locked-down VM for a
strong sandbox — and describe it with labels the scheduler matches against. The
only behavior genuinely removed is "isolate locally on a single host without a
worker"; it is recovered by running a local containerized worker alongside the
orchestrator.

## Enrollment

On first connect, the worker redeems its token, binds it to this machine's
durable id, receives a session credential, and the orchestrator admits it into
the pool:

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

orchestrator → worker   enrolled { workerId, sessionCredential }   |   error { ... }
```

A worker advertises **labels** and platform/arch, not runtimes — there is no
runtime axis to negotiate. Shipping the swamp binary keeps the orchestrator and
worker in version lockstep, so the capability interfaces match; `protocolVersion`
(already present on `ExecutionRequest`) rejects an incompatible worker at
enrollment rather than mid-run. The `sessionCredential` is a short-lived bearer
token that authenticates the worker's data-plane HTTP/2 requests. The worker is
addressable in the pool by its token
`--name` and its `instanceUuid`; a step may target it directly by either (see
[Scheduling](#scheduling-fan-out-and-provisioning)).

### Enrollment tokens

Tokens are the unit of *logical provisioning* — admitting a worker into the
system. Each token is:

- **Named** — for audit and identification, and as the worker's addressable handle
  in the pool (`ci-runner-3`).
- **Time-boxed** — a `--duration` lifetime that is a *hard deadline*: it bounds
  enrollment and reconnection, and when it elapses the orchestrator actively
  disconnects a connected worker. Continuing past it means minting a new token.
- **One machine** — it enrolls exactly one machine. The first connect binds it
  to the worker's `machineId` (a durable id persisted in the worker's cache
  directory); an *enrollment* attempt from a different machine is rejected.
- **Reconnect-for-lifetime** — after enrollment, the *bound machine* may
  re-authenticate by presenting `{token, machineId}` as many times as needed
  until the lifetime expires. This is what survives a broken control socket
  *and* a process restart or reboot: the worker comes back as the same pool
  member without a freshly minted token.

The token is a built-in **enrollment-token** model whose instances are swamp data,
with states `unused → enrolled → expired`; the `unused → enrolled` transition
records the bound `machineId`, and two workers cannot race to claim one
token. The datastore itself provides no compare-and-swap — concurrent saves to
one data item simply land as successive versions — so atomicity comes from the
**orchestrator process serializing all token and lease transitions in memory**:
it is the sole writer of these models, and enrollment for a given token is a
critical section. (A conditional save — rejecting unless `latest` matches an
expected version — is the future primitive if orchestrators ever scale out.)
The CLI surface:

```bash
swamp worker token create <name> --duration <dur>   # mint; prints the credential once
swamp worker token list                             # state, expiry, name, bound machine
swamp worker token revoke <name>                    # invalidate before expiry
```

The printed credential has the form **`<name>.<secret>`**: the name half
addresses the token aggregate at enrollment (no scan over the pool), the
secret half is compared — constant-time — against the vault-stored plaintext.

The `instanceUuid` is in-memory only and distinguishes a *socket blip* (process
alive, UUID stable, same pool member) from a *process restart* (new UUID, fresh
enrollment of the same machine). The `machineId` is what the token binds to: it
lives in a `machine-id` file in the worker's cache directory, so a worker
started with a stable `--cache-dir` survives restarts and reboots on its
original token for as long as the token lives, while the default fresh temp
cache directory yields a new machine identity per process. When the lifetime
expires the token is dead for everyone — the orchestrator disconnects the
worker and rejects re-enrollment. Replacing a machine or outliving a token
means minting a new one — machines are the unit of trust; processes come and
go.

## Worker state is swamp data

The orchestrator does not keep the worker pool, token lifecycle, or step leases
in a private in-memory registry. It persists them as **swamp data**, written by
first-class **built-in models** through the same datastore and catalog as any
model method's output:

- a **worker** model — one artifact per enrolled worker: name, `instanceUuid`,
  labels, platform/arch, resource limits, connection status, current load.
  (Definition instances are prefixed `worker-<name>` because tokens and
  workers share one definition-name namespace; the pool-addressable `name`
  inside the data stays bare.);
- an **enrollment-token** model — the token lifecycle aggregate above;
- a **step-lease** model — which step is in flight on which worker.

These ship with swamp and are registered at startup like its other built-ins.
This is not incidental — it is *why* the rest of the design composes:

- **Provisioning and autoscaling become workflows.** A workflow can
  `data.query('modelName == "worker" && attributes.status == "idle"')` (content
  fields live under `attributes` and load on demand; or count busy workers, or
  filter by label) to decide whether to mint a token and launch another host.
  The control plane is introspectable through the exact primitive workflows
  already use.
- **Lifecycle history is free.** Because data is versioned-immutable
  (see [Data semantics](#data-semantics)), every status change is a new version,
  so the full enroll → busy → idle → expire history of a worker is queryable for
  audit and debugging with no extra machinery.
- **Reports and the CLI come for free.** `swamp data query`, reports, and any
  CEL helper see worker state the same way they see model output — no bespoke
  "pool status" surface to build.

The scheduler reads and writes this data as its source of truth; it is not a
parallel store that can drift from it.

Versioned-immutable state has a churn cost: every busy/idle flip and lease
change is a new version, and garbage collection is an explicit operation
(`swamp data gc`), not automatic. The built-in models therefore **declare
retention up front** — bounded `garbageCollection` version counts (and duration
`lifetime`s where appropriate) on worker-status and step-lease data — and the
orchestrator runs data GC over its own bookkeeping models periodically, so
control-plane churn cannot grow the datastore without bound while recent
history stays queryable.

## The remote `MethodContext`

The heart of the design: on a worker, the injected `MethodContext`
(`src/domain/models/method_context.ts`) is built from **proxy adapters**. Each
capability call serializes to a request to the orchestrator, which runs it against
the real repository and returns the result.

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
`context.queryData`) is unchanged. Only the implementations behind those handles
differ: local in-process repositories on the loopback executor, remote proxies on
a worker — control-plane RPCs for metadata, the HTTP/2 data plane for bytes.

Not every injected dependency is a flat RPC stub. Some are *factories* that
produce more behavior — `createCelEnvironment` returns a CEL `Environment` whose
own data-access calls must proxy home. The boundary there is "construct the
object locally on the worker, but inject *its* leaves as remote proxies."

## The capability protocol

"Everything proxies back" must become a **closed, named set of verbs**, because
any capability that is *not* proxied is a method that silently fails on a worker.
The inventory below is generated by walking the actual `MethodContext`
(`src/domain/models/model.ts`), the `DataWriter` interface, and the injected
service ports (`UnifiedDataRepository`, `VaultService`, `DefinitionRepository`,
`OutputRepository`, `DataQueryService`); every context member gets an explicit
disposition — a proxy verb, worker-local, or shipped state. Fourteen verbs:

| Verb               | Backed by                                                                  | Transport | Notes                                  |
| ------------------ | -------------------------------------------------------------------------- | --------- | -------------------------------------- |
| `getData`          | repo reads (`findByName`/`findById`/`getContent`/`stream`), `context.readResource`, `readModelData` | ws + h2   | ws resolves `latest`→version; h2 streams bytes |
| `queryData`        | `dataQueryService` / `context.queryData`, incl. `select` projection and attribute loading | ws        | CEL predicate over the catalog; always live |
| `listVersions`     | `repo.listVersions`, `findAllGlobal`/`findAllForModel` enumeration         | ws        | Version-history and cross-model enumeration |
| `persistResource`  | resource writer (`writeResource`)                                          | h2        | Streams bytes; durable immediately     |
| `persistFile`      | file writer `writeAll`/`writeText`/`writeStream`                           | h2        | Streams bytes; durable immediately     |
| `appendData`       | `DataWriter.writeLine` → `repo.append`                                     | h2        | Incremental append; durable per request (live logs) |
| `deleteData`       | `repo.delete`, `repo.removeLatestMarker`                                   | ws        | Lifecycle/GC-aware methods use these   |
| `resolveSecret`    | `vaultService.get` / `getAnnotation`                                       | ws        | Authorized per step                    |
| `putSecret`        | `vaultService.put` / `putAnnotation` / `deleteAnnotation`                  | ws        | Vault writes — the mint model's own path |
| `readDefinition`   | `definitionRepository` reads                                               | ws        | Lazy-load; cacheable for the run       |
| `readOutput`       | `outputRepository` execution-history reads                                 | ws        | Optional context member; same lazy/cache rule |
| `resolveModel`     | catalog / `catalogStore`                                                   | ws        | Workflow step model resolution         |
| `getExtensionFile` | `context.extensionFile(relPath)` co-located assets                         | h2        | `GET /bundle/{fingerprint}/file/{relPath}`; cacheable by fingerprint |
| `log` / `event`    | run-event stream                                                           | ws        | Already serializable; flows to client  |

Completeness of this inventory is the correctness-critical task; it must be
re-walked against `MethodContext` whenever a context member is added, and it is
pinned behind the negotiated `protocolVersion`. Workers still hold no datastore:
artifact *bytes* (`getData` / `persistResource` / `persistFile` / `appendData` /
`getExtensionFile`) ride the HTTP/2 data plane, which also terminates at the
orchestrator; everything else is control-plane metadata.

Implementation note: the data-repository port also has synchronous members
(`listVersionsSync`, `findAllGlobalSync`, ...) that cannot make a network
round-trip, plus whole-store enumeration (`findAllGlobal`, `findAllForModel`)
and raw write/maintenance members (`save`, `allocateVersion`, `rename`,
`collectGarbage`, path accessors) that the verbs deliberately do not cover —
writes flow exclusively through the remote writers. On a worker, every one of
these fails loudly with an `UnsupportedOnRemoteWorkerError` naming the member
and pointing at the loopback executor, never silently.

The remaining context members deliberately do **not** proxy:

- **`repoDir`** points at a per-dispatch scratch directory on the worker.
  Workers carry no repository checkout, so reading repo *contents* through it is
  unsupported on a remote executor; a method that needs repo files runs on the
  loopback executor, or on a worker deployed with a checkout and labeled
  accordingly.
- **Local compute stays local.** Subprocess spawning (`Deno.Command` — the shell
  model), outbound network calls, and SDK clients (`cloudControlClientFactory`)
  execute on the worker. That is the point of remote execution: the compute —
  including the processes it spawns and the APIs it calls — runs where the
  worker runs. The credentials and environment such calls need arrive via the
  shipped environment (below) or vault-resolved inputs.
- **`createCelEnvironment`** constructs the CEL environment locally on the
  worker; its data-access leaves are the same remote proxies.
- **Provider code never ships.** Vault and datastore providers execute
  orchestrator-side *behind* `resolveSecret`/`putSecret` and the data verbs — a
  worker speaks verbs, never providers. Report providers are the exception:
  checks and reports run on the executor (see
  [Checks and reports](#checks-and-reports-run-on-the-executor)).
- **`followUpActions`** returned by a method ride back serialized on the
  dispatch result (`methodName`/`delayMs`/`maxRetries`; the
  `continueCondition` function cannot cross the wire — the orchestrator
  re-evaluates conditions against the returned handles), and the orchestrator
  performs them.

## The execution environment

Methods read ambient environment variables (`Deno.env`), and the processes they
spawn inherit them. On a single host that environment is the orchestrator's; a
worker host's own environment is an accident of deployment. To keep
local-equals-remote semantics, **the orchestrator snapshots its full environment
and ships it with every dispatch**. The worker holds the snapshot in memory for
the duration of the step, applies it to the method's execution context and to
any subprocesses the method spawns, and drops it when the step ends. Nothing is
persisted on the worker, and an idle worker holds no environment at all.

The snapshot **overlays** the worker's base environment rather than replacing
it, and a small fixed denylist of process-identity and host-runtime variables is
never shipped — the worker host's own values win for `HOME`, `USER`, `LOGNAME`,
`SHELL`, `PATH`, `PWD`, `TMPDIR`/`TEMP`/`TMP`, `HOSTNAME`, `TERM`, `XDG_*`,
`DENO_*`, and swamp's own `SWAMP_*` runtime variables. Shipping the
orchestrator's `HOME` or `PATH` would silently corrupt the worker's own runtime
(tool resolution, cache and config locations, subprocess lookup); these
variables describe *where the process is running*, which is precisely the thing
remote execution changes. The denylist is pinned in code and versioned with the
`protocolVersion`, so both sides agree on it.

This is also the secret-injection path for ambient credentials: cloud SDK calls
(`cloudControlClientFactory`), CLIs invoked by the shell model, and anything
else that authenticates from the environment works on a worker exactly as it
does on the orchestrator host. `env.*` runtime expressions are unaffected — they
already resolve orchestrator-side at dispatch time, consistently with
`vault.get(...)`; the shipped snapshot covers the *ambient* reads inside method
code and its subprocesses.

The deliberate trade-off: every dispatched step sees the orchestrator's whole
environment, so dispatching to a worker grants the same ambient access that
running on the orchestrator host would. Scoping the snapshot (allowlists per
token or per label) is a later refinement; v1 chooses single-host fidelity over
introducing a new partial-environment failure mode.

Because the overlay mutates the worker's process-global environment, **v1
workers execute dispatches serially** (one in flight per worker; an
overlapping dispatch is rejected with `worker_busy`). Parallel dispatch per
worker requires subprocess-level environment isolation and is future work —
fan-out comes from many workers, not from concurrency inside one.

## Shipping extension code

A worker resolves no extensions of its own. The dispatch references the extension
bundle by fingerprint; on a cache miss the worker fetches it from the
orchestrator's HTTP/2 data plane (`GET /bundle/{fingerprint}`) and loads it
**in-process** in its own swamp runtime. The bundle is the same `bundleSource`
swamp already builds (see
[execution-drivers.md](./execution-drivers.md#self-contained-bundling)); the
worker needs nothing pre-installed.

The fingerprint comes from the existing content-fingerprint cache
(`.swamp/driver-bundles/`, sha-256 over the bundle), and a worker caches what it
has already fetched — so a bundle is shipped at most once per worker per version.
This mirrors the versioned-handle data cache — code and data both cache by
content/version identity and travel over the same h2 data plane.

Built-in models ship **no bundle at all**: the dispatch carries a
`builtin:<type>` sentinel and the worker resolves the model from its own
binary's registry — enrollment already guaranteed version lockstep, and a
sentinel for a type the worker does not know is a loud
binaries-disagree error. Co-located extension assets — files resolved through
`context.extensionFile(relPath)` — are *not* inlined into the single-file JS
bundle; the worker prefetches the (small) asset tree via
`GET /bundle/{fingerprint}/files` + `GET /bundle/{fingerprint}/file/{relPath}`
before executing, because `extensionFile()` is synchronous and must resolve a
local path. Assets cache under the fingerprint like the bundle itself.

### Checks and reports run at the orchestrator, around the method body

As built, checks and reports keep their existing pipeline *position*, which is
**before and after the execution seam at the orchestrator** — this is where
they have always run relative to out-of-process execution, and remote dispatch
enters at exactly that seam (`DefaultMethodExecutionService`, where the
in-process executor used to be selected). Only the method body moves to the
worker; pre-flight checks, output records, deletion markers, and follow-up
actions run at the orchestrator with local repositories, unchanged. This
supersedes an earlier draft that ran checks worker-side: it preserves today's
semantics exactly, and report-provider bundles never need to ship. (The
dispatch protocol reserves `reportBundleFingerprints` should that ever
change.) Control-plane bookkeeping runs (worker/token/lease transitions)
skip per-run report artifacts so pool churn stays bounded.

## Data semantics

Two facts about swamp's data model shape the contract, both verified against the
current code.

### Writes are immediately durable, not staged

`context.writeResource` / `createFileWriter` call `repo.save()`
(`src/domain/models/data_writer.ts`, `unified_data_repository.ts`), which writes
the version directory, metadata, content, `latest` symlink, and catalog entry
*before the `await` resolves*. There is no buffer-and-commit-at-end model — and
the system depends on this: `method_execution_service.ts` deliberately collects
handles for data written **before a throw**, so a write-then-throw method (e.g.
a code-review `verdict=FAIL`, the issue-lifecycle model) leaves its data visible.

Consequences for the proxy model: a `persistResource` / `persistFile` is an
HTTP/2 `PUT` that completes only once `repo.save()` has persisted at the
orchestrator. There is **no staging layer to build**. A worker that writes 3 of 5
outputs then dies leaves 3 durable writes — exactly what a local process crash
does today.

Two `DataWriter` modes need an explicit remote shape:

- **`writeLine` (append)** promises per-line durability via `repo.append` — the
  live-log contract. Remotely it maps to the `appendData` verb: each request (a
  line or a small batch) is durable at the orchestrator once acknowledged, so a
  worker crash loses at most the unacknowledged tail — same as today.
- **`getFilePath` (direct file I/O)** hands the method a real path, typically so
  a subprocess can write output straight to it. There is no orchestrator path on
  a worker, so remotely the path is a **worker-local spool file**; `finalize()`
  uploads it as one streamed `PUT`. For this one mode, durability moves from
  write-time to finalize-time — a worker that dies mid-spool leaves *no* write
  rather than a partial file, the safer of the two divergences. Local behavior
  is unchanged.

### Data is versioned-immutable, not content-addressed

`DataId` is a random UUID (`src/domain/data/data_id.ts`), not a content hash.
A `DataHandle` is identified by the `(dataId, version)` tuple
(`src/domain/models/model.ts`). A pinned `(dataId, version)` is immutable
forever; a bare `dataId` resolves to `latest`, which mutates when a new version
is written.

This sets the **worker cache rule** precisely:

- **Cacheable:** artifact bytes keyed by `(dataId, version)`. Once fetched, that
  version never changes — safe to cache for the life of the worker, and a strong
  `ETag` on `GET /data/{dataId}/{version}` lets the runtime honor it for free.
- **Always live:** `latest` resolution and `queryData` results. `latest`
  resolution is a small control-plane RPC that yields a concrete version, which
  the worker then fetches (and caches) over h2.

"Lazy-load" therefore means "lazy-load *and* cache by versioned handle," which
collapses the round-trip cost of hot, immutable reads. The same immutability is
what gives worker-state data (above) free lifecycle history.

## Data plane: two transports

A worker never holds datastore configuration; all data still flows to the
orchestrator. But rather than hand-build chunking and flow control over one
socket, the orchestrator exposes **two worker-initiated transports**. The
realization that makes this clean: **the entire data plane is worker-initiated** —
a running method only ever *pulls* its inputs and *pushes* its outputs, and even
the bundle is pulled on a cache miss, so plain request/response suffices and no
server-push is needed.

- **Control plane — WebSocket** (worker-initiated, bidirectional, small messages):
  enrollment, dispatch, cancel, streamed run events, and the metadata capability
  verbs (`queryData`, `latest` resolution, `resolveSecret`, `readDefinition`,
  `resolveModel`, `log`). This is the symmetric two-registry protocol above.
- **Data plane — HTTP/2** (worker-initiated request/response, streamed): the
  byte-heavy operations only — read artifact content
  (`GET /data/{dataId}/{version}`), write artifact content (`PUT /data/...` →
  `repo.save()`), and bundle fetch on a cache miss (`GET /bundle/{fingerprint}`).
  HTTP/2 supplies multiplexing and per-stream flow control natively, so the
  chunking, credit accounting, and priority queues we would otherwise hand-roll
  come from the runtime. Deno streams request and response bodies, so memory stays
  bounded on both ends.

Implementation note: Deno negotiates HTTP/2 only via ALPN over TLS, so the
data plane runs h2 under `wss://`/`https://` deployments and HTTP/1.1 over
plain TCP — the handlers are identical either way, and the single listener
serves both the control socket and the data plane. The worker derives the
data-plane base URL from its connect URL (`ws → http`, `wss → https`) unless a
dispatch overrides it for split deployments.

Both connections are dialed **outbound by the worker**, so NAT-friendliness is
preserved. Ideally they are a *single* connection — a WebSocket bootstrapped over
an HTTP/2 stream via extended `CONNECT` (RFC 8441) — but Deno's WebSocket is
HTTP/1.1-based on both the server-upgrade and outbound-client sides and does not
implement RFC 8441 today, so v1 runs two worker-initiated connections that can
share one port via ALPN. Collapsing them to a single connection is a clean future
optimization if Deno gains RFC 8441 support. Versioned-immutable data is a natural
fit for h2: `GET /data/{dataId}/{version}` is an immutable, strongly-`ETag`'d
resource, freely cacheable by the worker and any intermediary.

### Authenticating the data plane

The two transports share one identity. At enrollment (over the control socket) the
orchestrator issues a short-lived **bearer token** as the session credential; the
worker presents it on every HTTP/2 request to prove it is an enrolled worker. Its
lifetime is deliberately short; the worker refreshes it over the control socket a
set interval before it would expire, so the window **slides** forward and an
active worker stays continuously authenticated with no hard cliff. A control-socket
reconnect also re-issues it.

Authorization on top of that authentication starts deliberately thin — it mirrors
single-host semantics and needs almost no new code:

- **Writes are constrained to the step's declared output specs.** This is already
  enforced by the data writer: `createResourceWriter` / `createFileWriter` throw
  on an undeclared spec (`Undeclared resource spec '<name>'`, `data_writer.ts`).
  Schema validation is deliberately *warn-only* in the writer today — it emits a
  `schema_validation_warning` event rather than rejecting — so spec-name
  enforcement, not schema enforcement, is the write-scoping guarantee. Because
  the orchestrator persists a worker's `PUT` through that same writer, a worker
  can only write to specs its model declares — no new authorization layer
  required.
- **Reads are unrestricted** — the status quo for `getData` / `queryData` on a
  single host. Tightening reads to a lease-scoped subset is a later refinement, not
  a v1 requirement.

## Scheduling, fan-out, and provisioning

The orchestrator owns the DAG (`WorkflowExecutionService`,
`src/domain/workflows/execution_service.ts`) and the worker pool — whose state
lives in swamp data ([above](#worker-state-is-swamp-data)). *Logical
provisioning* — admitting workers into that pool — is in scope for v1 and consists
of token issuance + enrollment + the data-backed pool + label dispatch.

Dispatch matches a ready step against the pool:

1. **Direct target (optional)** — a step may pin to a specific worker by its
   token name or `instanceUuid`. The scheduler routes only there, queuing until
   that worker is free or failing if it is not connected.
2. **Label selectors** — otherwise, does the worker match the step's required
   labels (`region=us-east`, `gpu`, a container/sandbox tag, etc.)? Isolation and
   environment requirements are expressed here, since there is no runtime axis.
3. **Platform/arch** — does the worker satisfy any platform constraint?
4. **Tiebreak** — least-loaded (or round-robin) among matching workers; queue
   when all matching workers are busy.

Label + platform matching plus direct targeting is the whole affinity story for
v1; data-locality affinity is explicitly not pursued yet. Because every capability
proxies home, **compute location and state location are fully decoupled** — a
step's data lives at the orchestrator regardless of which worker runs it. v1
dispatches at the **step** granularity, which is what yields fan-out *across*
workers; shipping a whole workflow to one worker is just the degenerate
single-worker case.

A step declares its requirements in workflow YAML with three new fields —
`target:` (worker name or `instanceUuid`), `labels:` (selector map), and
`platform:` — alongside the existing step fields; none of these exist today.
**`forEach` is the fan-out construct**: it already expands one step template
into N parallel instances (`ForEachExpansionService`), so `forEach` over a list
plus a label selector *is* "fan out across the fleet," with the existing
step-level `concurrency` field now capping in-flight dispatches rather than
in-process method runs.

v1 dispatch slots into the execution loop that exists: jobs and steps already
run concurrently within each topological level (`mergeWithConcurrency` in
`execution_service.ts`), so a dispatching step executor that awaits a worker
instead of running in-process fans out naturally — N ready steps in a level
become N concurrent dispatches, queuing (not failing) when no matching worker is
free. The known consequence: fan-out breadth at any moment is bounded by the
steps ready in the current topological level and their concurrency caps. A
free-running ready-step queue that dispatches across level boundaries is future
work, not v1.

### Host launching is a swamp workflow

Actively launching worker *hosts* is not a bespoke provider plugin — it is a
swamp workflow, which is why worker state living in swamp data matters. The two
pieces:

- **Token minting is a built-in model.** Its `mint` method records the
  enrollment-token data *and writes the token secret into a vault*, returning a
  vault reference (not the secret) as its output. A provisioning workflow calls
  it, then passes the reference downstream.
- **Worker-launch models are ordinary user extensions** — a model wrapping a k8s
  Job, a cloud VM API, etc., that reads the token via a `${{ vault.get(...) }}`
  expression and boots the swamp binary with the token and orchestrator URL so it
  dials home. swamp ships the *mechanism*; the cloud/k8s integrations are authored
  as extension models.

Because the token's plaintext only ever lives in the vault, it never lands in
persisted workflow run data. A provisioning workflow can `data.query` the pool,
decide how many workers to add, mint that many tokens, and fan out launch steps —
and an autoscaler is simply that workflow on a schedule. There is no
chicken-and-egg: the provisioning workflow runs on the orchestrator's **loopback
executor**, so the first workers launch with an empty pool; once they enroll,
later provisioning can itself fan out across them.

## Failure, reconnection, and retry

The immediate-write contract makes naive retry unsafe. Writes are **not
idempotent**: `dataId` is a fresh UUID and each save bumps a version counter, so
re-running a step that already wrote produces duplicate versions and orphaned
artifacts. Reconnection and retry are both governed by that single constraint.

Liveness is the **control socket**; a data-plane HTTP/2 request that fails is
per-request — a failed read is simply retried (reads are idempotent), and a failed
write is the ambiguity case below. When the control socket drops with a step in
flight, the orchestrator holds the step lease through a **reconnection grace
window** (bounded by the token lifetime) before giving up — so reconnection and
re-dispatch never race into double execution:

- **Worker reconnects within the window** (same `{token, machineId}`): it
  stays in the pool — same member, fresh session credential. As built, an
  in-flight dispatch does **not** survive the drop: the RPC pending state dies
  with the socket on both ends, and the worker aborts its in-flight execution
  when the channel closes (so a reconnected worker can never double-execute).
  If the step had **not written**, it is simply re-dispatched — to the
  reconnected worker or any other match — which is observably equivalent to
  resuming. If a **write** had landed, the step fails the run per the
  write-then-fail rule below.
- **Worker does not reconnect within the window:** the lease ends the same
  way. A **no-write** step re-dispatches to another matching worker; a
  **write-bearing** step fails the run and surfaces the partial state — exactly
  as a local mid-method crash leaves partial data today. swamp does not
  auto-retry crashed methods locally either, so this is not a regression.

Transparent re-dispatch (or mid-step resume) of a write-bearing step is a later
feature that must first solve write idempotency. It is not promised in v1.

## Security and trust

The proxy-everything model with shipped code is a net security improvement over
provisioning credentials and extensions onto workers:

- A worker holds **no datastore or vault credentials, no datastore config, and no
  pre-installed extensions**. It reads or writes only what the orchestrator hands
  it, and runs only the bundle it was dispatched. The one deliberate exception is
  the per-dispatch environment snapshot
  (see [The execution environment](#the-execution-environment)): while a step is
  in flight, the worker holds the orchestrator's ambient environment in memory,
  scoped to that step's lifetime. The orchestrator sees *every*
  capability call and authorizes every data-plane request against the step lease,
  so it is a natural authorization and audit chokepoint. Per-step secret scoping
  is the orchestrator refusing a `resolveSecret` outside the dispatched step's
  allowed set. Vault secrets are resolved orchestrator-side and travel only for
  the step that needs them (consistent with the out-of-process resolution pattern
  in [execution-drivers.md](./execution-drivers.md#vault-secret-resolution)).

- The **enrollment token** is named, time-boxed for first redemption, and
  enrolls exactly one machine, binding to the worker's durable `machineId`. The
  `{token, machineId}` pair is a *bearer* reconnection secret rather than
  proof-of-possession — the machine id is client-asserted, so the binding
  contains *accidental* token reuse (pasting one token onto a second box),
  not an attacker who holds the plaintext. That is acceptable because the pair
  rides the authenticated, encrypted `wss://` channel and the only ways to
  capture it are to MITM the TLS (mitigated by pinning the orchestrator
  certificate) or to compromise the worker host (which already grants code
  execution there, so no additional ground is lost). The **session credential**
  for the data plane is short-lived and lease-scoped. Lifetimes should be
  short — a token leaked *before* enrollment is the real exposure, since an
  attacker could enroll first. Expiry is enforced actively: the orchestrator
  disconnects a connected worker when its token lifetime elapses, and `revoke`
  cuts a token off early.

- Conversely, a worker tricked into connecting to the wrong URL hands code
  execution on its host to whoever owns that URL — the same trust model as a
  self-hosted CI runner. The worker should pin the orchestrator's certificate;
  both channels are authenticated and encrypted.

## What is reused vs. new

| Concern                          | Status                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Control protocol + multiplexing  | **Reuse** `src/serve/protocol.ts`, `connection.ts`, `serializer.ts`                     |
| Serializable execution envelope  | **Reuse** `ExecutionRequest` / `ExecutionResult` (serialize `followUpActions`; the envelope never carried driver fields) |
| Extension bundle + fingerprint   | **Reuse** `bundleSource` + `.swamp/driver-bundles/` cache; fetched over h2 on miss; report bundles + co-located assets ship the same way |
| Checks and reports pipeline      | **Reuse** — run on the executor unchanged, over the proxied context                      |
| Pure injectable operations       | **Reuse** libswamp `*Deps` + `MethodContext` injection seam                             |
| Worker/token/lease persistence   | **Reuse** the datastore + catalog — built-in models, not a private registry             |
| Out-of-process secret resolution | **Reuse** the resolve-before-dispatch pattern                                           |
| Run-event serialization          | **Reuse** `serializeEvent()`                                                            |
| Driver abstraction               | **Remove** `ExecutionDriver`, raw/docker/custom drivers, registry, `driver:` fields      |
| Role split (server ≠ executor)   | **New** — move request-dispatch handling to the dial-out side; two handler registries   |
| Enrollment handshake             | **New** — token redemption, machine binding, label exchange, session-credential issue    |
| Built-in worker-management models| **New** — `worker`, `enrollment-token`, `step-lease`; `swamp worker token` + mint model   |
| Remote `MethodContext` adapters  | **New** — proxy implementations of the repository/vault/data-writer ports               |
| Capability protocol verbs        | **New** — the 14-verb reverse channel split across ws (metadata) and h2 (bytes)         |
| Environment shipping             | **New** — per-dispatch orchestrator env snapshot, worker-memory only                     |
| Spool + append write modes       | **New** — worker-local spool for `getFilePath`; `appendData` verb for `writeLine`       |
| HTTP/2 data plane + auth          | **New** — worker-initiated bulk transfer; bearer-token auth, existing spec-write enforcement |
| Label scheduler + direct target  | **New** — data-backed pool registry, label/platform matching, target-by-name/uuid; step-level `target:`/`labels:`/`platform:` YAML fields |
| Lease + reconnection + failure   | **New** — grace window, in-flight read resume, write-then-fail                           |
| `swamp worker connect` command   | **New** — the dial-home CLI entry                                                        |

## v1 scope and non-goals

In scope:

- Worker dial-home + enrollment over `wss://` with a named, time-boxed token that
  enrolls once and reconnects the same `{token, instanceUuid}` for its lifetime;
  `swamp worker token` commands and a built-in mint model that writes the token to
  a vault.
- Drivers removed: in-process execution everywhere, isolation as a worker
  deployment property, the local loopback executor for single-host.
- Extension code fetched over the data plane on a cache miss and loaded
  in-process — model and report bundles, plus lazy co-located asset fetch.
- Remote `MethodContext` with the full 14-verb capability protocol proxied home,
  including the spool-on-finalize `getFilePath` and per-request-durable
  `appendData` write modes; checks and reports run on the executor.
- Per-dispatch environment shipping: the orchestrator's full env snapshot,
  worker-memory only, applied to the method and its subprocesses.
- A WebSocket control plane plus a worker-initiated HTTP/2 data plane for bulk
  transfer — native multiplexing/flow control, no hand-rolled framing.
- Worker/token/lease state persisted as swamp data by built-in models and
  queryable, with declared retention (`garbageCollection`/`lifetime`) and
  periodic orchestrator-run GC; token/lease transitions serialized in the
  orchestrator process.
- Versioned-handle read caching on the worker.
- Label + platform scheduling, plus direct targeting by worker name/uuid, over an
  orchestrator-owned, data-backed pool; step-level `target:`/`labels:`/
  `platform:` fields, with `forEach` as the fan-out construct and dispatch
  slotted into the existing level-parallel execution loop.
- Reconnection grace window; fail-the-run-on-write-then-drop failure semantics.
- Host launching as swamp workflows (mint model → vault → launch model → dial
  home), bootstrapped on the loopback executor.

Explicit non-goals for v1:

- **Remote datastore configuration for workers.** Workers never hold datastore
  config; all data terminates at the orchestrator. Revisit only if the ceiling
  bites.
- **Data-locality scheduler affinity.** Label/platform/direct targeting only.
- **Shipping cloud/k8s launch integrations.** swamp ships the mint model and
  dial-home contract; the launch models are user-authored extensions.

## Known limits

- **Latency amplification.** In-process capability calls are nanoseconds; over
  the wire each becomes a round-trip. Versioned-handle caching, the h2 data plane,
  and concurrent control RPCs mitigate it; the write path stays synchronous by
  contract.
- **Orchestrator as the data plane and SPOF.** Every read, write, secret,
  definition load, and catalog lookup — plus all worker-state bookkeeping —
  terminates at the orchestrator and its one datastore, so total throughput and
  availability are bounded by it, not by worker count. This is the accepted trade
  for credential-free workers and a single durable authority.
- **Two-transport correlation.** Until Deno supports RFC 8441, control (ws) and
  bulk (h2) are two separate worker-initiated connections sharing one identity via
  the session bearer token. Modest new surface — and the price of offloading
  framing to HTTP/2 rather than hand-rolling it.
- **Level-bounded dispatch.** v1 dispatches inside the existing level-parallel
  execution loop, so fan-out breadth at any moment is bounded by the steps ready
  in the current topological level and their concurrency caps — not by fleet
  size. A cross-level ready-step queue is future work.
- **Whole-environment dispatch.** Every dispatched step receives the full
  orchestrator environment snapshot; per-token or per-label env scoping is a
  later refinement.

