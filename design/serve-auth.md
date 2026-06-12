# Serve Authentication & Authorization

This design extends `swamp serve` from a single-host trust model to a server
that can be exposed on a network: TLS via Let's Encrypt, user login against
swamp-club.com by default (or any OAuth 2.0 provider), admission restricted to
particular collectives or whitelisted users, durable per-server client
credentials, and an authorization layer that grants users and groups access to
workflows, models, and data.

It builds directly on [remote execution](./remote-execution.md), which already
made the orchestrator "a natural authorization and audit chokepoint": token
issuance, session credentials, a bearer-authenticated data plane, and built-in
models for server bookkeeping all exist today for **workers**. This design
extends the same machinery to **users**.

## Why this shape

Three properties drive the design:

- **swamp speaks exactly one identity protocol: OAuth 2.0 client.** swamp is
  a Deno CLI binary; better-auth is a server-side framework that lives in the
  swamp-club codebase, not something swamp links against. Instead, swamp-club
  exposes itself as an OAuth 2.0 authorization server (better-auth's OAuth
  module, with the device authorization grant for headless clients and
  collective memberships from the `organization` plugin surfaced on the
  userinfo response), and swamp serve is a generic OAuth 2.0 client whose
  default authorization server is `https://swamp-club.com`. Pointing at Okta,
  Auth0, Keycloak, Entra, or even GitHub is a config change — endpoint URLs
  plus client ID — with no provider-specific code. Identity is established the
  OAuth way: the access token is exchanged at the provider's **userinfo
  endpoint** for the user's identity and groups, not by validating a signed
  ID token. This is deliberate — it sidesteps the entire offline-JWT footgun
  class (`alg:none`, audience confusion, JWKS fetching as an SSRF vector) in
  favor of one authenticated call to the provider at login time, which is
  cheap because login is interactive and infrequent. SAML never enters this
  codebase: better-auth's SSO plugin already brokers SAML 2.0 on the
  swamp-club side, and self-hosters put an OAuth broker (Dex, Keycloak) in
  front of their SAML IdP. This is the same answer Kubernetes, Vault, and
  Tailscale give.

- **The server mints its own credentials; the provider is consulted only at
  login.** A successful OAuth login does not hand the provider's access token
  to the swamp client. The server applies its admission policy, then issues
  its *own* revocable token using the proven enrollment-token shape
  (`<name>.<secret>`, secret hashed at rest, constant-time comparison).
  Day-to-day connections never touch the provider, the server works when the
  provider is down, and revocation is a local operation.

- **Policy and identity are swamp data.** Grants, groups, and known principals
  are built-in models persisted exactly like workers, enrollment tokens, and
  step leases. Versioned history doubles as the audit trail, `swamp data
  query` works on policy, both output modes come for free, and workflows can
  automate access management. Ephemeral material — session credentials, token
  secrets, TLS keys — is deliberately *not* swamp data.

## Ubiquitous language

| Term                  | Meaning                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Principal**         | An authenticated identity acting against the orchestrator: a **user** (OAuth login) or a **worker** (enrollment token). One session-issuance mechanism serves both. |
| **Authorization server** | The OAuth 2.0 provider the server trusts for user login. Default `https://swamp-club.com`; any OAuth 2.0 provider may be configured by its endpoint URLs. |
| **Admission policy**  | The server-side gate applied after the userinfo exchange and before token minting: allowed collectives and/or whitelisted users.      |
| **Server token**      | The long-lived, revocable credential the server mints for an admitted user. Same shape as an enrollment token; a built-in model.       |
| **Session credential**| The short-lived bearer credential (already used by workers) that authenticates individual control- and data-plane requests.            |
| **Grant**             | subject → effect → actions → resource selector (+ optional condition). The unit of authorization administration; a built-in model.    |
| **Group**             | A locally-managed named set of principals; a built-in model.                                                                          |
| **Rule**              | The compiled, engine-facing form of a grant: an action/resource matcher plus a compiled CEL condition program, carrying its source grant id for provenance. |
| **Rule pack**         | Serialized rules shipped as extension content. Inert until an admin enables the pack, which materializes its rules as grants.          |
| **IdP-asserted group**| A group whose membership is asserted by the provider at login (from the userinfo response) and never stored locally. Referenced in grants as `idp-group:<name>`. |
| **Resource selector** | A value object naming what a grant covers: `workflow:<pattern>`, `model:<pattern>`, `data:<pattern>`, `access:<pattern>`, with globs over scoped names (`@collective/*`). |
| **Action**            | What a grant permits: `run`, `read`, `write`, `admin`.                                                                                |
| **Admin principal**   | A principal holding `admin` on `access:*` — the authority to change rules. At least one is **required by config** in any enforcing mode; the server refuses to start without it. Materialized at startup as a config-sourced admin grant. |

## Authentication

### Login flow

Users authenticate with the **OAuth device authorization grant** — the CLI, the
server, and the browser may all be on different machines, which rules out a
localhost-callback flow. The existing swamp-club login
(`src/libswamp/auth/login.ts`) already walks a device-verification browser
flow, so the UX is familiar.

```
swamp auth login --server https://swamp.example.com:9090
```

1. The CLI calls the server's `/auth/*` endpoints (HTTP routes alongside the
   existing data plane in `src/serve/data_plane.ts`).
2. The server — the OAuth 2.0 client — starts a device authorization grant
   against its configured authorization server and relays the user code +
   verification URL to the CLI. The user completes login in any browser.
3. The server exchanges the resulting access token at the provider's userinfo
   endpoint (over TLS, endpoints pinned in config) to learn the identity and
   its groups, **verifies the token was issued for swamp's own client** (via
   token introspection where available, otherwise relying on the device
   grant's client binding — the OAuth equivalent of an audience check, and
   the one correctness item this protocol must get right), then applies its
   **admission policy**: the identity must carry one of `allowedCollectives`
   (matched against the groups field) and/or appear in `allowedUsers` (matched
   on the stable `sub`, never an unverified email). Admission is a pure domain
   service.
4. On admission the server mints a **server token** — `<name>.<secret>`,
   hashed at rest, default expiry ~90 days, revocable — and records or updates
   the **principal** (user id, display name, claims snapshot, last login) as
   swamp data.
5. The CLI stores the token as a per-server credential.

### Client credential storage

Today `~/.config/swamp/auth.json` holds exactly one swamp-club credential
(`src/domain/auth/auth_credentials.ts`). Server credentials are a sibling
aggregate in `domain/auth/`: a `ServerCredential` keyed by normalized server
URL, persisted to `~/.config/swamp/servers.json` with mode 0600, with a
`SWAMP_SERVER_TOKEN` environment override following the same precedence rules
as `SWAMP_API_KEY` (`src/infrastructure/persistence/auth_repository.ts`).

### Authenticating connections

The client presents its server token on the WebSocket upgrade; the server
exchanges it for a session credential exactly as worker enrollment does
(`src/serve/worker_gateway.ts`), and the data plane's existing
`sessions.verify()` bearer check extends unchanged to user sessions. This
fills the gap the remote-execution design left deliberately open — "no client
authentication today … intended to evolve to bearer tokens."

Users and workers thereby converge: a worker redeems an enrollment token, a
user redeems a server token, and both receive refreshing session credentials
from the same issuance mechanism. `Principal` is the value object that names
which kind is acting.

### Restricting who may log in

Admission config lives in the serve configuration:

```yaml
auth:
  mode: oauth           # none | token | oauth
  provider: https://swamp-club.com   # authorization, token, and userinfo endpoints derived or set explicitly
  clientId: swamp-serve-example
  groupsField: collectives   # default for the swamp-club provider; "groups" elsewhere
  allowedCollectives: [acme, stack72]
  allowedUsers: ["sub:auth0|abc123"]   # matched on stable subject, not email
  admins: ["sub:auth0|abc123"]         # REQUIRED in any enforcing mode — see below
```

`mode: token` enables server tokens minted locally on the host with no
provider at all (phase 1); `mode: none` preserves today's loopback trust
model and is the default when binding to 127.0.0.1.

### Safe-by-default binding (hard refusals, not warnings)

Today an off-loopback bind emits only a `logger.warn`. That is not a control.
The server **refuses to start** — a hard error, no `--force` — when:

- the bind address is non-loopback and `tls.mode` is `none`. Bearer tokens
  and session credentials travel on the WebSocket upgrade and in
  `Authorization` headers; on plaintext they are sniffable and replayable.
  Off-loopback therefore requires TLS (`static` or `acme`).
- the bind address is non-loopback and `auth.mode` is `none`. An
  unauthenticated control plane reachable from the network is arbitrary
  remote execution; the old warning understated it.

Loopback binds may still run `mode: none` with no TLS — that is the
single-host development model and stays frictionless. The matrix is: off the
loopback, both TLS and authentication are mandatory, enforced at startup.

## TLS

Two modes, because `Deno.serve` accepts PEM cert/key material directly:

- **`tls: static`** — cert and key file paths in serve config. Works
  immediately behind corporate PKI or a terminating proxy (Caddy, nginx).

- **`tls: acme`** — the server self-provisions from Let's Encrypt using the
  **HTTP-01 challenge**: it answers `/.well-known/acme-challenge/*` from a
  port-80 listener alongside the main port. Requires public DNS for the
  configured `domains` and a contact email. The ACME account key and issued
  certificates live under the swamp config dir (or a vault). A renewal loop
  re-issues ~30 days before expiry.

```yaml
tls:
  mode: acme            # none | static | acme
  domains: [swamp.example.com]
  email: ops@example.com
```

Two constraints shape the implementation. Deno has no built-in ACME client, so
this is either a small dependency or an implementation of the modest RFC 8555
subset (JWS over JSON, three endpoints). And `Deno.serve` cannot hot-swap
certificates on a live listener, so renewal restarts the listener — acceptable
because workers already reconnect with a grace window and clients retry.
DNS-01 (for servers without public DNS) is a later extension point, pluggable
the way vault providers are.

## Authorization

### The `access` bounded context

A new `domain/access/` context with three building blocks:

- **`Grant`** (aggregate root) — subject → effect → actions → resource
  selector, plus an optional condition, with an `active | revoked` lifecycle.
  Revocation is a state transition, never a delete, so history is retained.
- **`Group`** (aggregate root) — a locally-managed name + member principals.
- **`AccessDecisionService`** (domain port) —
  `(principal, action, resource) → allow | deny`, with an explain variant.
  Deny by default.

A grant record:

```yaml
id: 7f3a…
subject: { kind: idp-group, name: platform-eng }   # user | group | idp-group
effect: allow             # allow | deny — deny wins
actions: [run]
resource: { kind: workflow, pattern: "@acme/*" }
condition: 'tags.env == "staging"'   # optional ABAC condition: CEL, the same language as workflow expressions
state: active
createdBy: user:adam
createdAt: 2026-06-11T…
source: method            # method | file | extension:@acme/soc2-baseline
```

Resource selectors reuse the `@collective/name` scoping convention from
extension manifests as an authorization namespace: `model:@stack72/*` is a
natural grant. Revocation and denial stay distinct concepts: revoking a grant
removes its rules from the policy; a deny grant *is* policy, overriding any
allow.

### A configured admin is mandatory

Deny-by-default has a bootstrap problem: an empty grant store denies everyone,
including whoever would write the first grant. The answer is not a magic
escape hatch but a **required config field**. In any enforcing mode
(`token`, `oauth`), the serve config **must** name at least one admin
principal (the `auth.admins` list above), and the server **refuses to start**
if it is empty — the same hard-refusal posture as the binding rules.

At startup the server materializes each configured admin as a grant
(`subject: user:<sub>`, `effect: allow`, `actions: [admin]`,
`resource: access:*`, `source: config`). These are real, listable grants —
visible in `swamp access grant list`, distinguished by `source: config` — not
an invisible side channel. They are reconciled from config on every boot: the
config file is the source of truth for who may change the rules, so an admin
locked out of the running system is recoverable by editing config and
restarting, and an admin removed from config loses authority on the next boot.
An admin may grant `admin` to others at runtime, but the config-sourced set
cannot be revoked away to zero — losing the last admin requires editing
config, where physical access to the host already implies root authority.
This makes "who may change the rules" an explicit, auditable, fail-safe
configuration decision rather than an emergent property of login order.

### The decision engine: CEL conditions, evaluated in-house

Grant conditions are **CEL** — the same expression language workflows and
definitions already use ([expressions](./expressions.md)), evaluated by the
same baseline factory behind `src/infrastructure/cel/cel_evaluator.ts`. This
is the architecture of Google Cloud IAM Conditions (grants with CEL attached),
and Kubernetes and Istio make the same choice for policy. swamp shipping a
production CEL evaluator already is what makes this the cheap option as well
as the uniform one.

**Uniform with the existing CEL surfaces.** swamp has two CEL surfaces today
(internal and extension-author-facing); the grant-condition environment is a
third, built from the same factory, and it follows the established style
rather than inventing a dialect:

- **Flat resource fields, `data.query()`-style.** A condition is a predicate
  over the target resource's fields with no wrapper object — `tags.env ==
  "staging"`, not `resource.tags.env` — exactly how `data.query('modelName ==
  "scanner" && tags.env == "prod"')` predicates read. Field sets per kind:
  `workflow { name, tags, collective }`, `model { type, collective }`,
  `data { name, ns, tags, owner }` (`ns`, not `namespace`, matching the
  data-query convention since `namespace` is reserved in CEL).
- **Context as a namespace object, `run.*`-style.** The acting identity is
  exposed as `principal.sub`, `principal.email`, `principal.groups`,
  `principal.collectives` — the same shape as the existing `run.*` and
  `env.*` namespaces. Conditions like
  `collective in principal.collectives` or
  `owner.createdBy == principal.sub` ("you may delete what you created")
  are one-liners.
- **The environment is sealed — permanently.** No `data.*`, `vault.*`,
  `env.*`, or `model.*` receivers and no extension registrations, ever: a
  decision is a pure function over (resource fields, principal) with no I/O.
  CEL's own guarantees — non-Turing-complete, terminating, cost-bounded per
  evaluation — bound what any condition can cost, and the seal is what makes
  those guarantees real (a host function would be the escape hatch out of
  all of them, and would make policy meaning depend on extension versions).
  Demand for richer predicates is absorbed by growing the *baseline* with
  vetted deterministic functions (CIDR, semver, and the like — added by us,
  inside the seal); dynamic facts enter as data, via enricher-populated
  `principal.*` attributes or activation inputs, never as functions. There
  is deliberately no macro/abstraction layer for drying up repeated
  conditions: grants are largely machine-authored, repetition across them is
  cheap, and every condition remains self-contained and readable in place.

**The evaluation loop is ours.** With CEL carrying the conditions, a
general-purpose authorization library would be left doing only action/resource
matching and rule ordering — too little to justify the surface. The
`AccessDecisionService` port is implemented by a `CelAccessDecisionAdapter`
that owns a small, test-pinned loop:

1. **Subject matching is plain domain code.** Resolve the principal's local
   groups and IdP-asserted groups; select the active grants whose subject
   matches. *Who* a grant applies to is a domain concern.
2. **Each grant compiles to a rule**: an action/resource-selector matcher
   plus the grant's condition compiled to a CEL program. Compilation happens
   once per policy version at snapshot build (parsing is the expensive part;
   evaluation is fast) — the compiled rule set is global, not per-principal,
   because the principal arrives at evaluation time in the activation.
3. **Deny wins, by construction.** Matching deny rules are evaluated before
   allow rules and short-circuit; this ordering is a security-critical
   invariant of the adapter, never something a grant author thinks about.
4. **Provenance rides the rule.** The deciding rule carries its source grant
   id, and the stored condition is human-readable CEL, so
   `swamp access check` prints both the grant and the expression that
   decided.

**Write-time validation is a type check.** The grant `create` method parses
and type-checks the condition against the kind's declared environment, so a
typo'd field or a string-compared-to-int fails at authoring with a CEL type
error — not as a silently never-matching rule. The same check runs when
file-sourced grants are reconciled and when rule packs are enabled.

**Conditions are bounded, deterministically.** CEL guarantees termination,
not speed — nested comprehensions are polynomial in their inputs (and
`principal.groups` can be large), and rule packs are third-party content
whose safety pitch rests on these bounds being real. The limits, enforced in
the same write-time pass as the type check (grant create, file
reconciliation, pack enablement):

- **Source length ≤ 1KB** per condition, with **AST depth ≤ 24** — these
  protect the parser itself and keep the tier-1 "packs are reviewable as
  data" claim honest. A condition approaching the cap is a signal the policy
  concept belongs in the data model (a tag, a resource attribute, an
  enricher-populated claim), not in the expression.
- **Comprehension nesting ≤ 2** — the highest-leverage single rule, since it
  caps the polynomial degree of any condition directly.
- **A per-condition cost budget in deterministic units** (AST-node
  evaluations / comprehension iterations — never wall-clock, which would
  make the same grant pass on an idle server and fail under load), sized so
  worst-case evaluation is microseconds. Write-time static estimation
  rejects any condition whose *worst case* exceeds the budget, so the author
  is present when it fails. A generous wall-clock deadline exists only as
  defense-in-depth.
- **An aggregate per-decision budget**, so rule volume (a pack contributing
  hundreds of cheap conditions) cannot recompose what per-condition limits
  prevent.

`matches()` stays in the grant environment — too useful to lose — with two
guards acknowledging that swamp's evaluator (`@marcbachmann/cel-js`)
implements it as a backtracking JS `RegExp` rather than the linear-time RE2
the CEL spec assumes. First, **the pattern argument must be a string
literal**, enforced in the write-time pass: the regex sits in plain sight
next to the grant (a catastrophically backtracking literal is visible
pathology a reviewer can see), and data values can never become patterns —
otherwise `matches(name, tags.pattern)` would hand whoever names a resource
or sets a tag control of the regex. Second, `RegExp` execution is an opaque
host call the deterministic cost meter cannot see inside, so for `matches()`
specifically the wall-clock backstop deadline is the binding limit — the one
case where it is the primary defense rather than depth.

Runtime overrun semantics are asymmetric and deliberate: an allow-rule
overrun treated as "didn't match" fails closed, but a deny-rule overrun
treated the same way fails *open* — the deny silently stops denying. Since
write-time estimation makes overruns an invariant violation rather than an
expected path, any runtime budget overrun **fails the decision (deny) and
logs loudly**: it means the static estimator was wrong, which is a bug, not
a policy semantic. One ratchet governs all these values: raising a limit
later is free; lowering one invalidates grants and packs already in the
field. Start generous-but-bounded, never unbounded.

This upgrades the model from pure name-globs to attribute-based control:
"may read data where `tags.type == 'report'`", "may run workflows tagged
`env: staging`", "may touch only resources in a shared collective" are all
expressible, and selectors remain the common case that needs no condition at
all.

### Policy as an extension point

Extensions already ship models, vaults, workflows, datastores, and reports;
policy becomes one more content type, in tiers of increasing power and risk:

- **Tier 1 — rule packs** (the v1 extension point). An extension ships
  grants-as-data: YAML/JSON rules whose conditions are CEL source. Packs ride
  the existing bundle machinery and collective validation, and conditions can
  only be bounded CEL in the sealed grant environment — terminating,
  cost-limited, no I/O — so a compliance baseline like `@acme/soc2-baseline`
  ("only security-admins read data tagged `pii`") stays reviewable as data.
- **Tier 2 — context enrichers** (later). Extension code that enriches the
  principal's context at *login and session-refresh time* — on-call status,
  employment status, business hours. Deliberately not at decision time:
  checks stay fast, and enrichment failures fail closed before a session
  exists rather than during one. Time-bounded, results cached on the
  principal's claims snapshot.
- **Tier 3 — external deciders** (a non-goal). The port makes an OPA-style
  bridge *possible*, but a network call inside every decision is a latency
  and availability hazard that deny-wins rule packs mostly obviate.

The trap to design against explicitly: **an allow-rule pack is privilege
escalation by `extension install`.** Two guards:

1. **Installation is inert; enablement is the policy change.** Enabling a
   pack is a model-method mutation requiring `admin` on `access:*`, and it
   materializes the pack's rules as grants with
   `source: extension:@acme/soc2-baseline` — visible in
   `swamp access grant list`, versioned in the audit history, revocable like
   any other grant. Disabling the pack revokes them.
2. **Allow rules are collective-scoped; deny rules may be global.** A pack's
   allow rules may only target resources in the pack's own collective
   namespace (the existing `extension_collective_validator.ts` machinery does
   double duty); deny rules may apply globally, because tightening policy is
   safe where broadening is not.

### Groups from the IdP

Grants accept two distinct group subjects:

- `group:<name>` — local group; membership stored in the group model.
- `idp-group:<name>` — membership asserted by the provider's groups field on
  the userinfo response at login and recorded only on the principal's claims
  snapshot. No local membership list exists, so enterprise group
  administration stays in the provider. swamp-club collectives are exactly
  this with `groupsField: collectives`.

The deliberate consequence: IdP group membership is a **snapshot from login
time**. Removing a user from a group in the IdP takes effect at their next
login or token expiry — the standard snapshot-with-bounded-TTL tradeoff. Keep
server-token lifetimes modest; an optional server-held refresh token that
re-pulls userinfo on a cadence is a later config option for installations
wanting tighter revocation.

Group shape varies by provider (Keycloak emits group paths, Okta names, Entra
opaque GUIDs with an overage behavior past 200 groups), so the config carries
the field name plus a light filter/allowlist of groups the server cares about.
Handling Entra's overage callback is a non-goal; the filter is the answer.

### Enforcement points

Because the orchestrator owns the durable world, enforcement is three
chokepoints:

| Point                                  | Question                                                            |
| -------------------------------------- | ------------------------------------------------------------------- |
| `src/serve/connection.ts` (control)    | May this principal `run` this workflow / model method?              |
| `src/serve/capability_service.ts`      | May the *initiating* principal `read`/`write` this data?            |
| `src/serve/data_plane.ts` (bytes)      | Same, for artifact reads and writes.                                 |

The subtle case is workers acting on behalf of runs: a worker's capability
calls are checked against the **initiating user's** authority, not the
worker's. The run record is stamped with its principal at submission, and the
step lease already links dispatch → run, so attenuated authority flows down
the whole chain. The orchestrator owns audit; every decision logs the
principal.

### Policy and identity are swamp data

Grants, groups, and principals are built-in models, following the worker /
enrollment-token / step-lease precedent. Four invariants are load-bearing:

1. **Mutations only through model methods.** Generic data writes (`swamp data`
   commands, workflow steps) must not be able to create or alter access
   records — that would let data-write authority mint grants. The existing
   ownership validation (`OwnershipValidationError`; the built-in model owns
   its data as `model-method`) already enforces this shape; for access types
   it is security-critical and pinned by tests.
2. **The decision path bypasses enforcement.** Access checks gate data access
   and grants *are* data, so `AccessDecisionService` evaluates against an
   in-memory policy snapshot loaded through an internal repository read and
   invalidated when a grant/group method runs. This avoids recursion and
   lockout, and makes per-message decisions cheap.
3. **Only local membership is stored.** IdP-asserted groups never get a local
   membership list — that would become a second, stale source of truth.
4. **Ephemeral material is not swamp data.** Session credentials stay
   in-memory, token secrets are never persisted (only hashes), TLS/ACME keys
   live in the config dir or a vault.

### Administering grants

One mechanism — model methods on the access models — exposed through three
surfaces:

**Local CLI on the server host.** Filesystem access to the repo is root
authority (unchanged from today), so no session is required. This complements
the config-sourced admins — it is the recovery path when no admin can log in:

```bash
swamp access grant create --subject idp-group:platform-eng --allow run --on 'workflow:@acme/*'
swamp access grant create --subject idp-group:platform-eng --allow run --on 'workflow:@acme/*' \
  --when 'tags.env == "staging" && collective in principal.collectives'
swamp access grant list --subject idp-group:platform-eng
swamp access grant revoke <id>
swamp access group create release-managers
swamp access group add-member release-managers user:adam
```

**The same CLI, remotely.** With `--server`, each command is a
`model.method.run` over the existing control protocol — no new wire machinery.
Mutating access models requires the `admin` action on an `access:*` resource,
checked by the same decision service as everything else: admins are simply
principals with grants on the access models.

**Declarative, as a later phase.** A checked-in grants file reconciled at
startup gives policy-as-code reviewed in PRs. File-sourced grants are marked
`source: file` so the reconciler owns only its own records and never clobbers
imperatively-created grants.

One command is essential rather than nice-to-have — an explain-mode evaluator
on the same pure decision service:

```
swamp access check --subject user:adam --action run --on workflow:@acme/deploy
→ ALLOW via grant 7f3a… (idp-group:platform-eng → run → workflow:@acme/*)
```

Because grants are swamp data, workflows can manage them: a quarterly
access-review workflow that queries active grants, cross-references the IdP,
and files issues for stale ones is just a swamp workflow.

## Phasing

Each phase is independently shippable; nothing earlier is rewritten later.

1. **Server tokens on the control plane + static TLS.** Mostly reuses the
   worker session machinery; makes `--host 0.0.0.0` defensible immediately.
2. **ACME provisioning** (HTTP-01, renewal loop).
3. **OAuth login with swamp-club as default provider** — device grant,
   userinfo exchange + client-binding check, admission policy, `servers.json`.
   Requires swamp-club work in the other repo: better-auth's OAuth module with
   the device authorization grant, and collectives on the userinfo response.
4. **The `access` context** — grants, groups, the CEL-backed decision
   adapter, enforcement, required config admins, `swamp access` CLI.
   Selector-only grants first; the `condition` field and `--when` (ABAC) can
   land here or as a fast follow.
5. **Rule packs** — the tier-1 policy extension point: pack content type,
   enable/disable methods, collective-scoped allow validation.
6. **SAML as documentation, not code** — federate via swamp-club or an OAuth
   broker. Context enrichers (tier 2) follow demand.

## Non-goals and known limits

- **No SAML in this codebase.** Brokered via swamp-club's SSO plugin or an
  external OAuth bridge.
- **No Entra group-overage callback.** The groups filter/allowlist is the
  supported path for >200-group identities.
- **No hot certificate swap.** ACME renewal restarts the listener; reconnect
  semantics absorb it.
- **Snapshot semantics for IdP groups.** Membership changes propagate at next
  login or token expiry, not instantly.
- **Grants are per-repo state.** One orchestrator serves one repo today;
  shareable or centrally-managed policy is out of scope until that changes.
- **No external deciders.** Tier-3 policy extensions (OPA-style bridges
  implementing the decision port) are out of scope; rule packs plus deny-wins
  cover the compliance-overlay use case without a network call per decision.
- **No decision-time extension code.** Context enrichers run at login and
  session refresh only; the decision path evaluates the in-memory snapshot
  and nothing else.
- **No extension-registered CEL functions in the grant environment, ever.**
  The seal is permanent. New predicates land in the vetted baseline; dynamic
  facts arrive as principal attributes or activation inputs. This is a
  decided non-goal, not an open question — revisiting it means revising this
  design, not flipping a flag.

## Open questions

- Will swamp-club expose a public OAuth 2.0 authorization server with the
  device grant and collectives on userinfo? This is the lynchpin of phase 3
  and lives in the other repo.
- Default server-token lifetime. The earlier 90-day proposal is too loose
  against revocation: an `idp-group` membership is snapshotted at login, so a
  de-grouped user keeps access until the token expires. Lean short
  (hours-to-days) by default, or make the optional provider-refresh re-check
  mandatory whenever any `idp-group` grant is in play.
- Whether `mode: oauth` should *also* allow locally-minted tokens (break-glass
  access when the provider is down) or require them to be explicitly enabled.
- Which deterministic predicate libraries the sealed baseline should launch
  with (CIDR and semver are the likely first asks).
