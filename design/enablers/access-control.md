---
audience: operator, maintainer
enables: [serve]
last-verified: 2026-09-14 @ 626d7507
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
`access.token.mint`, the `swamp/server-token` model) refuses a service
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
lifecycle check and timing-safe comparison as the model's `redeem` method, but
read-only: it does not write `lastUsedAt`, run a model method, or create a model
run. Calling `redeem` directly still updates usage.

The record also names the secret it was minted with, as a SHA-256
`secretFingerprint`. A credential that matches the vault secret but not that
fingerprint is rejected: the record, and so the principal, belongs to a
different mint of the name (swamp-club#2482). See "Tokens" in
`design/primitives/serve.md`.

Implementation: `src/serve/token_auth.ts`,
`src/domain/models/access/server_token_model.ts`.

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

A grant targets a _subject_, not a principal. There are four subject kinds:

| Kind        | Format             | Matches when                                       |
| ----------- | ------------------ | -------------------------------------------------- |
| `user`      | `user:<name>`      | The principal is `user:<name>`                     |
| `group`     | `group:<name>`     | The principal is in the named local group          |
| `idp-group` | `idp-group:<name>` | The principal's IdP group claims include the group |
| `service`   | `service:<name>`   | The principal is the built-in `service:<name>`     |

### Local groups

Local groups are `swamp/group` model instances, each with a name and a list of
principal members. The `PolicySnapshot` indexes groups by principal, so
resolving subjects is a single map lookup.

### Subject resolution

For each request, the decision service builds the principal's subject list:

1. `<kind>:<id>`: the principal itself.
2. `group:<name>`: every local group the principal belongs to.
3. `idp-group:<name>`: every IdP group claim carried on the connection.

Every grant whose subject is in this list is a candidate.

Implementation: `src/domain/access/subject.ts`,
`src/domain/models/access/group_model.ts`.

## Grants

A grant allows or denies an action on a resource for a subject. Grants are
stored as `swamp/grant` model instances with state `active` or `revoked`.

### Schema

| Field       | Type                  | Description                                    |
| ----------- | --------------------- | ---------------------------------------------- |
| `id`        | string                | Unique grant identifier                        |
| `subject`   | string                | Target subject (`user:adam`, `group:ops`)      |
| `effect`    | `allow` \| `deny`     | Whether the grant permits or blocks            |
| `actions`   | `Action[]`            | One or more of `run`, `read`, `write`, `admin` |
| `resource`  | string                | Resource selector (`workflow:@acme/*`)         |
| `condition` | string (optional)     | CEL over resource fields and principal context |
| `methods`   | string[] (optional)   | Limit to these model methods (omit for all)    |
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

The `GrantFileReconciler` syncs file grants into model data, creating, updating
or revoking them as files change. The `file:<filename>` source separates them
from method-created grants during reconciliation.

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
lowest model id and revokes the others. The order does not depend on local
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
(for example an unmounted volume). Other files still reconcile. Where startup
accepts the input, its grants are revoked as before: a deleted or emptied
file, an emptied `--grants-file`, and a missing repository `grants/`
directory.

Implementation: `src/domain/access/grant_file.ts`,
`src/domain/access/grant_file_reconciler.ts`.

### Resource selectors

A resource selector has the form `<kind>:<pattern>`:

| Kind       | What it gates                        |
| ---------- | ------------------------------------ |
| `workflow` | `workflow.run`, `workflow.status`    |
| `model`    | `model.method.run`, `model.create`   |
| `data`     | `data.get`, `data.query`             |
| `access`   | Grant and group management, and the records the control plane stores as model data (see [Control-plane records](#control-plane-records)) |

Patterns support a trailing `*` wildcard:

- `@acme/*` matches `@acme/deploy`, `@acme/build`
- `@acme/deploy` matches only `@acme/deploy` (exact)
- `*` matches everything

#### Model resource dual-identity matching

For `model` resources, grants match **both** the instance name and the extension
type. A grant on `model:@xero/segment/*` matches any instance whose type is
under `@xero/segment/`, such as `segment-test-audiences` with type
`@xero/segment/audience`. The name is checked first. If it does not match, the
type from the model's definition is checked as a fallback. This holds on every
evaluation path: `decide()`, `explain()`, and `filterByResources` for
collection operations.

Implementation: `src/domain/access/resource_selector.ts`,
`src/domain/access/grant_based_access_decision_service.ts`.

#### Requests by id match the resource's name

Selectors match names, never ids. A request may name a model or workflow by
name or by UUID, so serve resolves it first and authorizes the resource it
resolves to: its canonical name and full fields (`modelType` and tags for a
model, `ns` and tags for its data, tags for a workflow). A request by the UUID
of `prod-db` is therefore denied by `deny model:prod-*` just as a request by
name is. The operation then acts on exactly that resource: it is handed the
resolved id and the authorized name, and accepts only a resource with both.
Ids alone are not enough — a resource may be named with another's UUID, and a
copied file keeps its id — so neither can redirect the action.

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
- A model is reported with the type its definition file declares, whether it
  is found by name or by id, so authorization and execution always see the
  same type.

Reads of a method output or a workflow run (`model.output.get`, `.data`,
`.logs`, `model.method.history.get` and `.logs`, `workflow.history.get` and
`.logs`) take an output or run id prefix — 3+ hex characters, matched across
every model or workflow before any name — or a model or workflow name or id,
which reads its latest output or run. Serve resolves the argument to the
output or run the read will return, authorizes its owners, and hands the read
that same resolved output or run, so nothing is looked up again after the
check (swamp-club#2673):

- An output is authorized on every definition declaring its model id. Ids
  are not unique, and a copied definition shares the original's outputs and
  data, so a deny on any of them refuses the read. Definitions of
  unregistered types and auto-definitions count.
- A run is authorized on the workflow recorded on it, by its recorded name.
  When no workflow still has both the recorded name and id — the workflow
  was renamed, or only a copy sharing its id remains — the workflow now
  found by that id is authorized too. A run's recorded name identifies its
  workflow exactly, unlike an output, whose data every copy shares.
- A read by model or workflow name authorizes that model or workflow and the
  owners of the latest output or run it returns.
- An output whose model was deleted is authorized on its model id; a run
  whose workflow was deleted, on its recorded workflow name (without tags).
- A prefix matching several outputs or runs is authorized on the owners of
  each match, looked up once per model or recorded workflow. The ambiguity
  error lists only the matches whose owners the caller may all read. Each
  distinct owner is decided and audited once, however many matches share
  it, so the audit log grows with the owners involved, not with the size of
  the history. When none is readable, the read is
  refused as a unique prefix of the first match would be (swamp-club#2743).
  Without enforcement, serve lists every match, as the CLI does.
- A prefix matching nothing is authorized as sent.
- `model.output.data` and `model.output.logs` return data artifact content, so
  they also need a `data` read on the owning models, as `data.get` does
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
request resolved to, not the id the client sent (a request by a model's UUID is
audited under the model's name); a string that matched nothing is recorded as
sent. A workflow-scoped `data.get` is audited under the names of the item's
owners, joined with ", " when there are several. The resolved name replaces the
sent identifier only when the event audits the same kind of resource: a
`run.attach`, audited as the run, keeps the run id. Denials already carry the
resolved resource.

Direct type execution (`model.method.run` with a type and a definition name)
acts on the definition `definitionName` names, which a request may set apart
from `modelIdOrName`. That definition is authorized too, by its canonical name
and fields (or, before it exists, by the name to be created with the named
type), after the requested model and the type; it is the one locked, recorded
for cancel and attach, and audited. The run is handed that definition's id and
fails if the name resolves to anything else by then (swamp-club#2672). Because
a direct run can rewrite an existing definition's global arguments, it takes
that definition's model lock whatever the method's kind. The
name vaults are authorized under is tracked by swamp-club#2676.

Implementation: `src/serve/handlers/resource_resolution.ts`. Guards:
`integration/serve_id_deny_conformance_test.ts`, which covers every request
type that names a resource, and
`integration/serve_canonical_authorization_rules_test.ts`.

### Actions

| Action    | Typical operations                                     |
| --------- | ------------------------------------------------------ |
| `run`     | Execute a workflow or model method (implies `approve`) |
| `read`    | Query data, view definitions, list resources           |
| `write`   | Create or update models, definitions, data             |
| `approve` | Approve or reject a workflow manual-approval gate      |
| `admin`   | Manage grants, groups, tokens, restricted models, and any operation on a control-plane record |

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

An `AccessDecision` whose grant passed `approve` only through `run` carries
`impliedBy: "run"`. `swamp access check` and `swamp access can-i` show it as
`[implied by run]`, and `can-i` without an action lists an implied `approve` row
per such grant. The server's `access.check` and `access.can-i` responses report
the policy as `approveRequiresExplicitGrant`.

Implementation: `src/domain/access/action.ts`,
`src/domain/access/grant_based_access_decision_service.ts`
(`runImpliesApprove` option, `actionsCoveredBy`).

## Grant evaluation model

The `GrantBasedAccessDecisionService` runs the evaluation. For a (principal,
action, resource) triple:

1. **Resolve subjects**: the principal itself, local groups, IdP groups.
2. **Collect candidates**: every grant whose subject is in the list.
3. **Filter**: keep grants matching the resource selector, the action and the
   method name (when the grant has a `methods` list). Implied actions count:
   `run` implies `approve`, except for allow grants when the server requires an
   explicit `approve` grant.
4. **Partition**: split into deny and allow grants.
5. **Evaluate denies first**: check each deny's condition, if any. The first
   matching deny wins and the request is rejected.
6. **Evaluate allows**: check each allow's condition, if any. The first matching
   allow wins and the request proceeds.
7. **Service trigger default**: a `service` principal asking to `run` a
   `workflow` is allowed (decision grant id `builtin:service-trigger-default`).
   It covers no other action or resource kind, so it never implies `approve`.
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
workflow does not have) withholds the default: the run is refused rather than
allowed, so a broken restriction fails closed. Write tag conditions defensively,
e.g. `!("trigger" in tags) || tags.trigger != "webhook"`. In a mixed-version
fleet, instances older than the service principal skip `service:` grants when
loading policy; they also do not authorize trigger runs.

### Condition evaluation

Grant conditions are CEL expressions evaluated in the sealed grant-condition
environment (see `design/enablers/expressions.md`, surface 3). Variables by
resource kind:

| Resource kind | Available fields                                             |
| ------------- | ------------------------------------------------------------ |
| `workflow`    | `name`, `tags`, `collective`                                 |
| `model`       | `name`, `modelType`, `tags`, `collective`, `methodName`      |
| `data`        | `name`, `ns`, `tags`, `owner`                                |
| `access`      | `name`                                                       |

Every kind can also use `principal.sub`, `principal.groups` and
`principal.collectives`.

The same variable list (`src/domain/access/condition_fields.ts`) serves grant
validation and the runtime evaluator. `methodName` is a request field: only
method requests (a method run, its cancel and attach, output and method-run
items) carry it, and a request without one evaluates it as `""`, so a condition
on it simply does not match; a grant's `methods` list is matched the same way
as before. `collective` and `owner` are declared but serve does not supply them
yet: a deny that references them refuses every request of its kind, an allow
never matches, and loading the policy logs a warning naming each such grant.

**Missing fields fail closed** (swamp-club#2675). Serve authorizes every
resource with all of its resource fields — `tags` is `{}` and `ns` is `""` when
the resource has none, and `name` is always the resource name. A condition that
references a resource field the resource does not carry cannot be evaluated: a
deny that needs it refuses, and an allow that needs it does not match. The check
is structural — the fields a condition references are read from its parsed
expression — never inferred from an error message. A condition that reads a tag
the resource does not have (`tags.env` on a resource with no `env` tag) is a
different case: the resource carries its tags, so the condition decides nothing
and other grants decide, as described above; guard such conditions with `in`.
A check on a resource kind as a whole (`kindResource`: type and schema
endpoints, extensions, datastores) touches no resource, so a condition on
resource fields decides nothing there either.

Each request has an **aggregate condition budget** of 100 CEL evaluations. If it
runs out, the request is denied whatever grants remain.

Implementation: `src/domain/access/grant_based_access_decision_service.ts`,
`src/domain/access/policy_snapshot.ts`.

## PolicySnapshot lifecycle

The `PolicySnapshot` is the in-memory aggregate of all active grants and groups.
It loads at serve startup and is rebuilt when grant or group model data changes.

1. **Initial load**: `PolicySnapshotLoader.load()` reads every `swamp/grant` and
   `swamp/group` data record from the repository.
2. **Auto-rebuild**: the loader subscribes to `ModelCreated`, `ModelUpdated`,
   `DefinitionCreated` and `DefinitionUpdated`. When a grant or group model
   changes, it rebuilds after a 500 ms debounce.
3. **Remote datastore**: with a remote datastore, an `AccessDataPoller` pulls
   `data/swamp/grant` and `data/swamp/group` every `--datastore-poll-interval`
   (default 30 s) and reloads on any change
   (`src/serve/access_data_poller.ts`).
4. **OAuth group refresh**: a `CollectiveRefreshService` re-fetches each
   logged-in user's collectives every `--group-refresh-interval` and closes
   connections whose admission lapsed
   (`src/serve/collective_refresh_service.ts`).

The `GrantBasedAccessDecisionService` picks up a rebuilt snapshot on the next
request. There is no per-request locking or snapshot versioning.

Implementation: `src/domain/access/policy_snapshot_loader.ts`.

## Collection operations and grant-scoped filtering

Single-resource operations (`model.get`, `workflow.run`, `data.get`) authorize
against the named resource, for example `model:@acme/deploy`. Collection
operations (`model.search`, `workflow.search`, `data.search`, `data.query`, and
their history, output and approval variants) return many results and cannot
name one up front.

These handlers run the query, then keep only the items the caller may read.
Each item is judged on the resources that own it now, looked up by id rather
than by the name recorded when it was written, with every resource field
present (`CanonicalResources`): a model item on its definition, an output or
method run on every model declaring its model id (a copy shares its outputs and
data) together with the method it ran, a data item on every owning model — or,
for workflow-scope data, its workflow — and a run or approval on its workflow.
An item with several owners is kept only when all of them are allowed. With
`model:@acme/*`, `model search` shows only matching models. With `model:*` it
shows everything. With no `read` grant for the kind, the request is refused.

A `*` resource name never matches a name-scoped deny, so no request over many
resources is authorized as `*` (swamp-club#2675):

- `model.validate`, `workflow.validate` and `workflow.evaluate` without a name
  run only over the models or workflows the caller may read. A workflow file
  that fails to parse is judged on the name it declares with no tags, since its
  tags cannot be read, so a tag-conditioned deny does not hide it. `model.evaluate`
  without a name evaluates every model, since evaluation orders them all in one
  dependency graph, but saves and returns only the readable ones.
- `data.query` drops unreadable records inside the query, before the limit,
  `limited` and any `select` projection are computed.
- Reports are data: `report.get` and `report.search` cover only reports whose
  owner the caller may read as `data`, and a named `--model` or `--workflow` is
  authorized first. The ambiguity error of `report.get` lists only readable
  owners.
- `vault.audit-trail` without a vault keeps only the entries of vaults the
  caller may read by name; the limit applies after filtering.
- `data.gc`, `data.prune`, `run.gc` and `summarise` reach every resource and
  cannot be narrowed, so they need the action on every resource of each kind
  they touch: any deny grant that applies to the caller for the kind and action
  refuses them, whatever its pattern or `methods` list, unless its condition
  reads only the principal and does not hold for this caller (`decideAll`);
  the refusal names the grant and says when it is conditional.

`access.can-i` and `access.check` explain a decision the way a request would
make it: a concrete model, data or workflow name is resolved to the resource it
names with all of its fields; a pattern with a wildcard names no single resource
and is explained as a check on the kind, where conditions on resource fields
decide nothing.

Endpoints that return only type definitions or schemas (`model.type.search`,
`model.type.describe`, `workflow.schema`, `report.type.search`,
`report.describe`, `vault.type.search`) need at least one `read` grant for the
kind, or check the kind itself, and do not filter per item.

Implementation: `filterByResources`, `resourceDecider`, `authorizeAnyOrReject`
and `authorizeAllOrReject` in `src/serve/handlers/shared.ts`;
`CanonicalResources` in `src/serve/handlers/resource_resolution.ts`. Guards:
`integration/serve_condition_fields_conformance_test.ts`, which classifies every
request type, and the `*` rule in
`integration/serve_canonical_authorization_rules_test.ts`.

## Control-plane records

The control plane stores its own records as model data beside user models:
`swamp/grant`, `swamp/group` and `swamp/server-token` for access control, and
`swamp/enrollment-token`, `swamp/worker`, `swamp/step-lease`,
`swamp/pending-dispatch` and `swamp/fleet-probe` for the worker fleet
(`CONTROL_PLANE_MODEL_TYPES`). They are never user data. A grant record is the
policy itself, a token record names its principal, expiry and the vault key
holding its secret, and a group record lists its members (swamp-club#2756).

- **Owned by the access kind.** Serve authorizes any model or data resource of
  a control-plane type as the access resource named by its normalized type,
  `access:swamp/grant` for example, not as `model:<name>` or `data:<name>`.
  The resource name is the type, so selectors match it; its fields are the
  record's own (`name`, `modelType`, `tags` of its model), so a condition
  naming one grant or token still decides on that record.
  `modelAccessResource` and `CanonicalResources` make that mapping, so it
  holds on every path that goes through them: `data.get`, `data.list`,
  `data.versions`, `data.delete`, `data.rename`, `data.search`, `data.query`,
  reports, workflow-history step data, `model.get`, `model.edit` (before and
  after the edit), `model.output.*` and
  `model.method.history.*`. An owner no longer found is judged on its recorded
  type — a data item's or output's owner, and the model of a run whose cancel or
  attach arrives after its definition was deleted (the run records its model
  type) — and method run and create gate every control-plane type as admin.
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
  model's name is refused, where a name that matches nothing reports not
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
`swamp/*` model type is missing from the list.

## Workflow execution context

On a `workflow.run` request, the handler checks that the principal has `run` on
`workflow:<name>`. If so, the workflow runs, including every model method call
in its steps, with no further checks. The workflow is the unit of authorization:
the caller may run all of it or none of it.

The reason is that the operator who wrote the workflow chose which models it
calls, and a `run` grant delegates that choice. Per-model grants would force
operators to grant `run` on every model a workflow touches, which leads to
overly broad grants.

**Direct model method calls through serve** (`model.method.run`) are authorized
on their own against `model:<name>`. The workflow exemption covers only model
calls the workflow engine makes internally.

Because a run delegates to whoever wrote the workflow, the writer is held to
what the workflow runs. A served `workflow.edit` that adds a step needs `run`
on the step's model (with the type, and `admin` for a restricted or
control-plane type, as a direct run needs) or on its nested workflow. A guard
or assert that calls `model.method("<model>", "<method>")` runs that method, so
it is held to the same check. A model target computed by an expression can
resolve to any model, restricted and control-plane ones included, which the
engine does not gate, so it needs `admin`; a computed nested workflow needs
`run` on every workflow. Steps already stored are not re-checked, and neither
is a run, so users running a workflow an admin wrote are unaffected. An edit
that changes the workflow's inputs or a step's `forEach` re-checks stored
computed targets that read `inputs` or `self`, since those are what can
retarget them; a retag or any other edit does not.

## Expression references

Expressions can read beyond the model they belong to: other models' data
(`data.*`, `model.<name>.resource`, `file.contents`), other models'
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
| `model.edit`, `workflow.edit`      | each expression whose text the stored content does not hold  |
| `model.method.run` inputs          | every expression in the inputs                               |
| runs, evaluate, validate           | nothing: stored content is the author's                      |

- **Data.** A reference to a named model needs `read` on the data it can
  return: every current owner of records stored under that name, and every
  definition with that name or id; deny wins. A reference whose model
  is computed, a cross-model accessor (`data.query`, `data.findByTag`), the
  `model` map used whole or with a computed key, a `ns:` or `*:` prefix, more
  than 32 named models, or text the analyzer cannot parse needs `read` on all
  data, so any data deny refuses it. A target computed from `self` counts too:
  `data.latest(self.name, ...)` is judged as reading any data. A definition
  lookup that fails refuses the reference.
- **Definitions.** `model.<name>.input` and `.definition` need `read` on the
  model.
- **env.** Reading the server's environment is an author's capability: a
  writer holds `write` on the model, so env is allowed on the write paths. In
  run inputs it needs `write` on the model run; a run-only caller is refused
  and told to reference env in the definition. `evaluate` and `validate` never
  resolve env, which is resolved only when a method runs.
- **Retargeting.** A stored expression that reads data through a target
  computed from `self` or `inputs` is re-checked when an edit could point it
  elsewhere: a model edit that changes its name, version, tags, global
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

- An author's computed target lets runners choose the model:
  `data.latest(inputs.target, ...)` in a stored definition reads whatever model
  a run passes as a plain input, and a target taken from another model's data
  (or from `steps.*` or `run.*`) follows whoever writes that data. That is the
  author's choice; avoid caller-controlled targets where the runner should not
  pick the model.
- Global arguments a run can override are the runner's choice. A workflow
  step's `globalArgs`, and a direct-type run's inputs, replace a model's
  global arguments for that run, and a direct run also saves them to the
  definition. Both need only `run`. A stored reference computed from
  `self.globalArguments` therefore reads whatever model the runner names, like
  one computed from `inputs`. Don't compute a data target from a global
  argument when runners shouldn't choose the model.
- The check runs when text is saved. A reference to a name that nothing owns
  today reads data later stored under that name, and expressions stored before
  this check existed are not re-checked.
- `vault.get` in run inputs is masked in output but its value reaches the
  method; vault authorization is swamp-club#2676.

## The can-i request

`swamp access can-i` lets a user check their own permissions on a running
server. It has two modes.

**Specific check**: test one (action, resource) pair:

```
swamp access can-i --action run --on workflow:@acme/deploy --server wss://swamp.acme.internal:9090
```

For method-scoped grants, add `--method` to test one model method:

```
swamp access can-i --action run --on model:@acme/my-model --method read --server wss://swamp.acme.internal:9090
```

It returns the matching grant decision and exits 0 for allow and 1 for deny.
With `--method`, the JSON response echoes the tested method in a `method` field.

**List all permissions**: omit `--action` and `--on` to see every grant that
applies to the caller across all resource kinds:

```
swamp access can-i --server wss://swamp.acme.internal:9090
```

The command sends an `access.can-i` WebSocket request. The server resolves the
caller's subjects and calls the decision service's `explain` method, which
returns every matching grant (allow and deny), not only the first.
`--collectives` simulates IdP group memberships so grant configurations can be
tested before deployment.

Implementation: `src/cli/commands/access_can_i.ts`,
`src/serve/handlers/access_handlers.ts`.
