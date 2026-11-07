---
audience: operator, maintainer
enables: [serve]
last-verified: 2026-11-07 @ 47eafaa7
---

# Access Control

Serve checks every request against an in-memory policy built from grant and
group data. Each check asks: "may this principal perform this action on this
resource?"

The check happens in serve handlers, not the domain layer
(`authorizeOrReject` in `src/serve/handlers/shared.ts`). The domain provides the
decision service and only serve handlers call it. A local `swamp` invocation (no
`--server`) is never subject to grants.

## Principals

A principal is the identity a request or run acts as. There are three kinds:

| Kind      | Format           | Source                                              |
| --------- | ---------------- | --------------------------------------------------- |
| `user`    | `user:<id>`      | OAuth sub claim, or the username on a server token  |
| `worker`  | `worker:<id>`    | Worker enrollment via the `rpc.enroll` frame        |
| `service` | `service:<id>`   | Built in: serve itself, for runs no client started |

Minting a server token rejects any other kind and names the valid ones. A stored
token whose principal does not parse (minted before that check, or hand-edited)
is refused at authentication with `401 invalid-principal`.

### Service principals

Serve starts some runs with no client behind them. Those runs act as a built-in
service principal, recorded as the run's `initiatedBy`:

| Principal           | Runs                                   |
| ------------------- | -------------------------------------- |
| `service:scheduler` | Cron fires, and fires replayed at boot |
| `service:webhook`   | Verified webhook deliveries            |

Service principals exist only in-process. Every token mint path (local CLI,
`access.token.mint`, the `swamp/server-token` behavior) refuses a service
principal, and a stored token naming one is refused at authentication with
`401 invalid-principal`, so no caller can act as the scheduler or the webhook
receiver. `--admins` rejects a service principal. A grant or group can still
name one explicitly; do not give it `admin`, since every scheduled or webhook
run would then act with it.

Each run is authorized when it starts executing, so a queued or replayed run is
checked against the current policy (`src/serve/trigger_authorizer.ts`). The
authorizer resolves the configured workflow once and decides on its canonical
name and tags, and the run executes that same workflow. A workflow that does not
resolve is decided on the configured value and fails in execution as before.

Implementation: `src/domain/access/service_principal.ts`.

The principal is resolved once per connection and attached to every request on
that WebSocket. In `none` auth mode there is no principal and no authorization.

Implementation: `src/domain/access/principal.ts`.

### Server-token authentication

Server tokens use the `<name>.<secret>` format. To authenticate an HTTP or
WebSocket request, serve resolves only a `swamp/server-token` definition and
reads its `token-main` lifecycle resource and vault secret. It applies the same
lifecycle check and timing-safe comparison as the behavior's `redeem` method,
but read-only: it does not write `lastUsedAt`, run a method, or create a
behavior run. Calling `redeem` directly still updates usage.

The record also names the secret it was minted with, as a SHA-256
`secretFingerprint`. A credential that matches the vault secret but not that
fingerprint is rejected: the record, and so the principal, belongs to a
different mint of the name (swamp-club#2482). See "Tokens" in
`design/primitives/serve.md`.

Implementation: `src/serve/token_auth.ts`,
`src/domain/models/access/server_token_model.ts`.

### Clients

A token records a client, written `<kind>:<id>`, separate from its principal.
"Client" here is not the OAuth client serve registers at swamp-club, nor
swamp-lib's `SwampClient`.

- The **kind** says what serve treats differently. `direct` applies no ceiling.
  `integration` is an app an admin registers, whose rights are the person's
  grants intersected with its ceiling (see
  [Integrations and ceilings](#integrations-and-ceilings)). No production path
  issues an `integration` token yet.
- The **id** says which one. Serve's behavior may depend on a client's kind. An
  integration ID is used only as the key to that integration's own record: no code
  compares it with a particular value or treats one ID differently from another.
  A grant condition an operator writes may read it.

| How the token is issued                 | Client             |
| --------------------------------------- | ------------------ |
| `swamp auth login --server`             | `direct:cli`       |
| Dashboard login                         | `direct:dashboard` |
| `swamp access token mint`, or `mint`    | `direct:token`     |

Serve writes the client when it issues the token and only reads it afterwards:
it is not a `mint` argument, nothing in a sign-in request can choose it, and
rotation keeps it. Authentication parses it strictly and refuses a malformed
value with `401 invalid-client`. The stored field stays a loose string, because
listing and GC skip a record that fails to parse and a bad value must not hide a
token from revocation. A token issued before clients has none and reads as
direct with no id. A dashboard session started from a pasted token keeps that
token's client.

The client labels how a token was issued, not what presents it: a copied
`direct:cli` token still reads `direct:cli`, so a `direct` id is not a security
boundary. So a refusal on `client` stops tokens issued to that integration. It
does not stop the app, or the person: they can still act through the CLI, or hand
an app a minted token that reads `direct:token`. To stop the action, deny the
person. Grant conditions read the client (see
[Condition evaluation](#condition-evaluation)). Runs and audit events record it;
see "Actor identity" in `design/enablers/serve-audit.md` and "Run records: the
threat model" below.

Implementation: `src/domain/access/client.ts`.

## Integrations and ceilings

An integration is an app an admin registers with `swamp access integration`. A
token whose client is `integration:<id>` is limited by that integration's ceiling
on every decision, inside `GrantBasedAccessDecisionService`, so handlers change
nothing. Effective rights are the person's grants intersected with the ceiling. A
ceiling can narrow rights and never adds any. An unknown or revoked integration,
or a client that does not parse, is refused.

No production path issues an integration token yet: linking a person belongs to
the delegation work. `swamp access integration` manages the records only.

A refusal is an explicit deny, named `builtin:integration-ceiling`,
`builtin:integration-unknown` or `builtin:integration-revoked`, never a null. Sites
that fall back to an admin check on a null would otherwise let an admin person
through. The audit event names the principal, the client and that grant.

### The ceiling

```json
{
  "version": 1,
  "ceiling": [
    { "actions": ["approve", "read", "run"], "resource": "workflow:@acme/deploy" }
  ]
}
```

- **Resources:** `workflow:` selectors only, with a wildcard only at the end.
  Registering or changing a ceiling refuses any other kind, behaviors included, so
  an integration token cannot run a behavior on any transport. A workflow never
  names a method, so a ceiling has no `methods`.
- **Actions:** only `run`, `read`, `approve` and `signal`. `write`, `tag` and `admin`
  are refused: a `write` ceiling could create a schedule that outlives the
  integration. Adding an action later is safe, and removing one is not.
- **Canonical form:** order and duplicates carry no meaning. Actions are sorted and
  deduped, entries with one resource merge, and entries sort by resource, serialized
  as RFC 8785 JSON. The **ceiling digest** is `sha256:` and the lowercase hex of
  those bytes. swamp-club computes the same one, from the same rules, for what a
  person consents to.
- **A digest only shows a change.** `ceilingWithin(consented, current)` says whether
  a ceiling widened, so a delegation needs a copy of the ceiling a person agreed to.

Implementation: `src/domain/access/ceiling.ts`.

### Actions match literally

A request through an integration needs two things: the ceiling names that exact
action on that workflow, and the person would be allowed it without the integration.

| Person holds    | Ceiling names | Result                                     |
| --------------- | ------------- | ------------------------------------------ |
| `run`           | `run`         | Run is allowed, and approve is refused     |
| `run`           | `approve`     | Approve is allowed, through the person's implied right, unless `--approve-requires-explicit-grant` is on |
| `approve`       | `run`         | Both are refused                           |
| A deny on `run` | `approve`     | Approve is refused                         |

Implications that grants have, such as `run` implying `approve`, never apply to a
ceiling itself, so a ceiling allowing only `run` does not allow approving a gate.

**Admin rights are not available.** Rights a person has only because they are an
admin never pass, since the admin check is decided on `access:*`, which no ceiling
covers. Only their explicit grants on workflows count. A restricted command needs
that admin check, so `--restricted-commands` keeps a command from every integration
token, even for an admin person.

### What each action allows

| Action    | Allows, on a workflow the ceiling names                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | Start a run, resume one (including from a job), attach to one, and cancel any run of it; save an evaluation when `read` also allows the evaluate                                                   |
| `read`    | The definition, search, run history and logs, approvals, waits, triggers, schedules, schema, validate, an unsaved evaluate, and that workflow's health entries                                     |
| `approve` | Approve or reject a gate                                                                                                                                                                           |
| `signal`  | Deliver a signal to a wait                                                                                                                                                                         |

**`run` includes cancel.** It reaches any run of the workflow, including another
person's or a scheduled one, and there is no separate action to narrow this.
Cancelling a parent also cancels its suspended children, on workflows the ceiling
does not name. To keep cancel away from integration tokens, list `workflow.cancel`
in `--restricted-commands`.

`read` does not reach a run's data: `data.*` needs a `data` read, which no ceiling
allows.

### Transports

| Transport                                       | An integration token                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| WebSocket requests                              | Decided on every request. A rule test walks every request type               |
| HTTP read route, action route, cancel, signal   | Decided as the WebSocket is                                                  |
| Admin routes (cluster, config, `/internal/runs`) | Refused, since they need admin                                               |
| `/api/v1/health`                                | Answers any valid token, even with an empty ceiling, showing only what it may read |
| Datastore API, commit feed (`commits.*`)        | Refused and audited: they replicate the repository                           |
| Dashboard session exchange                      | Refused and audited                                                          |

`swamp access check --client integration:<id>` judges a request against the
registered ceiling as serve would, so an unregistered ID reads as refused.

### What a ceiling cannot reach

A ceiling applies where a run starts. Once it has, the run behaves as any run does:
see [Workflow execution context](#workflow-execution-context). A ceiling allowing
`run` should name specific workflows.

- **Steps and child runs** have no ceiling, so a nested workflow runs even if the
  ceiling does not name it.
- **Vault use during a run** has no ceiling, in line with the rule that client
  conditions never narrow a run. That includes an admin person's reach to reserved
  vaults, if a stored workflow asks for one. Workflow run inputs stay inert, so an
  integration token cannot name a secret through them.
- **A run already started carries on** after its integration is narrowed or revoked,
  including one suspended at a gate. Resuming one by request needs `run` under the
  caller's own ceiling, so someone else can still resume it. An automatic resume
  after a gate needs the deciding token's ceiling to cover the parent; otherwise
  it waits for someone to resume it.

### The record

An integration is a `swamp/integration` control-plane record, in data
`integration-main`, holding its ID, name, credential hash, ceiling and state. It is
a record type of its own rather than a grant row, because a grant with a new
subject kind stops an older serve loading any policy.

- **The ID is final.** Revoking cannot be undone and the ID stays reserved, because
  tokens issued to it would otherwise come back to life. Listing keeps showing it,
  and `model delete`, `data delete` and `data rename` refuse its record. There is no clean-up path
  yet.
- **One record per ID.** The record's definition ID is derived from the integration
  ID, because nothing in storage can refuse a create and a second record would make
  every node refuse the ID. So registers that overlap reach one record. They can
  still all report success, and the last write's credential is the one that matches:
  the delegation work must close that before credentials are checked.
- **Revoked is final, except for overlapping writes.** Each local change pulls first,
  and serve reads a copy its poller refreshes, so a change sees what has already
  synced. With no lock, on a store with one cache per machine a write that overlaps
  another, or arrives before serve's next poll, is last write wins: a register can
  still bring back a just-revoked ID. A commit-log datastore has one writer and refuses
  it. Delegation should recheck this before it relies on the record for credentials.
- **The credential** is `swi1.<id>.<64 hex>`, generated by the CLI and shown once at
  registration. Serve and the repository only ever see its SHA-256 hash: a long
  random secret has nothing to guess, so it needs no slow hash. Nothing checks it
  yet, and it cannot be rotated.
- **Audit:** a registration, ceiling change or revoke through serve is a behavior
  run, audited with the principal, client, state and ceiling digests, never the hash.
- **On a follower** every command is forwarded to the leader, including `list` and
  `show`, so an operator does not read a copy behind a revoke they just made.

### Changes apply without a grant reload

Serve keeps integrations in `IntegrationDirectory`, apart from the policy snapshot,
so `--grant-reload manual` does not hold them and reloading them never publishes held
grant changes. Each decision reads it live.

| Where                                   | A revoke or narrowing applies                                    |
| --------------------------------------- | ---------------------------------------------------------------- |
| The node that took the command          | Before it replies                                                |
| A write forwarded by a follower         | At once, because the leader decides                              |
| A follower's own reads | When its commit feed applies the change. It refuses reads once its copy goes stale |
| A peer on a v2 datastore                | Within `--datastore-poll-interval`, 30 s by default              |
| A local CLI write with no `--server` on a v2 datastore | Within the same interval                          |

- **With the leader gone** and storage reachable, a follower keeps answering reads,
  and no revoke can land meanwhile, because writes need a leader.
- **A request past its check** finishes. Approving or rejecting decides again inside
  the run's claim, so it sees the change.
- **Open sessions:** on each node, revoking or narrowing closes that integration's
  WebSocket and stream sessions with code 4003, and audits it. Widening closes
  nothing. A closed session leaves its runs running.
- **It fails closed.** Until a load has read every record, every integration is
  refused, and only integration tokens feel that: grants and direct tokens are
  untouched, and serve still starts. A record that names itself but cannot be read,
  a ceiling version this build cannot read, or copies of a record that disagree
  refuse that integration. A token for an integration registered a moment ago is
  refused until the record arrives.

### Upgrade first

Upgrade every instance before registering an integration.

- **An older node ignores these records** when it loads its policy, so it still
  starts. It does not know the type is a control-plane record, though, so on that
  node anyone with `data` or `model` read can see the name, ceiling and hash, and a
  member with write could forge a record a newer node would honour.
- **An older node gives a token with an `integration:` client the person's full
  authority,** because it applies no ceiling. So no token may be issued until every
  instance supports ceilings, which the delegation work must check first.

Implementation: `src/domain/access/integration_directory.ts`,
`src/domain/models/access/integration_model.ts`,
`src/domain/access/integration_credential.ts`, `src/cli/commands/access_integration.ts`.
Guards: `integration/serve_integration_ceiling_rules_test.ts` walks every request
type, and `integration/serve_client_rules_test.ts` pins who reads an integration ID.

## Admission

Before authorization, an admission gate decides who may connect at all. In
OAuth mode the operator must configure at least one of:

- `--allowed-collectives`: the user must belong to one of these collectives,
  checked against the IdP's group claims.
- `--allowed-users`: the user's OAuth sub must be in this list.

If neither is set, the server refuses to start rather than admit anyone. A user
who fails admission is disconnected before any request is evaluated; one who
passes moves on to per-request authorization.

Implementation: `src/domain/access/admission.ts`.

## Subjects

A grant targets a _subject_, not a principal. There are five subject kinds:

| Kind         | Format              | Matches when                                            |
| ------------ | ------------------- | ------------------------------------------------------- |
| `user`       | `user:<name>`       | The principal is `user:<name>`                          |
| `group`      | `group:<name>`      | The principal is in the named local group               |
| `idp-group`  | `idp-group:<name>`  | The principal's IdP group claims include the group      |
| `collective` | `collective:<slug>` | The principal's swamp-club collectives include the slug |
| `service`    | `service:<name>`    | The principal is the built-in `service:<name>`          |

IdP groups and collectives are separate lists from the OAuth userinfo response
(`groups` and the `--groups-field` field) and never stand in for each other: a
team without SSO has no IdP groups, so it grants its members by `collective:`.
Only OAuth logins carry either list; a manually minted token, a no-auth session
and the built-in service principals carry neither. A collective cannot be a
serve admin (`--admins`).

In OAuth mode a grant file can also write `username:<name>`, which serve
resolves to `user:<sub>`; see [Usernames in grant files](#usernames-in-grant-files).

### Local groups

Local groups are `swamp/group` behavior instances, each with a name and a list
of principal members. The `PolicySnapshot` indexes groups by principal, so
resolving subjects is a single map lookup.

### Subject resolution

For each request, the decision service builds the principal's subject list:

1. `<kind>:<id>`: the principal itself.
2. `group:<name>`: every local group the principal belongs to.
3. `idp-group:<name>`: every IdP group claim carried on the connection.
4. `collective:<slug>`: every collective carried on the connection.

Every grant whose subject is in this list is a candidate.

Implementation: `src/domain/access/subject.ts`,
`src/domain/models/access/group_model.ts`.

## Grants

A grant allows or denies an action on a resource for a subject. Grants are
stored as `swamp/grant` behavior instances with state `active` or `revoked`.

### Schema

| Field       | Type                  | Description                                    |
| ----------- | --------------------- | ---------------------------------------------- |
| `id`        | string                | Unique grant identifier                        |
| `subject`   | string                | Target subject (`user:adam`, `group:ops`)      |
| `effect`    | `allow` \| `deny`     | Whether the grant permits or blocks            |
| `actions`   | `Action[]`            | One or more of `run`, `read`, `write`, `admin` |
| `resource`  | string                | Resource selector (`workflow:@acme/*`)         |
| `condition` | string (optional)     | CEL over resource fields and principal context |
| `methods`   | string[] (optional)   | Limit to these methods (omit for all; see [Method scope](#method-scope)) |
| `state`     | `active` \| `revoked` | Only `active` grants are evaluated             |
| `source`    | string                | Where the grant came from (see below)          |

### Grant sources

| Source             | Meaning                                         |
| ------------------ | ----------------------------------------------- |
| `method`           | Created via `swamp access grant create`         |
| `config`           | Loaded from server configuration at startup     |
| `file:<filename>`  | Reconciled from a grants file: the bare filename for the repository `grants/` directory, `grants-dir/<filename>` for `--grants-dir` files, `grants-file` for the `--grants-file` file |
| `extension:<name>` | Bundled with an extension                       |

### Grant files

Operators can declare grants in YAML files in the repository's `grants/`
directory, and in one additional directory set with `--grants-dir`. A
`--grants-dir` that is the repository `grants/` directory itself is read once,
from `grants/`, so each file keeps a single source. A relative `--grants-dir`
or `--grants-file` resolves against the repository directory, whether it comes
from the flag, `SWAMP_GRANTS_DIR`/`SWAMP_GRANTS_FILE` or `.swamp/serve.yaml`, so
the same configuration loads the same grants wherever serve is started. Each
file contains:

```yaml
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run, read]
    resource: "workflow:@acme/*"
  - subject: "group:ops"
    effect: allow
    actions: [run, read, write]
    resource: "model:*"
    condition: 'resource.tags.env == "staging"'
  - subject: "user:monitor"
    effect: allow
    actions: [run]
    resource: "model:@acme/my-model"
    methods: [read, list]
```

Each entry sets exactly one of `resource` (a string) or `resources` (an array of
strings). `resources` is shorthand that expands into one grant per string, with
all other fields identical:

```yaml
grants:
  - subject: "idp-group:my-team"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/create-thing"
      - "workflow:@acme/connect-thing"
```

This equals two entries, each with `resource:`. It expands at parse time, so
the domain model, reconciler and evaluation engine only see single-resource
grants. Setting both `resource` and `resources` is an error. `resources` takes
up to 100 entries.

In the same way, each entry sets exactly one of `subject` (a string) or
`subjects` (an array of strings). `subjects` expands into one grant per subject,
so a team that shares access needs one entry instead of a copy per person:

```yaml
grants:
  - subjects:
      - "user:alice"
      - "user:bob"
      - "user:carol"
    effect: allow
    actions: [read, write, run]
    resources: ["workflow:*", "model:*"]
```

An entry with both arrays expands into one grant per subject and resource pair,
six here. Setting both `subject` and `subjects` is an error, a subject listed
twice rejects the entry, and `subjects` takes up to 100 entries. Each invalid
subject is reported, and each invalid resource or condition once, not once per
subject. As with any grant file error, the whole file is rejected: serve refuses
to start, `swamp access reload` rejects the reload, and the directory poller
keeps the file's stored grants. No valid subject from a partly invalid list is
applied. Because the expanded grants are identical, rewriting repeated
single-subject entries as one `subjects` entry changes no grants on reload. A
`subjects` list keeps membership in the reviewed file; a `group:` subject keeps
it in the datastore, managed with `swamp access group`.

#### Usernames in grant files

In OAuth mode a grant file can name a user by username instead of by OAuth
subject (`sub`), with `username:<name>`:

```yaml
grants:
  - subjects: [username:alice, username:bob]
    effect: allow
    actions: [read, run]
    resource: workflow:*
```

`username:` is not a subject kind. It exists only in grant files: serve resolves
the name to its `sub` and stores an ordinary `user:<sub>` grant, so matching
stays on the `sub` and the grants API never accepts `username:`. `user:<x>`
keeps meaning the principal id `<x>`; a value is a username only when it is
written as `username:`. With `--auth-mode token` a user principal already is
its username, so write `user:<name>`; any mode other than `oauth` rejects a file
that names `username:`. Names are looked up with the provider's
`/api/auth/resolve-user` endpoint.

A username can be renamed, and after an account is deleted its name can be
registered by someone else. A grant matched on the name at request time would
then apply to a different person, so a name is resolved once and pinned, in the
`oauth-resolved-grant-usernames` key of the `_token-secrets` vault (apart from
the admin and allowed-user resolutions):

- A pinned name is never looked up again. A grant follows the account, not the
  name: after a rename the grant still applies to the account, and whoever
  registers a freed name inherits neither its allows nor its denies. Changing
  the file to the account's new name changes no grant, since both resolve to
  the same `sub`.
- A name the provider reports as not found is recorded with the time it was
  first seen missing and is never looked up again, so a typo cannot be claimed
  by whoever registers it later. Its file is rejected until the name is removed
  or changed. A file with a name that does not resolve is rejected whole, as
  with any invalid subject, so a deny is never silently dropped.
- Any other lookup failure (provider unreachable) records nothing; the name is
  looked up again when the grant file changes, on `swamp access reload`, or
  when serve restarts.
- A record is forgotten only when no grant file names it and every grant source
  loaded, so a file held back for an error keeps the pins of its names. To
  re-point a name, or to retry one first seen missing, remove it from every
  file, reload, then add it back.
- A `username:` entry and a `user:` entry, or two usernames, that resolve to the
  same grant are a duplicate and reject the file.

Serve startup looks new names up with the token it uses for new admin names:
the collective API key (`SWAMP_API_KEY` or `--club-api-key-file`), else a
device grant, which a serve run by a process manager cannot complete. A name a
startup records as missing stays recorded even though startup refuses. While
serve runs, the auto-reload and `swamp access reload` look new names up only
with the collective API key. Without one, a file naming a new username is held
back with its stored grants unchanged until serve restarts; the auto-reload
tries it again only when the file changes. One load looks up at most 200 new
names, four at a time, within 60 seconds; past the cap the files naming them
are rejected. Pinned names need no provider, so an outage never touches them.
Peer instances share the vault: each load reads the pins again, so a name a
peer pinned is not looked up a second time, and each write merges with what a
peer stored since, keeping the peer's record for a name both recorded.

`--admins` and `--allowed-users` names in OAuth mode are pinned the same way,
in the `oauth-resolved-admins` key (`src/serve/oauth_access_list_resolution.ts`):
a resolved name is never looked up again, and a name the provider reports as not
found stays skipped until it is removed from the list. Startup looks up only
names with no record, so it needs a credential that can call
`/api/auth/resolve-user` (a login token, or a collective API token with
`oauth:manage`) only when a name is added; a refused lookup names that scope.
An entry must be a plain username: admins, allowed-users and not-found records
share that one key's map, so an entry containing a colon after the optional
`user:` prefix (`allowed:bob`, `group:eng`) could spell another entry's record.
It is skipped with an ERROR, without a lookup, and records nothing.

`swamp access grant list` shows the username beside the `sub`, and audit
records name an actor resolved this way by username;
`swamp access can-i` reports the matching grant as `user:<sub>`.
`swamp serve check-config` looks every name up afresh and cannot read the pins,
so a name serve recorded as missing can show as resolved there.

The `GrantFileReconciler` syncs file grants into behavior data, creating,
updating or revoking them as files change. The `file:<filename>` source
separates them from method-created grants during reconciliation.

The source of a `--grants-dir` or `--grants-file` grant does not depend on
where the file is mounted. Serve instances that share a datastore can mount
the same files at different paths; with the path in the source, each instance
reconciled the other's grants as grants of a file it no longer had and revoked
them, deny grants included, until the other instance recreated them. Neither
form can equal a repository `grants/` file name, which has no slash and ends in
`.yaml` or `.yml`. A `--grants-file` that is also in the `--grants-dir` is
stored under both sources, with the same grants.

Grants stored before this change carry the absolute path of their file. No
instance loads that source any more, so the first reconcile after an upgrade
revokes them and creates the same grants under the new source, in one sync
unit. The datastore push is not atomic across files, so a peer that pulls
mid-push can briefly see the revoke before the create. Until every instance on
a datastore is upgraded, older instances still store and revoke by absolute
path.

Instances that share a datastore must load the same grant files. An instance
without a `--grants-dir`, or with different files in it, revokes the other
instance's `grants-dir/` grants, as it does for repository `grants/` files it
does not have.

Reconcile treats every stored copy of a grant as the same grant. Serve
instances that start against one datastore can each store a copy of a file
grant or `--admins` grant. An entry removed from a file, or an admin removed
from `--admins`, has every copy revoked.

For a file grant still in its file, reconcile keeps the active copy with the
lowest behavior id and revokes the others. The order does not depend on local
state, so no peer ever revokes the lowest active copy it can see, and at least
one copy stays active while peers sync. Admin grants for admins still in
`--admins` are left as they are, duplicates included: their definitions share a
name-derived path, so peers cannot agree on a copy to keep until they sync. A
wrong pick could revoke the last active copy, and an active duplicate does no
harm. When every copy is revoked and the admin is added back, the copy backed
by the stored definition is reactivated.

Startup and `--grant-reload auto` push their grant writes to the datastore, as
`access reload` does, inside the exclusive sync gate
(`src/serve/grant_write_tracking.ts`).

Under `--grant-reload auto`, the poller does what a restart would do with the
same files. Where startup refuses to start, the source keeps its stored grants
unchanged and the error is logged: a file with a YAML or schema error, an
unreadable file, and a missing or unreadable `--grants-file` or `--grants-dir`
(for example an unmounted volume). An emptied file in the repository `grants/`
directory is a schema error, so it keeps its grants too. Other files still
reconcile. Where startup accepts the input, its grants are revoked: a deleted
file and a missing repository `grants/` directory at once, and an emptied
`--grants-file` or `--grants-dir` file once two consecutive polls have read it
as empty. A rewrite in place reads as empty between its truncate and its write,
and a single such read must not drop a deny. So revoking an emptied file can
take up to two poll intervals. A node with no running poller, in manual reload
mode, revokes it on the one reconcile it runs on taking the lead. A takeover's
reconcile counts as a poll, so at a takeover the two reads can fall close
together. Replace grant files atomically: a partial write that happens to parse reconciles as what it
contains.

Implementation: `src/domain/access/grant_file.ts`,
`src/domain/access/grant_file_reconciler.ts`.

### Resource selectors

A resource selector has the form `<kind>:<pattern>`:

| Kind       | What it gates                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow` | `workflow.run`, `workflow.status`                                                                                                           |
| `model`    | `model.method.run`, `model.create`                                                                                                          |
| `data`     | `data.get`, `data.query`                                                                                                                    |
| `access`   | Grant and group management, and the records the control plane stores as behavior data (see [Control-plane records](#control-plane-records)) |
| `vault`    | `vault.*` requests, and vault operations during serve runs (see [Vaults](#vaults))                                                          |

Patterns support a trailing `*` wildcard:

- `@acme/*` matches `@acme/deploy`, `@acme/build`
- `@acme/deploy` matches only `@acme/deploy` (exact)
- `*` matches everything

`behavior` is an exact synonym of the `model` kind (swamp-club#3334).
`behavior:@acme/*` and `model:@acme/*` are one selector, in a grant file, in
`swamp access grant`, `access check` and `access can-i`, and in a request.
The selector is read as `model:` when it is parsed, before any comparison or
authorization, so a grant is always stored as `model:`. One grant file entry
that lists both spellings of a selector is a duplicate. Any other kind,
including `behaviour` and plurals, is refused, so a misspelled deny fails at
load instead of matching nothing. The parser is
`src/domain/access/resource_selector.ts`.

#### Behavior resource dual-identity matching

For `model` resources, grants match **both** the instance name and the extension
type. A grant on `model:@xero/segment/*` matches any instance whose type is
under `@xero/segment/`, such as `segment-test-audiences` with type
`@xero/segment/audience`. The name is checked first. If it does not match, the
type from the behavior's definition is checked as a fallback. This holds on
every evaluation path: `decide()`, `explain()`, and `filterByResources` for
collection operations.

#### Type spellings

Types are stored in one spelling: lowercase, with `::`, `.` and whitespace
folded to `/`, and an extension type's leading `@` kept (`AWS::EC2::VPC` is
stored as `aws/ec2/vpc`). A selector can name a type in another spelling, and
how it matches depends on the grant's effect (swamp-club#3130):

- **A deny matches its type in any spelling.** `deny model:@Acme/*`,
  `deny model:acme/*` and `deny model:AWS::EC2::*` cover `@acme/...` and
  `aws/ec2/...` types, and for a pattern written as a type path (with a `/`
  or `::`) a leading `@` is ignored on either side, as
  `restricted-model-types` compares types. A pattern without one (`a*`,
  `prod-*`, `web.prod`) may be written for behavior names, so it keeps its `@`
  as written and never reaches `@` types; it still folds case and
  separators, so `deny model:web.prod` also covers the type `web/prod`. The
  same holds for an `access:` deny on a control-plane record
  (`access:@swamp/grant` covers `swamp/grant`).
  Only the type comparison folds: instance names still match as written,
  though a deny written for mixed-case legacy names (`deny model:Prod-*`)
  now also covers types spelled `prod-...`. A pattern that is only `@` before
  its wildcard (`@*`) keeps its written meaning, so it never grows to every
  type.
- **An allow matches only as written.** Folding it would widen what it
  grants, so a misspelled allow matches no type, as before.

Every non-canonical spelling is reported with the canonical one, except that a
finding never tells an admin to respell a pattern that may name behavior names
(that would drop them); it says what the grant matches instead: as a warning
when a grant is created (the selector may also name instance names, so it is
never refused), once per grant when serve loads its policy, and by `swamp serve
check-config` for grant files. A grant condition is not rewritten: comparing
`modelType` (or an access resource's `name`) with a string literal no type is
spelled as is refused when the grant is created, and reported as a warning for
stored and file grants, which keep loading — a grant-file error stops serve
starting. Literals tested with `startsWith`, `endsWith` or `contains` are folded
the same way, so `modelType.contains(".")` or `modelType.endsWith("Probe")` is
refused too: no stored type contains a `.` or an uppercase letter. A bare
literal (`exp/probe`) is a valid spelling of a bare type, so it is not reported,
and does not match `@exp/probe`.

Implementation: `src/domain/access/resource_selector.ts`,
`src/domain/access/grant_based_access_decision_service.ts`,
`src/domain/access/grant_spelling.ts`.

#### Requests by id match the resource's name

Selectors match names, never ids. A request may name a behavior or workflow by
name or by UUID, so serve resolves it first and authorizes the resource it
resolves to: its canonical name and full fields (`modelType` and tags for a
behavior, `ns` and tags for its data, tags for a workflow). A request by the
UUID of `prod-db` is therefore denied by `deny model:prod-*` just as a request
by name is. The operation then acts on exactly that resource: it is handed the
resolved id and the authorized name, and accepts only a resource with both. Ids
alone are not enough — a resource may be named with another's UUID, and a copied
file keeps its id — so neither can redirect the action.

- A string that matches nothing is authorized as sent. The operation then
  reports its usual not-found, and can only ever act on a resource whose id is
  that exact string.
- A workflow file that fails to parse is authorized on the name the file
  declares, since operations such as validate still find it. Its tags cannot
  be read, so rules conditioned on tags do not match it; name selectors do.
- A failed lookup fails the request, after the raw string is authorized so a
  refused caller learns nothing more. It is never treated as "not found".
- Run cancel and attach authorize the resource the run was started on. Serve
  records its canonical name and id when the run starts, and resolves it by id
  when a cancel or attach arrives, so a rename during the run cannot redirect
  the check. Webhook-triggered runs do the same. Records from older instances,
  which carry only a name, resolve that name.
- A behavior is reported with the type its definition file declares, whether it
  is found by name or by id, so authorization and execution always see the
  same type.

Reads of a method output or a workflow run (`model.output.get`, `.data`,
`.logs`, `model.method.history.get` and `.logs`, `workflow.history.get` and
`.logs`) take an output or run id prefix — 3+ hex characters, matched across
every behavior or workflow before any name — or a behavior or workflow name or
id, which reads its latest output or run. Serve resolves the argument to the
output or run the read will return, authorizes its owners, and hands the read
that same resolved output or run, so nothing is looked up again after the check
(swamp-club#2673):

- An output is authorized on every definition declaring its behavior id. Ids
  are not unique, and a copied definition shares the original's outputs and
  data, so a deny on any of them refuses the read. Definitions of
  unregistered types and auto-definitions count.
- A run is authorized on the workflow recorded on it, by its recorded name.
  When no workflow still has both the recorded name and id — the workflow
  was renamed, or only a copy sharing its id remains — the workflow now
  found by that id is authorized too. A run's recorded name identifies its
  workflow exactly, unlike an output, whose data every copy shares.
- A read by behavior or workflow name authorizes that behavior or workflow and
  the owners of the latest output or run it returns.
- An output whose behavior was deleted is authorized on its behavior id; a run
  whose workflow was deleted, on its recorded workflow name (without tags).
- A prefix matching several outputs or runs is authorized on the owners of
  each match, looked up once per behavior or recorded workflow. The ambiguity
  error lists only the matches whose owners the caller may all read. Each
  distinct owner is decided and audited once, however many matches share
  it, so the audit log grows with the owners involved, not with the size of
  the history. When none is readable, the read is
  refused as a unique prefix of the first match would be (swamp-club#2743).
  Without enforcement, serve lists every match, as the CLI does.
- A prefix matching nothing is authorized as sent.
- `model.output.data` and `model.output.logs` return data artifact content, so
  they also need a `data` read on the owning behaviors, as `data.get` does
  (swamp-club#2739). The other five return output or run metadata or the run
  log file and need only the `model` or `workflow` read.

`data.get` and `data.list` scoped to a workflow (`workflowName`, optionally
`runId`) read a run's data, which reveals the run and its steps, so they need
`read` on the workflow — resolved as above — before any run is looked up: a
missing run, a pending run or a run id reaches only a caller who may read that
workflow's history (swamp-club#2603). `data.get` then authorizes `data` read on
every owner of the item it will return and reads exactly that item: the
workflow by id and name, the run, the owner and the version it authorized
(`resolveWorkflowData` and `expectedOwner` in libswamp). Data a workflow owns
itself, such as workflow-scope report output, is named by its workflow — in
`data.get`, `data.list` and `data.search` alike — and authorized as `data` on
the workflow's name and tags.

The response audit event of a request authorized this way records the name the
request resolved to, not the id the client sent (a request by a behavior's UUID
is audited under the behavior's name); a string that matched nothing is recorded
as sent. A workflow-scoped `data.get` is audited under the names of the item's
owners, joined with ", " when there are several. The resolved name replaces the
sent identifier only when the event audits the same kind of resource: a
`run.attach`, audited as the run, keeps the run id. Denials already carry the
resolved resource.

Direct type execution (`model.method.run` with a type and a definition name)
acts on the definition `definitionName` names, which a request may set apart
from `modelIdOrName`. That definition is authorized too, by its canonical name
and fields (or, before it exists, by the name to be created with the named
type), after the requested behavior and the type; it is the one locked, recorded
for cancel and attach, and audited. The run is handed that definition's id and
fails if the name resolves to anything else by then (renamed in, or deleted).
The exception is a name no definition had at the check: if a concurrent run
created it since, the run adopts it when the caller may run that definition,
judged the same way (swamp-club#2672). Because
a direct run can rewrite an existing definition's global arguments, it takes
that definition's behavior lock whatever the method's kind. Vaults are
authorized by name as described in [Vaults](#vaults).

Implementation: `src/serve/handlers/resource_resolution.ts`. Guards:
`integration/serve_id_deny_conformance_test.ts`, which covers every request
type that names a resource, and
`integration/serve_canonical_authorization_rules_test.ts`.

### Actions

| Action    | Typical operations                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`     | Execute a workflow or method (implies `approve` and `signal`)                                                                                                                               |
| `read`    | Query data, view definitions, list resources                                                                                                                                                |
| `write`   | Create or update behaviors, definitions, data (implies `tag`)                                                                                                                               |
| `approve` | Approve or reject a workflow manual-approval gate                                                                                                                                           |
| `signal`  | Deliver a signal to a `wait_for_signal` step of a workflow, and nothing else                                                                                                                |
| `tag`     | Change a behavior's or workflow's tags, in addition to `write` on it                                                                                                                        |
| `admin`   | Manage grants, groups, tokens, restricted behaviors (`--restricted-model-types`, matched in any spelling: a leading `@` is ignored; see below), and any operation on a control-plane record |

**Renaming through an edit**: `model.edit` and `workflow.edit` refuse content
whose `name` differs from the stored one unless the request sets
`allowRename`, and refuse a name another behavior or workflow holds even then
(swamp-club#3302). `allowRename` states the client's intent and grants
nothing: the edited name is still authorized as below.

**Restricted behavior types**: a behavior whose stored type is listed in
`--restricted-model-types` needs `admin` on `access:*` to be created, run,
edited (including a rename or retag) or deleted, by id or by name, for its
data to be deleted or renamed, and for a workflow step that runs it to be
added or changed (swamp-club#3129, swamp-club#3131). Reading it stays open to
`read`. `data.gc`, `data.prune` and `run.gc` are unchanged: they apply
retention across the repository rather than acting on one behavior. Data a
restricted behavior's arguments read from other behaviors is not covered
(swamp-club#3171).

**`run` implies `approve`**: a grant with `actions: [run]` also passes `approve`
checks, so existing `run` grants can still approve. To allow approval without
execution, use `actions: [approve]` alone.

**Requiring an explicit `approve` grant** (opt-in): `swamp serve
--approve-requires-explicit-grant` stops an allow grant on `run` from passing
`approve`. The config key is `auth.approve-requires-explicit-grant` and the env
var is `SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT`. With it on, an automation
principal granted `run` cannot clear a gate meant for a person. It is off by
default. A deny on `run` always denies
`approve`, setting or not, so turning it on can only narrow access. Like other
`auth.*` settings it is per process; every replica behind a load balancer must
share it.

**`signal` is its own action, and `run` implies it** (swamp-club#3094). A grant
with `actions: [signal]` lets its holder deliver a signal to a wait on the
workflows it covers and do nothing else there: it cannot start, approve, resume,
read or list. That suits a callback identity, or a person who answers a wait
without being able to run the workflow. A grant with `actions: [run]` also
passes `signal` checks, for the reason it passes `approve`: whoever may start
the workflow gains little from answering its waits. `approve` does not imply
`signal`, and `signal` implies nothing.

A holder of `signal` alone cannot list waits, so it signals a wait it was told
the ID of, or names the workflow and a key a `wait_for_signal` step declares
(swamp-club#3211). By key the request names the workflow, and it is resolved
and authorized like any request that names one, before anything about the key
is read. Key claims are kept per workflow ID, which a copied file shares, so the
caller needs `signal` on every workflow with that ID; the wait the key resolves
to is then authorized as a wait named by ID is. A refused caller gets the answer
an unknown workflow or key gets. See
"Signal" in [serve](../primitives/serve.md).

**Requiring an explicit `signal` grant** (opt-in): `swamp serve
--signal-requires-explicit-grant` (config key
`auth.signal-requires-explicit-grant`, env var
`SWAMP_SIGNAL_REQUIRES_EXPLICIT_GRANT`) stops an allow grant on `run` from
passing `signal`. It is independent of the `approve` setting, off by default and
per process. A deny on `run` always denies `signal`, setting or not, so a
principal under a deny on `run` cannot signal even with an explicit `signal`
allow, and turning the setting on can only narrow access.

**Do not store a grant that names `signal` while an older build shares the
datastore.** A build from before this action cannot parse such a grant, and
`PolicySnapshotLoader` in builds before swamp-club#3386 skips a stored grant
that fails schema validation without a warning. The whole grant is lost to that
build, not only its `signal`: an allow for `signal, read` no longer grants
`read`, and a deny for `run, signal` no longer denies `run`, so the older build
allows what the grant was written to stop. Rolling back to an older build has
the same effect on grants made meanwhile. A declarative grant file fails closed
instead: the older build refuses to start on it. From swamp-club#3386 on, a
build that cannot validate a stored grant or group treats it as unrecognised
(item 5 of the PolicySnapshot lifecycle below): it refuses to start on it, and
once running it keeps a deny it read earlier. Upgrade every host that reads the
datastore before the first grant naming `signal` is created.

**`tag` is its own action, and `write` implies it** (swamp-club#3085). A
behavior's or workflow's tags are what a condition such as
`tags.team == "team-a"` reads, for the behavior or workflow itself and for the
data it owns, which is judged on its owner's current tags. Whoever may change
those tags may therefore move a resource into or out of every grant that reads
them, including a `data:` read grant. So a `model.edit` or `workflow.edit` whose
saved tags differ from the stored ones needs `tag` as well as `write`: on the
resource as it was (its name and prior tags), so a member cannot move it out of
a tag their grants depend on, and on the resource as the edit leaves it, so they
cannot move it in. A rename counts as a retag and needs `tag` on the old name
and the new one: a `tag` grant scoped by name would otherwise be reached by
renaming a resource into its pattern first and retagging it after. An edit that
changes neither tags nor name needs no `tag`. A restricted or control-plane behavior is edited as admin, which covers
its tags. Behaviors and workflows are created untagged (`model.create`,
`workflow.create` and direct type execution set no tags), so every tag is set
through an edit.

The prior tags are both the ones the edit loaded and the ones stored when it
saves, read again just before the save: an edit carrying tags it loaded before
someone else's retag would otherwise put the old tags back without a `tag`
check. When the stored resource is no longer found under the name and id the
edit loaded, the edit is judged a retag. The window between that read and the
save remains, as for every edit (edits take no lock).

By default a grant with `actions: [write]` also passes `tag` checks, so existing
grants keep their meaning. That leaves a tag-conditioned read grant open to
anyone who may write the resources it covers. Close it either way:

- **Require an explicit `tag` grant** (opt-in): `swamp serve
  --tag-requires-explicit-grant` (config key
  `auth.tag-requires-explicit-grant`, env var
  `SWAMP_TAG_REQUIRES_EXPLICIT_GRANT`) stops an allow grant on `write` from
  passing `tag`. It is independent of the `approve` and `signal` settings, off
  by default and per process. A deny on `write` always denies `tag`, setting or
  not, so turning it on can only narrow access. Grant `tag` where tags may
  change, scoped by a condition when needed; a name pattern also works, since
  a rename needs `tag` too.
- **Deny `tag`** without the setting: a deny grant on `tag` for the members
  whose reads depend on tags overrides the `tag` their `write` implies.

A self-service team that may label its own resources needs a `tag` grant whose
condition holds both before and after the change. Because new resources are
untagged, `tags.team == "team-a"` alone does not let a member tag a new
behavior into team-a; `!("team" in tags) || tags.team == "team-a"` does, and
lets them claim any resource without a `team` tag. Keep data other teams must
not read away from untagged owners.

A data resource takes its owner's current name as well as its tags, so a `data:`
grant scoped by name has the same exposure: with `read` on `data:team-a-*` and
`write` on `model:*`, renaming another team's behavior to `team-a-x` exposes its
data. This predates the `tag` action. Since a rename needs `tag`, either way of
closing the retag above closes it too; without one, scope data reads by tag
conditions only together with one of them.

**Do not store a grant that names `tag` while an older build shares the
datastore**, for the reason given for `signal` above: a build from before this
action skips the whole grant, and every other action in it goes with it. A deny
on `write, tag` no longer denies `write` there, so the older build lets the
member edit what the grant was written to stop. Upgrade every host first, and
until then keep `tag` in a grant entry of its own, a deny above all.

An `AccessDecision` whose grant passed `approve` or `signal` only through `run`
carries `impliedBy: "run"`, and one that passed `tag` only through `write`
carries `impliedBy: "write"`. `swamp access check` and `swamp access can-i` show
them as `[implied by run]` and `[implied by write]`, and `can-i` without an
action lists an implied `approve` row and an implied `signal` row per `run`
grant, and an implied `tag` row per `write` grant. The server's `access.check`
and `access.can-i` responses report the policies as
`approveRequiresExplicitGrant`, `signalRequiresExplicitGrant` and
`tagRequiresExplicitGrant`.

Implementation: `src/domain/access/action.ts`,
`src/domain/access/grant_based_access_decision_service.ts`
(`runImpliesApprove`, `runImpliesSignal` and `writeImpliesTag` options,
`actionsCoveredBy`), `tagsChanged` in `src/domain/access/access_resources.ts`,
and `authorizeRetag` in `src/serve/handlers/shared.ts`, called from the
`model.edit` and `workflow.edit` handlers.

## Grant evaluation model

The `GrantBasedAccessDecisionService` runs the evaluation. For a (principal,
action, resource) triple:

1. **Resolve subjects**: the principal itself, local groups, IdP groups.
2. **Collect candidates**: every grant whose subject is in the list.
3. **Filter**: keep grants matching the resource selector, the action and,
   when the grant has a `methods` list, the request's method (see
   [Method scope](#method-scope)). Implied actions count:
   `run` implies `approve` and `signal`, and `write` implies `tag`, each except
   for allow grants when the server requires an explicit grant for that action.
4. **Partition**: split into deny and allow grants.
5. **Evaluate denies first**: check each deny's condition, if any. The first
   matching deny wins and the request is rejected.
6. **Evaluate allows**: check each allow's condition, if any. The first matching
   allow wins and the request proceeds.
7. **Service trigger default**: a `service` principal asking to `run` a
   `workflow` is allowed (decision grant id `builtin:service-trigger-default`).
   It covers no other action or resource kind, so it never implies `approve`
   or `signal`.
8. **No match**: if an `admin` grant on `access:*` matches, the request proceeds
   (admin fallback). Otherwise it is denied by default.

**Deny-first**: a deny always beats an allow for the same subject, action and
resource. There is no other priority or ordering.

**Service trigger default**: the default is computed, not stored, so no grant
reconcile, reload or fleet version skew can remove it, and existing schedules and
webhooks keep running when authorization is added. `explain` and
`swamp access check --subject service:<id>` report it. To restrict trigger runs, add
deny grants: `deny run workflow:deploy` for `service:webhook` stops one
workflow, and a conditioned deny such as
`deny run workflow:* when name != "nightly"` for `service:scheduler` allows
only the named workflows.

A deny whose condition cannot be evaluated (for example a `tags.<key>` the
workflow does not have) refuses, so a broken restriction fails closed. Write tag
conditions defensively, e.g. `!("trigger" in tags) || tags.trigger != "webhook"`. In a mixed-version
fleet, instances older than the service principal skip `service:` grants when
loading policy; they also do not authorize trigger runs.

### Method scope

A grant's `methods` list scopes it to requests that name one of those methods.
An allow with a `methods` list matches only a request whose method is in the
list; a request that names no method is not admitted by it. A deny with a
`methods` list refuses a request whose method is in the list, and every request
that names no method, so a scoped deny cannot be stepped around by a request
that names none. A grant without `methods`, or with an empty list, is unscoped.

Which requests name a method:

- **Behaviors**: a method run, its cancel and attach, `model.method.describe`,
  and reads of what one run produced (`model.output.get`, `.data`, `.logs`,
  `model.method.history.get`, `.logs`, and output, history and usage search
  items). `model.get`, create, edit, delete, retag, validate and evaluate name
  none, so a scoped allow on a behavior does not let its holder read or change
  the definition.
- **Vaults**: every vault request names its verb, the request type without
  `vault.`: `get`, `describe`, `inspect`, `list-keys`, `read-secret`,
  `audit-trail`, `search`, `put`, `delete`, `annotate`, `create`, `edit`
  (rename and repair included) and `migrate`. Vault operations in a serve run
  use `get`, `list-keys`, `put`, `delete`, `annotate`, `describe` (annotation
  and refresh-hook reads) and `edit` (refresh-hook changes), so a `put`-only
  grant never sets a refresh hook.
- **Access**: a run of a control-plane or admin-only behavior names its method,
  so `allow admin access:* methods: [create]` admits running the grant
  behavior's `create` and nothing else; admin checks that are not a method run
  (restricted commands, the admin fallback) name none.
- **Workflows and data** never name a method.

Datastore commits that a run saves (`data.save`, `data.append`, `output.save`)
and partition uploads name no method, but any method a scoped run allow covers
could have made them, so they are decided as any method
(`AccessResource.anyMethod`, set only in
`src/domain/datastore_v3/commit_authorization.ts`): a scoped run allow admits
them. A scoped deny still refuses them, because the commit cannot show which
method ran; a member's local run is not authorized by serve, so the commit is
the only point where the deny applies. A behavior with a scoped deny for a
member therefore takes no data or output commits from that member's runs.

`swamp access grant create` refuses `methods` on a workflow or data grant and a
vault method that is not a vault verb. A grant file or stored grant with them
still loads, with a warning, and its allow matches nothing.

### Condition evaluation

Grant conditions are CEL expressions evaluated in the sealed grant-condition
environment (see `design/enablers/expressions.md`, surface 3). Variables by
resource kind:

| Resource kind | Available fields                                             |
| ------------- | ------------------------------------------------------------ |
| `workflow`    | `name`, `tags`, `collective`, `run` (approve only)           |
| `model`       | `name`, `modelType`, `tags`, `collective`, `methodName`      |
| `data`        | `name`, `ns`, `tags`, `owner`                                |
| `access`      | `name`                                                       |
| `vault`       | `name`, `key`                                                |

Every kind can also use `client`, `principal.sub`, `principal.groups` and
`principal.collectives`.

The same variable list (`src/domain/access/condition_fields.ts`) serves grant
validation and the runtime evaluator. `methodName` is a request field: only
method requests (a method run, its cancel and attach, output and method-run
items) carry it, and a request without one evaluates it as `""`, so a condition
on it simply does not match. A vault's `key` is a request field too: the
secret a request names (`put`, `read-secret`, `delete`, ...), `""` on one that
names none. `collective` and `owner` are declared but serve does not supply them
yet: a deny that references them refuses every request of its kind, an allow
never matches, and loading the policy logs a warning naming each such grant.

`client` is a request field holding the token's `<kind>:<id>`. A token with no
client reads as `direct:`, so `client.startsWith("direct:")` holds for it and
`client != "integration:slack"` does not refuse it. Unlike a resource field it
decides on kind-level checks and operations over every resource. Writing a grant
refuses a literal no token can hold, and warns on a literal `direct:` id, since a
direct id is not a boundary. Type and schema endpoints only look for an allow, so
a client deny does not hide type definitions. Client conditions never narrow a
run: `run` on a workflow or behavior delegates use of what it touches, so inside
a run `client` reads as `direct:`. To keep an integration out of a workflow, deny
`run` on it. A vault deny on the client stops direct requests only. That leaves
one known limit: a secret an integration names in behavior inputs resolves in the
run, so a client deny does not stop it until caller inputs act as the caller
(swamp-club#4479). A vault allow on the client warns when written: it limits the
subject's runs like any vault allow, and a condition requiring an integration
never matches there.

`run` describes the run an `approve` decision acts on, and covers `reject`, which
is decided as `approve`: `run.initiator.kind`, `run.initiator.id`,
`run.initiator.sub` and `run.serveDriven`. A user's `sub` is their id, so it
compares directly with `principal.sub`. A service run's `sub` is empty, since no
person started it and no principal's id is empty, so anyone with `approve` can
decide it. A run with no usable initiator (none recorded, `ghost`, or text that
does not parse) has no `run` at all, so a deny needing it refuses and an allow
needing it does not match. A grant naming `run` on any other action is refused
when written, because no other decision can supply it, including `[run]` and
`[approve, read]`. So is a path `run` does not have, such as
`run.initiatr.sub`, and a condition whose types cannot evaluate (see below). A
stored grant that reaches a node anyway warns at load and decides by the rules
here.

**Missing fields fail closed** (swamp-club#2675). Serve authorizes every
resource with all of its resource fields — `tags` is `{}` and `ns` is `""` when
the resource has none, and `name` is always the resource name. A condition that
references a resource field the resource does not carry cannot be evaluated: a
deny that needs it refuses, and an allow that needs it does not match. The check
is structural — the fields a condition references are read from its parsed
expression — never inferred from an error message.

**A condition that errors fails closed.** Authorization does not read an error as
no match: a deny whose condition errors at decision time refuses, whatever allow
applies, and an allow whose condition errors does not match, so it grants
nothing. `access check` and `access can-i` report the same. An unmatched request
can still reach the admin fallback.

This covers reading a tag the resource does not have. A deny on `tags.env ==
"prod"` refuses `prod` resources and every resource with no `env` tag, in reads
and listings too. A resource being created has no tags, so such a deny on `write`
refuses creating one. A vault request is decided as a data resource with no tags,
so such a data deny also refuses that subject's vault requests, `vault.search`
included. To apply a deny only to resources carrying the tag, guard it: `"env" in
tags && tags.env == "prod"`, or `has(tags.env) && ...`.

A check on a resource kind as a whole (`kindResource`: type and schema
endpoints, extensions, datastores) touches no resource, so a condition on
resource fields decides nothing there; it is not an error.

**Types are checked when a condition is written.** A condition is checked against
declared types, without evaluating it, so a part a decision would skip is checked
too: `run.initiator.kind`, `.id` and `.sub`, `principal.sub`, `client` and tag
values are strings, `run.serveDriven` is a bool, and `principal.groups` and
`principal.collectives` are lists of strings. `principal.email` is never supplied.
A condition fails the check if its types cannot evaluate, or if it gives anything
but true or false. One naming `run` or `client` also fails on `dyn()`, and on
converting a `run` or `client` value with `int`, `uint`, `double`, `bool`,
`timestamp` or `duration`.

| Where the condition is                     | Names `run` or `client`                               | Names neither                                |
| ------------------------------------------ | ----------------------------------------------------- | -------------------------------------------- |
| `access grant create`, `@swamp/grant` create | Refused                                               | Refused                                      |
| Grant file                                 | Refused: the whole file, as any grant file error      | Warning from `serve check-config`; it loads  |
| Stored grant                               | Warning when serve loads it; decides as evaluated     | Warning when serve loads it; decides as evaluated |

A stored grant is never rewritten or dropped. The warning appears once per grant
per serve process, and again after a restart or when the grant changes, in the
serve log only. Fix a grant written by a method by revoking it and writing it
again, and one from a file by editing the file. A deny reading a tag with no guard
warns at `access grant create`, from `serve check-config` for a grant file, and
when serve loads it, and is never refused for that. That warning looks for
an `in` or `has` on the same tag anywhere in the condition, so it does not prove
the guard is in the right place.

The check cannot catch everything, and a condition that passes is not proven to
decide as intended:

- A wrong-typed stored condition can evaluate to false rather than erroring, such
  as a comparison of different types. As a deny it never fires, and `access check`
  reports allow with no mention of it. The load warning is the only signal.
- Failures that depend on values still pass, and refuse at decision time as a
  deny: a division by zero, an index out of range, a converted tag, a value
  converted after `cel.bind` renamed it, or a tag no guard covers.
- A comparison of `run.initiator` with a map type-checks, and matches only a map
  holding all three of its keys.
- An admin's direct commit of a grant record to the datastore, such as from an
  older CLI, is not validated when it lands. The load warning reports it.

Check what a condition does on a real resource with `access check` before relying
on it.

Each request has an **aggregate condition budget** of 100 CEL evaluations. If it
runs out, the request is denied whatever grants remain.

Implementation: `src/domain/access/grant_based_access_decision_service.ts`,
`src/domain/access/policy_snapshot.ts`.

### Who can cancel a run

A cancel of one workflow run, by `swamp workflow cancel --run --server`
(`POST /api/v1/cancel/workflow-run/<id>`) or the `workflow.cancel` request the
dashboard uses, needs `run` on the run's workflow, for any run of it: there is no
per-run ownership, and a person with `approve` could end the run by rejecting it
anyway. It is decided on the workflow of what would be aborted, not on a stored
record while something holds that run id. A condition cannot narrow it, since `run`
is not available to a `run` decision. To keep cancel admin-only, list
`workflow.cancel` in `--restricted-commands`, which binds both routes. `deny run`
also stops a cancel, but stops starting the workflow too.

A refused caller, a missing run, a finished run and another workflow's run get the
same not-found reply, on each route. Cancelling a parent also cancels the suspended
children it waited on, on workflows where the caller holds no grant; the reply names
a child only to a reader of its workflow. The audit log records the caller on the
parent's event and names them in the reason of each child's system event.

What stays different, and why:

| Route                                       | Needs                                                  | Why                                                       |
| ------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `POST /api/v1/cancel` (bulk)                | `admin` on `access:*`                                  | It reaches every run                                      |
| `POST /api/v1/cancel/method-run/<id>`       | `admin` on `access:*`                                  | No CLI uses it; the WebSocket `cancel` takes `run`        |
| `POST /api/v1/cancel/workflow-run/<id>`     | `admin` on `access:*`, or `run` on the run's workflow  | An admin denied `run` keeps it, as before this rule       |
| `workflow.cancel`                           | `run` on the run's workflow                            | An admin denied `run` is refused, as `run` decides here   |

A follower authenticates a per-run cancel and forwards it with the caller's own
credentials, so the leader decides and records it, on its policy and records.

### Separation of duties

To forbid self-approval, write a `deny`, once for each subject that holds `run`,
`approve` or `admin`:

```yaml
- subject: "idp-group:approvers"
  effect: deny
  actions: [approve]
  resource: "workflow:@acme/*"
  condition: "principal.sub == run.initiator.sub"
```

An `allow` conditioned on the initiator is not enough. `run` implies `approve`
unless serve requires an explicit grant, and an unmatched request still reaches
the admin fallback. A deny only binds the subjects it names: there is no wildcard
subject.

A person refused on their own run sees that they are denied `approve`, and the
audit event names the grant and the client. The gate keeps waiting, for someone
else to decide, and the person can still cancel the run with `run` (see "Who can
cancel a run"). Finish or cancel suspended runs with no usable initiator before
writing such a deny: nobody it covers can decide them, and anyone with `run` on
the workflow can cancel them.

**Approve and reject decide twice.** Before any run is read, `run` is pending: a
deny on it waits and an allow on it counts as possible, so a caller with no right
to decide gets the same reply whether or not the run exists, and no run is read.
Then, inside the run's claim and before anything is written, the decision is made
on the record it will act on. A caller holding only a run-conditional allow can
therefore tell refused from not found; they hold `approve` on that workflow.

`access.can-i`, `access.check` and `workflow.approvals` follow the same split.
An explanation that names no run marks each decision needing one `dependsOn`, and
`workflow.approvals` sets `canDecide` per run, with
`canDecideReason: grant-condition` when the caller could decide other runs of the
workflow but not this one. It also sets `canCancel` and `canResume` per row and on
`parentRun`, unaudited, and `swamp workflow approvals` offers only the commands
those allow. `canCancel` answers for `swamp workflow cancel --server`.

**What self-approval guarantees:**

| Run                                     | Guarantee                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serve-driven                            | Holds: the initiator is the authenticated principal                                                                                                |
| Member-driven, written since #4454      | The initiator is checked, but a gate never binds the runner against their will (see the threat model): a modified CLI skips it                    |
| Child of a member-driven run            | Can be misattributed: any caller with `run` on an active parent's workflow can write a child naming the parent's initiator, and then approve it    |
| Recorded before #4454                   | Self-reported, and cannot be told apart from a checked one                                                                                         |
| No usable initiator                     | Fails closed                                                                                                                                       |
| Older CLI during an upgrade window      | Not weakened: serve refuses the record and the work is run again                                                                                   |
| `auth: none`                            | None: grants are never consulted, and `decidedBy` comes from the client                                                                            |

An operator who needs more can add `|| !run.serveDriven` to the deny. Only serve
can set what `serveDriven` reads, so a member's record cannot claim it. This also
refuses legitimate approvals of member-driven runs.

**Upgrade first.** Write a grant naming `client` or `run` only once every serve
instance runs a release that supports them. An older instance treats such a deny
as undecided, so it does not fire and any allow still applies, and it refuses to
load such an entry from a grant file. Approve is decided on the leader, so an
older leader misses self-approval; reads are decided where they arrive, so an
older follower misses client denies on reads. Do not downgrade while such a grant
exists.

Failing closed on a condition that errors takes effect per instance, so a mixed
fleet decides differently until every instance is upgraded: an older one skips the
deny, a newer one refuses. Before upgrading, run `swamp serve check-config` with
the new binary, since a grant file holding a refused condition stops serve
starting. Review deny grants that read a tag and guard any that should not apply
to untagged resources. A stored grant's warnings appear only once a new instance
has loaded it, so `access grant list` is the way to find them beforehand. An older
CLI and an older serve together still accept what this release refuses, so upgrade
serve before relying on the refusal.

Review stored denies on `admin` too. One whose condition always errors, such as one
reading `principal.email`, did nothing before and now refuses its subjects `admin`,
including the access to revoke it. If those subjects hold every admin, nobody can
revoke it through serve, so fix it before upgrading.

The read-access fingerprint changes with this rule, so a member's local copy of a
serve datastore resets once on the first command after the upgrade, and copies
filtered under the old rule do not keep what a deny now refuses. While instances of
both versions answer, the fingerprint differs between them; the reset cooldown
limits how often a copy rebuilds.

Implementation: `withRunCondition` and `withRunPending` in
`src/domain/access/access_resources.ts`, `AccessResource.pending` in
`src/domain/access/access_decision_service.ts`, and `runDecisionGuard` in
`src/serve/handlers/workflow_handlers.ts`.

## PolicySnapshot lifecycle

The `PolicySnapshot` is the in-memory aggregate of all active grants and groups.
It loads at serve startup and is rebuilt when grant or group behavior data
changes.

1. **Initial load**: `PolicySnapshotLoader.load()` reads every `swamp/grant` and
   `swamp/group` data record from the repository.
2. **Auto-rebuild**: the loader subscribes to `ModelCreated`, `ModelUpdated`,
   `DefinitionCreated` and `DefinitionUpdated`. When a grant or group behavior
   changes, it rebuilds after a 500 ms debounce.
3. **Peer changes**: an `AccessDataPoller` reloads, in either reload mode,
   when another process changed `data/swamp/grant` or `data/swamp/group`. It
   checks every `--datastore-poll-interval` (default 30 s)
   (`src/serve/access_data_poller.ts`). With a remote datastore it pulls those
   directories and reloads when the pull changed anything. On a v2 filesystem
   datastore, where serve instances share the files and nothing is pulled, it
   fingerprints the record directories instead
   (`src/serve/filesystem_access_data_change_source.ts`, swamp-club#3371). Only
   `grant-main` and `group-main` are watched, the data the loader reads. A
   record whose new versions are all ones the instance's own `ModelUpdated`
   events named (`dataVersions`, published by every method run) is its own
   write and stays staged in manual mode, as a pull never returns the
   puller's own writes. Anything else, including a local CLI write, is a peer
   change. A v3 datastore has one writer at a time and runs no poller.
4. **OAuth group refresh**: a `CollectiveRefreshService` re-fetches each
   logged-in user's collectives every `--group-refresh-interval` and closes
   connections whose admission lapsed
   (`src/serve/collective_refresh_service.ts`). It applies a userinfo answer
   only when its subject matches the token's principal; otherwise it keeps the
   token's snapshot and logs a warning.
5. **Unreadable records** (swamp-club#3386): a grant or group record that exists
   but cannot be read (a directory or file this process may not read, such as
   one a peer wrote with a restrictive umask or another uid) or whose JSON does
   not parse never vanishes silently. `findAllForType` reports each data name it
   skips, or the model directory when it cannot list it, and still returns the
   model's other data. The loader treats a skipped model directory, or its
   `grant-main` or `group-main`, like a content read that failed. Other data a
   grant or group model keeps, such as a method-summary report, is not access
   data: one that fails neither fails the record nor is named in its fix.

   The first build of a loader has no earlier version to fall back on, so it
   fails closed: it throws `UnreadableAccessRecordsError`, and serve refuses to
   start, as do `swamp access reload` and `swamp access check`. Serve's boot
   reconcilers of file and admin grants run before that build and read every
   stored grant's `grant-main` (`readStoredGrants`,
   `src/domain/access/stored_grant_reader.ts`), never the other data a grant
   model keeps. Reconciling without a grant they cannot load could duplicate or
   orphan it, so one that cannot be read, is corrupt or fails validation, or
   whose model directory cannot be listed, makes them throw the same error
   before they write anything. A record that cannot be loaded may be a deny, and
   the loader cannot tell. The error lists each record with its fix:
   - corrupt (its JSON or metadata does not parse, or its `metadata.yaml` is
     empty): it never loads by itself, so the error names the command that
     removes it, `swamp data delete <model-id> grant-main -y` (`group-main` for
     a group). An orphaned record (`@swamp/grant`, `@swamp/group`) has no
     definition that command can reach, so the error names its directory,
     `data/@swamp/grant/<model-id>`, instead;
   - unrecognised (it parses, but its grant, group or metadata fails this
     build's validation): a newer swamp may have written it, so the error says
     to upgrade first and only otherwise to remove it;
   - unreadable (reading it failed: a filesystem error such as
     `PermissionDenied`, any error from a remote read, or content or
     `metadata.yaml` gone missing from a record read before): give the process
     read access and retry. A record never read whose content or metadata is
     missing is mid-write and skipped, as before.

   A record is classed by where it failed, not by its error's class: a remote
   read that fails with a parse error is still unreadable, since the next read
   may succeed.

   This applies to allows too, so a datastore with one damaged record of any
   kind stops these commands until it is fixed, where earlier releases skipped
   it.

   Every later build succeeds:
   - a grant whose last-known version, read by an earlier build of this process,
     was an active deny stays in force (fail closed);
   - any other grant is left out. Leaving out an allow is fail safe. A deny that
     appeared after the first build and was never read cannot be enforced, and
     the error log says so;
   - a group keeps its last-known members, so deny grants on it still apply, and
     allow grants to the group are suspended, so a member removed in the version
     that cannot be read gets no allow through the group. Allow conditions that
     test membership of the group still see the last-known members. A group
     never read is left out.

   Each record is logged at error once, with its fix when it is corrupt or
   unrecognised, at debug while it stays the same, and at info once it reads
   again. A record stays the same while its outcome and error class do, so an
   error message that varies (a remote request id) does not repeat the error
   line. `PolicySnapshotLoader.unreadable` lists the records the last successful
   build could not read, whoever ran it (the boot load, an auto-mode rebuild,
   the reload endpoint, the poller). The poller rebuilds every cycle while that
   list holds an unreadable record, because the filesystem change source cannot
   see a file turning readable again (a mode change moves only its ctime) and a
   remote datastore's read can fail for one cycle. A corrupt or unrecognised
   record is not retried: it never reads by itself, and the write that fixes it
   is a change. A record read before whose content stays missing is retried
   every cycle until it is removed. A rebuild that finds the same unreadable
   records and loads the same grants and groups as the last one logs its
   snapshot line at debug and skips the unsupplied-field warnings; one that
   loads a peer's change logs and warns as usual. The change source fingerprints
   each directory or entry it cannot read as its error and keeps walking
   everything beside it, so an unreadable old version never hides a new version
   of the record, and every other record is still compared. A build that throws
   (a grant or group type directory, canonical or orphaned, that cannot be
   listed) keeps the previous snapshot and last-known records. Builds run one at
   a time, whoever asks for them, so an older build never commits over a newer
   one; a read that never returns therefore holds every later build, the
   poller's and the reload endpoint's included. The poller logs a failed cycle
   at warning, and from the third consecutive failure on at error, saying other
   processes' grant and revoke changes are not being applied; it logs recovery
   at info.

The `GrantBasedAccessDecisionService` picks up a rebuilt snapshot on the next
request. There is no per-request locking or snapshot versioning.

Implementation: `src/domain/access/policy_snapshot_loader.ts`.

## Collection operations and grant-scoped filtering

Single-resource operations (`model.get`, `workflow.run`, `data.get`) authorize
against the named resource, for example `model:@acme/deploy`. Collection
operations (`model.search`, `workflow.search`, `data.search`, `data.query`, and
their history, output and approval variants) return many results and cannot
name one up front.

These handlers run the query, then keep only the items the caller may read. Each
item is judged on the resources that own it now, looked up by id rather than by
the name recorded when it was written, with every resource field present
(`CanonicalResources`): a behavior item on its definition, an output or method
run on every behavior declaring its behavior id (a copy shares its outputs and
data) together with the method it ran, a data item on every owning behavior —
or, for workflow-scope data, its workflow — and a run or approval on its
workflow. An item with several owners is kept only when all of them are allowed.
With `model:@acme/*`, `behavior search` shows only matching behaviors. With
`model:*` it shows everything. With no `read` grant for the kind, the request is
refused.

Serve finds an id's owners through a definition index it keeps between requests
(`DefinitionIdIndex`, swamp-club#3968), instead of reading every definition,
auto-definitions included, on each request. The index records which file
declares which id and which name, and for each regular file the name, type and
tags naming and authorizing read of it. A direct-type workflow step in serve looks its
definition name up across every type in the same index (swamp-club#4037), so a
step whose definition does not exist yet does not read every definition to find
that out; serve's other lookups by name still read the definitions themselves. A
definition file serve cannot read fails those steps' lookups, as it fails the
owner check, until it is fixed or removed. Each request first checks the stat of
every definition directory. A directory whose stat moved, or was less than 2 s
old when it was last listed, is listed again. The listing stats its files and
reads only those whose own stat moved (or was that recent when read), except a
regular file named after the name it declares (`<name>.yaml`, as a save names a
definition whose name is filename-safe) whose stat was settled: that file is kept without a stat (swamp-club#4307),
so a write costs a stat of the files it added, not of every file beside them.
Deciding when a stat is taken keeps a write that lands in the same clock tick as
a listing from hiding behind a stat that only later looks old. The request then stats each owner's file, and
reads it only when that stat moved, was less than 2 s old, reports neither a
ctime nor an inode, or the file is a symlink (swamp-club#4231). A rewrite moves the stat's mtime, ctime, size or inode,
so owners are judged on the names and tags stored now. Creating, removing or renaming a definition file moves its
directory's stat, so a new or removed file is seen by the next request, whichever
process wrote it. swamp's saves and a v3 datastore's pulls replace a file by
renaming a new one over it, and a datastore extension's pull creates one. A kept
file replaced under its own name is seen by a lookup of the id or name it
declared before, which reads it, and by the next lookup by id that finds nothing,
which first stats every kept file; otherwise within 30 s, since a request at
least 30 s after the last such pass stats every kept file. A file that failed to
parse, a file a lookup found rewritten, and a
symlinked definition (whose target may sit in another directory) are stat'ed on
every request, so changes to them made in place are seen too. Two changes wait.
A kept file replaced to declare an id another file declares, or a name it is not
stored under, waits up to 30 s. A regular file that declares an id, overwritten
in place to declare another (by hand, or by a datastore extension that
overwrites files in place), waits for its directory's next change and then up to
30 s, or for a lookup of the id it declared. Until then the file is not an owner
of its new id, which fails open: a deny that this copy
would bring, by its name or its tags, does not apply. Making that change needs
write access to the definitions, which can change any owner's file itself, so
it grants nothing more. A filesystem that does not update directory mtimes
would hide new files until serve restarts; no supported datastore is known to.
Outside serve (the CLI, tests) each request still scans.

A `*` resource name never matches a name-scoped deny, so no request over many
resources is authorized as `*` (swamp-club#2675):

- `model.validate`, `workflow.validate` and `workflow.evaluate` without a name
  run only over the behaviors or workflows the caller may read. A workflow file
  that fails to parse is judged on the name it declares with no tags, since its
  tags cannot be read, so a tag-conditioned deny does not hide it.
  `model.evaluate` without a name evaluates every behavior, since evaluation
  orders them all in one dependency graph, but returns only the readable ones,
  each judged on its stored definition before evaluation, as a named
  `model.evaluate` is (swamp-club#4090): a tag can hold an expression.
- `model.evaluate` and `workflow.evaluate` are admitted on `read` but save an
  evaluation only when the caller may `run` the behavior or workflow, as the
  runs that write the same files are decided (swamp-club#3940): `admin` for a
  restricted or control-plane behavior type. With or without a name, the
  decision is made on the stored definition, before evaluation. A
  `--last-evaluated` run replays the saved file, and a workflow's records the
  inputs it was evaluated with, so a reader could otherwise choose what a
  runner executes. A reader gets the evaluation back with `saved: false` and no
  `outputPath`. Evaluate has no method, so a `run` grant conditioned on
  `methodName` does not let it save. A file saved before this rule records no
  producer and is not told apart: a run without `--last-evaluated`, or an
  evaluate by a caller who may run, rewrites it.
- `data.query` drops unreadable records inside the query, before the limit,
  `limited` and any `select` projection are computed.
- Reports are data: `report.get` and `report.search` cover only reports whose
  owner the caller may read as `data`, and a named `--model` or `--workflow` is
  authorized first. The ambiguity error of `report.get` lists only readable
  owners.
- `vault.audit-trail` without a vault, and `vault.search`, keep only the
  vaults the caller may read under the request rule in [Vaults](#vaults); the
  limit applies after filtering.
- `data.gc`, `data.prune`, `run.gc` and `summarise` reach every resource and
  cannot be narrowed, so they need the action on every resource of each kind
  they touch: any deny grant that applies to the caller for the kind and action
  refuses them, whatever its pattern or `methods` list, unless its condition
  reads only the principal and does not hold for this caller (`decideAll`);
  the refusal names the grant and says when it is conditional.

`access.can-i` and `access.check` explain a decision the way a request would
make it: a concrete behavior, data or workflow name is resolved to the resource
it names with all of its fields; a pattern with a wildcard names no single
resource and is explained as a check on the kind, where conditions on resource
fields decide nothing.

Endpoints that return only type definitions or schemas (`model.type.search`,
`model.type.describe`, `workflow.schema`, `report.type.search`,
`report.describe`, `vault.type.search`) need at least one `read` grant for the
kind, or check the kind itself, and do not filter per item. For the vault
endpoints a `read` grant on `data` or on `vault` counts.

Implementation: `filterByResources`, `resourceDecider`, `authorizeAnyOrReject`
and `authorizeAllOrReject` in `src/serve/handlers/shared.ts`;
`CanonicalResources` in `src/serve/handlers/resource_resolution.ts`. Guards:
`integration/serve_condition_fields_conformance_test.ts`, which classifies every
request type, and the `*` rule in
`integration/serve_canonical_authorization_rules_test.ts`.

## Control-plane records

The control plane stores its own records as behavior data beside user behaviors:
`swamp/grant`, `swamp/group`, `swamp/server-token` and `swamp/integration` for
access control, and
`swamp/enrollment-token`, `swamp/worker`, `swamp/step-lease`,
`swamp/pending-dispatch` and `swamp/fleet-probe` for the worker fleet
(`CONTROL_PLANE_MODEL_TYPES`). They are never user data. A grant record is the
policy itself, a token record names its principal, expiry and the vault key
holding its secret, and a group record lists its members (swamp-club#2756).

- **Owned by the access kind.** Serve authorizes any behavior or data resource
  of a control-plane type as the access resource named by its normalized type,
  `access:swamp/grant` for example, not as `model:<name>` or `data:<name>`. The
  resource name is the type, so selectors match it; its fields are the record's
  own (`name`, `modelType`, `tags` of its behavior), so a condition naming one
  grant or token still decides on that record. `modelAccessResource` and
  `CanonicalResources` make that mapping, so it holds on every path that goes
  through them: `data.get`, `data.list`, `data.versions`, `data.delete`,
  `data.rename`, `data.search`, `data.query`, reports, workflow-history step
  data, `model.get`, `model.edit` (before and after the edit), `model.output.*`
  and `model.method.history.*`. An owner no longer found is judged on its
  recorded type — a data item's or output's owner, and the behavior of a run
  whose cancel or attach arrives after its definition was deleted (the run
  records its behavior type) — and method run and create gate every
  control-plane type as admin.
- **Forwarded commits.** Serve's datastore API (team mode, swamp-club#3915)
  decides every op on a control-plane behavior, and every control-plane
  intent (`grant.*`, `token.*`, …), as `admin` on the record, including a
  grant written as plain data. A key that lands in a control-plane behavior's
  paths under another behavior's intent is refused whoever sends it, and a
  landed control-plane commit reloads the policy snapshot. Every other
  forwarded write is decided as serve's handlers decide the same write, its
  content checked as theirs is (swamp-club#3922). See "Team mode: serve's
  datastore API" in `design/enablers/datastores.md`.
- **Run control.** `approve`, `reject` and `signal` are decided only by serve's
  handlers, which authorise the caller and record the decision. A forwarded run
  record may carry a decision serve holds and never makes one, so holding
  `approve` or `signal` lets no record carry a decision (swamp-club#4245). A
  serve-mode checkout sends these commands to the handlers, and `cancel --run` of
  a run it does not drive. See "Run records: the threat model" below.
- **Decided as admin.** The decision service decides every action on a
  control-plane record as `admin`, whatever the request asked for
  (`isControlPlaneRecordResource`). So `read`, `write` or `run` on `data:*` or
  `model:*` never reaches these records: single-resource requests are refused,
  naming `admin` on `access:swamp/<type>`, and collections leave the records
  out. `admin` on `access:*` reaches them. A narrower grant such as `admin`
  on `access:swamp/*` or `access:swamp/grant` reaches them on single-record
  reads and writes, but not everywhere: `model.method.run` and `model.create`
  on a control-plane type check `admin` on `access:*` itself, and the
  collection requests (`data.search`, `data.query`) first need some `read`
  grant on `data`, so such a caller also needs one to see records in a
  collection. Where a record is recorded under a control-plane type, its
  access record is always among its owners, even when a user definition now
  shares its id. The full type is the
  resource name so it can never collide with `access:grant` and
  `access:group`, which `access.grant.list` and `access.group.list` still
  authorize as `read`.
- **Not addressable from expressions.** The CEL data namespace passes the
  control-plane types, bare and `@`-prefixed as they can be stored
  (`CONTROL_PLANE_STORED_TYPES`), to `DataQueryService` as `excludeModelTypes`, which
  drops them in SQL before the predicate, the limit or a `select` projection
  runs, so no predicate reaches them. `model.<name>` and its orphan-data
  fallback skip them. `workers.connected()` keeps its own read of worker
  state. This holds wherever expressions are evaluated, locally too.
- **Existence is not hidden.** A caller asking `data.get` for a control-plane
  behavior's name is refused, where a name that matches nothing reports not
  found, so the caller learns that the name exists. Name and tag denies behave
  the same way, and control-plane names cannot be listed without admin.

Operations over every resource (`data.gc`, `data.prune`, `run.gc`,
`summarise`) are decided per kind and are unchanged. Prune treats
control-plane records as always live, gc only trims old versions, and
`summarise` shows metadata, which needs no more than read.

Implementation: `src/domain/models/control_plane_types.ts`,
`src/domain/access/control_plane_records.ts`,
`src/domain/access/grant_based_access_decision_service.ts`,
`src/serve/handlers/resource_resolution.ts`,
`src/domain/data/data_query_service.ts` (`excludeModelTypes`),
`src/domain/expressions/model_resolver.ts`. Guard:
`integration/control_plane_types_rules_test.ts` fails when a built-in
`swamp/*` behavior type is missing from the list.

## Vaults

A vault is a resource of its own kind, `vault:<name>` (swamp-club#2676). The
pattern matches the vault's name with the usual selector rules, so
`vault:prod-*` covers `prod-db` and `prod-api` and nothing else. Conditions see
`name` and the request field `key` (see
[Condition evaluation](#condition-evaluation)).

Vault access is decided at two points, by two rules. A `vault.*` request needs
an allow, as every request does. A vault operation inside a serve run is
allowed until the triggering principal is scoped, because runs read vaults
unchecked before the vault kind existed and making them default-deny would
break every existing run.

|                    | Request rule (`vault.*` requests)                                          | Run-time rule (vault operations in a serve run)                                         |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Refused by         | a deny for the action on `data:vault`, `data:<name>` or `vault:<name>`     | a reserved vault, unless `admin` on `access:*`; a deny for the action on `vault:<name>` |
| Admitted by        | the check that predates the vault kind, or an allow on `vault:<name>`¹     | anything, until the principal holds a vault allow; then only an allow on `vault:<name>` |
| No matching grant  | refused                                                                    | allowed, unless the principal is vault-scoped                                           |
| `data` grants      | count                                                                      | play no part                                                                            |

¹ Not for `put` with refresh options, which only the older check admits (see
[Request rule](#request-rule)).

### Request rule

Every vault request is authorized on `vault:<name>` with its own action:
`get`, `describe`, `inspect`, `list-keys`, `read-secret` and `audit-trail` are
`read`; `put`, `delete`, `annotate`, `create` and `edit` (rename and repair
included) are `write`; `put` with refresh options and `migrate` are `admin`.
Each request also names its verb, which a vault grant's `methods` list matches
(see [Method scope](#method-scope)). For a vault named N:

1. A deny for the action that matches `data:vault`, `data:N` or `vault:N`
   refuses.
2. Otherwise the check that predates the vault kind runs unchanged:
   `data:vault`, the vault's own name under `data`, or `admin` on `model` for
   `migrate`, admin fallback included. If it allows, the request proceeds.
3. Otherwise an allow for the action on `vault:N` admits it — except `put`
   with refresh options, which only step 2 admits: a refresh hook is a shell
   command serve runs on its host on later reads, so it needs `admin` on
   `data:vault`, never just `admin` on one vault.
4. Otherwise the request gets the same refusal as before the vault kind.

A refused caller is refused before any vault is looked up. `vault.get` and
`vault.describe` authorize the name or id as sent, then resolve it and act
only on the vault they authorized; a vault whose id or name differs by then is
not found. `vault.search` and `vault.audit-trail` without a vault keep each
vault the rule above would allow, and admit a caller whose only read grants
are vault grants. A vault grant never reaches another vault, and a `read`
grant never allows a `write`.

Implementation: `authorizeVaultOrReject`, `admitVaultListingOrReject` and
`vaultListingDecider` in `src/serve/handlers/shared.ts`;
`src/serve/handlers/vault_handlers.ts`.

### Run-time rule

During a serve run every vault operation is judged against the principal that
triggered the run: `vault.get(...)` expressions in definitions, workflows and
method inputs, method code using `context.vaultService`, sensitive outputs and
their read-back, and data queries that resolve vault references. `get`, `list`,
annotation and refresh-hook reads are `read`; `put`, `delete`, and annotation
and refresh-hook changes are `write`. Each is also judged with its vault verb
(see [Method scope](#method-scope)). For vault N and action A:

1. **Reserved vaults** (`_`-prefixed, such as `_token-secrets`) are refused in
   every serve run unless the principal holds `admin` on `access:*`, whatever
   other grants exist. No run needs them; before this rule any run, including
   a run-only caller's method inputs, could read `_token-secrets`.
2. **Inert without vault grants.** While the policy holds no grant of the
   vault kind, the operation is allowed, so a deployment without vault grants
   resolves vaults exactly as before.
3. **Deny.** A vault deny for A that matches N refuses.
4. **Scoped.** If any vault allow, for any action, applies to the principal —
   directly, through a local group or through an IdP group — the principal is
   vault-scoped for every action: the operation is allowed only when an allow
   for A matches N.
5. Otherwise the operation is allowed.

So a deny-only grant blocks just the denied vault, and a principal granted
`read` on `vault:roomcontrol` can read only `roomcontrol` in its runs, and
write nowhere. A principal holding `admin` on `access:*` is never scoped by
step 4 and is still refused by an explicit vault deny. `data` grants play no
part at run time: `deny read data:prod-db` does not stop a run reading the
vault `prod-db`.

Writing the first vault grant activates the rule for the whole server.
Principals with only deny grants lose the denied vaults; a principal given any
vault allow becomes default-deny for vaults, so a CI token granted one vault
loses every other vault it used. Grant every vault such a principal needs in
the same change.

A refusal happens before the provider is touched. It fails the step with a
message naming the vault and the principal, never a value, and is audited as a
`secrets` denial (see `design/enablers/serve-audit.md`).

**Decision inputs.** The policy is read on every operation, so grant reloads
and revocations apply mid-run. The principal's memberships are captured once
at run start: a server-token principal from its token record, re-validated
behind a short cache, so a revoked token's runs lose vault access within that
time rather than at once; an OAuth principal with its session's IdP groups and
collectives, so group changes apply from its next run; a service principal
with local groups only, as trigger authorization does.

**Resumes.** A workflow run persists its triggering principal (kind, id and
token binding) and that membership snapshot. Every resume — approve-then-resume,
a parent's auto-resume, detached or attached — is scoped by the persisted
principal and snapshot, never by the approver or the resumer, who is still
authorized to resume as before. A run triggered from a server-token session
stays bound to that token: live and on resume, the token record is
re-validated, so once the token is revoked, re-minted or deleted every vault
operation is refused while the policy holds any vault grant. Expiry alone does
not cut a run off, since it was authorized when it started; token GC deletes
an expired token after its grace period (one hour by default), and from then
on it is refused. A run started from an OAuth session records no token
binding: its short-lived login token is never re-checked, and the run keeps
the identity and memberships captured at its start. The memberships are always
the persisted snapshot. A resumed run with no persisted snapshot
(started on an older release, or saved by an older replica, which strips the
field) refuses every vault operation once the policy holds any vault grant,
and logs why; with no vault grant it runs as before. Resume or cancel
suspended runs from older releases before writing the first vault grant.
Method runs are never resumed.

**Trigger principals.** Scheduled runs act as `service:scheduler` and webhook
runs as `service:webhook`, so a vault grant on either scopes every scheduled or
webhook run on the server. To bound one workflow, use its `vaults:` list.

**Workflow `vaults:` list.** A workflow may declare the most vaults any of its
runs may read or write. It applies to local runs too, nested workflows
intersect with their parent's list, and it is checked alongside the principal
rule, so either can refuse. A run records the list in force at run start, and
a resume is held to that recorded list and the workflow's current one, so an
edit to the workflow can narrow a suspended run but never widen it. See
`design/primitives/workflows.md`.

**Sensitive outputs** get no exemption. Storing a sensitive field and every
read-back of its reference are vault operations on the vault the field lands
in (field `vaultName`, a step's `dataOutputOverrides` `vaultName`, the spec's
`vaultName`, `defaultVault`, then the first user vault), so a scoped principal
needs `read` and `write` on that vault. Because a refused store would land after
the method's side effects, a mutating method with sensitive outputs has every
target vault decided for both actions before it runs, and is refused up front
with a message naming the vault and one fix: list the vault in the workflow's
`vaults:` list when that list refused, otherwise change the principal's
`vault:<name>` grants — or point the output at a vault it may use. Grant
conditions on `key` are honoured when the value is stored: the store decides
every field with the key it is stored under before storing any of them, so a
refusal leaves no field's value behind. The up-front check decides with a
field's own `vaultKey` when it sets one; a key generated at write time (from
the instance name) is not known yet, so the up-front check refuses only what
it can decide without the key and leaves a refusal that depends on a `key`
condition to the store. Keep author secrets out of the
default vault: make a dedicated outputs vault the default, or route outputs
with a spec `vaultName` or a step's `dataOutputOverrides`, and grant scoped
principals `read` and `write` on it. Granting a default vault that also holds
author secrets reopens them.

**Workers.** Secret reads and writes a worker makes for a dispatched step are
held to the dispatching run's scope (see
`design/enablers/remote-execution.md`).

**What it does not bound.** A shell step that runs a nested `swamp` reads the
local repository with the run's gate pass, and step code that calls a
provider's CLI uses the host's credentials; neither is bounded by vault
grants. Where a principal must not reach a vault, isolate it with a separate
orchestrator or separate provider credentials per trust boundary. Local CLI
runs are bounded only by a workflow's `vaults:` list.

Implementation: `src/domain/vaults/run_vault_access.ts` (the run's scope,
entered on `AsyncLocalStorage` and checked by `VaultService` on every
per-vault method), `src/domain/models/sensitive_output_vault.ts` (the one
target-vault resolver), `src/serve/run_vault_access_policy.ts`.

### Explaining vault decisions

`access.can-i` and `access.check` resolve a concrete `vault:<name>` to the
vault and explain it with its fields; a wildcard is explained as a check on
the kind. For a concrete vault they also report the run-time decision for that
principal: whether vault operations in its runs are restricted, and by which
grant. On a trigger principal they note that its scope applies to every
scheduled or webhook run. The run-time decision uses the same memberships as
the request explanation: the caller's own session for a self-check; for another
subject (`access.check` with a different `subject`), only the IdP groups and
collectives the request supplies in its `groups` and `collectives` fields.
Without supplied groups or collectives the server knows none for another user,
so the reason names the memberships that are not included, and an `idp-group:`
or `collective:` grant through them is not reflected.

### Compatibility

- **Changed: data denies on vaults.** A deny on `data:vault` or
  `data:<vault name>` now refuses every request on the vault, whichever name
  the request was checked under before. Move vault denies to `vault:<name>`;
  a `data` deny has no effect on runs.
- **Changed: reserved vaults.** Serve runs can no longer read
  reserved vaults, except for principals with `admin` on `access:*`.
- **Upgrade first.** Write vault grants, or workflows that set `vaults:`, only
  once every serve replica on the datastore runs a release that supports them.
  An older replica refuses to start on a grant file holding a vault grant,
  silently ignores stored vault grants (denies included, so it enforces none of
  them), rejects a workflow file that sets `vaults:`, and strips the persisted
  triggering principal from runs it saves, which makes their resumes fail
  closed once vault grants exist.
- Grant files written before this release cannot contain vault grants, so for
  them the only request-time change is the data-deny tightening above, and the
  run-time rule stays inert.

## Workflow execution context

On a `workflow.run` request, the handler checks that the principal has `run` on
`workflow:<name>`. If so, the workflow runs, including every method call
in its steps and every nested workflow it calls (with theirs), with no further
checks. The workflow is the unit of authorization: the caller may run all of it
or none of it. A nested workflow's own grants play no part in its parent's run,
so withholding or denying `run` on a workflow stops it being started directly
but not called from a parent. A gate inside a nested workflow is decided on the
child's run, so `approve` is checked against the child's workflow, whichever
parent called it.

Vault operations are the exception: once the policy holds a vault grant, each
one in the run is judged against the triggering principal by the run-time rule
in [Vaults](#vaults).

The reason is that the operator who wrote the workflow chose which behaviors it
calls, and a `run` grant delegates that choice. Per-behavior grants would force
operators to grant `run` on every behavior a workflow touches, which leads to
overly broad grants.

**Direct method calls through serve** (`model.method.run`) are authorized
on their own against `model:<name>`. The workflow exemption covers only behavior
calls the workflow engine makes internally.

Because a run delegates to whoever wrote the workflow, the writer is held to
what the workflow runs. A served `workflow.edit` that adds a step needs `run` on
the step's behavior (with the type, and `admin` for a restricted or
control-plane type, as a direct run needs) or on its nested workflow. A guard or
assert that calls `model.method("<model>", "<method>")` runs that method, so it
is held to the same check; `model` used any other way (aliased with `cel.bind`,
wrapped in `dyn()`) may run any behavior and needs `admin`. A behavior target
computed by an expression can resolve to any behavior, restricted and
control-plane ones included, which the engine does not gate, so it needs
`admin`; a computed nested workflow needs `run` on every workflow. Steps already
stored are not re-checked, and neither is a run, so users running a workflow an
admin wrote are unaffected. A nested workflow is checked only when the
workflow does not already call it by that name: a step added that calls a
nested workflow another stored step already names needs nothing more, and
neither does a change to a stored nested workflow step's inputs (an expression
the change adds is still checked, see
[Expression references](#expression-references)). The exception is a stored
step the edit changes — its inputs, method or `dependsOn`, or its name or job — that runs a restricted
or control-plane behavior, or a behavior it computes: what the step holds is
what that behavior runs with, so the change needs `admin` (swamp-club#3131).
Removing a step, a retag, or a change to the workflow's input defaults or a
job's `dependsOn` does not, since a caller with `run` on the workflow already
chooses its inputs. An edit that changes the workflow's inputs or a step's
`forEach` re-checks stored computed targets that read `inputs` or `self`, since
those are what can retarget them; a retag or any other edit does not. Such a
target placed in a step that did not hold it is checked there, since that step's
`forEach` may differ.

## Expression references

Expressions can read beyond the behavior they belong to: other behaviors' data
(`data.*`, `model.<name>.resource`, `file.contents`), other behaviors'
definitions (`model.<name>.input`), and the process environment (`env`). Over
serve they are evaluated in the server process, so serve authorizes expression
text against the principal who supplies it, when they supply it
(swamp-club#2755, swamp-club#2786). Implementation:
`src/domain/expressions/expression_references.ts` (what an expression reads,
from the AST evaluation parses) and
`src/serve/handlers/expression_reference_authorization.ts`.

| Supplied by                        | Checked                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `model.create`                     | every expression in its global arguments                     |
| `model.edit`, `workflow.edit`      | each expression it puts somewhere new (see below)            |
| `model.method.run` inputs          | every expression in the inputs                               |
| runs, evaluate, validate           | nothing: stored content is the author's                      |

- **Data.** A reference to a named behavior needs `read` on the data it can
  return: every current owner of records stored under that name, and every
  definition with that name or id; deny wins. A name nothing owns yet needs
  `read` on all data, since it will read whatever is stored under it later.
- **What an edit puts somewhere new.** An edit is checked for every expression
  whose text is new, every stored expression it moves or copies to a path where
  it was not, and every expression in a workflow step whose target it changed,
  since where an expression sits decides where its value goes. An expression
  left in place, under an unchanged step, is not re-checked. Steps are
  identified by job and step name, so adding, removing or reordering other steps
  does not count as moving them. A reference whose behavior is computed, a
  cross-behavior accessor (`data.query`, `data.findByTag`), the `model` map used
  whole or with a computed key, a `ns:` or `*:` prefix, more than 32 named
  behaviors, or text the analyzer cannot parse needs `read` on all data, so any
  data deny refuses it. A target computed from `self` counts too:
  `data.latest(self.name, ...)` is judged as reading any data. A definition
  lookup that fails refuses the reference.
- **Definitions.** `model.<name>.input` and `.definition` need `read` on the
  behavior.
- **env.** Reading the server's environment is an author's capability: a
  writer holds `write` on the behavior, so env is allowed on the write paths. In
  run inputs it needs `write` on the behavior run; a run-only caller is refused
  and told to reference env in the definition. `evaluate` and `validate` never
  resolve env, which is resolved only when a method runs.
- **Vault secrets.** A `vault.get(...)` expression is not checked when it is
  saved: the analyzer records no vault reference, so
  `authorizeExpressionReferences` never sees one (swamp-club#3086). It is judged
  when a serve run resolves it, by the run-time rule in [Vaults](#vaults),
  against the vault grants of the principal that triggered the run. This is the
  expression function, not the `vault.get` serve request, which the request rule
  decides. While the policy holds no vault grant the run-time rule is inert and
  the expression stays an author's capability: a writer, holding `write` on the
  behavior or workflow, may use any vault secret in what they author. Unlike
  env, a `vault.get(...)` expression is also allowed in method run inputs to any
  caller, since run-only callers such as CI tokens pass secrets that way; the
  value reaches the method and is masked in output. So without vault grants,
  `write` on workflows or behaviors, and `run` on a behavior whose method can
  surface its inputs, include access to the repo's vault secrets. To bound a
  principal, grant it `vault:<name>`: once it holds any vault allow its runs
  reach only the vaults it is granted. Reserved vaults are never readable by a
  serve run, except to principals with `admin` on `access:*`. Workflow run
  inputs are inert and never resolve a `vault.get(...)` expression.
- **Retargeting.** A stored expression that reads data through a target
  computed from `self` or `inputs` is re-checked when an edit could point it
  elsewhere: a behavior edit that changes its name, version, tags, global
  arguments or inputs (expression text included, since global-argument
  expressions are evaluated before `self.globalArguments` is read), a workflow
  edit that changes its inputs or a step's `forEach`, or an edit that places
  the same text somewhere it was not, where `self` may differ. So an edit
  that changes `target: ${{ "dev-db" }}` to `${{ "prod-db" }}` under
  `data.latest(self.globalArguments.target, ...)` is refused. This covers
  edits only: a run can still override global arguments (see below).
- **Refusals** name the expression as sent, with the same wording whether the
  target exists or is denied, and are audited like other denials. Auth mode
  `none` and admins are not checked, as everywhere else.

What this does not cover, by design:

- An author's computed target lets runners choose the behavior:
  `data.latest(inputs.target, ...)` in a stored definition reads whatever
  behavior a run passes as a plain input, and a target taken from another
  behavior's data (or from `steps.*` or `run.*`) follows whoever writes that
  data. That is the author's choice; avoid caller-controlled targets where the
  runner should not pick the behavior.
- Global arguments a run can override are the runner's choice. A workflow step's
  `globalArgs`, and a direct-type run's inputs, replace a behavior's global
  arguments for that run, and a direct run also saves them to the definition.
  Both need only `run`. A stored reference computed from `self.globalArguments`
  therefore reads whatever behavior the runner names, like one computed from
  `inputs`. Don't compute a data target from a global argument when runners
  shouldn't choose the behavior.
- The check runs when text is saved. Expressions stored before this check
  existed are not re-checked.
- Vault secrets: a `vault.get(...)` expression is not checked when saved; a
  serve run judges it when it resolves, and nothing bounds it outside serve
  but a workflow's `vaults:` list. See **Vault secrets** above and
  [Vaults](#vaults).

## The can-i request

`swamp access can-i` lets a user check their own permissions on a running
server. It has two modes.

**Specific check**: test one (action, resource) pair:

```
swamp access can-i --action run --on workflow:@acme/deploy --server wss://swamp.acme.internal:9090
```

For method-scoped grants, add `--method` to test one method:

```
swamp access can-i --action run --on model:@acme/my-model --method read --server wss://swamp.acme.internal:9090
```

It returns the matching grant decision and exits 0 for allow and 1 for deny.
With `--method`, the JSON response echoes the tested method in a `method` field.
`swamp access check` takes `--method` the same way, locally and with
`--server`; for a vault the method is the vault verb.

**List all permissions**: omit `--action` and `--on` to see every grant that
applies to the caller across all resource kinds:

```
swamp access can-i --server wss://swamp.acme.internal:9090
```

The command sends an `access.can-i` WebSocket request. The server resolves the
caller's subjects and calls the decision service's `explain` method, which
returns every matching grant (allow and deny), not only the first. It always
uses the caller's own session memberships; to test grants for other
memberships, use `swamp access check` with `--groups` and `--collectives`.

Implementation: `src/cli/commands/access_can_i.ts`,
`src/serve/handlers/access_handlers.ts`.

## The access check

`swamp access check` explains whether a subject can perform an action on a
resource. With `--server` the server explains it. Without `--server` it is
explained locally against the repo's grants. Both explain a concrete behavior,
data or workflow name as a request would judge it: the name is resolved from the
repo to the resource it names, with its stored type and tags, so `deny write
--on model:command/shell` denies a write to a `command/shell` behavior under any
name, and a condition on `tags` reads the resource's own tags. A name that
matches nothing is a resource with no tags. A wildcard pattern or an `access:`
resource is a check on the kind. Locally and on the server the resource is built
by one function, so the two give the same answer for the same repo
(swamp-club#3224).

`--field key=value` (local only) overrides a resolved field, to simulate a
resource that does not exist yet or a future tag; a `tags.<key>` field replaces
that one tag and keeps the others. A lookup that fails is reported as a warning,
and the resource is then checked by name only.

A local check knows nothing a server is started with: `--restricted-model-types`
(which needs `admin` on `access:*` to create or run a restricted type) and the
caller's IdP groups are not reflected, so check against the server when those
matter.

Implementation: `src/libswamp/access/explained_resource.ts` (used by
`src/cli/commands/access_check.ts` and `src/serve/handlers/access_handlers.ts`),
`src/domain/access/access_resources.ts`.

## Run records: the threat model

Decided on 2026-11-01 and approved by stack72 (swamp-club#4245).

**Serve does not try to stop a member forging the record of a run they drive. It
stops that forgery reaching anything outside the member's own run.**

A member who drives a run locally owns the process. They can patch the CLI to skip
a gate and run the next step anyway, and no record check can prevent that. A gate
in a member-driven run binds people who run the CLI unmodified. It never binds the
runner against their will.

**In scope.** Serve guarantees all four:

1. **No forged decisions.** A decision (approval, rejection, signal outcome,
   cancel) exists only if serve's handler made it, under the decider's own grant.
   A forwarded record cannot create, change or drop one, other than a retry
   clearing it for a fresh decision. A cancel a caller makes
   through serve is decided on their grant, recorded and stamped; what the run's
   record says afterwards is a status, which is out of scope, so the member driving
   the run can report past it.
2. **Runs serve drives take no forwarded record at all.** On those runs, gates do
   bind. A run is serve-driven when its record has a triggering principal or names
   an instance as owner; only serve records either.
3. **Serve never acts on a member-driven run's state with anyone else's
   authority.** On its own account serve does not resume such a run: after an
   approval, a signal, a child ending, or on its continuation sweep. Its owner
   resumes it. A caller who asks to resume it, or to cancel it, does so on their
   own grant.
4. **Serve records who wrote each record.** Any member with `run` on a workflow is
   trusted to report runs of that workflow, and serve's commit stamp records who
   did. There is no per-run ownership refusal: one member resuming another's run
   works.

**Initiator (swamp-club#4454).** A new run record names the principal serve
stamps on its commit (the token record's principal), or, for a child run, its
stored parent's initiator; anything else is refused with
`run-initiator-mismatch` (`run_initiator_mismatch` in the CLI, advising an
upgrade). Serve rewrites no bytes, and the frozen-field rule keeps it after the
first record. A child a resume creates keeps the parent's initiator; who resumed
it is out of scope. The rule is not limited to resumes: any caller with `run`
on an active parent's workflow can create a child record attributed to the
parent's initiator. Under auth mode none nothing is checked. Two upgrade windows
are accepted, not closed: work an older CLI queued offline across a serve
upgrade, and a leader upgraded before its followers (an old follower never
advertises the check). Such a record is kept in the member's outbox as rejected
and its work is run again; there is no path that accepts it as it is.

**Login tokens.** An admin may revoke any token but may not reveal a login
token (one an OAuth or device login minted) through serve.

A record's `client` follows the same split. Only serve records it, so a forwarded
first record that carries one is refused and it cannot change afterwards. A
decision serve recorded on a member-driven run may come back without its client,
because an older CLI strips a field it does not know, and nothing else about the
decision may differ. A modified CLI can do the same, so on such a run the audit
event is the authority on the client.

**Out of scope:**

- the step, job and run statuses, outputs and timings a member reports for a run
  they drive;
- splitting such a report across commits.
- `triggerSource`, a behavior's output provenance and the `initiatedBy` data
  tag, which are the member's report: the commit stamp says who wrote them.
- the step starts a member reports for a run they drive (swamp-club#4319). A
  start is a run's own small record that a step began, read with the run's
  record on recovery. It holds a job, a step and a start time and nothing else,
  so it carries no decision. Serve refuses one for a run with no stored record or
  one serve drives, and one whose key is not its own start. Since there is no
  per-run ownership, a member with `run` on a workflow can report a start for
  another member-driven run of it; the most that does is make a step of that run
  read as `unknown`, or add a step of that name to its recovered record, so its
  recovery asks before running it again. A recovery through serve withdraws no
  start, since a removal needs `write`, and a member may recover with `run`.

- what a waiting gate shows its approver beyond one wait: it is frozen while
  the wait is open, but a retry clears the decision and opens a new wait, which
  shows what the member's record says then.

So a member-driven run's record can show a gate passed with no decision on it, or
a nested step succeeded with no child. That is what it means: the member reported
it, and the commit stamp says who. Nothing outside that run acts on it.

**For a gate that must bind its runner, run the workflow on serve** (`--server`, a
trigger or a schedule, optionally on workers).

**Signals in team mode.** A run that waits for a signal runs on serve.
In a serve-mode checkout, a workflow with a signal wait is refused before it starts,
because serve can deliver a signal only to a wait it registered itself. A forwarded
record names no signal wait, so nothing a member reports reaches serve's wait
records. Decided on 2026-11-02: local delivery would need the judge to accept
outcomes a member wrote, and a wait exists for someone else to signal. Approval gates
are unaffected: `approve` and `reject` go to serve's handlers. Use `--server`, a
trigger or a schedule. A member's `workflow history get` shows a signal serve accepted
by reading serve's view of the run, which needs `read` on the workflow there.

**Delete and recreate.** A forwarded record under a deleted run's id has nothing
stored to compare against, so deleting a guarded run's record needs `admin` on the
workflow. A run is guarded when its stored record is serve-driven or holds an
approval decision; a record serve cannot read counts as guarded. This covers a
forwarded `run.delete`, `run-snapshot.delete` or `run-start.delete` and `workflow
delete` through serve,
and the refusal is audited. A member still deletes their own undecided member-driven
run with `write`. A `run gc` through serve that sets its own cut-off (`--older-than`)
needs `admin` on every workflow, since it chooses which records go; a dry run does not.
Serve's automatic retention, and a `run gc` on the configured policy, are unchanged:
they still need only `write` on data and remove finished runs past the policy,
guarded or not. That is the remaining limit, bounded by the policy the admin set. On
a serve that takes no forwarded records none of this applies, as nothing can replace
a deleted record.

**Limits of the marker.** When a member-driven parent is cancelled through serve, a
child that does not link back is not cancelled with it: its owner cancels it.
On a v3 serve, a run a CLI drove directly against the
datastore also counts as member-driven, so its owner resumes it. A v2 datastore
has no forwarded records, so serve still acts on its runs as before. Bookkeeping
serve does on any run's state (interrupting a run whose owner died, superseding a
suspended run with matching inputs, closing wait records) changes only that run's
record and runs no step.
