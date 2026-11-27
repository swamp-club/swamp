---
audience: maintainer, operator
enables: [serve]
last-verified: 2026-11-26 @ e2ab2c52e
---

# Serve Federation

Serve Federation joins swamp serves to a hub. The hub records what each member
reports about itself. It is being built in five units behind an experimental
gate. This doc describes slice 1. Unit 1 (the gate, `serve.yaml` version 2 and
the fingerprint), Unit 2 (the hub) and Unit 3 (the member) are in the code. The
rest is the design the later units build.

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
9. The hub stores only hashes of join tokens, join ids and credentials. A member
   keeps its credential in its encrypted control-plane vault.
10. **Strings from another serve are escaped at the terminal.** Every string a
    member or the hub supplied passes through `escapeControlCharacters` before
    log-mode output prints it (`serve member list`, `get` and `remove`,
    `serve hub` and `serve hub forget`). Stored records keep the value exactly
    as received, and join and check-in never refuse a value for a control
    character. JSON output is left to `JSON.stringify`, which escapes C0
    characters but not DEL or C1. No source scan enforces this, since a regex
    cannot tell a remote string from a local one; the renderers' property test
    is the guard.

## The experimental gate

`SWAMP_EXPERIMENTAL_FEDERATION=1` turns the feature on. Any other value, or no
value, leaves it off. One pure function, `isServeFederationEnabled`, decides
this from an env lookup. No other code reads the variable.

With the gate off:

- the federation `swamp serve` subcommands are not registered. They live in
  `SERVE_FEDERATION_ROUTES`, which is added to `SERVE_ROUTES` only with the gate
  on;
- `serve.yaml` is parsed by the version 1 path, so `version` and `federation`
  are unknown keys that are warned about and ignored;
- `federation` never appears in a reload report;
- `swamp serve check-config` output is unchanged, including its warnings for
  `restricted-commands` entries;
- `swamp/serve-member` is not registered. `models.ts` never imports it, and
  `registerFederationModelTypes` registers it only with the gate on;
- no hub is built, so `/federation/v1/*` falls through to the 404 it gets today
  and its spans carry no route;
- the `federation.*` requests are refused exactly as a made-up request type is.
  Only a serve that built a hub validates them, through a hub-only request
  schema. Every other serve keeps today's schema and today's
  `serverRequestPayloadFields()`.

A hub is built only with the gate on and a version 2 `serve.yaml` with
`federation.role: hub`.

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
  `audit`, `audit.hmac`, `audit.stores[i]` and its `retention`, `audit.policy`
  and its `rules[i]`, `audit.wal`, `audit.alerts[i]` and its `match`,
  `threshold` and `action`, `audit.sinks[i]` and its `auth`, `batch`, `retry`
  and `filter`, `triggers.<workflow>`, `webhooks[i]` and `federation`. A version
  1 file still only warns about the sink `filter`'s unknown keys and is silent
  about the other audit mappings. Free-form maps stay open:
  `triggers.<workflow>.inputs`, `webhooks[i].config`, and audit store and sink
  `config`.
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
  name: <member-name> # optional, default "hub"

# a member
version: 2
federation:
  hub: <hub-url>
  join-token-file: <path>
```

The `federation` block must be a mapping with exactly one of `role: hub` or
`hub: <url>`. `role` accepts only `hub`. A hub may not set `join-token-file`. Only a hub may
set `name`, its own member name, which follows the member name rules. A join
token can never be minted for it.
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

| Building block         | Kind                | Where                                               | Unit |
| ---------------------- | ------------------- | --------------------------------------------------- | ---- |
| `Fingerprint`          | Value object        | domain                                              | 1    |
| `FingerprintCollector` | Domain service      | domain, with ports                                  | 1    |
| `JoinToken`            | Entity              | hub control-plane store, `federation/tokens/<name>` | 2    |
| `MemberCredential`     | Value object        | hub control-plane store, hash only                  | 2    |
| `ServeMember`          | Aggregate root      | `swamp/serve-member` built-in behavior on hub       | 2    |
| `Instance`             | Entity in member    | inside `ServeMember`                                | 2    |
| `FederationHub`        | Application service | hub                                                 | 2    |
| `MemberStatusSweeper`  | Application service | hub, leader only                                    | 2    |
| `HubLink`              | Entity              | member control-plane store, `federation/link/`      | 3    |
| `MemberCheckInService` | Application service | member                                              | 3    |

`Fingerprint` is created through `Fingerprint.create()`, which refuses a missing
field or any field outside the contract, for what a serve collects itself. The
hub reads a member's report with `fromWire()`, which drops fields outside its
contract, and a stored record with `fromRecord()`, which keeps them for the
rewrite but leaves them out of `hash()` and every field it reads. Both
accept any value in a field whose set of values may grow (below), so only
`create()` holds a value to the lists this swamp defines. `FingerprintCollector` builds
one from ports for build info, merged settings, deployment classification,
vault types, extensions and worker records. The domain never reads YAML, the
lockfile or the datastore itself. `src/domain/serve/fingerprint.ts`,
`src/domain/serve/fingerprint_collector.ts`.

A `JoinToken` is named, single use and time limited: one hour by default, 30
days at most. Its states are `unused`, `used`, `expired` and `revoked`. It is a
separate type from worker enrollment tokens, so a join token can never admit a
worker. It is not a model type. Only its hash is stored, in the hub's
control-plane store at `federation/tokens/<name>`, whose history is its audit
trail. Its wire form is `<name>.<secret>`. On first use it also records the
hash of the join's `joinId`, which lets that member, and only that member,
replay the join (see "Protocol"). Once the member record is written it records
`admittedAt`. Its reader keeps fields it does not know, and so does every hub
rewrite of it.

A member credential has the wire form `swfm1.<memberId>.<secret>`. Its sha256
hash is kept at `federation/credentials/<memberId>` in the control-plane store
and compared in constant time. Removing a member deletes it.

A `ServeMember` holds the member's id, name, role, current fingerprint, status
and instances. It holds no secret and no hash of one. `swamp/serve-member` is
the first built-in `swamp/` type that is user data rather than control-plane
data, so `data:read` reads it. The hub writes it only through the type's
methods with literal inputs. Every hub of a team reads it, so it keeps keys it
does not know, at the top, in each instance and in the fingerprint, and writes
them back unchanged. A fingerprint a member's check-in replaces carries only
the fields the hub that wrote it knows. A member record gets a new data version only when
its fingerprint hash, its pool summary or its status changes. Its versions are
its history and can be queried with `data.query`. Runtime fields never create a
version. Check-in times go to the control-plane store under
`federation/seen/<memberId>/<instanceId>`, never to data. Each seen record is
`{ at, runtime: { team, startedAt, ready } }`, the runtime fields of that
check-in's fingerprint; a record written before runtime was carried reads with
no runtime. The leader writes the hub's own seen record under the hub record's
id every check-in interval (`HubSelfRecord`), and removes the hub's seen records
of any other instance, so after a restart or a new leader the hub has one. The
hub's record lists that one instance. The sweeper never derives the hub's
status from it. The hub reports serve's own readiness in it. Seen records are
read eight at a time.

`federation.member.list` and `.get` answer each record with a `live` view beside
it: per instance its last check-in and runtime facts, freshest first, and the
freshest time. It comes only from the seen records, never from the record's own
instance list. A binary from before Unit 4.1 parses seen records strictly and
deletes this shape in its sweep, so a hub team on mixed versions can show
members going stale until the old leader is replaced. Every reader since ignores
fields it does not know. Each reply carries the hub's `now`, which
`swamp serve member` reads ages against.

An instance id must be a UUID before any key is built from it. A member has at
most 64 live instances. An instance unseen for 24 hours is pruned.

A member is `online` while it checked in within three check-in intervals (90
seconds), then `stale`, then `offline` after 10 minutes. The leader's
`MemberStatusSweeper` applies those changes. The hub keeps its own member
record, with role `hub`, written only by the leading node.

Every token and member write on the hub runs on one `federation` transition
tail. Join verifies the token, checks the name, marks the token used, then
writes the credential and the member record, then marks the token
`admittedAt`, so a token is never reusable. A replay replaces the member's
credential and writes no record. When the record is missing and the token was
never admitted, the hub stopped mid-join and the replay writes it; when it was
admitted, the record was deleted and the replay gets 401. Members are removed
with `swamp serve member remove`, never by deleting their data. A token spent
before `admittedAt` existed still re-admits.
Remove marks the record removed, then deletes the credential.
`src/domain/serve/`, `src/serve/federation/`.

### The member

A member's `HubLink` holds the hub URL, its member id and name, the hub's name
and when it joined, in one of five states: `unjoined`, `joining`, `joined`,
`refused` or `mismatched`. A `joining` link also holds the `joinId` of its open
join, which with the join token could replay it, so no view, log or audit event
shows it. A `joined` link keeps it until a check-in succeeds with the stored
credential; a refused or mismatched link holds none. A member binary from before
that reads a joined link holding a `joinId` as corrupt, so every node of a
member team runs this version or later. It lives in the member's
control-plane store at `federation/link/record`, beside the store a rebuilt
instance on the same datastore reads, so a rebuild is the same member. Each
instance's last attempt, result, backoff and an `aliveAt` time go under
`federation/link/instances/<instanceId>`; records unseen for 24 hours are
pruned. The credential lives only in the encrypted `_token-secrets` control-plane
vault under `federation-member-credential`, outside the `server-token-` keys
token GC and token health select. It is held exactly while the link is `joined`
or `mismatched`.

`MemberCheckInService` runs in the background, started once serve is ready.
Serve's startup, `/ready`, runs, schedules and workers never wait on it, and no
hub failure stops serve; an error building it is logged and serve runs without
it. At start it decides from the link, the stored credential and `serve.yaml`:

- joined, same hub: check in;
- joined, another hub: `mismatched`, one error, no request;
- refused or unjoined, with a `join-token-file`: join, then check in at once;
- otherwise: idle, one warning.

A join or the removal of a stray credential runs only under the join claim,
`federation/member/join-claim`, taken with `putIfAbsent` and taken over once it
is two minutes old. A takeover deletes the stale claim only if it still reads
as it did, and a node checks it still holds the claim before calling the hub.
Nodes that lose it look for the credential every 5 seconds, quietly.
Before a join request leaves, the member writes the link as `joining` with a
new `joinId`, a lower-case UUID. A start that finds a `joining` link with no
credential of its own retries that join with the stored `joinId`, even if
`serve.yaml` now names another hub URL, and so does a node taking over a stale
join claim. A lost or unusable reply, a `5xx`, a `429` or a shutdown keeps the
`joining` link and retries with backoff; only a `401` or `409` abandons it. The
join reply is recorded on the link before the credential is stored, so a
restart between the two still finds a credential that is its own. Once the hub
has spent the token, those writes are retried a few times within seconds, even
through a shutdown, since losing them loses the membership. A join refused
because another node spent the token meanwhile checks in as that node's member.

Each instance checks in with serve's own process `instanceId`, at the reply's
`checkInIntervalSeconds` clamped to 5 s – 1 h with ±10 % jitter. A network
error, `5xx`, `429` or refusal backs off exponentially from the interval to 5
minutes with jitter, and `retry-after` is a floor. `409` waits the full 5
minutes. A `401` on check-in first looks at the stored credential: one another
node stored for the same member is taken up. Otherwise, under the join claim, a
join not yet confirmed is replayed once with the stored `joinId`, which heals a
node that stalled and stored a credential the hub had already replaced. Failing
that, the link is marked `refused` and the credential deleted, only when both
still belong to that member, and check-ins stop until restart; a later start
with a `join-token-file` joins as a new member, even to another hub. A `401` on
join is logged once and not retried until restart. A mismatched or idle member
records why on its instance (`mismatched`, `not_joining` or `refused`).

The member's calls take a 10 second timeout and abort on shutdown, never follow
a redirect, verify TLS with serve's `--ca-cert` roots added, and read at most
64 KiB. The join reply's credential must parse and name the reply's member id.
The token file is read up to 4 KiB and is never logged. Shutdown stops the loop
as the `federation member` stage and marks the instance stopped.
`src/serve/federation/member_check_in_service.ts`,
`src/cli/commands/serve_federation_member.ts`.

## Fingerprint contract

Only these fields. Adding one is an architecture decision.

The value lists below bind only a serve's own fingerprint. A hub accepts, stores
and shows as written any non-empty string for `deploymentMode`,
`datastoreFormat`, `authMode`, `federationRole` and `team.role`, and any
positive integer for `serveYamlVersion`, so a member on a later swamp keeps
joining and checking in, and an older hub of a team reads a newer hub's record.
An unknown value is part of the fingerprint like any other: in a static field it
moves `hash()` and cuts a version.

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
| `workers`          | `{ total, byVersion, byLabelKey }`                      | worker records, or the live pool       | pool    |
| `team`             | `{ role: leader, follower, peer or single, nodes }`     | running serve                          | runtime |
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
never read into it. A running member on a local control plane counts the workers
connected to it instead, since its own pool is authoritative there. A v3 team
or v2 serves sharing a control plane count the records: each node holds only its
own connections, so a live count would differ per instance and cut a member
record version whenever another instance checked in.

`team` is `leader` or `follower` on a v3 team, and `peer` for v2 serves sharing
a remote control plane, with `nodes` counted from live heartbeats; anything
else, a lone v2 node included, is `single`. Hub and member share
`serveTeamFacts`. `src/serve/federation/serve_team.ts`.

`settingsHash` covers exactly these merged settings: auth mode, TLS on or off,
remote-only, verify-on-enroll, dispatch-env-allow names, max-concurrent-runs,
max-runs-per-principal, max-run-duration, the approve, signal and tag
explicit-grant flags, grant-reload mode, hot-reload, reuse-port, schedule,
dashboard, auto-resume, shutdown-drain-timeout, restricted model types and
commands, and reserved-worker-labels names (only when set, so a node without the
setting hashes as before). It never covers admins, allowed users or collectives,
webhook routes or secrets, the OAuth client id or secret, token secrets, any
file path, host or port. List settings are compared as sets of names.

`deploymentMode` uses the same classification serve logs at startup. A v3
datastore has a control plane without opening anything. For an extension
datastore, the provider is loaded and asked for its capabilities only, with no
pull, push, lock or namespace binding. If the provider cannot load, the command
fails with a named error rather than guess the mode.
`src/domain/serve/deployment_mode.ts`.

## Protocol (`/federation/v1`)

Plain HTTPS JSON on serve's existing listener. It is mounted only on a hub with
the gate on.

- `POST /federation/v1/join` takes `{ joinToken, joinId, fingerprint,
  protocolVersion, capabilities }`. It returns `{ memberId, memberName,
  credential, hub, checkInIntervalSeconds }`. `joinId` is required, a
  lower-case UUID the member chose; without it the join gets 400 naming it. The
  token is consumed atomically, and its record keeps the hash of `joinId`. A
  join with a used token and the same `joinId`, before the token expires and
  while the member it created is not removed, is a replay: it gets the same
  reply with a new credential for the same member, and the old credential stops
  working. Any other used, expired, revoked or missing token gets the same 401.
  A name held by a live member gets 409.
- `POST /federation/v1/check-in` takes `Authorization: Bearer <credential>` and
  `{ instanceId, fingerprint, protocolVersion, capabilities }`. It returns
  `{ hub, checkInIntervalSeconds, jobs: [] }`. `jobs` is reserved for slice 2
  and is always empty. A 65th live instance gets 409.
- `hub` is `{ name, swampVersion, protocolVersion: 1 }`.
  `checkInIntervalSeconds` is 30.
- A removed member's credential gets 401. The member stops retrying until it is
  restarted. The member side is described under "The member".
- These routes authenticate their own callers and are outside user sign-in.
  Join has the per-address burst limit. Failed joins count per address. Failed
  check-ins count per member and address, or per address when the credential
  does not parse.
- A body over 64 KiB gets 413. Another `protocolVersion` gets 400 naming the
  supported one. A fingerprint refusal names the field path and echoes nothing
  the caller sent. Fingerprint fields outside the hub's contract, sent by a
  member on a newer swamp, are dropped and never stored or versioned. A value
  the hub does not know, in a field whose set of values may grow, is accepted
  and stored as written.
- Both sides ignore unknown `capabilities` strings, so slice 2 can add verbs
  without a protocol bump.
- In team mode a follower forwards the body to its leader, which applies every
  federation write. A refusal names no leader, since the caller is not
  authenticated.
- Audit events for join and check-in are `auth` events. A replay is its own
  `federation.member.join.replayed` event. They never carry a token, credential
  or `joinId`, and refused check-ins are coalesced per reason.

## Access

A new resource, `access:swamp/federation`. `read` lists and gets members.
`admin` mints, lists and revokes join tokens, and removes members.

An app reads the live view through the `federation:read` capability, which
allows `federation.member.list` and `.get` and nothing else, under the viewer's
`read` on the same resource. It exists only with the gate on: off, `app.yaml`
naming it is refused as an unknown capability. Member history comes from
`data:read` on `swamp/serve-member`, so viewing it also needs data read on that
type. See `design/surfaces/apps.md`.

Six WebSocket requests carry these: `federation.member.list`, `.get` and
`.remove`, and `federation.token.create`, `.list` and `.revoke`. They are
validated only on a hub. Member remove is sync-gated and confirmed. Token
writes are forwarded to the leader. Lists and get are answered locally. They
are audited as admin requests, like other access requests.

`federation.link.get`, `read` on the same resource, returns a member's link and
instance records. It is validated only on a serve that built a member, through a
member-only request schema, and is answered by any node.

## Commands

All are under `swamp serve`, in `SERVE_FEDERATION_ROUTES`, and registered only
with the gate on.

| Command                                           | Runs on   | Unit |
| ------------------------------------------------- | --------- | ---- |
| `swamp serve fingerprint`                         | any repo  | 1    |
| `swamp serve member token create, list, revoke`   | hub       | 2    |
| `swamp serve member list, get, remove`            | hub       | 2    |
| `swamp serve hub`, `swamp serve hub forget`       | member    | 3    |

`swamp serve fingerprint` prints the fingerprint and its hash. In JSON mode it
prints `{ fingerprint, hash }` with runtime fields `null`, since only a running
serve knows them. It reads the config, datastore, vaults, extension lockfile and
worker records without starting a server or syncing.
`src/cli/commands/serve_fingerprint.ts`, `src/libswamp/serve/fingerprint.ts`.

`swamp serve member` sends the `federation.*` requests with `--server`. Without
it, it opens the store serve uses locally. Local mode refuses unless the gate is
on and `serve.yaml` is a version 2 hub, on a checkout that writes through
serve, and on a v2 extension datastore, where serve may keep the control-plane
store remotely. `token create` prints the join token once.
`src/cli/commands/serve_member*.ts`.

`swamp serve member list` and `get` show ages in their largest unit, read
against the hub's `now`.

`swamp serve hub` shows the hub, the member, the link state and each instance's
last check-in, or its last attempt, result and next retry while it is refused,
mismatched, joining or backing off. It sends
`federation.link.get` with `--server`; locally it reads the control-plane store
serve uses, a v2 extension datastore's remote one included. `swamp serve hub
forget --yes` deletes the credential, then the link records. It is local only,
and refused while any instance on the link refreshed `aliveAt` within two
minutes, so a serve stopped without shutting down blocks it that long. The
refusal is checked before the repository is opened to write, so a running serve
gets it rather than the writer's lock.
`src/cli/commands/serve_hub*.ts`.

## Units

| Unit             | Scope                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Foundation    | The gate and its fitness test, this doc, `serve.yaml` version 2, the fingerprint and its command      |
| 2. Hub           | `role: hub`, join tokens, the `/federation/v1` routes, member records, the status sweeper, access     |
| 3. Member        | `hub:` config, join, credential storage, the check-in loop, `swamp serve hub`                         |
| 4.1 Live view    | The live member view in the replies and `swamp serve member list/get`, `federation:read`, client types |
| 4.2 Hub app      | The `@swamp/serve-hub` dashboard app, built in swamp-extensions, with `[federation:read, data:read]`   |
| 5. Release       | A live check, removing the gate, user docs, UAT journeys, the bundled skill update, publishing the app |

## Why

| Decision                                                             | Reason                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An experimental env gate, not long-lived branches                    | Every merge to main ships. The gate lets small changes merge while nobody can reach a half-built feature.                                                                                                                                   |
| Commands under `swamp serve`                                         | It is a serve feature configured in `serve.yaml`.                                                                                                                                                                                           |
| HTTPS polling, not a WebSocket                                       | Members pull state. Polling passes load balancers, and slice 2 jobs fit the same pull.                                                                                                                                                      |
| Member records as swamp data, written only on change                 | History and queries come from the data layer, without a data write per check-in.                                                                                                                                                            |
| The fingerprint is an allowlist with no hostnames                    | It settles data residency up front. Members are named by the join token.                                                                                                                                                                    |
| Version 2 closes every mapping `serve.yaml` defines                  | A typo should fail closed. A misspelt webhook `scheme` or `header` silently falls back to default verification in version 1. A misspelt audit sink secret key such as `tokne` sends an empty credential. Only version 2 files are affected. |
| Workers are a pool field, outside the hash, counted from all records | The hash means "configuration changed". Workers joining or reconnecting are not configuration drift. Counting records keeps it stable across restarts.                                                                                      |
| Federation routes sit in their own route table                       | The default table stays exactly as before, so the gate-off tree is unchanged. The gated table is added only when the gate is on.                                                                                                            |
| Join tokens are not a model type                                     | Listing a new type in `CONTROL_PLANE_MODEL_TYPES` would change gate-off behaviour for grants, extensions and requests naming it.                                                                                                            |
| Credential hashes in the control-plane store, not the member record  | The record is user data, readable with `data:read`. It holds no secret or hash of one.                                                                                                                                                      |
| `swfm1.<memberId>.<secret>` credentials                              | The member id finds the hash without a scan. The prefix is not reserved as a token name, so gate-off token handling is unchanged.                                                                                                           |
| Last-seen times outside the record                                   | A check-in would otherwise write a data version every 30 seconds.                                                                                                                                                                           |
| Runtime facts in the seen record                                     | The live view needs them, and the write already happens each check-in; in the record they would add a data version.                                                                                                                         |
| Live state through `federation:read`, history through `data:read`    | An app needs current last-seen times, which data never holds. Replaces the earlier decision that the app needs only `data:read`.                                                                                                            |
| The app gate decided at `app.yaml` parse, not in the SDK             | The broker runs in the browser and cannot see the gate; a grant only exists for a descriptor serve accepted.                                                                                                                                |
| Instance ids are UUIDs, at most 64 per member                        | Untrusted ids build control-plane keys, and one member cannot grow its record without bound.                                                                                                                                                |
| The burst limit on join only                                         | A member's instances check in from one address. Failed check-ins still count, per member and address.                                                                                                                                       |
| A hub-only request schema                                            | With no hub, today's schema and payload-field list apply, so `federation.*` gets today's `invalid_request`.                                                                                                                                 |
| Span routes for `/federation/v1/*` only on a hub                     | The fixed route table stays as before. Elsewhere those paths are unknown and carry no route.                                                                                                                                                |
| No new v3 write intents                                              | Member writes are model-method `data.save` writes, and token and credential writes are control-plane writes, admin by type.                                                                                                                 |
| Join spends the token first; remove marks the record first           | A crash never leaves a reusable token or a credential for a removed member.                                                                                                                                                                 |
| Join is idempotent through a member-chosen `joinId`                  | A lost reply must not need an operator. Replay needs the token and the private `joinId`, and rotating the credential settles a reply lost twice.                                                                                            |
| The leader alone writes the hub's own record and sweeps              | A follower that wrote too would add versions and race the leader. Its `team` field comes from the running team.                                                                                                                             |
| No hub of hubs                                                       | A product decision. A later roll-up stays possible because the rule lives in config validation, not the protocol.                                                                                                                           |
| The member joins and checks in in the background                     | Serve's readiness, runs and workers never depend on a hub being up.                                                                                                                                                                         |
| Each instance checks in with its own id                              | Per-node versions are needed once upgrades arrive; the hub groups instances under one member.                                                                                                                                               |
| One join per member, under a claim in the control-plane store        | Several nodes share one token and one credential; the claim keeps them to one join.                                                                                                                                                         |
| The credential in the control-plane vault                            | It lives with the datastore, so a rebuilt instance is the same member, and it is never in a plain file or a log.                                                                                                                            |
| The link at `federation/link/record`, not `federation/link`          | A filesystem store keeps each key as a file, and the instance records need `federation/link/` as a directory.                                                                                                                               |
| A mismatched link keeps its credential                               | Restoring the hub URL resumes check-ins; leaving a hub is an explicit `forget`.                                                                                                                                                             |
| A refused link may join any hub                                      | The hub already ended it, so a new token is enough; there is nothing left to forget.                                                                                                                                                        |
| `forget` reads `aliveAt`, not a pid file                             | serve writes a pid file only as a daemon, and `aliveAt` is refreshed in every link state, across every node on a shared store.                                                                                                              |
| A member-only request schema                                         | As for the hub: a serve that is not a member keeps today's schema and payload-field list.                                                                                                                                                   |
| Control-plane records several versions read ignore unknown fields    | A hub team in a rolling upgrade mixes versions. A record is corrupt only when a field it knows is missing or wrong, never for a field it does not know.                                                                                     |
| Stored records keep unknown keys; the wire fingerprint drops them    | An older hub rewriting a newer hub's record must not strip its fields. A member may run newer swamp than its hub; the hub stores only what its allowlist knows, so a new field never creates a version.                                     |
| A hub accepts any value in a fingerprint field whose values may grow | Hubs run older swamp than some members once federation ships, and the tolerance must be in the first released hub: a value a later release adds would otherwise be refused with 400. Only a serve's own fingerprint uses the closed lists, so this swamp never emits a value it does not define. |
| A stalled node heals through the retained `joinId`, not fencing      | Compare-and-set or claim fencing would need a conditional put on `ControlPlaneStore` that every datastore extension implements. One replay under the claim settles it.                                                                    |
| `admittedAt` on the join token                                       | A replay must finish a join the hub crashed in, but must not recreate a member an operator deleted.                                                                                                                                         |
| The hub keeps one seen record and lists one instance                 | After a restart or a new leader, the live view and `serve member list` agree on one hub instance.                                                                                                                                           |
| Seen records read eight at a time                                    | `member.list` stays fast on a remote control-plane store without a new store API.                                                                                                                                                           |
| Replies carry the hub's `now`                                        | Clock skew between the CLI and the hub never skews a relative time.                                                                                                                                                                         |
