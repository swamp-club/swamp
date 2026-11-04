# Swamp apps

An app is a React page viewers open at `/apps/<name>`, behind the dashboard's
sign-in. It runs in a sandboxed iframe and reaches swamp only through the
dashboard, limited to what its `app.yaml` declares and what the viewer may do.
Swamp serves React, the SDK, the shadcn UI kit and d3, so an app bundles only
its own code.

Build an app for an interactive view people use: a board, a run console, an
inventory browser. For a one-off analysis of run output write a report instead
([extension guide](../extension/guide.md)).

| Need                                                                                         | Read                                                           |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A recipe: live data, editing through methods, run console, charts, deep links, external APIs | [references/patterns.md](references/patterns.md)               |
| Hook signatures, every request and its payload, mock host, error codes                       | [references/sdk.md](references/sdk.md)                         |
| Something does not load, is refused or looks wrong                                           | [references/troubleshooting.md](references/troubleshooting.md) |

## The shape

A behavior is the backend, swamp data is the database, the app is the view. The
app reads data and run history, and it changes things only by running a method
or workflow its `app.yaml` names. Secrets, API calls and validation live in
behaviors, never in the app.

## Build one

```bash
swamp app init @acme/board                      # into extensions/apps/board; default template asks runs:read for its sample chart: prune
swamp app init @acme/charts --template gallery  # one d3 example per data source; prune its capabilities
cd extensions/apps/board && bun install
swamp app dev        # hot reload inside the local dashboard (swamp dashboard)
bun test             # src/**/*.test.ts against a mock host
bunx tsc --noEmit    # type-check; request names and payloads are typed
swamp app build      # writes dist/
```

Bun is the toolchain, pinned in the app's `mise.toml`; `app build` and `app dev`
run through `mise exec` when that file is there. `init`, `dev` and `build`
rewrite `.swamp-platform/` (git-ignored; types, test copies and the dev build).
Never edit it, and never import from it.

Layout: `app.yaml`, `src/main.tsx` (provider, keep it), `src/App.tsx`, logic in
plain `src/<feature>/*.ts` modules so tests reach it, `src/index.css` (keep its
two imports).

## app.yaml

```yaml
name: "@acme/board" # your collective; the folder name is the last part
title: Board
entry: dist/index.html
bridge: 1
platform: "1.4" # the platform minor whose APIs the app uses
capabilities: [data:read]
run: [] # workflows the app may start, e.g. ["@acme/nightly"]
methods: # behavior methods the app may run
  - behavior: team-board # behavior name (`model:` also accepted)
    type: "@acme/board" # its type, pinned
    methods: [move_ticket, add_ticket] # required: only these may run
```

Set `platform:` to the newest minor whose API the app uses: `1` covers
`useRequest`, `useWorkflowRun`, `useSwamp` (with `navigate`) and the kit;
`useMethodRun` needs `"1.1"`, `useDataChanges` `"1.2"`, `toast` `"1.3"`, the d3
interaction and format modules `"1.4"`. `swamp app init` writes the minor of the
swamp running it and `swamp app build` warns when the line is missing; an older
swamp than the app needs refuses it rather than failing at load.

| Capability     | Allows                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `runs:read`    | `workflow.run.search`, `workflow.run.summary`, `workflow.history.*`, `model.usage.summary`, `run.attach`  |
| `data:read`    | `data.get`, `data.query`, `data.search`, `data.versions`, `model.output.search`, `data.subscribe`         |
| `catalog:read` | `workflow.search`, `workflow.get`, `model.search`, `model.get`                                            |
| `health:read`  | `useHealth()`                                                                                             |
| `workers:read` | `worker.list`                                                                                             |
| `run: [names]` | `workflow.run` for exactly those workflows                                                                |
| `methods:`     | `model.method.run` of exactly the listed methods, on those behaviors, only while each has the pinned type |

A request outside them is refused with `app_capability_denied`. Vault, access,
audit and app-management requests are never available. Ask for the fewest: a new
capability sends the app back for operator review. The viewer's own grants still
apply on top, so an app never adds rights.

## Read, change, follow

```tsx
import {
  useDataChanges,
  useMethodRun,
  useRequest,
  useSwamp,
  useWorkflowRun,
} from "@swamp-club/app-sdk/react";
import { Button, Card, toast } from "@swamp-club/ui";

// typed by name: a typo or wrong field does not compile
const { data, error, refetch } = useRequest("data.query", {
  predicate: 'modelName == "team-board" && specName == "ticket"',
});
const tickets = data?.data.results.map((r) => r.content) ?? [];

// refetch on change instead of polling (falls back to polling by itself)
const { version } = useDataChanges({ behaviors: ["team-board"] });
useEffect(() => {
  if (version > 0) refetch();
}, [version, refetch]);

// change things only through a listed method; calls may overlap
const method = useMethodRun();
await method.run({
  modelIdOrName: "team-board",
  methodName: "move_ticket",
  inputs: { id, title, column: "done" },
}); // rejects with the method's error

// start a listed workflow, or attach to a running one, and watch it live
const { run, start, attach, stop } = useWorkflowRun();
await start({ workflowIdOrName: "nightly", inputs: { env: "dev" } });
run.steps["build/compile"]?.status;
```

- A `data.query` with `select` answers in `data.projected`, not `results`.
- Inputs reach methods as literal data; workflow inputs may not contain `${{`.
  Validate inputs in the behavior's schema: any viewer may send them.
- `stop()` or unmounting stops following; the run goes on. Apps cannot cancel
  runs.
- `useSwamp().app.local` is true on the local dashboard, which refuses runs and
  method runs: disable those controls there, and try write flows under
  `swamp serve --dashboard` or with `createMockHost`.

## Test

```ts
import { connectApp, createMockHost } from "@swamp-club/app-sdk";
const host = createMockHost({
  app: { capabilities: ["data:read"] }, // refuses what this grant would
  responses: { "data.query": { data: { results: [], total: 0 } } },
  streams: { "workflow.run": [{ kind: "job_started", jobId: "build" }] },
});
const { client } = await connectApp({}, host.port);
```

React and d3 come from the app's dev dependencies (pinned to the platform); the
UI kit is types only, so test logic modules, not rendered kit components.

## Rules that catch people out

- Never put an API key in an app; the bundle is readable and apps have no vault.
  Call the API from a behavior and read its data.
- `fetch` works only for keyless HTTPS APIs that allow CORS from origin `null`.
  An app can send anything it reads to any HTTPS site; tell the operator.
- Import components from `@swamp-club/ui` before writing your own. Swamp serves
  `react`, `react-dom`, the SDK, the kit, and d3's `array`, `scale`, `shape`,
  `hierarchy` and (from `"1.4"`) `selection`, `zoom`, `brush`, `drag`, `format`,
  `time-format`, `interpolate`, `force`; anything else (icons, date libraries)
  is bundled: declare it in `dependencies`, not `devDependencies`, so push
  audits it. Never add a second React.
- Use `--swamp-*` and shadcn variables, never literal colours. Series use
  `--chart-1..5`; run status `--swamp-success`, `--swamp-danger`,
  `--swamp-running`, `--swamp-cancelled`, `--swamp-warning`, `--swamp-info`.
  Label or legend every chart.
- Use d3 to compute (scales, path strings, layouts) and JSX to render the
  `<svg>`; see the chart recipe for when d3 should own a node. Use `max` from
  `d3-array`, not `Math.max(...values)`.
- Keep `swampApp()` in `vite.config.ts` and do not set `base`; the app is served
  under a per-launch path.
- Use `navigate(path)` and `path` from `useSwamp()` for deep links; there is no
  router to install.

## Enable and ship

```bash
swamp app list
swamp app approve @acme/board  # shows the grant and asks; --yes skips. Needs admin on access:swamp/app-approval
swamp app revoke @acme/board
```

Never approve an app on the user's behalf; show them the command. Under serve,
viewers need a grant per app, or one for every app:

```bash
swamp access grant create --subject group:analysts --allow read --on 'access:swamp/apps/@acme/board'
swamp access grant create --subject group:ops --allow read --on 'access:swamp/apps/*'
```

Add `--server <url>` to act on a serve, where one approval covers every
instance. Operators can also use Manage apps in the dashboard.

To publish, list the folder in the extension manifest, with the behaviors it
needs, and push:

```yaml
behaviors:
  - board.ts
apps:
  - board
```

Run `swamp app build` first. `app.yaml`, the built `dist/`, `package.json` and
`bun.lock` ship; sources do not. Push checks every package in `bun.lock` at its
locked version, and audits on npm and OSV everything the app's `dependencies`
reach, leaving out the modules swamp serves; build tools in `devDependencies`
get only the lock checks, so declare every library the code imports under
`dependencies` (`bun add`, not `bun add -d`). It refuses an app without
`bun.lock`, with another lockfile, with any package from outside the npm
registry (git, file, URL, link, workspace, another registry), with `overrides`,
`resolutions`, `trustedDependencies` or `patchedDependencies`, with a package
listed twice at different versions, or whose name is outside the extension's
collective. An extension may ship only apps. Workflows it ships must be named in
its collective (`@acme/nightly`), so name a workflow an app will `run:` that way
from the start. `quality` and `push --dry-run` need the network and a login with
membership of the collective.
