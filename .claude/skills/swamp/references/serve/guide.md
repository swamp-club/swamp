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

## Access Checking

```bash
# Admin explain mode — see why a subject is allowed or denied
swamp access check --subject user:alice --action run --on workflow:@acme/deploy

# User self-service — check your own permissions
swamp access can-i --action run --on workflow:@acme/deploy --server wss://...
```

## Token Management

```bash
swamp access token mint <name> --principal user:<id>   # plaintext shown once
swamp access token list
swamp access token revoke <name>
swamp access token rotate <name>                       # revoke + mint replacement
```

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
