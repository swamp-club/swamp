---
audience: operator, maintainer
enables: [serve]
last-verified: 2026-11-18 @ 253ee3d17
---

# Serve workspaces

**Status:** Partly built. Addresses with a path and the host (steps 1 to 7 of
the [execution plan](#execution-plan)) are built, as is default off (step 20):
`swamp serve host` lists every workspace folder and runs a serve for each one
whose wanted file says `active`. Lifecycle, sign-in and the dashboard are not.
It describes how one address hosts several serves, which promoting a local
workspace to a server assumes.

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
machine. A hosted workspace lives on a host. A host will also recognize the
workspaces in that registry and serve one when asked.
[The host](#the-host) describes that plan.

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

The worker cannot keep its whole connect path, or even infer the prefix a
forwarder removed: serve accepts a control socket on any path, so existing
proxies that route the socket on a path of its own reach serve today with the
data plane at the root, and either inference would move them. The prefix is
therefore declared, never inferred. A forwarder that removes a prefix sends it
in `X-Forwarded-Prefix`; serve reads that header only with `--trust-proxy` and
passes it to the worker in the enroll reply (`forwardedPrefix`). The worker
keeps the prefix only when it starts its own connect path, and the client joins
each route onto that base instead of resolving it as an absolute path. Without
the header every worker keeps the root, as now. Only the origin of an explicit
`--data-plane-url` is used; a path in it is ignored. The proof is a test that
runs every client against a serve stand-in behind a forwarder that strips a
prefix. A client the list above missed fails there.

Apart from passing that header on, serve needs no change for this. Behind a
forwarder it already takes the public host name in `--trusted-hosts` for its
`Host` and `Origin` checks, and reads the caller's IP from the forwarding header
with `--trust-proxy`. Its `--address` already names the address clients use,
which the owner claim compares. The URLs serve hands out in `/auth/info` and the
device flow are the OAuth provider's, not its own.

This part stands alone: it lets an ordinary serve sit under a path on a shared
reverse proxy. The dashboard is the exception; see [Dashboard](#dashboard).

## The host

`swamp serve host` runs in a **host folder**. It is a hidden command for now:
it runs, but serve's help and `swamp help serve` do not list it.

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
answers 404 when the host has no root. The `/w/` prefix belongs to the host, so
a route the root's repo defines under `/w/`, such as a webhook route, is never
reached.

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
carried over. The router passes `Authorization`, `Origin` and cookies through
untouched: each serve authenticates its own callers and the router adds no
credential. It overwrites `X-Forwarded-For` with the caller's address,
`X-Forwarded-Host` with the caller's `Host` and `X-Forwarded-Proto` with the
listener's protocol, so a caller cannot supply its own. Serve reads the
protocol for its dashboard session cookie's `Secure` flag and expected origin,
so the router, which terminates TLS, must send it. It sets
`X-Forwarded-Prefix` to `/w/<name>` for a workspace and removes it for the
root, so a worker's data plane follows the workspace it connected to. A host
that is itself behind a proxy is told so in `host.yaml` and passes on what that
proxy reports, with a workspace's `/w/<name>` appended to the proxy's prefix. A
workspace that is not running answers 503 with its state. An unknown name
answers 404.

HTTP goes to the child over `node:http`, not `fetch`: Deno's `fetch` sends a
streamed body chunked and drops its `Content-Length`, which the v3 datastore's
chunk upload requires. `node:http` keeps `Content-Length` and `Host` and does
not decode the reply. A WebSocket is opened with Deno's client, which sets
`Host` from the URL, so a child reads the public host from `X-Forwarded-Host`.
That client cannot see why a child refused a handshake, so a refused upgrade
reaches the caller as 502.

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
- Exit 75 from a ready child means a restart is safe, as after a lost writer
  lease. The child is started again after a short backoff and the exit never
  counts as a crash. Serve also exits 75 for a temporary refusal at startup,
  such as an unreachable auth server or a busy writer. An exit 75 before ready
  backs off like a crash, doubling up to the cap, but never counts toward
  `failed`: the serve retries until what it waits on comes back, and reaching
  `ready` resets the backoff.
- Any other exit the host did not ask for is a crash: exponential backoff,
  capped. Repeated crashes inside a window hold in `failed` until someone
  resumes the workspace. Suspending or deleting a failed workspace leaves it
  `failed`; like `stopped`, it has no child, so removal accepts either.
- Stop is SIGTERM, so serve's drain path runs. A child still running after a
  grace is killed. The grace defaults to more than a default serve shutdown
  takes, and a workspace whose repo raises its drain timeout is given a longer
  one.
- A child not ready within a deadline is stopped, and that counts as a crash.
- A child's stderr goes to the host's log, tagged with its workspace. Its last
  lines are kept as the reason it exited.

**Children.** Each child is `swamp serve --json` in its repo folder, configured
by that repo's own `serve.yaml`. The host adds `--host 127.0.0.1`, `--port 0`,
`--address` with the child's public address, `--trusted-hosts` with the host's
public name, `--trust-proxy` and `--exit-on-stdin-close`. The child reports the
port it got on its `--json` listening line. The root alone is also given
the `workspaces/` folder and the host's address, as the hidden
`--host-workspaces-dir` and `--host-address`, which make it the serve that
takes the [lifecycle requests](#lifecycle). A workspace is also given the
root's address, which [Sign-in](#sign-in) uses. The child inherits the host's
environment, as plain serve inherits its operator's, so models and workers see
what they would under plain serve. `SWAMP_REPO_DIR` and `SWAMP_DATASTORE` are dropped, since they would
point every workspace at one repo or datastore, and `SWAMP_HOME` and
`SWAMP_CONFIG_DIR` are pinned (`src/serve/host/child_env.ts`).
No serve setting is passed: an environment variable outranks each
workspace's `serve.yaml`, so one would set grants, addresses and policy (the
explicit-grant rules, the dispatch allow-list, run limits) for every workspace,
unseen by its team. Every name in `SERVE_ENV_MAP`
(`src/serve/serve_env_map.ts`) is held back, and the OAuth client secret with
it, except `SWAMP_CA_CERT`, the operator's outbound trust. The host warns at
startup for each one it holds back. `SWAMP_SERVE_CERT_FILE` and `SWAMP_SERVE_KEY_FILE` are set empty, which
outranks a `tls:` block in the repo's `serve.yaml`: the host terminates TLS and
polls `/ready` over plain loopback HTTP.

The host is one trust domain, as plain serve is: whoever starts it is trusted
by every workspace, as plain serve's operator is trusted by its repo. Every
workspace's models see the host's whole environment, cloud credentials
included, by the same rules as under plain serve: code inside the serve reads
all of it, a method's external tool gets it without `SWAMP_*`, and a worker
gets what the workspace's own `dispatch-env-allow` lets through. Two workspaces
cannot hold different credentials. Only serve settings are held back, because
they would override a team's `serve.yaml` where the team cannot see it.

A serve with auth mode `none` relies on its loopback bind and its Host check to
stay private. Behind the router that bind no longer hides it, so a host whose
listener is off loopback refuses to start or route to a child in auth mode
`none`. A host on loopback behind a proxy refuses it too, since the proxy in
front is usually public: one with `trust-proxy: true`, or one whose `address`
is not a loopback name, since each child trusts that name in its Host check and
something must forward it to a loopback listener. `host.yaml` can set
`allow-unauthenticated-behind-proxy: true` for a proxy that authenticates every
caller. A child reports its auth mode as `authMode` on its `--json` listening
line. A refused child is stopped as a requested stop, never restarted, and
answers 503 with state `refused` until the host restarts or its folder is
removed and added again.

`--exit-on-stdin-close` is a new hidden flag: serve starts its drain when stdin
reaches end of file, as the dashboard child already does. The host keeps each
child's stdin open, so a child never outlives the host and the host needs no pid
files and no orphan clean-up. Stopping the host stops its children through
their drain paths first: SIGTERM, a kill after the grace, then their stdin
closes.

**The root workspace** is the repo `root:` names in `host.yaml`. An existing
serve becomes a root by naming its repo there and keeping its settings in its
`serve.yaml`. Its address does not change.

**The folder is the list.** Every repo folder in `workspaces/` whose name is a
workspace name and that holds a `.swamp.yaml` is a workspace. The host watches
the folder without recursing, so the children's own writes never wake it, and
rescans it every 5 seconds, which finds a marker written after its folder. An
operator can make a workspace by hand, and the lifecycle below does the same
thing. A removed folder's workspace is stopped and answers 404.

**Default off.** The host never starts a serve for a workspace on its own. It
starts one only when the workspace's wanted file says `active`, which a resume
writes. Finding a folder in `workspaces/`, reading a registry entry and
creating a workspace all leave the workspace listed and stopped. The choice is
kept in the wanted file, so a workspace someone resumed comes back after a host
restart. The root is the one exception: naming it in `host.yaml` is the
operator turning it on. The host logs one line for each workspace it lists and
does not start, naming the wanted file to write. Under `--json` that line is a
log record in the output stream. The `listening` and `workspaces` events carry
a count and names, not each workspace's state; its status file and the 503 its
address answers say whether it runs.

**Registered workspaces.** The host also reads the workspace registry of the
user it runs as, the list `swamp workspace import` and `swamp workspace create`
add to ([workspace](./workspace.md)). The host recognizes every workspace in
it: the workspace is listed, it has a status file, and it has no serve.
Registering a repo never starts one. This is item 19 of the
[execution plan](#execution-plan) and is not built.

A registered workspace is served where it is, at `/w/<name>` under its registry
name, once someone resumes it. That is `workspace.resume` on the root, or an
operator writing its wanted file as `active`. A suspend stops it again. The
repo keeps the datastore, vaults and `serve.yaml` it already has. Nothing
copies the root's auth mode or admission lists into it, and the host admits it
by the same rule as any child. Clients, workers and checkouts that used another
address for the repo keep using it. Their owners point them at the new one.

The host reads the registry with each rescan and never writes it. A registry
file that does not exist yet is an empty registry to the host. The host does
not adopt the repos a first read by a workspace command would, and it
recognizes them once such a command has written the file. A registered
workspace's wanted and status files are in `workspaces/` under its registry
name, like any other workspace's. The status file says the workspace is
registered, which is how the root knows one without reading the registry. The
root learns of a new one up to one rescan late.

The registry keeps names and folders unique, but it does not store every folder
by its real path, so the host resolves each one before it compares. The host
adds four rules:

- A name belongs to whichever the host took on first, the folder in
  `workspaces/` or the registered workspace, and the status file records which.
  The other is passed over, with a line in the host's log. A folder never
  inherits a registered workspace's wanted file. With no status file, the
  folder has the name.
- A wanted file with no status file and no folder beside it is a create that
  has not finished. The host takes on no registered workspace under that name
  while the file is there, so the new folder gets the name. An operator
  therefore resumes a registered workspace by hand only once the host lists
  it, and removes a wanted file that a failed create left behind.
- A registered folder that is the root's repo, or one of the host's own
  workspace folders, is passed over, so no repo has two serves from one host.
- A registered workspace the host took on is stopped when it leaves the
  registry, and its wanted and status files are removed. A later import under
  the same name starts nothing.

`workspace.delete` refuses a registered workspace, since no workspace command
deletes a registered folder. `swamp workspace remove` takes it off the host.
`workspace.create` refuses a registered name. `workspace.list` and
`workspace.get` say which workspaces are registered.

Registering is an act of the host's user on the host's machine. No request
registers a repo, since that would let a remote caller name a folder for the
host to run code from. Only the root's admins may suspend or resume a
registered workspace. A grant on `workspace:<pattern>` does not reach one, even
when its name matches: the grant was given for workspaces its holders create,
and a registered repo is the host user's own. A root admin can start a serve
for any workspace that user has registered. The registry's trust mark is about
agents and does not gate serving.

**`host.yaml`** (`src/serve/host/host_config.ts`) refuses unknown keys and names
the field that is wrong:

| Key                                  | Default                       | Meaning                                                                                  |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `address`                            | required                      | The public address; may carry a path when a proxy serves the host under one             |
| `listen.host`                        | `127.0.0.1`                   | Off loopback needs TLS, as for serve                                                     |
| `listen.port`                        | `443` with TLS, `8080` without |                                                                                          |
| `listen.cert-file`, `listen.key-file` | none                          | Given together; relative to the host folder                                              |
| `root`                               | none                          | The root workspace's repo; relative to the host folder, never inside `workspaces/` nor containing it; a folder without `.swamp.yaml` is refused at startup |
| `trust-proxy`                        | `false`                       | The host is behind a proxy, whose forwarding headers it passes on                        |
| `allow-unauthenticated-behind-proxy` | `false`                       | Admits a child in auth mode `none` behind a proxy; only on a loopback listener with `trust-proxy` or a public `address` |
| `oauth-client.id`, `oauth-client.secret-file` | none                 | Given together; every child is started with them. The file is relative to the host folder, never inside `workspaces/` nor the root, and a missing, unreadable or empty one is refused at startup |

The host binds its listener before it starts any child, so a listener that
cannot bind starts nothing. SIGTERM and SIGINT stop the watcher, drain every
child, then close the listener. SIGHUP follows plain serve: where serve would
reload (stdin is not a terminal) the host sends SIGHUP to every ready child,
skipping any still starting, which may not handle it yet; at a terminal it is a
hangup and drains like SIGTERM.

With `--json`, stdout is one JSON object per line: `listening`, `workspaces`
and `stopped` by `status`, and every log record, the children's stderr
included, as `status: "log"` with its level, category and message
(`JSON_LOG_LINE_COMMANDS` in `src/cli/stdout_contract.ts`). Other commands drop
records below fatal in JSON mode. A 503 names only the state, since it goes to
anyone who can reach the address; the reason, such as an admission refusal or
a child's exit, is in that log.

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
its secret file. The host passes it to each child, root included, with the
existing `--oauth-client-id` and `--oauth-client-secret-file` flags
(`src/serve/host/serve_process.ts`). The path reaches a child, never the
secret. A flag outranks `serve.yaml`, so the host's client replaces a root's
own, and delegation links the root made under its old client are no longer
found: people sync holds each as `club_unknown`.

A supplied client skips registration, but serve still looks up each entry in
`admins` or `allowed-users` its cache lacks, and without a collective key that
lookup is a device grant. A `user:` prefix is no way around it: in `oauth` mode
serve strips it and looks the rest up as a username (`usernameOf`), so a
subject is not found and, with a collective key, startup refuses because no
configured admin exists. `oauth` mode needs at least one admin, so a new
workspace's first start always looks names up. It does so unattended only with
a collective key in the host's environment (`SWAMP_API_KEY` or
`SWAMP_API_KEY_FILE`, which reach every child); otherwise a person completes one
device grant. The names it resolves are kept in the workspace's vault
(`oauth-resolved-admins`), so later starts look up only names added since.

`create` spares the creator that grant: it seeds the new workspace's
`oauth-resolved-admins` from names the root already holds. The creator's
username is the workspace's one admin and maps to the subject the root
authenticated; each copied allowed-user takes the root's record, resolved or
skipped, so a name skipped on the root stays skipped. With the host's OAuth
client, a first start then makes no lookup. An allowed-user the root never
resolved is still looked up. Seeding was chosen over an entry form that is
already resolved: that form would change the access-list grammar serve,
`check-config` and reload all parse, give an operator a hand-written way past
the pinned lookup, and still leave the root's allowed-users to look up. A
caller the root knows only by subject cannot create an `oauth` workspace,
since serve skips an admin that is not a plain username.

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
| `workspace.get`     | One workspace: state, restarts, and why it is not ready, described by state                    | `read` on `workspace:<name>`  |
| `workspace.suspend` | Stops its serve and keeps everything; `resume` starts it again                                 | `admin` on `workspace:<name>` |
| `workspace.delete`  | Stops its serve and removes its folder                                                         | `admin` on `workspace:<name>` |

`workspace` is a new resource kind in grants. With no grant naming it, only the
root's admins can make these requests. Until that kind exists, the root's
admins (`admin` on `access:*`) make every request but `list`, and a caller
acting through an integration or a delegation is refused `list` too, since its
ceiling cannot name a workspace. A token-mode root refuses `create` until the
[sign-in exchange](#sign-in) exists: the creator would have no way to get a
token inside the new workspace. Each request, allowed or refused, is in the
root's audit log with the caller and the workspace name
(`src/serve/handlers/workspace_handlers.ts`). A follower root answers them
itself, since only the node holding the folder can. A grant of `write` and `admin` on
`workspace:data-*` to a group lets that group create, start and remove its own.
With `write` alone it creates a workspace that an admin then starts. No grant
reaches the suspend or resume of a registered workspace, as
[The host](#the-host) describes.

The root and the supervisor never call each other. They share two small files
per workspace, beside its folder:

- **Wanted**, `workspaces/<name>.wanted.yaml`, written by the root: `wanted`
  (`active`, `suspended` or `deleted`), `creator` and `changedAt`. A folder
  without one is listed and not started, and its status file says
  `wanted: suspended`. Only `wanted` is required, so an operator can suspend or
  resume a workspace by editing that one line while the host runs.
- **Status**, `workspaces/<name>.status.yaml`, written by the host: `state`
  (the observed state), `wanted`, `restarts` (spawns after an exit the host did
  not ask for, over the host's lifetime), `reason` and `updatedAt`. The reason
  is an unreadable wanted file, an admission refusal, or the last lines of the
  serve's stderr in `backoff` or `failed`; it is null otherwise. A host that
  shuts down writes `stopped`. A status write that fails is tried again every
  5 s, since a serve held in `failed` reports nothing more.

Both are written atomically through a hidden temporary file, so a reader never
sees half of one. `HostedWorkspace` (`src/domain/serve/hosted_workspace.ts`)
is the aggregate, and the only place the file word `active` meets the
supervisor's `running`; its file store is
`src/infrastructure/persistence/hosted_workspace_file_repository.ts`.

The host reads the wanted files with each rescan of `workspaces/`
(`src/serve/host/workspace_reconciler.ts`):

- `suspended` stops the serve and keeps everything. A workspace already
  suspended when the host starts is never started.
- `active` starts it again. A changed `active` record is also what takes a
  workspace out of `failed`; rereading the same record does nothing, so an
  operator resuming by hand changes the file, and the services always write a
  new `changedAt`.
- A wanted file that cannot be read (bad YAML, an unknown field, over 4 KiB,
  not a regular file) is reported in the host's log and in the status file,
  and changes nothing: the workspace keeps the last state read whole, and is
  not started when the host has read none. A wanted file that is absent while
  its folder is there follows the same rule, whether the scan listed it and it
  was gone by the read, as while an editor saves by removing and recreating
  it, or the scan saw none: a running workspace keeps running and a suspended
  one stays stopped until a wanted file says otherwise. Once the folder is
  gone too, the host forgets that state, so a folder added back by hand with
  no wanted file is not started.
- A wanted file that is `active` or `suspended` with no folder beside it is left
  alone until the folder appears.
- A folder removed by hand stops its serve, as before, and its status file is
  removed once the serve has stopped.

`create` sets the repo up in a hidden `.<name>.creating-<uuid>` folder, writes
the wanted file as `suspended`, then renames the folder into place, so no scan
lists a workspace before it is whole, and a new workspace is listed and has no
serve until a resume. A failed create removes the folder and the wanted file it wrote. One per-name
lock serialises create, suspend, resume and delete, and create removes a
`.creating-` folder an earlier create left. A create stopped between the
wanted file and the rename leaves the name taken until a `delete`, which the
host completes for a wanted file with no folder. `delete` writes
`deleted`. Once the host sees `deleted` it removes the workspace, and a later
edit of the file does not stop it: it stops the serve and waits for it to
exit, renames the folder to a hidden `.<name>.deleting-<uuid>` so no scan sees
half a folder, removes that, removes the status file, and removes the wanted
file last. Until the end the wanted file still says `deleted`, so a host that
stopped halfway finishes at its next start, and the next scan removes a hidden
folder left behind. A removal touches only names that pass
`parseWorkspaceName`, and a rename never follows a link, so a workspace folder
that is a link loses only the link.

Setting up a repo runs as a child process in its folder, the hidden
`swamp serve provision-workspace`, which reads its access settings as JSON on
stdin, initialises the repo, writes `serve.yaml` and seeds the name cache. The
root's process never loads another workspace's extensions, and never registers
another workspace's `_token-secrets` vault, which is process-wide.

What the services return reaches remote callers, so it names no host path.
`get` and `list` describe the host's reason by state (backing off, failed, a
removal being retried, another problem) and never repeat it: it can hold host
paths and the serve's own stderr. The reason itself stays in the status file. A
file-system error the services did not expect returns `host_error` and goes to
the host's log.

The root's admins hold the lifecycle, not the contents. They are not principals
inside a workspace unless its own admins add them. When a workspace's admins
are gone, an operator on the host suspends it, edits the admins in its
`serve.yaml` and resumes it.

CLI: `swamp serve workspace create|list|get|suspend|resume|rm`, each with log
and json output, each a request to the root at the host's address
(`src/cli/serve_workspace_request.ts`). The group is hidden while
`swamp serve host` is. `create` makes a workspace without starting it, and
`resume` starts it. `rm` sends `workspace.delete` and asks first in log mode
unless given `--yes`. The client checks a name with `parseWorkspaceName` before
sending it, since serve refuses a malformed name as `invalid_request`, which the
client reads as a serve that predates workspace requests. The root's own
messages for `not_found`, `already_exists`, `busy` and the other service codes
reach the caller as written; `unauthorized`, `not_a_host_root` and
`invalid_request` are explained in terms of the address given.

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
code taken to any workspace but the one it names is refused there. That holds
for an honest workspace: the root does not authenticate the redeemer, so
hostile code in one workspace could redeem a code issued for another by
claiming its name. It would gain a token only inside its own workspace, and
[Limits](#limits) already rules out tenants that do not trust each other.

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
| `HostedWorkspace` | Aggregate root      | Name, creator, wanted state; deleted is never left; the wanted file is its store                |
| `ManagedServe`    | Entity              | Wanted state, observed state, crash count, backoff; property-tested over random event sequences |
| Workspace router  | Host transport      | Prefix match, forward, 503 and 404; in `src/serve/host/`                                        |
| Reconciler        | Host service        | Joins the folder scan, the wanted files and the supervisor; runs removals                       |
| Status writer     | Host service        | Writes each workspace's status file, one write in flight; a projection, not a repository        |
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
on its own. The first four groups are the phases, in order. Journeys that
spawn the binary belong in `swamp-uat` and are not listed.

### Addresses with a path

1. **The worker's data plane keeps the connect URL's path.** Serve passes a
   trusted proxy's `X-Forwarded-Prefix` to the worker in the enroll reply,
   `dataPlaneUrlFromConnectUrl` keeps it when it starts the connect path, and
   the client joins each route onto its base instead of resolving it as an
   absolute path. Done when a worker connected at `…/w/x` through a forwarder
   that strips `/w/x` and declares it sends its data-plane requests under
   `/w/x/`, and a worker with no declared prefix sends the requests it sends
   today (`src/worker/data_plane_client.ts`).
2. **Every client works behind a prefix.** An integration test puts a forwarder
   that strips a prefix in front of an in-process serve and runs each client
   through it: the CLI's WebSocket and `/api/v1/request` calls, server login,
   workflow cancel, the v3 datastore client, and a worker's control socket and
   data plane, with the forwarder declaring the prefix it removes so the
   worker's data plane follows it. A small fix for a client that fails goes in
   the same PR. A large one becomes its own issue. After 1.

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
   that exit 75 never raises the crash count or leads to `failed`, and that
   `failed` is left only by a resume (`src/domain/serve/`).
5. **The supervisor.** It drives one `ManagedServe` per child through a process
   port: spawn, read the port from the listening line, poll `/ready`, SIGTERM,
   hold stdin. Tests use a fake port. The `Deno.Command` adapter stays thin,
   since tests here do not spawn processes. After 3 and 4.
6. **The router.** Prefix match, streamed HTTP forward, WebSocket relay, the
   forwarding and prefix headers, 503 and 404. It takes a lookup from name to
   port and state, so it needs no supervisor. Done when the integration test in
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
   with no stored client of its own and registers none. After 7.
10. **Workspace services.** The provisioner and the application services for
    create, list, get, suspend, resume and delete, working on the host folder.
    Create sets up under a temporary name and renames into place. Create writes
    the wanted file as `suspended` before the rename, so a new workspace has no
    serve until a resume. Without a
    collective key in the host's environment, a new workspace's first start
    needs a device grant for its names, so create seeds the workspace's
    `oauth-resolved-admins` from names the root already resolved (see A hosted
    workspace for why not an entry form that is already resolved). The services
    are exported from `mod.ts`, and an integration test runs them on a temp
    folder (`src/libswamp/hosted_workspace/`). After 8.
11. **Workspace requests on the root.** The host gives the root the
    `workspaces/` folder, and serve handles `workspace.*`: protocol types,
    request schemas, the follower lists, authorization for the root's admins
    and audit. A serve without the folder refuses them, and a token-mode root
    refuses `create`. After 10.
12. **`swamp serve workspace` commands.** `create`, `list`, `get`, `suspend`,
    `resume` and `rm`, each with log and json output. `create` says that the
    new workspace is stopped and names the command that starts it. After 11.
13. **A `workspace` kind in grants.** `workspace` joins the resource kinds and
    the lifecycle requests check it: `write` to create, `read` to get, `admin`
    to suspend, resume and delete. Root admins pass as before. Once item 19 is
    built, no grant reaches the suspend or resume of a registered workspace.
    The access suites cover the new kind
    (`src/domain/access/resource_selector.ts`). After 11.
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

### Default off and the registry

19. **Registered workspaces.** The host reads the workspace registry with each
    rescan and writes a status file for every workspace in it, without starting
    a serve. A registry file that does not exist is an empty registry. A resume
    starts a serve in the registered folder. The host passes over a name or a
    folder it already serves, and a name whose wanted file belongs to a create
    that has not finished. It stops a workspace that leaves the registry and
    removes its files. The workspace services report which workspaces are
    registered, refuse to delete one and refuse to create over one. Only the
    root's admins may suspend or resume one. Done when a repo registered with
    `swamp workspace import` is listed as stopped while the host runs, a resume
    serves it at `/w/<name>`, `swamp workspace remove` stops it, an import
    under a name served before starts nothing, and an import made while a
    create under the same name is unfinished leaves the name with the new
    folder. After 10.
20. **Default off.** The host starts a serve only for a workspace whose wanted
    file says `active`. A folder in `workspaces/` with no wanted file is listed
    and not started, and a wanted file that cannot be read starts nothing. A
    running workspace is stopped by `suspended` or `deleted`, never by a wanted
    file that cannot be read, or that is absent for one scan, as while an
    editor saves it. The root still starts with the host. Done when a folder
    added by hand has no serve until its wanted file says `active`, a resumed
    workspace comes back after a host restart, and replacing a running
    workspace's wanted file does not stop it. After 8.

Issues 16 and 17 need only the first two groups, so the dashboard can proceed
beside the lifecycle. Issue 19 needs only issue 10, and issue 20 only issue 8.
Promoting a local workspace builds on issues 13 and 15 and is designed
separately.

## Limits

- **Tenants that do not trust each other.** Workspace processes run as one OS
  user, and extension code runs inside them. Code in one workspace can read and
  write another's folder, vault key, datastore files and wanted file, and read
  everything in the host's environment, cloud credentials included. This
  design separates failures, not hostile code. A child trusts the forwarding headers of anything that reaches
  its loopback port, not only the router.
- **One host.** A workspace's folder is on one machine, and its serve listens
  on that machine's loopback.
- **Lifecycle and sign-in need the root.** While the root is down no workspace
  can be created, suspended or deleted through the API, and no sign-in code is
  issued. Running workspaces and tokens already minted are not affected.
- **One OAuth client for every workspace.** Disabling the client named in
  `host.yaml`, or replacing its secret, which ends every link held under it,
  reaches every workspace at once.
- **A registered repo that another serve already runs.** While a `swamp serve`
  started outside the host holds the repo's datastore writer, the host's serve
  for it exits 75 at startup. The host retries without end, since that exit
  never leads to `failed`, and the status file shows `backoff` with the reason.
  Stop the other serve, or suspend the workspace.
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

- **What swamp-club sees.** One client used from many workspaces is accepted:
  swamp-club keeps an instance row per client and process, and binds no
  address to a client. With a collective key each workspace registers a row
  under the same client name and hostname, and a link consent page shows that
  same name and hostname for every workspace. Should a registration carry its
  workspace's address, and should a host appear as one serve?
