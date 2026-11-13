---
audience: operator, maintainer
enables: [serve]
last-verified: 2026-11-13 @ 8c9a21d85
---

# Serve workspaces

**Status:** Plan. Nothing here is built. It describes how one address hosts
several serves, which promoting a local workspace to a server assumes.

## Outcome

A team runs one host at one address. Several teams each have a **hosted
workspace** on it: their own definitions, datastore, vaults, schedules,
webhooks, grants and tokens. A person or a CI job points a client at a
workspace's address and everything works as it does against a serve today.

```
https://serve.acme.internal/              the root workspace
https://serve.acme.internal/w/edge-dns    a hosted workspace
https://serve.acme.internal/w/cost-reports
```

A hosted workspace is not an entry in the local workspace registry that
[workspace](./workspace.md) describes. That registry lists repos on a person's
machine. A hosted workspace lives on a host.

## The idea

**A hosted workspace is a whole serve.** It is an ordinary `swamp serve`
process for an ordinary repo, reached through a path on the host's address.
Nothing serve does is redone for many tenants. Authentication, grants, tokens,
audit, the scheduler, webhooks, the worker gateway and the datastore API all
stay per serve, so they are per workspace by construction.

**The host is not a serve.** It is a small process, `swamp serve host`, that
holds the listener, forwards each request to the right serve and keeps the
serves running. It has no repo. It loads no extension, opens no datastore and
authenticates no one.

Three things are new:

1. **Addresses with a path.** A workspace's server address is
   `<host address>/w/<name>`. Every client builds its requests from the whole
   address, not from its origin.
2. **The host.** A router and a supervisor in one process.
3. **Workspace lifecycle.** Creating, listing, suspending and deleting a
   workspace are requests to the root workspace.

The **root workspace** is the serve that answers every path outside `/w/`. It
is a child of the host like any other, and it is the one that takes lifecycle
requests. A host can run without one.

## Why this shape

**One swamp process serves one repo.**

- The extension type registries (models, vaults, datastores, reports, webhooks)
  are process-wide and keyed by type name. Two repos that define the same type
  would collide.
- Several process-wide holders carry one repo's object: the remote step
  dispatcher, the worker pool reader, remote-only mode, the datastore lock gate
  and the auto-resolver.
- Extension code runs in the serve process, unsandboxed.
- Some failures are the process's: a serve that loses its datastore's writer
  lease exits 75.

Hosting several repos in one process means making all of that per-repo, and
moving extension code out of the process so one workspace cannot stall or crash
the others. A process per workspace needs none of it, and a later move to one
process would not change anything a client sees.

**The host runs no repo code.** If the listener lived in a serve, that serve's
extensions could stall or crash it, and its exit 75 would stop every workspace
with it. Kept apart, a failing serve is one child restarting, the root
included. The local dashboard's hub already runs this way.

**Access control is written for one datastore.** Tokens, grants, groups and
delegations are records in the serve's own datastore, and
[access-control](../enablers/access-control.md) reasons about them together.
Keeping each workspace a whole serve keeps that design intact. A person still
signs in once; see [Sign-in](#sign-in).

**One writer per v3 datastore.** The writer lease covers the whole datastore, so
two serve processes cannot write two namespaces of one datastore. A hosted
workspace has its own datastore.

**The address is already keyed with its path.** `normalizeServerUrl` keeps the
path, so `servers.json` credentials, the datastore owner claim and a team-mode
checkout's copy already tell `…/w/edge-dns` from `…/w/cost-reports`.

## Addresses

Most clients already build their requests from the normalized address with its
path: the CLI's WebSocket and `/api/v1/request` calls, `auth server-login`,
`workflow cancel` and the v3 datastore client. One client is known to drop the
path:

- The worker's data-plane client derives its base URL from the connect URL with
  the path reset to `/`, and resolves each route against that base as an
  absolute path (`src/worker/data_plane_client.ts`).

The fix is to keep the connect URL's path in both places. The proof is a test
that runs every client against a serve stand-in behind a forwarder that strips
a prefix. A client the list above missed fails there.

Serve needs no change for this. Behind a forwarder it already takes the public
host name in `--trusted-hosts` for its `Host` and `Origin` checks, and reads
the caller's IP from the forwarding header with `--trust-proxy`. Its `--address`
already names the address clients use, which the owner claim compares. The URLs
serve hands out in `/auth/info` and the device flow are the OAuth provider's,
not its own.

This part stands alone: it lets an ordinary serve sit under a path on a shared
reverse proxy. The dashboard is the exception; see [Dashboard](#dashboard).

## The host

`swamp serve host` runs in a **host folder**:

```
<host folder>/
  host.yaml            the listener, the public address, the root, an OAuth client
  workspaces/<name>/   one repo per hosted workspace
```

The host folder is not under `<data dir>/workspaces`. That folder belongs to
the local workspace registry, which keeps its create locks there and adopts the
repos it finds there on its first read.

The host holds the listener and its TLS certificate. A request whose path
starts with `/w/<name>/` goes to that workspace's serve with the prefix
removed. Every other path goes to the root workspace's serve unchanged, or
answers 404 when the host has no root.

```
                 https://serve.acme.internal
                              │
                  swamp serve host                  no repo, no extensions,
                  ├─ router ─────────────────┐      no datastore
                  └─ supervisor              │
                        │                    ▼   127.0.0.1:<port>
          ┌─────────────┼─────────────┬─────────────┐
     swamp serve   swamp serve   swamp serve   swamp serve
     (root, at /)  (edge-dns)    (cost-reports) (…)
                                            each: own repo folder, datastore,
                                            vaults, grants, tokens, schedules
```

**Router.** It forwards HTTP requests with their bodies streamed in both
directions, never buffered, so SSE and the worker data plane pass through. A
WebSocket is relayed frame by frame between the caller's socket and one the
router opens to the child, with the query, subprotocols, `Origin` and cookies
carried over. The router passes `Authorization`, `Host` and cookies through
untouched: each serve authenticates its own callers and the router adds no
credential. It overwrites the forwarding header with the caller's address, so a
caller cannot supply its own. A host that is itself behind a proxy is told so
in `host.yaml` and passes on the address that proxy reports. A workspace that
is not running answers 503 with its state. An unknown name answers 404.

The worker data plane is HTTP/2 only under TLS and HTTP/1.1 over plain TCP,
with the same handlers. The hop from the router to a child is plain loopback
TCP, so the child side needs nothing new.

The local dashboard's hub also forwards `/w/<name>/…`
(`src/serve/local/workspace_hub.ts`), but only a fixed list of reads to a
read-only child. The router is new code with the same path shape.

**Supervisor.** One `ManagedServe` per child holds the wanted state, the
observed state, the crash count and the backoff. Its `step` is pure: from one
event and the time it returns the next state and one action (spawn, stop or
wait). Observed states are `stopped`, `starting`, `ready`, `backoff` and
`failed`.

- `starting` becomes `ready` when `GET /ready` on the child's port returns 200.
  Serve listens before it is ready, so a listening port is not enough.
- Exit 75 means a restart is safe, as after a lost writer lease. The child is
  started again after a short backoff and the exit never counts as a crash.
- Any other exit the host did not ask for is a crash: exponential backoff,
  capped. Repeated crashes inside a window hold in `failed` until someone
  resumes the workspace.
- Stop is SIGTERM, so serve's drain path runs.

**Children.** Each child is `swamp serve --json` in its repo folder, configured
by that repo's own `serve.yaml`. The host adds `--host 127.0.0.1`, `--port 0`,
`--address` with the child's public address, `--trusted-hosts` with the host's
public name, `--trust-proxy` and `--exit-on-stdin-close`. The child reports the
port it got on its `--json` listening line. A workspace is also given the
root's address, which [Sign-in](#sign-in) uses. The child's environment is set
explicitly.

`--exit-on-stdin-close` is a new hidden flag: serve starts its drain when stdin
reaches end of file, as the dashboard child already does. The host keeps each
child's stdin open, so a child never outlives the host and the host needs no pid
files and no orphan clean-up. Stopping the host stops its children through
their drain paths first.

**The root workspace** is the repo `root:` names in `host.yaml`. An existing
serve becomes a root by naming its repo there and keeping its settings in its
`serve.yaml`. Its address does not change.

**The folder is the list.** Every repo folder in `workspaces/` whose name is a
workspace name is a workspace. The supervisor watches the folder. An operator
can make a workspace by hand, and the lifecycle below does the same thing.

## A hosted workspace

A hosted workspace is a repo folder, `<host folder>/workspaces/<name>/`. It
has:

- **Its own datastore**, the one a new repo gets, inside its folder. Pointing
  it at a bucket is ordinary datastore setup, run in the folder while the
  workspace is suspended.
- **Its own vaults**, configured in the workspace like any repo's.
- **Its own access records.** Its `serve.yaml` is written at creation: the
  root's auth mode, OAuth provider and admission lists, and the workspace's own
  `admins`.
- **Its own schedules, webhooks and workers**, at its own address. A webhook URL
  is `<host address>/w/<name>/<route>`. A worker that connects to the
  workspace's address works for that workspace.

In `oauth` mode a serve without a client registers one on first start, which
needs a collective key or a person. `host.yaml` can name one OAuth client and
its secret file. The host passes it to each child with the existing
`--oauth-client-id` and `--oauth-client-secret-file` flags, so a new workspace
starts unattended.

Names follow `parseWorkspaceName`. A name is the workspace's address, and its
tokens, owner claim and checkouts' copies are keyed by that address, so a
workspace is never renamed.

## Lifecycle

The root workspace takes the lifecycle requests. Its grants decide who may make
them and its audit log records each one. The host gives the root the
`workspaces/` folder, and a serve without it refuses these requests.

| Request             | Does                                                                                           | Needs on the root             |
| ------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| `workspace.create`  | Makes the folder, sets up the repo, writes its `serve.yaml` with the caller as its first admin | `write` on `workspace:<name>` |
| `workspace.list`    | Names, addresses and states                                                                    | any authenticated principal   |
| `workspace.get`     | One workspace: state, restarts, the supervisor's reason when it is not ready                   | `read` on `workspace:<name>`  |
| `workspace.suspend` | Stops its serve and keeps everything; `resume` starts it again                                 | `admin` on `workspace:<name>` |
| `workspace.delete`  | Stops its serve and removes its folder                                                         | `admin` on `workspace:<name>` |

`workspace` is a new resource kind in grants. With no grant naming it, only the
root's admins can make these requests. A grant such as
`allow write workspace:data-*` to a group lets that group create its own.

The root and the supervisor never call each other. They share two small files
per workspace, beside its folder:

- **Wanted**, written by the root: `active`, `suspended` or `deleted`, with the
  creator and the time. A folder without one is `active`.
- **Status**, written by the supervisor: the observed state, the restart count
  and the reason when it is not ready.

`create` sets the repo up in a folder under a temporary name and renames it
into place, so the supervisor never starts half a workspace. `delete` writes
`deleted`. The supervisor stops the serve, then removes the folder and both
files. A host that stopped halfway finishes at its next start.

Setting up a repo runs as a child process in its folder. The root's process
never loads another workspace's extensions.

The root's admins hold the lifecycle, not the contents. They are not principals
inside a workspace unless its own admins add them. When a workspace's admins
are gone, an operator on the host suspends it, edits the admins in its
`serve.yaml` and resumes it.

CLI: `swamp serve workspace create|list|get|suspend|resume|rm`, each with log
and json output, each a request to the root at the host's address.

## Sign-in

A person signs in once, to the root. Each workspace still mints and checks its
own tokens, so every access record stays in the workspace.

1. The client asks the root for a sign-in code for one workspace
   (`workspace.sign-in`). The root gives any authenticated principal a
   single-use code that names the workspace and expires within a minute.
2. The client gives the code to the workspace (`POST /auth/exchange`).
3. The workspace redeems the code at the root and sends its own name with it.
   The root refuses a code that names another workspace. Otherwise it answers
   once with who the code was issued to: the principal, the username and the
   collectives.
4. The workspace applies its own admission lists and mints its own server
   token for that principal.

The root token never reaches a workspace, where extension code could read it. A
code taken to any workspace but the one it names is refused there.

The CLI does this by itself. Given a server address `<address>/w/<name>` and no
stored token for it, it exchanges when it holds a token for `<address>` and the
workspace's `/auth/info` offers the exchange. `swamp auth server-login` to a
workspace's address still works. A serve that was given no root address offers
no exchange.

A workspace token lives no longer than the root token it came from, and its
collectives are the ones the root knew at the exchange. The exchange is the
same in `token` mode, so the creator of a workspace reaches it with the token
they already hold.

## Dashboard

The root serves the dashboard bundle once, at `/dashboard/…`. The bundle
already knows a workspace segment: a workspace's pages are
`/dashboard/w/<name>/…` and their server calls go to `/w/<name>/…`
(`packages/dashboard/src/client/workspace_path.ts`). Three things stand between
that and a hosted workspace:

- The page takes a workspace segment to mean the local dashboard. It asks for
  the local token and its switcher reads the local hub's list. Under a host it
  signs in to the workspace's serve, and its switcher lists what
  `workspace.list` returns.
- Serve's dashboard session cookie has one name and `Path=/`, so the root's
  and every workspace's would overwrite each other. A serve with a path in its
  `--address` names its cookie for that path and scopes it to that path.
- Every workspace shares one browser origin. The pages are all swamp's own
  dashboard, so one workspace's page is not another tenant's code, but a
  script-injection bug in the dashboard would reach every workspace a browser
  is signed in to.

## What a client sees

- **CLI.** `--server <host address>/w/edge-dns`, or that address in
  `serverAddress`. A sign-in to the host's address covers it, and
  `servers.json` keeps the workspace's token under the workspace's address.
- **Team mode.** A v3 checkout whose serve address is a workspace's address
  writes through that workspace's datastore API. `swamp datastore claim` names
  the workspace's address as the owner.
- **Workers.** `swamp worker connect <workspace address>`.
- **Integrations and webhooks.** Every `/api/v1/…` and webhook route, under the
  workspace's path.
- **Dashboard.** `<host address>/dashboard/w/edge-dns/`, with its own sign-in.

## Domain model

| Concept           | Building block      | Notes                                                                                           |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `HostedWorkspace` | Aggregate root      | Name, creator, wanted state; the wanted file is its store                                       |
| `ManagedServe`    | Entity              | Wanted state, observed state, crash count, backoff; property-tested over random event sequences |
| Workspace router  | Host transport      | Prefix match, forward, 503 and 404; in `src/serve/host/`                                        |
| Provisioner       | Application service | Sets a repo up under a temporary name as a child process and renames it into place              |
| `workspace`       | Resource kind       | In `resource_selector.ts`; `read`, `write`, `admin`                                             |
| Sign-in code      | Value object        | Workspace name, principal, expiry; single use; kept by the root                                 |

The server address stays the string `normalizeServerUrl` returns. Tests follow
the ddd skill: property tests for `ManagedServe` and for `HostedWorkspace`
state changes, and an integration test with a host in-process, a fake process
port and port-0 serve stand-ins behind the router. That test covers a request
and reply, a streamed body each way, SSE, a WebSocket, a 503 for a stopped
workspace and a 404 for an unknown one. A fitness rule keeps `src/serve/host/`
from importing the model, vault and datastore registries.

## Execution plan

Each item is one lab issue and one PR. Each leaves `main` working and can ship
on its own. The four groups are the phases, in order. Journeys that spawn the
binary belong in `swamp-uat` and are not listed.

### Addresses with a path

1. **The worker's data plane keeps the connect URL's path.**
   `dataPlaneUrlFromConnectUrl` keeps the path, and the client joins each route
   onto its base instead of resolving it as an absolute path. Done when a
   worker connected at `…/w/x` sends its data-plane requests under `/w/x/`
   (`src/worker/data_plane_client.ts`).
2. **Every client works behind a prefix.** An integration test puts a forwarder
   that strips a prefix in front of an in-process serve and runs each client
   through it: the CLI's WebSocket and `/api/v1/request` calls, server login,
   workflow cancel, the v3 datastore client, and a worker's control socket and
   data plane. A small fix for a client that fails goes in the same PR. A large
   one becomes its own issue. After 1.

After these two, an ordinary serve works under a path on a shared reverse
proxy, without its dashboard.

### The host

3. **`serve --exit-on-stdin-close`.** A hidden flag. End of file on stdin
   starts the same drain SIGTERM starts. Done when a serve whose stdin closes
   drains and exits 0, and a serve without the flag ignores its stdin
   (`src/cli/commands/serve.ts`).
4. **`ManagedServe`.** The entity and its pure `step`: the five states, the
   exit 75 rule, crash counting and backoff. No I/O. Its property test runs
   random event sequences and checks that the backoff never passes its cap,
   that exit 75 never raises the crash count and that `failed` is left only by
   a resume (`src/domain/serve/`).
5. **The supervisor.** It drives one `ManagedServe` per child through a process
   port: spawn, read the port from the listening line, poll `/ready`, SIGTERM,
   hold stdin. Tests use a fake port. The `Deno.Command` adapter stays thin,
   since tests here do not spawn processes. After 3 and 4.
6. **The router.** Prefix match, streamed HTTP forward, WebSocket relay, the
   forwarding header, 503 and 404. It takes a lookup from name to port and
   state, so it needs no supervisor. Done when the integration test in
   [Domain model](#domain-model) passes (`src/serve/host/`).
7. **`swamp serve host`.** It reads `host.yaml`, scans and watches
   `workspaces/`, starts the root and each workspace with the child flags, and
   listens with TLS. Log and json output. The fitness rule for
   `src/serve/host/` lands here. Done when a root and two workspaces made by
   hand answer at their own addresses. After 5 and 6.

After 7 an operator who sets each workspace up has a multi-workspace host.

### Lifecycle and sign-in

8. **Wanted and status files.** `HostedWorkspace` and its file store. The
   supervisor stops a suspended workspace, removes a deleted one and writes
   each status. Done when an operator can suspend and resume a workspace by
   editing its wanted file. After 7.
9. **The host passes an OAuth client to its children.** `host.yaml` names the
   client and its secret file. Done when a workspace in `oauth` mode starts
   with no stored client and no collective key. After 7.
10. **Workspace services.** The provisioner and the application services for
    create, list, get, suspend, resume and delete, working on the host folder.
    Create sets up under a temporary name and renames into place. The services
    are exported from `mod.ts`, and an integration test runs them on a temp
    folder (`src/libswamp/hosted_workspace/`). After 8.
11. **Workspace requests on the root.** The host gives the root the
    `workspaces/` folder, and serve handles `workspace.*`: protocol types,
    request schemas, the follower lists, authorization for the root's admins
    and audit. A serve without the folder refuses them, and a token-mode root
    refuses `create`. After 10.
12. **`swamp serve workspace` commands.** `create`, `list`, `get`, `suspend`,
    `resume` and `rm`, each with log and json output. After 11.
13. **A `workspace` kind in grants.** `workspace` joins the resource kinds and
    the lifecycle requests check it: `write` to create, `read` to get, `admin`
    to suspend, resume and delete. Root admins pass as before. The access
    suites cover the new kind (`src/domain/access/resource_selector.ts`). After
    11.
14. **The sign-in exchange on serve.** The root issues and redeems sign-in
    codes. A workspace offers `/auth/exchange`, says so in `/auth/info` and
    mints a token from a redeemed code. The host passes each workspace the
    root's address. A token-mode root stops refusing `create`. Done when the
    holder of a root token gets a working workspace token, the root token is
    sent only to the root, and a code for one workspace is refused at another.
    After 11.
15. **The CLI signs in to a workspace through the root.** Credential lookup
    exchanges when it has no token for a workspace's address and holds one for
    the host's. Done when `--server <host address>/w/<name>` works after one
    `server-login` to the host. After 14.

### Dashboard

16. **A dashboard session cookie per path.** A serve with a path in its
    `--address` names its cookie for that path and scopes it to that path. A
    serve without one is unchanged (`src/serve/dashboard_session_handler.ts`).
17. **Sign-in under a workspace segment.** The page tells a host from the local
    dashboard by `/auth/info`, and under a host it signs in to the workspace's
    serve instead of asking for the local token. After 16.
18. **The switcher lists the host's workspaces.** Under a host it reads
    `workspace.list` from the root. After 11 and 17.

Issues 16 and 17 need only the first two groups, so the dashboard can proceed
beside the lifecycle. Promoting a local workspace builds on issues 13 and 15
and is designed separately.

## Limits

- **Tenants that do not trust each other.** Workspace processes run as one OS
  user, and extension code runs inside them. Code in one workspace can read and
  write another's folder, vault key, datastore files and wanted file, and read
  the OAuth client secret the host passes. This design separates failures, not
  hostile code.
- **One host.** A workspace's folder is on one machine, and its serve listens
  on that machine's loopback.
- **Lifecycle and sign-in need the root.** While the root is down no workspace
  can be created, suspended or deleted through the API, and no sign-in code is
  issued. Running workspaces and tokens already minted are not affected.
- **A workspace token outlives changes on the root.** Revoking a root token, or
  a change to the person's collectives, reaches a workspace only when its
  token expires. A workspace's admins can revoke the token there.

## Later

- **Several hosts.** Serve nodes of one workspace on different hosts must reach
  each other, and a node's advertised address has no path today
  (`normalizeAdvertiseAddress`). The v3 datastore client also follows a leader
  by origin. Each host would also need its own copy of a workspace's folder.
- **A shared worker pool.** A worker that connects to the host and works for
  several workspaces. Until then a workspace's serve runs its own steps, or
  takes workers at its own address.
- **A datastore chosen at creation**, from a template in the host's config, or
  shared with the caller's own remote datastore.
- **A host name per workspace**, for a browser origin each.
- **One process.** Per-repo registries and out-of-process extension code, behind
  the same addresses.

## Open questions

- **What swamp-club sees.** Each workspace is a serve: it sends its own
  heartbeat and registers its own instance. Is one OAuth client used from many
  workspace addresses acceptable there, and should a host appear as one serve?
