---
audience: operator, maintainer
enables: [serve]
last-verified: 2026-11-20 @ 0323a2314
---

# Serve workspaces

**Status:** Partly built. Addresses with a path, the host, lifecycle and
sign-in (steps 1 to 15 of the [execution plan](#execution-plan)) are built, as
are default off (step 24), the host registering the workspaces it runs
(step 19), taking them from the registry (step 20), serving a workspace
registered anywhere (step 21) and a host with no host folder (steps 22 and
23): `swamp serve host` runs in a host folder or without one, registers every
workspace folder in its `workspaces/` in the workspace registry, lists every
entry, runs a serve for each one whose wanted file says `active` and names its
folder, and its root takes the `workspace.*` requests and issues sign-in codes.
With no host folder it creates workspaces in the workspace location. The
dashboard (steps 16 to 18) is not built.
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

There is one list of workspaces on a machine: the workspace registry that
[workspace](./workspace.md) describes. A host serves entries from it. A
workspace a request creates on the host is a registry entry like any other, and
a repo its user registered with `swamp workspace import` is served where it is
once someone resumes it. [The host](#the-host) describes how.

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

`swamp serve host` is a hidden command for now: it runs, but serve's help and
`swamp help serve` do not list it. It reads `host.yaml` and keeps a **state
folder** of small files, one wanted file, one status file and one lock per
workspace. It finds them in one of two layouts, chosen in this order:

1. **A host folder**, given with `--host-dir`, or the current folder when it
   holds a `host.yaml` and is not the config dir. This is how every host runs
   today. A host started from inside the config dir uses the second layout, so
   starting there never gives that `host.yaml` a second state folder.

   ```
   <host folder>/
     host.yaml            the listener, the public address, the root, an OAuth client
     workspaces/          the state folder, and one repo per workspace made here
   ```

2. **No host folder.** Otherwise the host reads `<config dir>/host.yaml` and
   keeps its state folder at `<data dir>/host/`. That folder holds the wanted
   files, the status files and the locks, and no repo
   (`src/serve/host/host_layout.ts`). A workspace a request creates goes in
   the workspace location, beside the user's own.

The host logs which `host.yaml` it read. With no `--host-dir` and no
`host.yaml` found, the first run creates `<config dir>/host.yaml` and starts
from it (`src/serve/host/default_host_yaml.ts`): a listener on
`127.0.0.1:8080` whose address is `http://127.0.0.1:8080`, with every other key
written as a comment saying what it does. Off loopback needs TLS files no
default can name, so the created file never listens off loopback. It is created
exclusively, a temp file hard-linked into place: an existing `host.yaml`, even
an invalid one, is never replaced, and of two hosts starting at once one writes
it and the other reads it. A host folder is never created, and `--host-dir`
naming a folder with no `host.yaml` is refused. The host reports the file it
created before it listens, a line of its own in `--json`. The created file names
no root, so `swamp serve workspace` has nothing to talk to until the operator
sets `root:`; the line says so. Relative paths in `host.yaml` are taken
from the host folder, or from the config dir when there is none. One host runs
per state folder, in both layouts: the host holds an exclusive kernel lock on
`.host-lock` there while it runs (`src/infrastructure/persistence/host_state_lock.ts`),
which the kernel releases when the process dies, and a second host on the same
state folder exits naming it. The file has no `.lock` suffix, so no
workspace's own lock can be it.

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
the state folder and the host's address, as the hidden
`--host-workspaces-dir` and `--host-address`, which make it the serve that
takes the [lifecycle requests](#lifecycle), and with no host folder
`--host-no-folder` too. A workspace is also given the
root's address, as the hidden `--root-address`, which [Sign-in](#sign-in) uses;
a host with no root gives none. The child inherits the host's environment, as
plain serve inherits its operator's, so models and workers see
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

**The registry is the list.** A workspace of the host is an entry in the
workspace registry of the user the host runs as, `<config dir>/workspaces.json`
([workspace](./workspace.md)), and its serve runs in the entry's folder. The
registry does not store every folder by its real path, so the host resolves
each one before it compares one with another. Steps 19 to 21 of the
[execution plan](#execution-plan) build this, and are built: the host writes
the registry as below, and its workspaces are every entry, each at the real
path of its folder, plus every workspace folder in `workspaces/` whose name
and real path no entry has. One rule in `hostedWorkspaceFolders`
(`src/libswamp/workspace/hosted_roster.ts`) decides this for the host and the
workspace services alike.

- With each rescan the host first registers every workspace folder in its
  `workspaces/` that the registry lacks, then reads the registry. A workspace
  folder is a repo folder whose name is a workspace name and that holds a
  `.swamp.yaml`. Its entry has the folder's name and real path, recorded as
  `swamp workspace import` would record it, with no trust mark. Nothing is
  moved or copied.
- The host writes through the workspace store under the registry's lock, and
  waits for the lock a bounded time, 2 seconds, which passes a workspace
  command's one read and write and ends before the next rescan. A write that
  fails or times out is tried again at the next rescan and logged once per
  reason; it never delays or stops a serve, and a rescan does not wait for it.
  The host's writes run one at a time, so a registration a rescan started never
  lands after a removal has taken the entry away. A rescan's writes stop at the
  first that fails, so they wait for the lock once, and a host that is stopping
  starts no new registration. A registry the host creates adopts the repos under the data dir
  first, as any command that writes does. The host's read adopts nothing and
  takes no lock a workspace command would wait on.
- `workspace.create` registers the workspace it made once its folder is renamed
  into place, so a workspace a request created is an entry like any other and
  `swamp workspace list` shows it at once. The root writes that entry; the
  host's rescan is the safety net. A create whose registration fails still
  succeeds, and a create stopped before that is registered by the next rescan.
- A folder in `workspaces/` that could not be registered, or that a failed
  write has not registered yet, is still served from its folder, so a registry
  write that fails never stops a serve. A folder whose name or real path
  another entry has is the exception; see Names and folders below.
- A folder removed by hand from `workspaces/` stops its serve and answers 404.
  Its entry is removed once the serve has stopped, with its status file. The
  host removes only an entry whose folder is inside its own `workspaces/` and
  whose name is that folder's name. A folder that is a link is registered at
  its target's real path, so the host never removes that entry. An entry for
  `workspaces/<name>` whose folder was removed while the host was stopped is
  not listed, and the host removes it as it would after a removal by hand. A
  host whose `workspaces/` holds no workspace folder at all removes none, since
  a folder that was unmounted looks the same. Such an entry does not hold its
  name: `workspace.create` makes the folder there, which keeps the entry.
- The supervisor keeps a serve's folder from its first start, so a workspace
  whose folder changes keeps running where it is and starts in its new folder
  the next time it starts. A link in `workspaces/` that is pointed at another
  repo is the exception: its entry still names the first target, which keeps
  the name (see Names and folders), so it is listed there and stopped until
  `swamp workspace remove <name>` frees the name and the host registers the
  link at its new target.

The host watches `workspaces/` without recursing, so the children's own writes
never wake it, and rescans every 5 seconds, which finds a marker written after
its folder and an entry another command registered. An operator can make a
workspace by hand in `workspaces/`, and the lifecycle below does the same thing.
The workspace services take their workspaces from the same registry entries and
folders as the host.

**Listed is not started.** Every workspace of the host is listed and has a
status file, wherever its folder is. The host never starts a serve for a
workspace on its own. It starts one only when the workspace's wanted file says
`active`, which a resume writes. Finding a folder in `workspaces/`, reading a
registry entry and creating a workspace all leave the workspace listed and
stopped, and its address answers 503 with its state. Registering a repo never
starts one. The choice is kept in the wanted file, so a workspace someone
resumed comes back after a host restart. The root is the one exception: naming
it in `host.yaml` is the operator turning it on. The host logs one line for
each workspace it lists and does not start, naming the wanted file to write.
Under `--json` that line is a log record in the output stream. The `listening`
and `workspaces` events carry a count and names, not each workspace's state;
its status file and the 503 its address answers say whether it runs.

**Whose a workspace is** (step 21). Every workspace is one of two kinds, and
`workspace.list` and `workspace.get` say which, in the optional field `owner`:
`host` or `operator`. A name with a wanted file and no workspace has no
`owner`. An operator's own workspace with no wanted file is reported
`suspended`, as the host treats it.

- **The host's own** is a workspace a request created. Grants on
  `workspace:<pattern>` reach it, and `workspace.delete` removes its folder and
  its registry entry. With a host folder, every workspace whose folder is
  at `workspaces/<its name>` is the host's own, whoever made the folder, as
  every workspace is today; one registered under another name is not. With no host folder, a workspace is the host's own when
  its wanted file has a creator and names the entry's folder, compared by real
  path, which only `workspace.create` writes. Removing the creator or the
  folder by hand makes it the operator's own, the safe direction; writing both
  by hand for the entry's folder makes a repo the host's own, which only
  someone who can already write the state folder can do. No request carries a
  creator to another folder: a suspend or resume of the operator's own writes
  its folder with no creator, and the host removes a wanted file that has a
  creator once the registry names another folder for its name, as after a
  `swamp workspace remove` and an import elsewhere under the same name. A name no entry holds
  is the host's own when its wanted file has a creator and a folder: a create
  stopped before it registered. The host settles one at its next rescan, once
  it holds the name's create lock and so knows no create is running: it removes
  the wanted file and the hidden set-up folder, so a repo made later at that
  folder is not the host's own. While the registry cannot be read, a workspace
  listed from its wanted file has an owner no one can confirm: only the root's
  admins may suspend or resume it, its creator is kept, and no delete runs.
- **The operator's own** is any other registered workspace: a repo the host's
  user registered, wherever it is. `workspace.delete` refuses it, for the
  root's admins too, and names `swamp workspace remove`, since no workspace
  command deletes a registered folder. Only the root's admins may suspend or
  resume it. A grant on `workspace:<pattern>` does not reach those, even when
  its name matches: the grant was given for workspaces its holders create, and
  a registered repo is the host user's own. `workspace.get` follows the `read`
  grant, as for any workspace. A root admin can start a serve for any repo the
  host's user registered.

The wanted file is trusted as the host user's own, like everything in the state
folder. Code in a workspace runs as that user and could edit a wanted file to
make a repo the host's own, but it could as well remove the folder itself;
[Limits](#limits) already rules out tenants that do not trust each other.
Removing the creator or the folder from a wanted file makes a workspace the
operator's own, which is the safe direction.

Registering is an act of the host's user on the host's machine. No request
registers a repo, since that would let a remote caller name a folder for the
host to run code from. A request can create a workspace, never import a folder.
The registry's trust mark is about agents and does not gate serving.

A registered workspace is served where it is, at `/w/<name>` under its registry
name, once someone resumes it. The repo keeps the datastore, vaults and
`serve.yaml` it already has. Nothing copies the root's auth mode or admission
lists into it, and the host admits it by the same rule as any child, with the
same flags and environment. Clients, workers and checkouts that used another
address for the repo keep using it. Their owners point them at the new one.

**A wanted file belongs to one folder** (step 21). A wanted file is never
applied to a folder other than the one it was written for. Otherwise a wanted
file left by a removed workspace, or by a create that did not finish, would
start a serve in whatever repo is imported under that name later.

- A wanted file can name its folder. One that names none stands for
  `workspaces/<name>`, which is what every wanted file means today.
- The host starts a serve only when the wanted file's folder is the entry's
  folder, and the status file's reason says when it is not.
- A `deleted` the host cannot act on, because it stands for another folder,
  for a folder another workspace has, or for a name in a clash, is never left
  waiting: freeing the name later, as the host advises, would carry it out. The
  host removes that wanted file, unless it was rewritten since, logs that it
  deleted nothing, and the workspace is stopped as one with no wanted file. To
  delete it, delete it again once the name is the host's own.
- `suspend` and `resume` write the folder for a workspace outside
  `workspaces/`, and leave it out for one inside, so the wanted files of an
  existing host folder do not change and an older host still reads them.
- An operator who resumes one of their own workspaces by hand names its folder
  in the wanted file. Editing the `wanted` line of an existing file works as
  before.
- A name whose registered folder changes is stopped, and is not started in the
  new folder until its wanted file names it.

The field is `folder`, an absolute path, and is optional, so every wanted file
written until now still parses. Suspend and resume write the real path of the
entry's folder, and the host compares both sides by real path, so another
spelling an operator writes still matches.

**Names and folders.**

- A registered folder that is the root's repo is passed over, so no repo has two
  serves from one host.
- A folder in `workspaces/` whose name is registered to another folder is not
  served: the registry entry has the name, and is listed in its place. Neither
  is started while both are named so, whatever the wanted file says, since
  serving the entry's repo would answer at the address the folder's clients
  use. `workspace.resume` refuses that name to everyone with
  `workspace_name_clash`, which is not an authorization refusal and is in the
  client's list of root-written codes, and the status file's reason says to free the name
  with `swamp workspace remove <name>` or rename one of them, never to name the
  entry's folder. The host logs an error once per start that names both
  folders and `swamp workspace remove`, and leaves the registry unchanged.
- A folder in `workspaces/` registered under another name is not served under
  its own name either: the entry has the folder, so no repo has two serves.
  The host logs that clash the same way, and `workspace.list` and
  `workspace.get` say of the folder's own name that its folder is registered
  under another name, without naming it, since the caller may hold no grant on
  it. Nothing done under the folder's own name reaches it: `workspace.delete` refuses that name with
  `operator_workspace`, a wanted file under it neither starts nor removes
  anything, and just before it removes any folder the host checks both the
  workspaces it last listed and the registry read afresh. A removal that finds
  its folder claimed then is dropped with its `deleted`, never retried, so
  freeing the name later deletes nothing.
- A registry entry whose name is not a workspace name is passed over.
- A registered folder that is gone, or holds no `.swamp.yaml`, is listed and
  not started, and its status file's reason says so. The host looks again at
  every rescan.
- A workspace's wanted and status files are in the state folder under its
  registry name, wherever its folder is.

**Leaving the registry** (step 21). A workspace of the operator's own is stopped
when it leaves the registry, and its wanted and status files are removed. One
that is no longer listed but still registered, as when another entry names its
folder by a second spelling, is stopped and keeps its files. Its
folder is not touched. A later import under the same name starts nothing. A
wanted file written since it left, as by a resume after a new import, is kept.
An entry for a folder in `workspaces/` cannot leave this way: the next rescan
registers it again, so `swamp workspace remove` has no lasting effect on it
while the folder is there.

**A registry that cannot be read** (steps 19 to 21), because it is corrupt or a
newer swamp wrote it. While the host runs, it logs that, changes nothing and
keeps the entries last read whole, and registers nothing. At startup, with
nothing read yet, it serves what the wanted files name, each `active` one in the
folder that file names or stands for, so a bad registry does not stop a host at
its next restart. A folder a wanted file names is served only when it holds a
`.swamp.yaml`, is not the root's repo, and is not already a folder in
`workspaces/` or another wanted file's folder, so no repo gets two serves, and
the host logs each one it lists.
When the registry can be read again, a workspace listed only from its wanted
file that has no entry is stopped, and its wanted file is kept. The workspace
services answer the same way while the registry cannot be read. They then
see no clash, so `workspace.delete` refuses every workspace, the host's own
included, and a name they cannot place gets the operator's rules: only the
root's admins may suspend or resume it. Each refusal says the registry is
why. A name with no entry whose wanted file names a folder gets them too,
since only a change to a registered repo writes that. A registry file
that does not exist at startup is an empty one: a host with no registry file
and an empty `workspaces/` lists nothing and creates no file. One that
disappears while the host runs is treated as one that cannot be read, since no
command removes it: the host keeps the entries it last read, stops nothing,
registers nothing, since a write would create a registry without the entries
it held, and logs it once, until the file is back.

**A hand-written `deleted` for a workspace of the operator's own** (step 21).
The delete
service refuses one, but an operator can still write the file. The host never
removes or renames a folder outside its own `workspaces/`, and with no host
folder never one a request did not create, whatever the wanted file says. It
stops the serve, the workspace stays listed, and the status file's reason says
why nothing was removed and names `swamp workspace remove`. Unlike `deleted`
for the host's own, it is not final: writing `active` again, or a root admin's
resume, resumes it, since nothing that cannot be undone has started.

**The refusals** these rules add use `operator_workspace`, apart from the name
clash's `workspace_name_clash` (see Names and folders); both are in the
client's list of codes whose message the root wrote, so an older client
shows the root's own message. `workspace.delete` refuses an operator's own
workspace with it for everyone. `workspace.suspend` and `workspace.resume`
refuse it for a caller who is not one of the root's admins (admin on
`access:*`, as every caller is in auth mode `none`); the request handler
decides that and passes it in, and the service refuses under the workspace's
lock, so no other request changes the workspace between the check and the
write. Registry commands such as `swamp workspace import` take no such lock,
which is why the host checks a wanted file's folder again before it acts on
it. That refusal is audited as a denial of `admin` on `workspace:<name>`, like
any refused grant; the same request also has the allow of the grant check it
passed first. `workspace.create` refuses a name the registry holds with
`already_exists`.

**`host.yaml`** (`src/serve/host/host_config.ts`) refuses unknown keys and names
the field that is wrong:

| Key                                  | Default                       | Meaning                                                                                  |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `address`                            | required                      | The public address; may carry a path when a proxy serves the host under one             |
| `listen.host`                        | `127.0.0.1`                   | Off loopback needs TLS, as for serve                                                     |
| `listen.port`                        | `443` with TLS, `8080` without |                                                                                          |
| `listen.cert-file`, `listen.key-file` | none                          | Given together; relative to the folder that holds `host.yaml`                            |
| `root`                               | none                          | The root workspace's repo; relative to the folder that holds `host.yaml`, never inside the state folder (`workspaces/` with a host folder) nor containing it; a folder without `.swamp.yaml` is refused at startup |
| `trust-proxy`                        | `false`                       | The host is behind a proxy, whose forwarding headers it passes on                        |
| `allow-unauthenticated-behind-proxy` | `false`                       | Admits a child in auth mode `none` behind a proxy; only on a loopback listener with `trust-proxy` or a public `address` |
| `oauth-client.id`, `oauth-client.secret-file` | none                 | Given together; every child is started with them. The file is relative to the folder that holds `host.yaml`, never inside the state folder nor the root, and a missing, unreadable or empty one is refused at startup; a workspace whose folder holds it is not started, in either layout, and its status says why |

The `host.yaml` a first run creates sets `listen.host`, `listen.port` and
`address` to the loopback defaults above and lists every other key as a
comment.

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

## Compatibility

Making the registry the host's list and the host folder optional keeps these
true for a host folder that exists today:

- The same command, the same `host.yaml` and the same addresses.
- Every workspace that ran before an upgrade runs after it, with no step by the
  operator. The one exception is a folder in `workspaces/` whose name or real
  path another entry has (see Names and folders in [The host](#the-host)),
  which is not served; the host logs that clash at every start.
- Repos, wanted files and status files stay where they are, and nothing is
  moved. Suspend and resume by request leave a wanted file for a folder in
  `workspaces/` byte for byte as it is written today.
- New workspaces on a host with a host folder are still created in its
  `workspaces/`. One with no host folder creates where `swamp workspace create`
  would.
- The registry file gains no field and no schema version, so an older swamp
  reads and rewrites it without loss.
- An older `swamp serve workspace` client works against a newer root, and a
  newer client against an older root. A field added to a reply is optional, and
  a new refusal reaches an older client with the root's own message.

One thing changes for an existing host: every repo its user has registered is
listed on it, stopped. None starts until a root admin resumes it. Its
workspaces also appear in `swamp workspace list` and on the `swamp start` page.

## A hosted workspace

A hosted workspace is a repo folder, the one its registry entry names. One a
request creates is `<host folder>/workspaces/<name>/` on a host with a host
folder, and `<location>/<name>` in the workspace location on one without. It
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
them and its audit log records each one. The host gives the root the state
folder, and a serve without it refuses these requests. A workspace of the
operator's own is held to the rules in [Whose a workspace is](#the-host):
delete refuses it and only the root's admins may suspend or resume it.

| Request             | Does                                                                                           | Needs on the root                |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| `workspace.create`  | Makes the folder, sets up the repo, writes its `serve.yaml` with the caller as its first admin | `write` on `workspace:<name>`    |
| `workspace.list`    | Names, addresses and states                                                                    | any authenticated principal      |
| `workspace.get`     | One workspace: state, restarts, and why it is not ready, described by state                    | `read` on `workspace:<name>`     |
| `workspace.suspend` | Stops its serve and keeps everything; `resume` starts it again                                 | `admin` on `workspace:<name>`    |
| `workspace.delete`  | Stops its serve and removes its folder and its registry entry; refuses the operator's own      | `admin` on `workspace:<name>`    |
| `workspace.sign-in` | A single-use code the named workspace redeems for a token of its own (see [Sign-in](#sign-in)) | any person signed in to the root |

`workspace` is a resource kind in grants, with a pattern that is a workspace
name, a prefix of one ending in `*`, or `*`. With no grant naming it, only the
root's admins (`admin` on `access:*`) make these requests, since a request no
grant decides falls back to that check. A deny on `workspace:<pattern>` refuses,
the root's admins included, as a deny on any kind does. A grant naming
`workspace` on a serve that is not a host's root is accepted and never checked,
since that serve refuses every `workspace.*` request.

A caller acting through an integration or a delegation is held to its ceiling,
which can name a workspace for `read` only: it may get a workspace its ceiling
and grants reach, and its `list` names only those, but it never creates,
suspends, resumes or deletes one, as a ceiling never carries `write` or `admin`.
swamp-club refuses a workspace entry in a consented ceiling until
swamp-club#4879 lands, so until then no delegation carries one.
`swamp access can-i` answers for the kind as the requests do, except that it
lists grants and so shows nothing for a root admin's fallback. A token-mode
root creates as an `oauth` one does, and its creator reaches the new workspace
through the [sign-in exchange](#sign-in). Each request, allowed or refused, is in the
root's audit log with the caller and the workspace name
(`src/serve/handlers/workspace_handlers.ts`). A follower root answers them
itself, since only the node holding the folder can. A grant of `write` and `admin` on
`workspace:data-*` to a group lets that group create, start and remove its own.
With `write` alone it creates a workspace that an admin then starts. No grant
reaches the suspend or resume of a workspace of the operator's own, as
[The host](#the-host) describes.

The root and the supervisor never call each other. They share two small files
per workspace in the state folder, under its name:

- **Wanted**, `<name>.wanted.yaml`, written by the root: `wanted`
  (`active`, `suspended` or `deleted`), `creator` and `changedAt`. A folder
  without one is listed and not started, and its status file says
  `wanted: suspended`. Only `wanted` is required, so an operator can suspend or
  resume a workspace by editing that one line while the host runs.
- **Status**, `<name>.status.yaml`, written by the host: `state`
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

The host reads the wanted files with each rescan
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
serve until a resume. Create then registers the workspace, and refuses
a name the registry already holds with `already_exists` (step 21). A failed
create removes the folder and the wanted file it wrote. One per-name lock
serialises create, suspend, resume and delete, and create removes a `.creating-`
folder an earlier create left. A create stopped between the wanted file and the
rename leaves the name taken until a `delete`, which the host completes for a
wanted file with no folder. `delete` writes `deleted`. Once the host sees
`deleted` it removes the workspace, and a later edit of the file does not stop
it: it stops the serve and waits for it to exit, renames the folder to a hidden
`.<name>.deleting-<uuid>` so no scan sees half a folder, removes that, removes
the registry entry, removes the status file, and removes the wanted
file last. A registry write that fails keeps the wanted file, so a later rescan
finishes the removal; a registry that cannot be read is passed over, so a
corrupt file never holds up a delete. Until the end the wanted file still says `deleted`, so a host that
stopped halfway finishes at its next start, and the next scan removes a hidden
folder left behind. A removal touches only names that pass `parseWorkspaceName`,
and a rename never follows a link, so a workspace folder that is a link loses
only the link. With a host folder, the host never removes or renames a folder
outside its own `workspaces/`.

On a host with no host folder, which the host tells its root with the hidden
`--host-no-folder` beside `--host-workspaces-dir`, create makes the repo at
`<location>/<name>`, where `swamp workspace create` would: the location set
with `swamp config set workspaces.dir`, else `<data dir>/workspaces`. It holds
the host's per-name lock and then the registry's create lock, the one
`swamp workspace create` holds, for the whole set-up, so a
`swamp workspace create` of the same name meanwhile waits and may time out.
Under both it reads the registry as every writer does, adopting the data dir's
repos first, and runs the registry's own checks (`newWorkspaceLocation`,
`checkNewWorkspaceFolder`), answering `already_exists` with no host path.
Then, in order:

| Step | What create does                                                   | Left if create stops here                     | How it ends                                                                                   |
| ---- | ------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | sets the repo up in `<location>/.<name>.creating-<uuid>`           | the hidden folder                             | nothing names it, so `delete` answers `not_found`; the next create of the name removes it     |
| 2    | writes the wanted file, `suspended`, with its creator and folder   | the hidden folder and the wanted file         | the host's next rescan, holding the name's lock, removes both; a `delete` before then also does |
| 3    | registers the entry as created, strictly                           | and an entry naming a folder not there yet    | `delete`: no folder to rename; the host removes the hidden folder, the entry and both files   |
| 4    | renames the hidden folder into place                               | a whole workspace                             | `delete` as for any workspace of the host's own                                               |

The entry is written before the rename, not after: with the rename first, a
create stopped between the two would leave a whole repo no entry names, which
no delete may remove. For the length of the rename, `swamp workspace list`
shows the entry's folder as missing, and a host rescan then lists it as not a
swamp repo; it is suspended, so nothing starts. A failure undoes the steps in
reverse: it removes the entry only while it still names the folder, then the
wanted file, then the hidden folder. An import that takes the name before
step 3 makes the strict registration fail, and create answers `already_exists`
having removed only what it made; one after step 3 is refused, since the name
is taken. Create refuses to rename a hidden folder that some entry has taken,
and a target already there, so it never moves or replaces a folder it did not
make.

Delete on such a host is the host's, as with a host folder, with two
differences. It renames the folder the wanted file records, and only while
the registry, read afresh, still names that folder for the workspace; an entry
that now names another folder ends the removal, keeping the folder and the
entry. It removes the hidden `.<name>.creating-` and `.<name>.deleting-`
folders in that folder's parent, and, for a name no entry holds, only in the
current workspace location and `<data dir>/workspaces`, never a directory the
wanted file alone names; no live create owns one, since create refuses while
a wanted file exists. It removes the entry only while it names that folder.
The registry's first read passes over the hidden folders. When
`swamp workspace remove` takes the entry of a workspace the host created, the
host stops its serve, keeps its folder and removes its wanted file, so a later
repo at that path is not the host's own. With the host stopped that removal is
not seen, and a repo made at the same path under the same name afterwards
would read as the host's own; swamp-club#4967 records an identity of the repo
in the wanted file to close that.

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
inside a workspace unless its own admins add them, except in `token` mode (see
[Sign-in](#sign-in)). When a workspace's admins
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
   (`workspace.sign-in`). The root gives any person signed in to it a
   single-use code that names the workspace and expires within a minute.
2. The client gives the code to the workspace (`POST /auth/exchange`).
3. The workspace redeems the code at the root and sends its own name with it.
   The root refuses a code that names another workspace. Otherwise it answers
   once with who the code was issued to: the principal, the username, the
   collectives and the root token's expiry.
4. The workspace applies its own admission lists and mints its own server
   token for that principal.

The root token never reaches a workspace, where extension code could read it. A
code taken to any workspace but the one it names is refused there. That holds
for an honest workspace: the root does not authenticate the redeemer, so
hostile code in one workspace could redeem a code issued for another by
claiming its name. It would gain a token only inside its own workspace, and
[Limits](#limits) already rules out tenants that do not trust each other.

The CLI does this by itself. Given a server address `<address>/w/<name>` and no
token for it from any source, it exchanges when the workspace's `/auth/info`
offers the exchange and `servers.json` holds a token for `<address>`. The host's
address is the one the user gave with `/w/<name>` removed, never one a serve
answers. A serve that was given no root address offers no exchange.

**What the CLI signs in with, and keeps** (`src/cli/workspace_sign_in.ts`).

- Only a host token `swamp auth server-login` stored is exchanged. A host token
  from `SWAMP_SERVER_TOKEN` or a token file is not: an exchange from it would
  either write a credential to a machine that chose to keep them out of files,
  or mint a workspace token on every command. A token file bound by `--server`
  to a workspace's address is sent there as it is, whatever it holds, since the
  user named that address.
- The workspace token goes into `servers.json` under the workspace's address,
  with an `expiresAt` on the client's clock (the lifetime the workspace granted,
  measured by its `Date` header). Within a few minutes of that expiry the CLI
  exchanges again before it sends the token; if that fails, the still-valid
  token is used. An expired token that cannot be replaced is not sent. A token
  a workspace refuses before its expiry (deleted, or the workspace rebuilt)
  gets the usual refusal, not a retry; behind a host that refusal reads as 502,
  since the router cannot see why a child refused a WebSocket, so a 502 or a
  401 from a workspace the CLI sent an exchanged token to names signing in to
  the host again, which replaces the token.
- A token stored by `swamp auth server-login` to a workspace's address carries
  no `expiresAt` and is used as it is.
- An exchanged token records a SHA-256 digest of the host sign-in it came from
  (the host entry's `obtainedAt` and token), and stands only while the host's
  stored entry still matches it. Any `swamp auth server-login` to the host,
  device or `--token`, as someone else or with the same token, replaces the
  workspace token on the next command: the workspace runs as the new identity,
  and a token the workspace revoked has a way out in every mode. A host entry
  removed from `servers.json` stops the workspace token being sent. The CLI has
  no server sign-out.
- Two commands that both find no workspace token both exchange; the later write
  wins. Writes to `servers.json` hold an OS advisory lock on a sidecar file, so
  neither drops another server's entry. On a filesystem that cannot lock (some
  NFS and SMB mounts) the write goes ahead without it, as before the lock, so
  `swamp auth server-login` keeps working there.
- When the workspace offers the exchange and no host token is usable (none
  stored, or one from `SWAMP_SERVER_TOKEN`), a `--server` command stops before
  it sends anything, naming the sign-in that covers the host.
- A network failure or a busy root or workspace leaves the command to go on as
  it would have. Only a refusal stops it, and the message says which: the host
  refusing the stored sign-in, the root refusing the code, or the workspace's
  admission lists refusing the principal, which signing in to the host again
  does not cure. Before asking for a code over the WebSocket, whose refusal
  the host's router hides, the CLI asks the root's HTTP route, which checks the
  token first and whose status the router passes on. Serve's own 401 there
  (its `unauthorized` code, not a proxy's bare 401) is a refused
  host token and costs the root's lockout (five failures a minute per token
  name) one failure per attempt; an accepted token clears the count. A 429
  there, the lockout or a rate limit, stops the command with the wait the root
  gave, since the code request could only be turned away too (a 429 without
  serve's `rate_limited` code goes on to the socket); the lockout
  covers every token of that name, so a valid new one waits as well.

A workspace token lives no longer than the root token it came from, and its
collectives are the ones the root knew at the exchange. The exchange is the
same in `token` mode, so the creator of a workspace reaches it with the token
they already hold.

**Who gets a code.** Only a person: a worker's root credential must not reach
into every workspace. A caller acting through an integration or a delegation is
refused one too, since the workspace token would not carry that caller's
ceiling. A root in `none` mode issues none; its workspaces need no sign-in. The
root does not look the name up, so the request tells no one which workspaces
exist; a code for a name with no workspace is never redeemed. Each request is
in the root's audit log with the caller and the workspace name, and the code is
in neither the audit log nor a log line.

**Where the root keeps codes.** In memory, in the root process the host
started, keyed by the code's hash. That process is the only node holding the
`workspaces/` folder, so it alone answers `workspace.sign-in`, and the root's
public address routes there through the host's router. Redeem
(`POST /auth/sign-in-code/redeem`) is answered on the node that received it,
never forwarded to a leader. A code is gone after its first redeem, refused or
not, or after a minute; a restart of the root drops the codes outstanding. Each
person holds at most 20 unused codes.

**How a workspace reaches the root.** Through the host's router at the root's
public address, the `--root-address` the host gave it. The workspace sends the
code and its own name, never a token. Its own name is what its `--address` adds
to the root's (`<root address>/w/<name>`). The host's loopback listener was the
other way, but fails under TLS, whose certificate names the public host.

**What redeem answers.** The principal, the username, the login email, the
collectives and groups, and the root token's expiry. Every refusal answers 404
with `sign_in_code_refused`; a workspace takes any other 404 for a root it
cannot reach, so a proxy's 404 never reads as a refused code. Redeem has no
rate limit: every workspace reaches it from the host's own address, and a
256-bit code cannot be guessed. The root audits a redeem and the refusal of a
code it issued, never a made-up code, so anonymous callers cannot fill its
audit log. A workspace in `oauth` mode refuses a principal with no login email,
applies its own admission lists, and records the login identity on the token it
mints, so its lists keep applying to that token. The exchange route is rate
limited per address as `/auth/device` is, and a refused code counts against
that address. A root token revoked in the minute between issue and redeem still
yields a workspace token, as any change on the root reaches a workspace only
when the workspace token expires.

**`token` mode trusts whoever mints root tokens.** A `token`-mode identity is a
name an operator chose, so a workspace cannot tell a person's own root token
from one minted for them. A root admin can mint a root token for any principal,
or reveal an existing one, and so can act as that principal at the root; through
the exchange the same holds in every `token`-mode workspace, its admins
included. This was accepted over tracking who minted or revealed each token,
which would still leave a root admin able to run steps on the host, where
[Limits](#limits) already put every workspace in reach. An `oauth` workspace is
not exposed: a token minted by hand carries no login email, and it refuses
such a grant.

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
| `WorkspaceRegistry` | Aggregate root (existing) | The host's list of workspaces; read with each rescan, written only through the workspace store |
| Reconciler        | Host service        | Joins the registry, the folder scan, the wanted files and the supervisor; runs removals         |
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
    and audit. A serve without the folder refuses them. After 10.
12. **`swamp serve workspace` commands.** `create`, `list`, `get`, `suspend`,
    `resume` and `rm`, each with log and json output. `create` says that the
    new workspace is stopped and names the command that starts it. After 11.
13. **A `workspace` kind in grants.** `workspace` joins the resource kinds and
    the lifecycle requests check it: `write` to create, `read` to get, `admin`
    to suspend, resume and delete. Root admins pass as before. A ceiling can
    name a workspace for `read`, and a ceilinged caller's `list` names only
    what it could get. Once item 21 is built, no grant reaches the suspend or
    resume of a workspace of the operator's own.
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

19. **A host registers the workspaces it runs** (swamp-club#4918). At startup
    and with each rescan the host registers every workspace folder in
    `workspaces/` the registry lacks, create registers the workspace it made,
    and delete removes the entry. The folder scan still decides what is
    served. A folder that cannot be registered is logged once and still served,
    and a registry that cannot be read is logged and left alone. Done when a
    host started on a host folder with two workspaces lists both in
    `swamp workspace list` at their own folders, both still answer at their
    addresses, and the JSON written has only the registry's keys. After 10.
20. **The host takes its workspaces from the registry** (swamp-club#4919). The
    host and the workspace services work from registry entries whose folder is
    inside `workspaces/`, plus folders that could not be registered, each with
    a folder of its own. Nothing an operator or a client sees changes. Done
    when the in-process host test passes unchanged apart from supplying a
    registry, one folder under two spellings is one workspace, a repo
    registered outside `workspaces/` is not listed, and a host started with a
    registry that cannot be read serves the folders in `workspaces/`. After 19.
21. **A workspace registered anywhere is listed and served in place**
    (swamp-club#4865, built). Every registry entry is a workspace of the host, listed
    and stopped until resumed, and served from its own folder. A wanted file
    names its folder, delete refuses the operator's own, and only the root's
    admins suspend or resume one. Done when a repo registered with
    `swamp workspace import` is listed as stopped within one rescan, a resume
    serves it at `/w/<name>`, `swamp workspace remove` stops it and leaves its
    folder, a left-behind `active` wanted file starts nothing for a later
    import, a hand-written `deleted` leaves its folder untouched, and the
    access suites cover the refusals. After 20.
22. **A host with no host folder** (swamp-club#4920, built). With no `--host-dir` and
    no `host.yaml` in the current folder, the host reads
    `<config dir>/host.yaml` and keeps its state folder at `<data dir>/host/`.
    One host runs per state folder, in both layouts. Done when such a host serves its root and each
    resumed registered workspace, a host folder runs unchanged with no file
    moved, a second host on one state folder refuses to start, and
    `swamp serve host --help` describes both layouts. After 21.
23. **A host with no host folder creates workspaces** (swamp-club#4921, built).
    Create makes the repo in the workspace location under the registry's
    create lock, registers it as created, and writes a wanted file that names
    the folder, which makes it the host's own. Done when create makes a folder
    and an entry there, `swamp serve workspace rm` removes both, a workspace
    the user made with `swamp workspace create` is refused by delete, and a
    test that stops create at each step, or imports the same name at each
    step, never sees a folder a request did not create removed. After 22.
24. **Default off.** The host starts a serve only for a workspace whose wanted
    file says `active`. A folder in `workspaces/` with no wanted file is listed
    and not started, and a wanted file that cannot be read starts nothing. A
    running workspace is stopped by `suspended` or `deleted`, never by a wanted
    file that cannot be read, or that is absent for one scan, as while an
    editor saves it. The root still starts with the host. Done when a folder
    added by hand has no serve until its wanted file says `active`, a resumed
    workspace comes back after a host restart, and replacing a running
    workspace's wanted file does not stop it. After 8.
25. **A first host run creates `host.yaml`** (swamp-club#4971). With no
    `--host-dir` and no `host.yaml` found, the host writes
    `<config dir>/host.yaml` with the loopback defaults and the other keys as
    comments, and starts from it. Done when such a host serves from the file it
    wrote, an existing or invalid `host.yaml` is never replaced, two hosts
    started at once write it once, `--host-dir` naming a folder with no
    `host.yaml` is still refused, and `swamp serve host --help` says the first
    run creates it. After 22.

Issues 16 and 17 need only the first two groups, so the dashboard can proceed
beside the lifecycle. Issues 19 to 23 run in order, after issue 10, issue
24 needs only issue 8, and issue 25 needs issue 22.
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
- **Two hosts run by one user share one registry.** Each lists every entry,
  the other host's workspaces included, and a name is unique across both, since
  the registry keeps names unique. Run a second host under its own `SWAMP_HOME`.
- **`access can-i` does not know whose a workspace is.** It answers a grant
  holder's suspend or resume of an operator's own workspace as the grant
  decides, and the request is then refused with `operator_workspace`.
- **A host depends on a registry it can read.** A registry file removed while
  the host is stopped is an empty registry at its next start, so no registered
  repo is listed. Their wanted files stay, so restoring the file brings each
  back as it was. While the registry cannot be
  read, a running host keeps the entries it last read and registers nothing,
  and a host started then serves only what the wanted files name (see
  [The host](#the-host)). A new or removed workspace is not seen until the
  registry can be read again.
- **A registered repo that another serve already runs.** While a `swamp serve`
  started outside the host holds the repo's datastore writer, the host's serve
  for it exits 75 at startup. The host retries without end, since that exit
  never leads to `failed`, and the status file shows `backoff` with the reason.
  Stop the other serve, or suspend the workspace.
- **A workspace reaches the root at its public address.** Redeeming a sign-in
  code needs the host to reach its own public name. Split DNS, hairpin NAT or a
  proxy the host cannot reach from inside breaks the exchange; the workspace
  answers 502 and logs the address it could not reach.
- **In `token` mode a root admin reaches every workspace.** Anyone who can
  mint or reveal a root token can sign in to a `token`-mode workspace as any
  principal (see [Sign-in](#sign-in)). Use `oauth` mode for a host whose root
  admins should not be principals inside its workspaces.
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
