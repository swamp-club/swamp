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

A principal is the authenticated identity making a request. There are two kinds:

| Kind     | Format        | Source                                          |
| -------- | ------------- | ----------------------------------------------- |
| `user`   | `user:<id>`   | OAuth sub claim, or the username on a server token |
| `worker` | `worker:<id>` | Worker enrollment via the `rpc.enroll` frame    |

Minting a server token rejects any other kind and names the valid ones. A stored
token whose principal does not parse (minted before that check, or hand-edited)
is refused with `401 invalid-principal`.

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

A grant targets a _subject_, not a principal. There are three subject kinds:

| Kind        | Format             | Matches when                                    |
| ----------- | ------------------ | ----------------------------------------------- |
| `user`      | `user:<name>`      | The principal's `kind:id` matches exactly       |
| `group`     | `group:<name>`     | The principal is in the named local group       |
| `idp-group` | `idp-group:<name>` | The principal's IdP group claims include the group |

### Local groups

Local groups are `swamp/group` model instances, each with a name and a list of
principal members. The `PolicySnapshot` indexes groups by principal, so
resolving subjects is a single map lookup.

### Subject resolution

For each request, the decision service builds the principal's subject list:

1. `user:<id>`: the principal itself.
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

For `model` resources, grants match **both** the instance name and the
extension type. A grant on `model:@xero/segment/*` matches any instance whose
type is under `@xero/segment/`, such as `segment-test-audiences` with type
`@xero/segment/audience`. The name is checked first, then the type from the
model's definition. This holds on every evaluation path: `decide()`,
`explain()`, and `filterByAuthorization` for collection operations.

Implementation: `src/domain/access/resource_selector.ts`,
`src/domain/access/grant_based_access_decision_service.ts`.

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

1. **Resolve subjects**: user, local groups, IdP groups.
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
7. **No match**: if an `admin` grant on `access:*` matches, the request proceeds
   (admin fallback). Otherwise it is denied by default.

**Deny-first**: a deny always beats an allow for the same subject, action and
resource. There is no other priority or ordering.

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
3. **Remote datastore**: an `AccessDataPoller` pulls `data/swamp/grant` and
   `data/swamp/group` every 30 s and reloads on any change
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

It exits 0 for allow and 1 for deny. With `--method`, the JSON response echoes
the tested method in a `method` field.

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
