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
| `file:<filename>`  | Reconciled from a YAML file in the grants directory |
| `extension:<name>` | Bundled with an extension                       |

### Grant files

Operators can declare grants in YAML files in the grants directory, set with
`--grants-dir`. Each file contains:

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

Implementation: `src/domain/access/grant_file.ts`,
`src/domain/access/grant_file_reconciler.ts`.

### Resource selectors

A resource selector has the form `<kind>:<pattern>`:

| Kind       | What it gates                        |
| ---------- | ------------------------------------ |
| `workflow` | `workflow.run`, `workflow.status`    |
| `model`    | `model.method.run`, `model.create`   |
| `data`     | `data.get`, `data.query`             |
| `access`   | Grant and group management           |

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
evaluation path: `decide()`, `explain()`, and `filterByAuthorization` for
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
  error lists only the matches whose owners the caller may all read; each
  match left out is audited as a denial. When none is readable, the read is
  refused as a unique prefix of the first match would be (swamp-club#2743).
  Without enforcement, serve lists every match, as the CLI does.
- A prefix matching nothing is authorized as sent.
- `model.output.data` and `model.output.logs` return data artifact content, so
  they also need a `data` read on the owning models, as `data.get` does
  (swamp-club#2739). The other five return output or run metadata or the run
  log file and need only the `model` or `workflow` read.

Direct type execution (`model.method.run` with a type and a definition name),
`*` resources, and vaults authorize differently today; swamp-club#2672, #2675
and #2676 track them.

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
| `admin`   | Manage grants, groups, tokens, restricted models       |

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

These handlers run the query, then pass each item through `decide()` with the
item's resource name. With `model:@acme/*`, `model search` shows only matching
models. With `model:*` it shows everything. With no `read` grant for the kind,
the result is empty.

Endpoints that return only type definitions or schemas (`model.type.search`,
`workflow.schema`) need at least one `read` grant for the kind but do not filter
per item.

**CEL conditions and search results**: search items carry only some condition
fields, usually `name` and `modelType`. A condition that uses a missing field,
such as `resource.tags`, fails closed because the evaluator returns `false` for
unknown variables. Conditional grants can therefore be stricter on collection
operations than on single-resource ones.

Implementation: `filterByAuthorization` and `authorizeAnyOrReject` in
`src/serve/handlers/shared.ts`.

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
