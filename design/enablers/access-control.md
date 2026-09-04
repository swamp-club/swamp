---
audience: operator, maintainer
enables: [serve]
last-verified: 2026-08-31 @ 8e14ae13
---

# Access Control

Serve evaluates authorization per request against an in-memory policy built from
grant and group data. The entire access-control subsystem exists so that the
serve primitive can answer one question: "may this principal perform this action
on this resource?"

Authorization is checked at the serve handler boundary
(`authorizeOrReject` in `src/serve/handlers/shared.ts`), not at the domain
layer. The domain provides the decision service; only serve handlers call it.
This means a local `swamp` invocation (no `--server`) is never subject to
grants — grants govern serve access only.

## Principals

A principal is the authenticated identity making a request. Two kinds exist:

| Kind     | Format         | Source                                                               |
| -------- | -------------- | -------------------------------------------------------------------- |
| `user`   | `user:<id>`    | OAuth sub claim, or the username on a server token                   |
| `worker` | `worker:<id>`  | Worker enrollment via the `rpc.enroll` frame                         |

The principal is resolved once at connection time and attached to every
subsequent request on that WebSocket. In `none` auth mode there is no principal
and authorization is skipped entirely.

Implementation: `src/domain/access/principal.ts`.

## Admission

Before authorization, a separate admission gate controls who may connect at all.
In OAuth mode, the operator must configure at least one of:

- `--allowed-collectives` — the user must belong to one of these collectives
  (checked against the IdP's group claims)
- `--allowed-users` — the user's OAuth sub must appear in this list

If neither list is configured, the server refuses to start (preventing an
open-to-anyone server). A user who passes admission proceeds to per-request
authorization; a user who fails admission is disconnected before any request is
evaluated.

Implementation: `src/domain/access/admission.ts`.

## Subjects

A grant targets a _subject_, not a principal directly. Three subject kinds exist:

| Kind        | Format              | Matches when                                                |
| ----------- | ------------------- | ----------------------------------------------------------- |
| `user`      | `user:<name>`       | The principal's `kind:id` matches exactly                   |
| `group`     | `group:<name>`      | The principal is a member of the named local group          |
| `idp-group` | `idp-group:<name>`  | The principal's IdP group claims include the named group    |

### Local groups

Local groups are defined as `swamp/group` model instances. Each group has a name
and a list of principal members. The `PolicySnapshot` indexes groups by principal
so that subject resolution is a map lookup, not a scan.

### Subject resolution

When evaluating a request, the decision service builds the full subject list for
the principal:

1. `user:<id>` — the principal itself
2. `group:<name>` — for every local group the principal belongs to
3. `idp-group:<name>` — for every group claim from the IdP (carried on the
   connection)

All grants whose subject matches any entry in this list are candidates.

Implementation: `src/domain/access/subject.ts`,
`src/domain/models/access/group_model.ts`.

## Grants

A grant is a rule that allows or denies a specific action on a specific resource
for a specific subject. Grants are persisted as `swamp/grant` model instances
with state `active` or `revoked`.

### Schema

| Field       | Type                    | Description                                         |
| ----------- | ----------------------- | --------------------------------------------------- |
| `id`        | string                  | Unique grant identifier                             |
| `subject`   | string                  | Target subject (`user:adam`, `group:ops`)            |
| `effect`    | `allow` \| `deny`       | Whether this grant permits or blocks                |
| `actions`   | `Action[]`              | One or more of `run`, `read`, `write`, `admin`      |
| `resource`  | string                  | Resource selector (`workflow:@acme/*`)               |
| `condition` | string (optional)       | CEL expression over resource fields and principal context |
| `methods`   | string[] (optional)     | Restrict to specific model methods (omit for all)   |
| `state`     | `active` \| `revoked`   | Only `active` grants participate in evaluation      |
| `source`    | string                  | Origin of the grant (see below)                     |

### Grant sources

| Source               | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `method`             | Created via `swamp access grant create`              |
| `config`             | Loaded from server configuration at startup          |
| `file:<filename>`    | Reconciled from a YAML file in the grants directory  |
| `extension:<name>`   | Bundled with an extension                            |

### Grant files

Operators can define grants declaratively in YAML files placed in the grants
directory (configured via `--grants-dir`). Each file contains:

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

The `GrantFileReconciler` syncs file-based grants into model data, creating,
updating, or revoking grants as files change. File-sourced grants carry the
`file:<filename>` source so they can be distinguished from method-created grants
during reconciliation.

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

Implementation: `src/domain/access/resource_selector.ts`.

### Actions

| Action  | Typical operations                                  |
| ------- | --------------------------------------------------- |
| `run`   | Execute a workflow or model method                  |
| `read`  | Query data, view definitions, list resources        |
| `write` | Create or update models, definitions, data          |
| `admin` | Manage grants, groups, tokens, restricted models    |

Implementation: `src/domain/access/action.ts`.

## Grant evaluation model

The `GrantBasedAccessDecisionService` implements the evaluation algorithm. For a
given (principal, action, resource) triple:

1. **Resolve subjects** — build the full subject list (user + local groups + IdP
   groups)
2. **Collect candidates** — find all grants whose subject is in the list
3. **Filter** — keep only grants that match the resource selector, the requested
   action, and the method name (when the grant specifies a `methods` list)
4. **Partition** — separate into deny grants and allow grants
5. **Evaluate denies first** — for each deny grant, evaluate the condition (if
   any). The first matching deny wins and the request is rejected
6. **Evaluate allows** — for each allow grant, evaluate the condition (if any).
   The first matching allow wins and the request proceeds
7. **No match** — if no grant matches, check for an `admin` grant on
   `access:*`. If that matches, the request proceeds (admin fallback). Otherwise
   the request is denied by default

**Deny-first**: a deny grant always beats an allow grant for the same subject,
action, and resource. This is evaluated per-request — there is no grant priority
or ordering beyond "denies win."

### Condition evaluation

Grant conditions are CEL expressions evaluated in the sealed grant-condition
environment (see `design/enablers/expressions.md`, surface 3). Available
variables per resource kind:

| Resource kind | Available fields                                             |
| ------------- | ------------------------------------------------------------ |
| `workflow`    | `name`, `tags`, `collective`                                 |
| `model`       | `name`, `modelType`, `tags`, `collective`, `methodName`      |
| `data`        | `name`, `ns`, `tags`, `owner`                                |
| `access`      | `name`                                                       |

All resource kinds also have access to `principal.sub`, `principal.groups`, and
`principal.collectives`.

An **aggregate condition budget** of 100 evaluations per request prevents
unbounded CEL execution. If the budget is exceeded, the request is denied
regardless of remaining grants.

Implementation: `src/domain/access/grant_based_access_decision_service.ts`,
`src/domain/access/policy_snapshot.ts`.

## PolicySnapshot lifecycle

The `PolicySnapshot` is the in-memory aggregate of all active grants and groups.
It is loaded at serve startup and rebuilt when grant or group model data changes.

1. **Initial load** — `PolicySnapshotLoader.load()` reads all `swamp/grant` and
   `swamp/group` data records from the repository
2. **Auto-rebuild** — the loader subscribes to `ModelCreated`, `ModelUpdated`,
   `DefinitionCreated`, and `DefinitionUpdated` events. When a grant or group
   model changes, a debounced rebuild (500 ms) fires
3. **Remote datastore** — when using a remote datastore, an `AccessDataPoller`
   pulls `data/swamp/grant` and `data/swamp/group` every 30 s and triggers a
   reload when anything changed (`src/serve/access_data_poller.ts`)
4. **OAuth group refresh** — a `CollectiveRefreshService` re-fetches each
   logged-in user's collectives from the provider at
   `--group-refresh-interval` and closes connections whose admission lapsed
   (`src/serve/collective_refresh_service.ts`)

The `GrantBasedAccessDecisionService` holds a reference to the current snapshot.
When the snapshot is rebuilt, the service picks up the new one on the next
request — there is no request-level locking or snapshot versioning.

Implementation: `src/domain/access/policy_snapshot_loader.ts`.

## Workflow execution context

Authorization is checked at the serve handler boundary, not at the domain layer.
When a client sends a `workflow.run` request, the handler checks whether the
principal has `run` on `workflow:<name>`. If that check passes, the workflow
executes — including all model method calls within its steps — without further
authorization checks.

A `run` grant on a workflow resource is sufficient for all model method calls
within that workflow. Individual model grants are not required for
workflow-internal steps. The workflow is the authorization unit: either the
caller may run the whole workflow, or they may not.

This is by design. A workflow is an operator-authored DAG of steps. The operator
chose which models the workflow calls; granting `run` on the workflow delegates
that authority. Requiring per-model grants within a workflow would force
operators to grant `run` on every model a workflow touches, defeating the
purpose of workflow-level authorization and leading to overly broad grant
configurations.

**Direct model method calls through serve** (`model.method.run`) are authorized
independently against `model:<name>` — the workflow exemption applies only to
model calls made internally by the workflow engine.

## The can-i request

`swamp access can-i` lets a user check their own permissions against a running
server. It operates in two modes:

**Specific check** — test a single (action, resource) pair:

```
swamp access can-i --action run --on workflow:@acme/deploy --server wss://swamp.acme.internal:9090
```

For method-scoped grants, add `--method` to test a specific model method:

```
swamp access can-i --action run --on model:@acme/my-model --method read --server wss://swamp.acme.internal:9090
```

Returns the matching grant decision (allow or deny) and exits with code 0 for
allow, 1 for deny.

**List all permissions** — omit `--action` and `--on` to see every grant that
applies to the caller:

```
swamp access can-i --server wss://swamp.acme.internal:9090
```

Returns all matching grant decisions across all resource kinds.

Under the hood, the command sends an `access.can-i` WebSocket request to the
server. The server resolves the caller's principal and subjects, then calls the
decision service's `explain` method — which returns all matching grants (both
allow and deny), not just the first match. The `--collectives` flag lets the
caller simulate IdP group memberships for testing grant configurations before
deploying them.

Implementation: `src/cli/commands/access_can_i.ts`,
`src/serve/handlers/access_handlers.ts`.
