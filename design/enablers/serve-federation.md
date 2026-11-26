---
audience: maintainer, operator
enables: [serve]
last-verified: 2026-11-26 @ 8e48b97d7
---

# Serve Federation

Serve Federation joins swamp serves to a hub. The hub records what each member
reports about itself. It is being built in five units behind an experimental
gate. This doc describes slice 1. Unit 1 (the gate, `serve.yaml` version 2 and
the fingerprint) is in the code. The rest is the design the later units build.

## Goal of slice 1

1. A serve can act as a **hub**.
2. Other serves can join that hub as **members**.
3. The hub can see each member's fingerprint and status.
4. A dashboard app installed on the hub shows the connected serves.

Slice 1 only lets the hub see its members. The hub never changes anything on a
member.

Not in slice 1: releases, profiles, rings, config changes, swamp upgrades, grant
bundles, worker management, quarantine, conformance scoring, release signing,
running jobs on members, and a hub of hubs.

## Language

| Term              | Meaning                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Federation        | The feature: serves joined to a hub. Never "fleet".                                             |
| Hub               | A serve with `federation.role: hub`. It accepts members and records what they report.           |
| Member            | A serve with `federation.hub: <url>`. It joins exactly one hub and checks in on a timer.        |
| Join token        | A one-time, time-limited secret minted on the hub. It lets one serve join as a named member.    |
| Member credential | A random secret the hub issues on join. The member presents it on every check-in.               |
| Check-in          | A member's periodic outbound HTTPS call to the hub, carrying its fingerprint.                   |
| Fingerprint       | The fixed, allowlisted set of facts a serve reports about itself.                               |
| Instance          | One serve process of a member. A team-mode member has several.                                  |
| Member status     | `online`, `stale` or `offline`, derived by the hub from check-in times. `removed` is terminal. |

## Invariants

1. **Gate off means no change.** With `SWAMP_EXPERIMENTAL_FEDERATION` not set to
   exactly `1`, swamp behaves as it did before slice 1. Commands, help schema,
   config parsing and warnings, registered types, routes and JSON output are
   all the same.
2. **Version 1 forever.** A `serve.yaml` with no `version` key, or `version: 1`,
   parses exactly as before, gate on or off.
3. Members pull. The hub never connects out.
4. The hub changes nothing on a member in slice 1.
5. A serve is a hub, a member, or neither. There is no hub of hubs.
6. A member joins one hub. Changing hubs means removing the member first.
7. **Fingerprints are allowlisted.** No hostnames, IPs, ports, paths, usernames,
   grants, secrets or hashes of secrets leave a serve.
8. Members own their data. Nothing a member stores is sent to the hub.
9. The hub stores only hashes of join tokens and credentials. A member keeps its
   credential in its encrypted control-plane vault.

## The experimental gate

`SWAMP_EXPERIMENTAL_FEDERATION=1` turns the feature on. Any other value, or no
value, leaves it off. One pure function, `isServeFederationEnabled`, decides
this from an env lookup. No other code reads the variable.

With the gate off:

- the federation `swamp serve` subcommands are not registered;
- `serve.yaml` is parsed by the version 1 path, so `version` and `federation`
  are unknown keys that are warned about and ignored;
- `federation` never appears in a reload report;
- `swamp serve check-config` output is unchanged.

The gate fitness test keeps one list of federation surfaces and asserts that
none is reachable with the gate off. Each unit adds the surfaces it builds.
The last unit removes the gate and the test together.
`src/domain/serve/federation_gate.ts`,
`integration/serve_federation_gate_rules_test.ts`.

## Configuration: `serve.yaml` version 2

- **No `version`, or `version: 1`:** the version 1 parser, gate on or off. In
  such a file `version` and `federation` stay unknown-key warnings and are
  ignored, never refused.
- **`version: 2`, gate on:** every version 1 key keeps its name and meaning. An
  unknown key in any mapping whose keys `serve.yaml` defines is an error naming
  the full key path. That covers the top level, `auth`, `tls`, `token-secrets`,
  `audit`, `audit.hmac`, `audit.sinks[i]`, `triggers.<workflow>` and
  `webhooks[i]`. Free-form maps stay open: `triggers.<workflow>.inputs`,
  `webhooks[i].config`, and audit store and sink `config`.
- **A higher integer version** is refused with "serve.yaml version N needs a
  newer swamp". A value that is not a positive integer is refused naming
  `version`. YAML reads `2.0` as the integer 2.

The shared validators for webhook entries and trigger overrides keep their
version 1 behaviour for their other callers. Only the version 2 loader asks for
strictness.

```yaml
# a hub
version: 2
federation:
  role: hub

# a member
version: 2
federation:
  hub: <hub-url>
  join-token-file: <path>
```

The `federation` block must be a mapping with exactly one of `role: hub` or
`hub: <url>`. `role` accepts only `hub`. A hub may not set `join-token-file`.
`join-token-file` is a path resolved against the repository. Any other key is
an error.

The hub URL must be `https:`, or `http:` only to a loopback host. Loopback means
exactly `localhost`, `127.0.0.0/8` and `[::1]`, compared on the parsed hostname.
`127.0.0.1.example.com` is not loopback. Credentials in the URL, query strings
and fragments are refused, and the error never echoes the URL. A path prefix is
allowed and is stored without a trailing slash.

Anything that writes `serve.yaml` back keeps `version` and `federation`.
`federation` is a restart-only entry in the reload catalogue. It is a merged
option only with the gate on and a version 2 file. `swamp serve check-config`
reports the config version with the gate on. `src/serve/serve_config.ts`,
`src/serve/serve_settings_reload.ts`.

## Domain model

| Building block          | Kind               | Where                                             | Unit |
| ----------------------- | ------------------ | ------------------------------------------------- | ---- |
| `Fingerprint`           | Value object       | domain                                            | 1    |
| `FingerprintCollector`  | Domain service     | domain, with ports                                | 1    |
| `JoinToken`             | Entity             | `swamp/serve-join-token` built-in behavior on hub | 2    |
| `ServeMember`           | Aggregate root     | `swamp/serve-member` built-in behavior on hub     | 2    |
| `Instance`              | Entity in member   | inside `ServeMember`                              | 2    |
| `HubLink`               | Entity             | member, control-plane vault                       | 3    |
| `MemberCheckInService`  | Application service | member                                           | 3    |
| `MemberStatusSweeper`   | Application service | hub                                              | 2    |

`Fingerprint` can be created only through `Fingerprint.create()`, which refuses
a missing field or any field outside the contract. `FingerprintCollector` builds
one from ports for build info, merged settings, deployment classification,
vault types, extensions and worker records. The domain never reads YAML, the
lockfile or the datastore itself. `src/domain/serve/fingerprint.ts`,
`src/domain/serve/fingerprint_collector.ts`.

A `JoinToken` is named, single use and time limited. Its states are `unused`,
`used`, `expired` and `revoked`. It is a separate type from worker enrollment
tokens, so a join token can never admit a worker. Only its hash is stored.

A `ServeMember` holds the member's name, current fingerprint, status,
credential hash and instances. A member record gets a new data version only
when its fingerprint hash, its pool summary or its status changes. Its versions
are its history and can be queried with `data.query`. Runtime fields never
create a version. Check-in times go to the control-plane store under
`federation/seen/<memberId>/<instanceId>`, never to data.

## Fingerprint contract

Only these fields. Adding one is an architecture decision.

| Field              | Type                                                    | Source                                 | Class   |
| ------------------ | ------------------------------------------------------- | -------------------------------------- | ------- |
| `swampVersion`     | string                                                  | build info                             | static  |
| `platform`, `arch` | string                                                  | runtime                                | static  |
| `serveYamlVersion` | 1 or 2                                                  | config                                 | static  |
| `deploymentMode`   | `local`, `durable` or `durable (limited)`               | the classification serve uses at start | static  |
| `datastoreKind`    | `filesystem` or the datastore type name                 | config                                 | static  |
| `datastoreFormat`  | `v2` or `v3`                                            | config                                 | static  |
| `vaultKinds`       | list of vault type names                                | vault configs                          | static  |
| `authMode`         | `none`, `token` or `oauth`                              | merged settings                        | static  |
| `tls`              | boolean                                                 | merged settings                        | static  |
| `remoteOnly`       | boolean                                                 | merged settings                        | static  |
| `loopbackOnly`     | boolean                                                 | merged `host`                          | static  |
| `federationRole`   | `hub`, `member` or `none`                               | config                                 | static  |
| `extensions`       | list of `{ name, version }`                             | extension lockfile                     | static  |
| `settingsHash`     | sha256 hex                                              | allowlisted merged settings            | static  |
| `workers`          | `{ total, byVersion, byLabelKey }`                      | every `swamp/worker` record            | pool    |
| `team`             | `{ role: leader, follower or single, nodes }`           | running serve                          | runtime |
| `startedAt`        | ISO time                                                | running serve                          | runtime |
| `ready`            | boolean                                                 | running serve                          | runtime |

| Class   | In `hash()` | A change on the hub          |
| ------- | ----------- | ---------------------------- |
| static  | yes         | a new member record version  |
| pool    | no          | a new member record version  |
| runtime | no          | nothing in data              |

`hash()` is sha256 over canonical JSON (keys sorted recursively, no whitespace)
of the static fields only. It answers "has this serve's configuration
changed?". Restarts, reconnecting workers and pool changes never alter it.

`workers` counts every worker record, whatever its status, so a restart leaves
it unchanged. It counts by swamp version and by label key. Label values are
never read into it.

`settingsHash` covers exactly these merged settings: auth mode, TLS on or off,
remote-only, verify-on-enroll, dispatch-env-allow names, max-concurrent-runs,
max-runs-per-principal, max-run-duration, the approve, signal and tag
explicit-grant flags, grant-reload mode, hot-reload, reuse-port, schedule,
dashboard, auto-resume, shutdown-drain-timeout, and restricted model types and
commands. It never covers admins, allowed users or collectives, webhook routes
or secrets, the OAuth client id or secret, token secrets, any file path, host
or port. List settings are compared as sets of names.

`deploymentMode` uses the same classification serve logs at startup. A v3
datastore has a control plane without opening anything. For an extension
datastore, the provider is loaded and asked for its capabilities only, with no
pull, push, lock or namespace binding. If the provider cannot load, the command
fails with a named error rather than guess the mode.
`src/domain/serve/deployment_mode.ts`.

## Protocol (`/federation/v1`)

Plain HTTPS JSON on serve's existing listener. It is mounted only on a hub with
the gate on.

- `POST /federation/v1/join` takes `{ joinToken, fingerprint, protocolVersion,
  capabilities }`. It returns `{ memberId, memberName, credential, hub }`. The
  token is consumed atomically. A used, expired or revoked token gets the same
  401.
- `POST /federation/v1/check-in` takes `Authorization: Bearer <credential>` and
  `{ instanceId, fingerprint, protocolVersion, capabilities }`. It returns
  `{ hub, jobs: [] }`. `jobs` is reserved for slice 2 and is always empty.
- A removed member's credential gets 401. The member stops retrying until it is
  restarted.
- These routes authenticate their own callers and are outside user sign-in.
  They have per-credential and per-address rate limits.
- Both sides ignore unknown `capabilities` strings, so slice 2 can add verbs
  without a protocol bump.

## Access

A new resource, `access:swamp/federation`. `read` lists and gets members.
`admin` mints, lists and revokes join tokens, and removes members.

## Commands

All are under `swamp serve` and registered only with the gate on.

| Command                                           | Runs on   | Unit |
| ------------------------------------------------- | --------- | ---- |
| `swamp serve fingerprint`                         | any repo  | 1    |
| `swamp serve member token create, list, revoke`   | hub       | 2    |
| `swamp serve member list, get, remove`            | hub       | 2    |
| `swamp serve hub`                                 | member    | 3    |

`swamp serve fingerprint` prints the fingerprint and its hash. In JSON mode it
prints `{ fingerprint, hash }` with runtime fields `null`, since only a running
serve knows them. It reads the config, datastore, vaults, extension lockfile and
worker records without starting a server or syncing.
`src/cli/commands/serve_fingerprint.ts`, `src/libswamp/serve/fingerprint.ts`.

## Units

| Unit             | Scope                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Foundation    | The gate and its fitness test, this doc, `serve.yaml` version 2, the fingerprint and its command      |
| 2. Hub           | `role: hub`, join tokens, the `/federation/v1` routes, member records, the status sweeper, access     |
| 3. Member        | `hub:` config, join, credential storage, the check-in loop, `swamp serve hub`                         |
| 4. Dashboard app | The `@swamp/serve-federation` app, reading member records with `data:read`                            |
| 5. Release       | A live check, removing the gate, user docs, UAT journeys, the bundled skill update, publishing the app |

## Why

| Decision                                                           | Reason                                                                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An experimental env gate, not long-lived branches                  | Every merge to main ships. The gate lets small changes merge while nobody can reach a half-built feature.                                                              |
| Commands under `swamp serve`                                       | It is a serve feature configured in `serve.yaml`.                                                                                                                       |
| HTTPS polling, not a WebSocket                                     | Members pull state. Polling passes load balancers, and slice 2 jobs fit the same pull.                                                                                  |
| Member records as swamp data, written only on change               | History and queries come from the data layer, without a data write per check-in.                                                                                        |
| The fingerprint is an allowlist with no hostnames                  | It settles data residency up front. Members are named by the join token.                                                                                               |
| Version 2 closes every mapping `serve.yaml` defines                | A typo should fail closed. A misspelt webhook `scheme` or `header` silently falls back to default verification in version 1. Only version 2 files are affected.        |
| Workers are a pool field, outside the hash, counted from all records | The hash means "configuration changed". Workers joining or reconnecting are not configuration drift. Counting records keeps it stable across restarts.                 |
| Federation routes sit in their own route table                     | The default table stays exactly as before, so the gate-off tree is unchanged. The gated table is added only when the gate is on.                                       |
| No hub of hubs                                                     | A product decision. A later roll-up stays possible because the rule lives in config validation, not the protocol.                                                      |
