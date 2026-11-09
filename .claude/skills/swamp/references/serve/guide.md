# Swamp Serve & Access Control

Expose a swamp repo over the network with authentication, authorization, and
grant-based access control.

For a team writing one v3 datastore through serve (team mode), see
[team-mode.md](team-mode.md).

## Auth Modes

| Mode    | Flag                | Use case                                       |
| ------- | ------------------- | ---------------------------------------------- |
| `none`  | `--auth-mode none`  | Loopback only, no auth (deprecated)            |
| `token` | `--auth-mode token` | Manual token minting, no swamp-club dependency |
| `oauth` | `--auth-mode oauth` | Users authenticate via swamp-club              |

OAuth mode requires `--allowed-collectives` or `--allowed-users` to control
admission. Use `--admins` to grant admin access to specific principals. Removing
someone from either list (and restarting serve) refuses their login tokens,
integration links and open sessions on the next request or within 30 s. Adding
them back restores the same credentials. Tokens minted with
`swamp access token create` are not subject to admission.

At startup, serve skips any `admins` or `allowed-users` username the provider
does not know and logs an ERROR for it. A name that resolved before keeps its
cached identity (with a WARN) rather than being dropped. It refuses to start if
no admin resolves, or if every allowed-user is unknown and no collectives are
set. A skipped name stays skipped across restarts and unrelated edits; to
re-check it, remove it from the list, restart, then add it back. Run
`swamp serve check-config` (with `--config <path>` or the same auth flags as
`swamp serve`) to check the names before deploying. It exits non-zero on any
unknown name.

```bash
# Token auth
swamp serve --auth-mode token --admins 'user:oauth|user-123'

# OAuth with collective-based admission
swamp serve --auth-mode oauth \
  --allowed-collectives platform-eng \
  --admins 'user:oauth|admin-456'
```

## Grant Model

Grants control what authenticated users can do. Default deny — no matching grant
means denied.

| Concept    | Format                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Subjects   | `user:<id>`, `group:<name>`, `idp-group:<name>`, `collective:<slug>`, `service:scheduler`, `service:webhook` |
| Effects    | `allow`, `deny` (deny wins)                                                                                  |
| Actions    | `run`, `read`, `write`, `approve`, `signal`, `tag`, `admin`                                                  |
| Resources  | `workflow:@acme/*`, `behavior:hello`, `data:*`, `vault:prod-*`, `access:*`                                   |
| Conditions | CEL expressions via `--when 'tags.env == "staging"'`, including `client` and, for `approve`, `run`           |

Admin on `access:*` implies all actions (superuser).

`behavior:<pattern>` and `model:<pattern>` are the same selector; grants are
stored as `model:`. Audit filters likewise accept `behavior.*` actions (e.g.
`swamp audit log --action behavior.method.run`) and `behavior:` resources, and
match the stored `model.*` / `model:` events. A `behaviour:` selector is
refused.

Scheduled runs act as `service:scheduler` and webhook runs as `service:webhook`
(recorded as the run's `initiatedBy`). Both may `run` any workflow unless a deny
grant matches, so restrict them with deny grants (e.g. `deny run` on
`workflow:deploy` for `service:webhook`). No token can be minted for them.

`approve` decides manual approval gates. By default a `run` grant also permits
`approve`, so any principal that can run a workflow can clear its gates. To stop
an automation principal granted `run` from clearing a gate meant for a person,
start serve with `--approve-requires-explicit-grant` (config
`auth.approve-requires-explicit-grant`): only grants that name `approve` then
count. A deny on `run` still denies `approve`. `swamp access can-i` marks
approvals that come from a `run` grant as `[implied by run]`.

`signal` delivers a signal to a `wait_for_signal` step and nothing else: a
principal with only `signal` cannot run, approve, resume, read or list. Grant it
alone to a callback system or to a person who answers waits without running the
workflow. A `run` grant also permits `signal` unless serve runs with
`--signal-requires-explicit-grant` (config
`auth.signal-requires-explicit-grant`). A deny on `run` still denies `signal`.

`tag` changes a behavior's or workflow's tags. A `model edit` or `workflow edit`
whose tags differ from the stored ones, or that renames, needs `tag` on the old
name and tags and on the new ones, as well as `write`. Data is judged on its
owner's current tags, so a principal who may retag can satisfy any
tag-conditioned `data:` grant. A `write` grant also permits `tag` unless serve
runs with `--tag-requires-explicit-grant` (config
`auth.tag-requires-explicit-grant`); a deny on `write` still denies `tag`. When
reads depend on a tag condition, turn the setting on and grant `tag` where tags
may change, or deny `tag` to those members. New resources are untagged, so a
team that labels its own uses a condition such as
`!("team" in tags) || tags.team == "team-a"`, which also lets it claim any
untagged resource.

## Signals Through Serve

```bash
# CLI, against a server
swamp workflow waits --server wss://...          # needs read on the workflow
swamp workflow waits --pending --server wss://...  # plus signals held for a key
swamp workflow signal <waitId> --payload '{"verdict":"ship"}' --server wss://...
# By key: no wait ID and no read grant needed, only signal on the workflow
swamp workflow signal --workflow <name> --key <key> --payload '{"verdict":"ship"}' --server wss://...

# HTTP, for a system with a token and a wait ID
curl -X POST https://<host>/api/v1/signal/<waitId> \
  -H "Authorization: Bearer <name>.<secret>" \
  -d '{"payload":{"verdict":"ship"}}'

# HTTP by key: the workflow and key go in the body, never the path
curl -X POST https://<host>/api/v1/signal \
  -H "Authorization: Bearer <name>.<secret>" \
  -d '{"workflow":"<name>","key":"<key>","payload":{"verdict":"ship"}}'

# A sender that retries adds a key: the retry gets the first receipt back
# with "duplicate": true, and nothing is delivered or held twice
curl -X POST https://<host>/api/v1/signal \
  -H "Authorization: Bearer <name>.<secret>" -H "Idempotency-Key: build-812" \
  -d '{"workflow":"<name>","key":"<key>","payload":{"verdict":"ship"}}'
```

### Acting over HTTP

`POST /api/v1/action` runs workflow actions for an integration: bearer token
only (a person's delegated `swda1.` access token, see Integrations), per-person
rate limit, one JSON reply with a stable `code` on failure.

```bash
curl -X POST https://<host>/api/v1/action \
  -H "Authorization: Bearer <name>.<secret>" -H "Content-Type: application/json" \
  -d '{"type":"workflow.run","payload":{"workflowIdOrName":"<name>","idempotencyKey":"button-812"}}'
# 202 {"data":{"runId":"...","replayed":false}}; a retry with the same key returns
# the same run with replayed true, and other inputs get idempotency_conflict

curl ... -d '{"type":"workflow.history.get","payload":{"runId":"<full id>"}}'
curl ... -d '{"type":"workflow.approvals"}'   # each row's suspendedAt names the attempt
curl ... -d '{"type":"workflow.approve","payload":{"workflowIdOrName":"<name>","runId":"<id>","stepName":"<gate>","suspendedAt":"<from the row>"}}'
```

A success is `{requestId, type, data}`, with the action's result in `data`; a
failure is `{code, message}`, plus `requestId` once the action was dispatched.
`workflow.reject`, `workflow.resume` (runId required, suspended runs only) and
`workflow.signal` work the same way. Fields not listed for a type are refused. A
repeated decision gets `already_decided`, a decision for an attempt since
re-opened `gate_reopened`, and a step name in several jobs `ambiguous_gate`
until `jobName` picks one (read the job from status). A paused run reads
`suspended` in status. An approved run continues with `--auto-resume`, or
`autoResume: true` when it has inputs, or a `workflow.resume`; the reply's
`autoResumed` says which. A repeated start is safe only on one node or a team
leader.

`swamp workflow run --server` prints the wait ID and the signal command with
`--server` when the run suspends on a wait, its own or a nested run's, and for a
keyed wait the by-key command too. A nested run's wait is named only to a caller
who may read that workflow, and so is the holder a `wait_key_held` failure
names. The dashboard's Approvals & Signals page lists open, signalled and
expired waits with their keys and by-key commands, and the pending signals held
for a key with the time left. A server older than `--pending` lists no pending
signals, and the command warns.

| HTTP status | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| 200         | Delivered; the body carries the receipt                        |
| 202, by key | Held for a wait not yet open (`status: pending`, `heldUntil`)  |
| 202, by key | `status: accepted`: receipt only, to a token without `read`    |
| 404         | No such wait, or the token may not signal it (same answer)     |
| 404, by key | Unknown workflow, undeclared key, or not allowed (same)        |
| 409, by key | `no_open_wait`; compare `lastWait.settledAt` with your attempt |
| 409, by key | `already_pending`: an earlier signal is held for the key       |
| 422         | Payload refused; `errors` lists why and the wait stays open    |
| 409         | Already settled                                                |
| 410         | Expired, or closed before a signal arrived                     |
| 401 / 429   | No valid token / rate limited (plain-text body)                |
| 400 / 413   | Body or `Idempotency-Key` malformed, or `waitId` by key / big  |
| 403 / 503   | `workflow.signal` is admin-only here / audit cannot record     |
| 501 / 500   | Datastore cannot hold waits / stored record unreadable         |

The reply names the workflow, run and step only for a caller who may also `read`
the workflow. The receipt's `submittedBy` is the token's principal. Once a run's
last wait is settled, serve resumes it by itself when the workflow's auto-resume
policy allows (see "Auto-Resume"); otherwise resume it with
`swamp workflow resume`. A 200 means the wait took the signal, not that the run
will use it: a cancel at the same moment still ends the run. More than 50
signals a minute from one address are answered 429; retry. A step's `key`
changed while its wait is open strands that wait for a key-only sender (old key
404, new key 409 with no `lastWait`); someone who may read the workflow signals
it by wait ID.

Upgrade every host on the datastore before creating a grant that names `signal`
or `tag`: an older build drops such a grant whole, with every other action in
it, so a deny on `write,tag` stops denying `write` there. Until every host is
upgraded, keep `signal` and `tag` in grants of their own.

## Webhook Route Files

A webhook route can come from a reviewed repo change instead of host config: one
YAML file per route in `webhook-routes/` (`--webhook-routes-dir` to move it),
with the same fields as a `webhooks[]` entry in `.swamp/serve.yaml`.

```yaml
# webhook-routes/github-push.yaml
route: /hooks/github-push
workflow: deploy
secret: "@vault=webhooks:github-push"
scheme: github
```

- The route must sit under `/hooks/`, with segments of letters, digits and
  `-._~` only; the secret must be `@vault=<vault>:<key>`.
- `swamp serve reload` makes a new or changed file live; deleting the file
  removes the route on the next reload.
- A bad file is refused on its own (named in the startup log or reload errors);
  two files claiming one route are both refused. A `serve.yaml` or `--webhook`
  route on the same path wins, and the file route is reported as shadowed.
- Run `swamp serve check-config` in CI on the PR to catch a bad file before it
  reaches serve. It does not look up vault keys or resolve extension schemes.
- Health and the dashboard show such a route with source `file` and its file
  name. Extensions never contribute routes.

## CLI Grant Management

```bash
# Create grants
swamp access grant create --subject user:alice --allow run --on workflow:@acme/*
swamp access grant create --subject group:ops --deny read --on data:@acme/secrets-*
swamp access grant create --subject idp-group:platform-eng \
  --allow run,read --on workflow:@acme/* --when 'tags.env == "staging"' \
  --server wss://swamp.example.com
swamp access grant create --subject collective:acme --allow read --on 'workflow:*'

# List and revoke
swamp access grant list [--server wss://...]
swamp access grant revoke <grant-id> [--server wss://...]

# Rebuild policy snapshot from grants and groups
swamp access reload [--server wss://...]
```

`swamp access policy` is an alias for `swamp access grant`.

## Integrations

An integration is an app an admin registers. A person's rights through it are
their grants intersected with its ceiling, which covers only `workflow:`
resources and allows only `run`, `read`, `approve` and `signal`. Actions match
literally, and `run` includes cancelling any run of that workflow.

```bash
# Prints the credential once; only its hash is kept
swamp access integration register slack-bot --name 'Slack bot' \
  --ceiling 'run,read,approve=workflow:@acme/deploy' [--server wss://...]
swamp access integration list [--server wss://...]
swamp access integration show slack-bot [--server wss://...]
swamp access integration ceiling slack-bot --ceiling 'read=workflow:@acme/*'
swamp access integration revoke slack-bot
```

Changes apply with no `swamp access reload`. Revoking is final, and the id can't
be used again. Upgrade every serve instance before registering one.
`--require-email-match` lets only the swamp-club account whose email the app
names approve a link.

An app acts as a person only after they link: the app calls
`POST /api/v1/delegations/links` with its credential as the bearer token, shows
the person swamp-club's consent URL, then redeems
`POST
/api/v1/delegations/redeem` for a 1-hour access token and a refresh token
(`/refresh` mints a new access token and keeps the refresh token, so racing
refreshes are harmless; swamp-lib's `SwampIntegrationClient`, `DelegatedTokens`
and `SwampActionClient` wrap these routes). Rights are the person's grants
within the integration's ceiling and what they consented to. A link lasts 30
days. Links need an oauth-mode serve registered with swamp-club, and every serve
node upgraded.

```bash
swamp access delegation list [--integration slack-bot] [--state issued]
swamp access delegation show <id>
swamp access delegation end <id>   # swamp-club is told by the leader
```

`swamp access check --client integration:<id>` judges a request against the
registered ceiling as well as the grants, so it reports a refusal for an id that
isn't registered.

## Declarative Grants

For production deployments, manage grants as YAML files in the `grants/`
directory at the repo root (alongside `models/`, `workflows/`, `vaults/`).

```yaml
# grants/platform-eng.yaml
grants:
  - subject: idp-group:platform-eng
    effect: allow
    actions: [run]
    resource: workflow:@acme/*
  - subject: idp-group:developers
    effect: deny
    actions: [read]
    resource: data:@acme/secrets-*
```

Each entry takes `subject` or a `subjects` list, and `resource` or a `resources`
list (up to 100 each); lists expand to one grant per subject and resource pair:

```yaml
grants:
  - subjects: [user:alice, user:bob]
    effect: allow
    actions: [read, run]
    resources: [workflow:*, behavior:*]
```

`user:<id>` is the principal id (the OAuth `sub`). In OAuth mode, name a user by
username with `username:<name>` (grant files only): serve resolves it once to
the `sub`, pins it, and stores a `user:<sub>` grant, so a renamed or
re-registered name never re-points the grant. A name that does not resolve
rejects the whole file; a name first seen missing stays rejected until removed
from every file. Other auth modes reject `username:`. A running serve looks up
new names only with a collective API key (`SWAMP_API_KEY`); otherwise restart
serve. See `design/enablers/access-control.md` "Usernames in grant files".

Apply with `swamp access reload --server wss://...`. Reload validates all files
first — rejects the entire reload if any file is invalid. The reconciler only
touches `source: file:*` grants; CLI-created grants are independent. Both
`.yaml` and `.yml` are accepted; flat directory only.

## Separation of Duties

Forbid self-approval with a deny, once per subject holding `run`, `approve` or
`admin`. An allow alone is not enough: `run` implies `approve`, and admins fall
back to allowed. There is no wildcard subject. `reject` is decided as `approve`.

```bash
swamp access grant create --subject idp-group:approvers --deny approve \
  --on 'workflow:@acme/*' --when 'principal.sub == run.initiator.sub'
```

`run` is available only on workflow grants with exactly the `approve` action. A
run with no usable initiator fails closed, so finish or cancel such runs first.
A service run has an empty `run.initiator.sub`, so people can approve it.

Refuse an integration with a condition on `client`, written `<kind>:<id>`:

```bash
swamp access grant create --subject group:ops --deny run \
  --on 'workflow:@acme/*' --when 'client == "integration:slack"'
```

- A token with no client reads as `direct:`.
- This refuses tokens issued to that integration, not the person, who can still
  use the CLI. A `direct:` id is not a boundary: a copied token keeps it.
- Client conditions never narrow a run. A vault deny on `client` stops direct
  requests; deny `run` on the workflow to keep an integration out of it.
- Upgrade every serve instance before writing these grants: an older one does
  not enforce the deny.

A condition whose types cannot evaluate is refused when written. A deny whose
condition errors at decision time refuses, and an allow does not match. That
includes reading a tag the resource lacks, so guard a deny meant only for tagged
resources: `"env" in tags && tags.env == "prod"`.

Check a condition locally, since a server reads the client from the caller's own
session:

```bash
swamp access check --subject user:alice --action run \
  --on 'workflow:@acme/deploy' --client integration:slack
```

Add `--field run.initiator.sub=alice` to check a condition on the run.
Self-approval's limits for member-driven runs are in
`design/enablers/access-control.md`.

## Vault Access

Grant vault access on `vault:<name>` (exact or trailing `*`). Conditions can use
`name` and `key` (the secret a request names).

```bash
swamp access grant create --subject group:ops --allow read --on 'vault:prod-*'
swamp access grant create --subject user:contractor --deny read,write --on vault:payroll
```

Grants on `data:vault` or `data:<vault name>` are the older form: they still
admit `vault.*` requests, but do not scope runs. Any deny on `data:vault`,
`data:<name>` or `vault:<name>` refuses every request on that vault — move
existing vault denies to `vault:<name>`.

**Upgrade first.** Write vault grants (and workflows with `vaults:`) only once
every serve replica runs a release that supports them. Older replicas refuse
grant files containing vault grants at startup, silently ignore stored vault
grants — denies included — and strip the run's persisted principal, so resumes
there fail closed.

### Run-time scoping

Vault grants also bound what serve runs can resolve, judged against the
principal that triggered the run (resumes keep that principal, not the
approver):

- No vault grant anywhere in the policy: runs resolve vaults as before.
- A deny-only vault grant blocks just that vault in the principal's runs.
- Any vault **allow** makes that principal default-deny for vaults on every
  action. A bot granted `read` on `vault:roomcontrol` reads `roomcontrol`, and
  its runs are refused `erp` (and every other vault, and every write). Grant
  every vault a principal needs in the same change.
- `data` grants play no part at run time. Reserved `_` vaults are refused to
  every serve run except principals with `admin` on `access:*`.
- `service:scheduler` / `service:webhook` grants scope every scheduled or
  webhook run server-wide; bound one workflow with its `vaults:` list instead.

Refusals fail the step before the method runs and are audited (category
`secrets`, outcome `denied`). `swamp access can-i --on vault:<name>` reports
both the request decision and whether that principal's runs are restricted.

**Sensitive outputs are vault writes.** A scoped principal needs `read` and
`write` on the vault its sensitive outputs land in (usually the default vault).
Keep author secrets out of it: make a dedicated outputs vault the default, or
set a spec `vaultName` / step `dataOutputOverrides`, and grant the bot
`read,write` on that vault.

**Not bounded:** a shell step running a nested `swamp` (reads the local repo
with the run's gate pass) or step code calling provider CLIs with the host's
credentials. Isolate those with a separate orchestrator or separate provider
credentials.

## Groups

```bash
swamp access group create <name>
swamp access group add-member <group> <principal>
swamp access group remove-member <group> <principal>
```

## IdP Group-Based Access Control

IdP groups are group memberships from your identity provider (e.g. Okta) that
flow through swamp-club's SSO integration. They let you write grants against
your existing org structure — no manual group management needed.

### How groups flow

1. User runs `swamp auth server-login` and completes the OAuth device flow
2. swamp-club authenticates the user via SSO and captures their IdP group
   memberships
3. `swamp serve` calls the swamp-club userinfo endpoint and reads the `groups`
   field from the response
4. Groups are stored on the server token and attached to every WebSocket
   connection for that user
5. Grants with `idp-group:<group>` subjects match against these stored groups

### Collectives vs groups

Swamp serve reads two membership lists from swamp-club, for different jobs:

| Concept         | Admission (who can connect) | Grant subject       |
| --------------- | --------------------------- | ------------------- |
| **Collectives** | `--allowed-collectives`     | `collective:<slug>` |
| **Groups**      | _(not used for admission)_  | `idp-group:<name>`  |

Collectives come from the userinfo field specified by `--groups-field` (default:
`collectives`): the swamp-club collectives the user belongs to. A
`collective:<slug>` grant matches every member of that collective, with or
without SSO. The slug is matched exactly, so write it as `swamp auth whoami`
lists it. Admission grants nothing on its own: a member admitted by
`--allowed-collectives` is denied everything until a grant covers them. To give
every member of a collective read access:

```yaml
# grants/acme-team.yaml
grants:
  - subject: collective:acme
    effect: allow
    actions: [read]
    resources: [workflow:*, behavior:*, data:*]
```

Groups come from the `groups` field in the userinfo response, which holds the
IdP groups swamp-club captures through SSO. Without SSO it is empty, and
`idp-group:` grants match nobody. The two lists never stand in for each other:
an `idp-group:<collective-slug>` grant does not match a collective's members,
and a `collective:<name>` grant does not match an IdP group of that name.

A collective cannot be an `--admins` entry; name the admins as users or a local
group. Upgrade every host on the datastore before creating a `collective:`
grant: an older build cannot read the subject and leaves the grant out, so a
`collective:` deny is not enforced on that host until it is upgraded.

### Background refresh

The server periodically re-fetches userinfo for all active tokens to keep group
memberships current. Users don't need to re-login when their groups change.

```bash
swamp serve --auth-mode oauth \
  --group-refresh-interval 2h \
  --allowed-collectives platform-eng
```

| Flag / env var                 | Default | Description                 |
| ------------------------------ | ------- | --------------------------- |
| `--group-refresh-interval`     | `4h`    | How often to refresh groups |
| `SWAMP_GROUP_REFRESH_INTERVAL` | `4h`    | Env var equivalent          |

Set to `0` to disable refresh. Refresh only runs in `--auth-mode oauth` with a
client secret configured.

### What happens on group removal

When a user is removed from an IdP group, the next refresh cycle detects the
change and updates the server token. Grants matching that group stop applying —
no re-login needed. The change takes effect within the refresh interval (default
4 hours).

### What happens on deprovisioning

When a user is fully deprovisioned from the IdP (account disabled or deleted),
the userinfo endpoint returns a 401. The server:

1. **Revokes the server token** — no new connections can authenticate with it
2. **Closes all active WebSocket connections** for that user (close code `4003`,
   reason `"Session revoked: access removed"`)

This happens on the next refresh cycle. Transient errors (network timeouts,
server errors) do not trigger revocation — existing groups are preserved until
the next successful refresh.

### SSO setup

SSO is configured in your swamp-club organization settings. The IdP group
attribute must be mapped so that group memberships appear in the userinfo
response. See your IdP's documentation for attribute mapping (e.g. Okta group
attribute statements).

## Access Checking

```bash
# Admin explain mode — see why a subject is allowed or denied
swamp access check --subject user:alice --action run --on workflow:@acme/deploy

# Deny by type: `--on behavior:<type>` matches behaviors of that type under any name
swamp access grant create --subject user:alice --deny write --on behavior:command/shell
swamp access check --subject user:alice --action write --on behavior:team-x-probe  # DENY if team-x-probe is command/shell

# User self-service — check your own permissions
swamp access can-i --action run --on workflow:@acme/deploy --server wss://...
```

A local `access check` resolves a concrete behavior, data or workflow name from
the repo (its stored type and tags), as serve does. `--field key=value`
overrides a resolved field to simulate a resource or tag that does not exist
yet. Settings a server is started with, such as `--restricted-model-types`, are
only reflected with `--server`.

## Token Management

Swamp has two token families — picking the wrong one is a common mistake.

| &nbsp;        | Collective API token                                    | Server access token                 |
| ------------- | ------------------------------------------------------- | ----------------------------------- |
| **Mint with** | `swamp auth token create`                               | `swamp access token mint`           |
| **Format**    | `swamp_org_<hex>`                                       | `<name>.<secret>`                   |
| **Env var**   | `SWAMP_API_KEY` (or `SWAMP_API_KEY_FILE`)               | `SWAMP_SERVER_TOKEN`                |
| **Scopes**    | `serve:*`, `oauth:manage`, …                            | principal-based (no scopes)         |
| **Used by**   | `swamp serve` → swamp-club (features, OAuth client reg) | Clients → a specific serve instance |

A collective token holding `tokens:mint` can create expiring tokens for its own
collective with `swamp auth token create --ttl 30d` (swamp-club caps the expiry
at 90 days), and revoke the tokens it minted with `swamp auth token revoke`.
`revoke` disables a token and keeps it listed; `swamp auth token delete` removes
it and needs a personal login.

To keep the collective API token out of the process env, put it in a file and
pass `swamp serve --club-api-key-file <path>` (also accepted by
`serve check-config` and forwarded by `serve daemon enable`) or set
`SWAMP_API_KEY_FILE=<path>`. Precedence is `--club-api-key-file`, then
`SWAMP_API_KEY_FILE`, then `SWAMP_API_KEY`; setting both env vars is an error.
Serve reads the key at startup for OAuth registration, username lookup and the
club heartbeat, so restart it after rotating the key; other lookups re-read the
file.

Every swamp process, serve and worker included, needs a swamp-club credential to
start. A daemon enabled with `serve daemon enable` or `worker daemon enable`
reads the enabling user's `auth login` credential and cached proof through
`SWAMP_CONFIG_DIR`. Container or CI deployments without that config dir set
`SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN` (the signin token lets the process
start while swamp-club is unreachable).

`SWAMP_SERVER_TOKEN` requires `SWAMP_SERVER_URL` (or `SWAMP_SERVE_URL`) to scope
which server the token applies to. Without a server URL, the token is silently
ignored and the client falls back to stored credentials in
`~/.config/swamp/servers.json`. Precedence for the server URL: `--server` flag >
`SWAMP_SERVE_URL` > `SWAMP_SERVER_URL` > `serverAddress` in `.swamp.yaml`.

If you set `SWAMP_API_KEY` where `SWAMP_SERVER_TOKEN` is expected, serve rejects
every connection with:

```
WebSocket auth rejected … "Invalid token format: expected <name>.<secret>"
```

### Server access token commands

```bash
swamp access token mint <name> --principal user:<id>   # secret stored in control-plane vault
swamp access token reveal <name> --yes                 # retrieve the full credential
swamp access token list
swamp access token revoke <name>
swamp access token rotate <name>                       # revoke + mint replacement
```

Revoking, rotating or expiring a token also ends WebSocket sessions already open
with it, as does a token record being deleted or becoming unreadable. This is
immediate on the instance that ran the revoke or rotate over its WebSocket.
Otherwise a periodic re-check ends them within about 30s of the instance seeing
the change. A revoke run from the CLI straight against the repo, with no serve
instance involved, is seen at once. An HA peer first pulls the change from the
datastore (`--datastore-poll-interval`, default 30s), so allow up to about a
minute there. The socket closes with code `4003` and a reason naming the cause,
or `4002` on expiry. A CLI run cut off with `4003` stops and prints the reason
rather than reconnecting. On `4002` it tries one reconnect, since the same code
ends a session at the 8-hour cap, where reconnecting works; if the token has
expired that reconnect is refused and the CLI reports the expiry reason.
Rotation keeps sessions opened with the new credential. The SSE health stream
(`/api/v1/health/stream`, readable with any valid token, which sees only the
runs, schedules and webhooks it may read; at most 10 open per token) ends the
same way, with a final `session-ended` event carrying the code and reason. With
audit enabled, each closed session records an `auth.session.terminated` event
whose `detail` is the cause: `revoked`, `rotated`, `expired`, `deleted` or
`invalid` (filter with `swamp audit log --action auth.session.terminated`).

A running serve deletes revoked tokens at its next token GC sweep. It deletes
expired tokens once a grace period has passed. Deleted tokens drop out of
`access token list`. The sweep runs every `--token-gc-interval` (default `1h`;
`0` disables it), and the grace period is `--token-gc-grace-period` (default
`1h`; `0` deletes at expiry). In `serve.yaml`, quote duration values such as `0`
(`token-gc-interval: "0"`): YAML reads an unquoted `0` as a number, which serve
rejects. A sweep collects at most 100 tokens, so a large backlog, such as the
first sweep after an upgrade, drains over several sweeps.

### Wiring a token into an external secret store

Use `reveal` to pipe the plaintext directly into a secret store without it
touching a terminal:

```bash
swamp access token reveal <name> --repo-dir /repo -y --json \
  | jq -re .token \
  | <store-command>   # e.g. kubectl create secret generic …
```

To deliver a credential to a shared Swamp vault, first mint or rotate the token.
Then, on the serve host, use `vault put` as the `reveal` pipeline's target. This
keeps the full credential out of terminal output:

```bash
swamp access token reveal <name> --repo-dir /repo -y --json \
  | jq -re .token \
  | swamp vault put <vault> server-token-<name> --yes
```

`reveal --json` outputs `{ "name": "…", "token": "…", "expired": false }`. The
pipeline stores the credential under `server-token-<name>` in the destination
vault. It is a copy: the token secret remains in its control-plane vault.

### Minting for a remote serve

`swamp access token mint` stores the token secret in the `_token-secrets`
control-plane vault, never in a user-configured vault. If the control-plane
vault cannot initialize (for example, expired or wrong datastore credentials),
`access token mint`, `rotate` and `reveal`, and `worker token create`, fail with
that underlying error. Fix the datastore access and rerun; do not create a vault
named `_token-secrets`.

By default the key that encrypts `_token-secrets` is stored in the datastore
beside the secrets, so datastore read access can decrypt every token. To keep
the key elsewhere, generate one yourself (`openssl rand -base64 32`), store it
in a user vault whose storage is outside the datastore, and name it in
`serve.yaml`:

```yaml
token-secrets:
  vault: prod-secrets
  key: swamp-token-secrets-key
```

Check it with `swamp serve check-config` (it checks the key is usable, not that
it matches a control plane already moved to another key). Then restart all serve
instances together: the first start re-encrypts the existing secrets and removes
the stored key. Local token commands refuse to run until serve has done this,
and afterwards refuse without the block or with a different key. Put the same
block in `.swamp/serve.yaml` on every host that runs the token commands locally,
and rotate tokens minted before the change: older datastore backups still hold
the old key.

To mint for a running serve, go through it with `--server` (admin only):

```bash
swamp access token mint <name> --principal user:<id> --server wss://swamp.example.com
```

The serve accepts the token at once — no restart. Prefer this over minting in a
separate process on the serve host (e.g. `kubectl exec`): with a remote
datastore, a running serve does not pull out-of-process token definitions, so
the token fails until serve restarts.

The mint output does not include the credential. Reveal it through the same
serve (admin only; answered by the leader and audited):

```bash
swamp access token reveal <name> --yes --server wss://swamp.example.com
```

A login token (`oauth-…`, minted by an OAuth or device login) is not revealable
through serve, even by an admin (`token_not_revealable`); revoke it instead.

`swamp worker token create <name> --duration <d> --server <url>` also stores the
secret in `_token-secrets` unless `--vault <name>` names another vault on the
server.

## OAuth Login

```bash
# Device grant flow via swamp-club
swamp auth server-login --server wss://swamp.example.com
```

## Remote-Only Mode

Disable local (loopback) execution so every user step must be dispatched to a
remote worker. Steps without placement (`target`, `labels`, or `platform`) fail
immediately instead of running on the orchestrator.

| Flag / env var      | Default | Description                         |
| ------------------- | ------- | ----------------------------------- |
| `--remote-only`     | `false` | Require placement on all user steps |
| `SWAMP_REMOTE_ONLY` | `false` | Env var equivalent                  |

Also settable as `remote-only: true` in the serve config YAML. See the
[remote-execution guide](../workflow/references/remote-execution.md#remote-only-mode)
for the error message, the fix, and the control-plane exemption.

## Auto-Resume

Serve resumes a suspended run by itself once every approval gate on it is
decided and every `wait_for_signal` step on it has an outcome.

| Flag / env var                  | Default | Description                                          |
| ------------------------------- | ------- | ---------------------------------------------------- |
| `--auto-resume`                 | `false` | Auto-resume workflows that declare no inputs         |
| `SWAMP_AUTO_RESUME`             | `false` | Env var equivalent (serve.yaml: `auto-resume: true`) |
| `--continuation-sweep-interval` | `30s`   | How often serve looks for runs to resume; `0` = off  |
| `--max-signal-wait-timeout`     | `1y`    | Longest `wait_for_signal` timeout this server allows |

A workflow's own `autoResume: true | false` always wins. A workflow that
declares inputs is never covered by the server flag and must set
`autoResume: true` itself, since it may need resume-time `--input`. The approve
response reports `autoResumed: true` when serve resumed the run. When a nested
workflow's run finishes through serve, serve also resumes the parent waiting on
it, under the parent's own policy, if the approver may approve the parent.
Cancelling or rejecting a parent through serve cancels its suspended nested runs
under the caller's grant on the parent; the reply names them only to a caller
who may read their workflow.

The instance that takes the approval or signal that settles a run resumes it at
once. A sweep at boot and every `--continuation-sweep-interval` (env
`SWAMP_CONTINUATION_SWEEP_INTERVAL`) retries a launch that was lost and picks up
runs signalled by a local command. Things to know:

- A local `workflow approve` is picked up by the sweep on a filesystem
  datastore. On S3 or GCS serve does not see it until it restarts: approve with
  `--server`, or resume manually.
- A run with both gates and signal waits is resumed by the sweep, not at once,
  when an approval is what settles it.
- A `signal` or `approve` grant releases the rest of the run. Nothing else is
  authorized at the resume, and no inputs can be supplied.
- A run with a wait still open is not resumed. A wait past its deadline is
  settled as timed out by the sweep and the run resumed, so the step fails with
  `wait_timeout` and its `failed` dependents run with no client action. This
  follows the auto-resume policy, needs the sweep to be running, and reads the
  server's own clock: keep serve hosts' clocks in sync. An approval gate past
  its timeout is not failed this way.
- `--max-signal-wait-timeout` (env `SWAMP_MAX_SIGNAL_WAIT_TIMEOUT`, e.g. `7d`)
  fails a step that asks for a longer wait when it would start waiting. Local
  runs and `workflow validate` do not apply it; waits already open keep their
  deadline.
- A parent waiting on a nested run is not resumed either, except right after its
  child was continued by a caller who may `signal` (or `approve`) the parent. A
  parent whose child the sweep continued, or timed out, stays suspended; serve
  logs the `swamp workflow resume` command for it.
- A run reset by `swamp workflow recover` is never resumed by serve, with no
  event: run `swamp workflow resume` as recover says. A run recovered before the
  upgrade is not protected this way.
- A run that cannot be resumed stays suspended; the audit log has one
  `workflow.auto_resume_skipped` or `workflow.auto_resume_failed` event with the
  reason (`global_cap`, ...). A run whose auto-resume policy is off is left
  alone with no event. A resume that starts and fails is retried with a backoff
  from 30s up to 15m; fix the cause and run `swamp workflow resume` to skip the
  wait. `held_by_local_command` means a local `workflow resume` died before it
  started the run: resume it manually.
- Several serve instances on one datastore resume a run once. On S3 or GCS,
  upgrade every host before relying on the sweep, and expect a run whose
  instance died to wait until an instance restarts.
- On a synced datastore serve resumes a run by itself only if its copy of the
  run record matches the remote one, so a run a peer cancelled is not resumed
  from an old copy. A datastore extension without `fetchContent`
  (`@swamp/s3-datastore` and `@swamp/gcs-datastore` before `2026.10.07.1`)
  cannot be compared: the sweep then runs once at boot (serve logs this), and a
  lost launch or a locally signalled run waits for a restart or a manual resume.
  `run_record_unreadable` in the audit log means the remote could not be read.
- `swamp workflow resume` is refused while a live serve instance is resuming the
  same run. Treat that as already handled. On a filesystem datastore the refusal
  is `is not suspended` instead.
- The first boot after upgrading resumes runs that were already settled and left
  suspended. Set `autoResume: false` on a workflow to keep its runs manual.

## When to Use What

| Scenario                           | Approach                  |
| ---------------------------------- | ------------------------- |
| A few grants for a small team      | CLI commands              |
| Policy for a production deployment | `grants/` directory files |
| Team on swamp-club                 | `--auth-mode oauth`       |
| Air-gapped or no swamp-club        | `--auth-mode token`       |
| Limit which vaults a bot can read  | `allow read vault:<name>` |
