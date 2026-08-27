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

| Concept    | Format                                                  |
| ---------- | ------------------------------------------------------- |
| Subjects   | `user:<id>`, `group:<name>`, `idp-group:<collective>`   |
| Effects    | `allow`, `deny` (deny wins)                             |
| Actions    | `run`, `read`, `write`, `admin`                         |
| Resources  | `workflow:@acme/*`, `model:hello`, `data:*`, `access:*` |
| Conditions | CEL expressions via `--when 'tags.env == "staging"'`    |

Admin on `access:*` implies all actions (superuser).

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

Apply with `swamp access reload --server wss://...`. Reload validates all files
first — rejects the entire reload if any file is invalid. The reconciler only
touches `source: file:*` grants; CLI-created grants are independent. Both
`.yaml` and `.yml` are accepted; flat directory only.

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
   reason `"Session revoked"`)

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
| **Env var**   | `SWAMP_API_KEY`                                         | `SWAMP_SERVER_TOKEN`                |
| **Scopes**    | `serve:*`, `oauth:manage`, …                            | principal-based (no scopes)         |
| **Used by**   | `swamp serve` → swamp-club (features, OAuth client reg) | Clients → a specific serve instance |

If you set `SWAMP_API_KEY` where `SWAMP_SERVER_TOKEN` is expected, serve rejects
every connection with:

```
WebSocket auth rejected … "Invalid token format: expected <name>.<secret>"
```

### Server access token commands

```bash
swamp access token mint <name> --principal user:<id>   # plaintext stored in vault
swamp access token list
swamp access token revoke <name>
swamp access token rotate <name>                       # revoke + mint replacement
swamp access token rotate <name> --vault <vault>       # rotate into a different vault
```

### Wiring a token into an external secret store

Use `reveal` to pipe the plaintext directly into a secret store without it
touching a terminal:

```bash
swamp access token reveal <name> --repo-dir /repo -y --json \
  | jq -re .token \
  | <store-command>   # e.g. kubectl create secret generic …
```

`reveal --json` outputs `{ "name": "…", "token": "…", "expired": false }`.

### Minting for a remote serve

`swamp access token mint` runs against a local repo and vault. For headless
deployments targeting a remote serve, mint inside the serve process's own
environment — e.g. via `kubectl exec` — not on the operator's laptop.

## OAuth Login

```bash
# Device grant flow via swamp-club
swamp auth server-login --server wss://swamp.example.com
```

## When to Use What

| Scenario                           | Approach                  |
| ---------------------------------- | ------------------------- |
| A few grants for a small team      | CLI commands              |
| Policy for a production deployment | `grants/` directory files |
| Team on swamp-club                 | `--auth-mode oauth`       |
| Air-gapped or no swamp-club        | `--auth-mode token`       |
