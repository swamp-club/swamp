# Creek cross-query example

A worked example of **creeks** — the swamp extension kind that lets you
cross-query swamp's local data alongside any external system (databases,
HTTP APIs, anything you can call from TypeScript) inside a single
`swamp data query` predicate.

This example wires up:

- A **Postgres** container holding a `customers` table (plan, MRR, last
  login) and an `incidents` table.
- A **MySQL** container holding a `deploy_audits` log.
- A swamp `@example/deployment` model that seeds a handful of resource
  rows in the local swamp catalog.
- Two creeks (`@example/postgres`, `@example/mysql`) that expose those
  databases as CEL-callable functions.
- Five cross-query examples, including a 3-way join across Postgres +
  MySQL + swamp in a single command.

## Setup

The example ships as a self-contained `extensions/` and `fixtures/`
tree. To try it, copy those two directories into a fresh swamp repo —
they'll be picked up by the loader automatically.

```bash
# 0. Build swamp from this branch (drops the binary at repo root as ./swamp)
deno run compile

# 1. Initialise a scratch repo and copy the example assets into it
mkdir -p /tmp/creek-demo && cd /tmp/creek-demo
/path/to/swamp/swamp init
cp -R /path/to/swamp/examples/creek-cross-query/extensions ./
cp -R /path/to/swamp/examples/creek-cross-query/fixtures ./

# 2. Trust the @example collective (one-time per repo)
swamp extension trust add example

# 3. Start the databases
(cd fixtures && docker compose up -d)

# 4. Seed the swamp side (one model run writes 7 deployment resources)
swamp model @example/deployment method run seed seed-run

# 5. Confirm both creeks are registered
swamp creek type search
# → @example/mysql (v2026.06.01.1, 3 methods) — Query the example MySQL deployment audit log
# → @example/postgres (v2026.06.01.1, 3 methods) — Query the example Postgres customers + incidents tables
```

The two databases are bound to non-standard host ports (5439 for
Postgres, 3309 for MySQL) so they don't collide with anything you might
already have running.

## What's in each store

**Postgres `customers`** — six rows, three plans (`enterprise`, `pro`,
`free`):

| name | plan | last_login | mrr_cents |
| --- | --- | --- | --- |
| acme-corp | enterprise | 2026-06-08T11:42Z | 250000 |
| beech-labs | pro | 2026-06-07T09:15Z | 49900 |
| cedar-systems | pro | 2026-05-30T16:01Z | 49900 |
| dogwood-io | free | 2026-06-08T08:08Z | 0 |
| elm-bank | enterprise | 2026-06-08T03:30Z | 980000 |
| fir-and-co | free | 2026-05-12T22:11Z | 0 |

**MySQL `deploy_audits`** — eight rows, latest-deploy-first per
customer.

**swamp `@example/deployment`** — seven `spec` resources, each tagged
with a `customer` and a `service`. Note that `fir-and-co` exists in
Postgres but has **no swamp deployment** — that's the set-difference
case Example 5 walks through.

## The cross-query CEL surface

Two new built-in CEL functions are available everywhere the swamp data
query language is — predicates, `--select`, and `--order-by`:

- `creek(type, method, args)` — outbound lookup: call a registered
  creek's method, receive whatever it returns. Calls are memoised per
  `(type, method, argsHash)` within a single query so a 1000-row
  predicate calling `creek("@x", "lookup", {key: name})` with 30 distinct
  names hits the network 30 times, not 1000.
- `swamp.data(predicate, select?)` — inbound lookup: run a fresh swamp
  data query inline and get the matching rows. Use this when iterating
  creek-returned data and you want to look the swamp side up per item.

Both share the same per-query cache. There's a recursion-depth cap (3)
on `swamp.data(...)` to keep deeply-nested cross-queries from running
away.

## Example 1 — enterprise prod deployments (Postgres + swamp)

> "Show me every swamp prod deployment whose customer is on Postgres's
> `enterprise` plan."

```bash
swamp data query '
  dataType == "resource"
  && attributes.environment == "prod"
  && creek("@example/postgres", "customer", {"name": attributes.customer}).plan == "enterprise"
' --select 'name + " (" + attributes.customer + " / " + attributes.service + ")"'
```

```
elm-bank-web  (elm-bank / web)
acme-corp-web (acme-corp / web)
acme-corp-api (acme-corp / api)
elm-bank-api  (elm-bank / api)
```

Four rows out of seven. The predicate iterates the swamp catalog row by
row; for each row, the `creek(...)` call fetches the matching Postgres
customer and the predicate checks `.plan`. Memoisation kicks in for
customers with multiple deployments (`acme-corp` appears twice but
Postgres is hit once).

## Example 2 — three-way join: swamp + Postgres + MySQL

> "For every successful API deploy of an `enterprise`-plan customer,
> show me the deployment name, version, MRR, and last-deploy timestamp
> in one row."

```bash
swamp data query '
  dataType == "resource"
  && attributes.service == "api"
  && creek("@example/postgres", "customer", {"name": attributes.customer}).plan == "enterprise"
  && creek("@example/mysql", "last_deploy_for", {"customer": attributes.customer}).status == "success"
' --select '{
  "deployment": name,
  "customer": attributes.customer,
  "version": attributes.version,
  "mrr": creek("@example/postgres", "customer", {"name": attributes.customer}).mrr_cents,
  "last_deploy_at": creek("@example/mysql", "last_deploy_for", {"customer": attributes.customer}).deployed_at
}'
```

```
┌───────────────┬───────────┬─────────┬────────┬────────────────────────────┐
│ deployment    │ customer  │ version │ mrr    │ last_deploy_at             │
├───────────────┼───────────┼─────────┼────────┼────────────────────────────┤
│ acme-corp-api │ acme-corp │ v2.3.1  │ 250000 │ "2026-06-08T10:30:00.000Z" │
│ elm-bank-api  │ elm-bank  │ v4.0.0  │ 980000 │ "2026-06-08T01:51:00.000Z" │
└───────────────┴───────────┴─────────┴────────┴────────────────────────────┘
```

Three data sources, four `creek(...)` calls per matching row, all
projected into a single result set. The two `customer(...)` calls and
the two `last_deploy_for(...)` calls hit the cache after the first
invocation per customer.

## Example 3 — cross-source ordering by Postgres MRR

> "Top 3 swamp deployments by Postgres MRR, descending."

```bash
swamp data query 'dataType == "resource"' \
  --order-by 'creek("@example/postgres", "customer", {"name": attributes.customer}).mrr_cents' \
  --order-direction desc \
  --limit 3 \
  --select '{"customer": attributes.customer, "service": attributes.service, "mrr": creek("@example/postgres", "customer", {"name": attributes.customer}).mrr_cents}'
```

```
┌───────────┬─────────┬────────┐
│ customer  │ service │ mrr    │
├───────────┼─────────┼────────┤
│ elm-bank  │ web     │ 980000 │
│ elm-bank  │ api     │ 980000 │
│ acme-corp │ web     │ 250000 │
└───────────┴─────────┴────────┘
```

`--order-by` runs after the predicate filter but *before* `--limit`, so
the top 3 are taken from the full sorted set rather than the first 3
encountered.

## Example 4 — Postgres-aggregated predicate

> "Which swamp deployments belong to a customer with at least one open
> incident?"

```bash
swamp data query '
  dataType == "resource"
  && size(creek("@example/postgres", "open_incidents_for", {"customer": attributes.customer})) > 0
' --select '{"deployment": name, "incidents": size(creek("@example/postgres", "open_incidents_for", {"customer": attributes.customer}))}'
```

```
┌────────────────┬───────────┐
│ deployment     │ incidents │
├────────────────┼───────────┤
│ acme-corp-web  │ 1         │
│ beech-labs-api │ 1         │
│ acme-corp-api  │ 1         │
│ elm-bank-api   │ 1         │
└────────────────┴───────────┘
```

The creek method returns a list; CEL's standard `size(...)` works
directly on it. The cache makes the doubled `creek(...)` calls (in
predicate and in select) collapse to one Postgres round-trip per
customer.

## Example 5 — inverse direction: Postgres customers missing from swamp

> "Which free-plan Postgres customers have **no** swamp deployment?"

This one flips the iteration direction. The outer query is a single
synthetic row (`'true' --limit 1`); the work happens inside `--select`,
which iterates Postgres and uses `swamp.data(...)` to look up swamp
per item.

```bash
swamp --json data query 'true' --limit 1 --select '
  creek("@example/postgres", "customers_on_plan", {"plan": "free"})
    .filter(c, size(swamp.data("attributes.customer == \"" + c.name + "\"")) == 0)
    .map(c, c.name)
'
```

```json
{
  "results": [["fir-and-co"]],
  "total": 1,
  "limited": true
}
```

`fir-and-co` is in Postgres's `free` plan but has no `attributes.customer
== "fir-and-co"` row in the swamp catalog. The inverse direction is what
makes the cross-query bidirectional — outbound `creek(...)` plus inbound
`swamp.data(...)` lets you start from either store and join into the
other.

## How the creeks are wired

Each creek is a TypeScript module under `extensions/creeks/`. The
`extensions/creeks/deno.json` provides the import map for `npm:`
specifiers (`postgres`, `mysql2`). When the swamp CLI starts, the creek
loader walks `extensions/creeks/`, bundles each `.ts` file via
`deno bundle`, validates the exported `creek` against
`UserCreekSchema`, and registers it with the global creek registry.

The author-facing contract is small:

```ts
export const creek = defineCreek({
  type: "@example/postgres",        // scoped name, @collective/name
  version: "2026.06.01.1",          // CalVer
  description: "…",
  methods: {
    customer: defineCreekMethod({
      description: "…",
      arguments: z.object({ name: z.string() }),
      execute: async (args, ctx) => {
        // ctx exposes: signal, logger, vaultService?, extensionFile
        // Return whatever you want — it flows back into the CEL caller.
      },
    }),
    // …
  },
});
```

Connection pooling is the author's responsibility — both creeks here
keep a module-scoped pool alive across calls so a thousand-row predicate
doesn't open a thousand connections.

## Notes on the CEL surface

There's one DX wrinkle worth knowing: CEL receiver methods require
pre-registered signatures in cel-js, but creek method names are
author-defined. To keep the wiring honest, the CEL surface uses a 3-arg
function form:

```cel
creek("@me/jira", "issue", {"key": name}).status == "open"
```

…rather than receiver-style `creek("@me/jira").issue({...})`. Property
access on the result works as expected. The TypeScript surface available
to model methods (`ctx.creek("@me/jira").issue(args)`) uses a Proxy and
keeps the receiver-style syntax.

## Tearing down

```bash
(cd fixtures && docker compose down -v)
```
