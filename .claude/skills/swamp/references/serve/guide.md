# Swamp Serve & Access Control

Expose a swamp repo over the network with authentication, authorization, and
grant-based access control.

## Auth Modes

| Mode    | Flag                | Use case                                       |
| ------- | ------------------- | ---------------------------------------------- |
| `none`  | `--auth-mode none`  | Loopback only, no auth (deprecated)            |
| `token` | `--auth-mode token` | Manual token minting, no swamp-club dependency |
| `oauth` | `--auth-mode oauth` | Users authenticate via swamp-club              |

OAuth mode requires `--allowed-collectives` or `--allowed-users` to control
admission. Use `--admins` to grant admin access to specific principals.

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

| Concept    | Format                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| Subjects   | `user:<id>`, `group:<name>`, `idp-group:<collective>`, `service:scheduler`, `service:webhook` |
| Effects    | `allow`, `deny` (deny wins)                                                                   |
| Actions    | `run`, `read`, `write`, `approve`, `signal`, `admin`                                          |
| Resources  | `workflow:@acme/*`, `model:hello`, `data:*`, `vault:prod-*`, `access:*`                       |
| Conditions | CEL expressions via `--when 'tags.env == "staging"'`                                          |

Admin on `access:*` implies all actions (superuser).

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

## Signals Through Serve

```bash
# CLI, against a server
swamp workflow waits --server wss://...          # needs read on the workflow
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
```

`swamp workflow run --server` prints the wait ID and the signal command with
`--server` when the run suspends on a wait, its own or a nested run's. A nested
run's wait is named only to a caller who may read that workflow. The dashboard's
Approvals page lists open, signalled and expired waits.

| HTTP status | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| 200         | Delivered; the body carries the receipt                        |
| 404         | No such wait, or the token may not signal it (same answer)     |
| 404, by key | Unknown workflow, undeclared key, or not allowed (same)        |
| 409, by key | `no_open_wait`; compare `lastWait.settledAt` with your attempt |
| 422         | Payload refused; `errors` lists why and the wait stays open    |
| 409         | Already settled                                                |
| 410         | Expired, or closed before a signal arrived                     |
| 401 / 429   | No valid token / rate limited (plain-text body)                |
| 400 / 413   | Body malformed, or by key carries a `waitId` / too large       |
| 403 / 503   | `workflow.signal` is admin-only here / audit cannot record     |
| 501 / 500   | Datastore cannot hold waits / stored record unreadable         |

The reply names the workflow, run and step only for a caller who may also `read`
the workflow. The receipt's `submittedBy` is the token's principal. Once a run's
last wait is settled, serve resumes it by itself when the workflow's auto-resume
policy allows (see "Auto-Resume"); otherwise resume it with
`swamp workflow resume`. A 200 means the wait took the signal, not that the run
will use it: a cancel at the same moment still ends the run. Many signals at
once on one token can be answered 429; retry. A step's `key` changed while its
wait is open strands that wait for a key-only sender (old key 404, new key 409
with no `lastWait`); someone who may read the workflow signals it by wait ID.

Upgrade every host on the datastore before creating a grant that names `signal`:
an older build drops such a grant whole, including a deny.

## CLI Grant Management

```bash
# Create grants
swamp access grant create --subject user:alice --allow run --on workflow:@acme/*
swamp access grant create --subject group:ops --deny read --on data:@acme/secrets-*
swamp access grant create --subject idp-group:platform-eng \
  --allow run,read --on workflow:@acme/* --when 'tags.env == "staging"' \
  --server wss://swamp.example.com

# List and revoke
swamp access grant list [--server wss://...]
swamp access grant revoke <grant-id> [--server wss://...]

# Rebuild policy snapshot from grants and groups
swamp access reload [--server wss://...]
```

`swamp access policy` is an alias for `swamp access grant`.

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
    resources: [workflow:*, model:*]
```

Apply with `swamp access reload --server wss://...`. Reload validates all files
first — rejects the entire reload if any file is invalid. The reconciler only
touches `source: file:*` grants; CLI-created grants are independent. Both
`.yaml` and `.yml` are accepted; flat directory only.

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

Swamp serve distinguishes two types of IdP membership:

| Concept         | Purpose                                  | Flag                    |
| --------------- | ---------------------------------------- | ----------------------- |
| **Collectives** | Admission gate — who can connect         | `--allowed-collectives` |
| **Groups**      | Grant matching via `idp-group:` subjects | _(no flag — always on)_ |

Collectives come from the userinfo field specified by `--groups-field` (default:
`collectives`). Groups come from the `groups` field in the userinfo response. If
your IdP doesn't populate a separate `groups` field, groups fall back to the
collectives list — so collectives serve both admission and grant matching.

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

# User self-service — check your own permissions
swamp access can-i --action run --on workflow:@acme/deploy --server wss://...
```

## Token Management

Swamp has two token families — picking the wrong one is a common mistake.

| &nbsp;        | Collective API token                                    | Server access token                 |
| ------------- | ------------------------------------------------------- | ----------------------------------- |
| **Mint with** | `swamp auth token create`                               | `swamp access token mint`           |
| **Format**    | `swamp_org_<hex>`                                       | `<name>.<secret>`                   |
| **Env var**   | `SWAMP_API_KEY` (or `SWAMP_API_KEY_FILE`)               | `SWAMP_SERVER_TOKEN`                |
| **Scopes**    | `serve:*`, `oauth:manage`, …                            | principal-based (no scopes)         |
| **Used by**   | `swamp serve` → swamp-club (features, OAuth client reg) | Clients → a specific serve instance |

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
`1h`).

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

The mint output does not include the credential, and `reveal` has no `--server`.
Run `swamp access token reveal <name> --yes` where the serve's repo or datastore
is reachable.

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
