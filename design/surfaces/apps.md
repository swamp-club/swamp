---
audience: extension-author, operator, maintainer
last-verified: 2026-11-04 @ 4d796d10
---

# Swamp apps

An app is a React application a viewer opens at `/apps/<name>`, behind the
dashboard's sign-in. It ships in an [extension](../primitives/extensions.md) or
is built in a repo's `extensions/apps/` folder. `/apps` lists the enabled apps
the viewer may open; managing them stays in the dashboard. An app reaches
[serve](../primitives/serve.md) through a connection the dashboard opens for it,
and it gets
the dashboard's theme, shadcn components and d3 chart examples.

`/apps` pages are the dashboard's bundle in a layout without its chrome, so they
share its sign-in and broker. Hosting them apart from the dashboard
changes nothing about the sandbox: the iframe stays, because app code on the
session's origin could act as whoever is signed in.

## Why this shape

App code is untrusted, because anyone can publish it. Dashboard pages share an
origin with the session cookie, so a page on that origin could act as whoever
is logged in, admins included. An app therefore runs in a sandboxed iframe with
an opaque origin. The dashboard opens each app's connection to serve, a socket
of its own on the viewer's session, and a broker in the dashboard is the only
way to it.

An app's effective access is the viewer's grants intersected with the app's
capabilities. Serve applies grants to every request as usual. The broker applies
capabilities, and it runs in the dashboard's realm, out of the app's reach.

## Packaging

An app is a folder with an `app.yaml`:

```yaml
name: "@acme/cost"
title: Cost
entry: dist/index.html
bridge: 1
capabilities: [runs:read, data:read, health:read]
run: ["@acme/nightly-report"]
methods:
  - behavior: cost-report # `model:` is a synonym
    type: "@acme/cost-report"
    methods: [refresh]
```

An extension lists app folders under `apps:` in its manifest, resolved from
`extensions/apps/` like any typed key (or from the manifest's folder under
`paths.base: manifest`). Push packages
`app.yaml` and the folder holding the entry, never the app's sources
(`readAppBundle`, `src/domain/extensions/extension_app_bundle.ts`). Its name must
use the extension's collective. The build may hold only files serve will answer
for, and no symlinks. That scan is a static check, and the sandbox is the control.

The build inlines what the app imports at runtime, so push audits that like an
import (`readAppDependencies`, `src/domain/extensions/app_dependencies.ts`). The
shipped set is the closure of the app's `dependencies`, `optionalDependencies`
and `peerDependencies` as `bun.lock` resolves them, leaving out the platform
modules swamp serves (`PLATFORM_PACKAGES`, which mirrors `PLATFORM_MODULES`)
and anything reached only through them. Every package in it goes through the OSV
and npm trust checks at its locked version, with no package budget and apart
from the extension's shared 50-package cap. Every other locked package is
build-only and gets the lock checks alone. Push refuses an app, whether the
package is shipped or build-only, with no `package.json`, no `bun.lock`, another
package manager's lockfile, a lock entry not fetched from the default npm
registry with an integrity hash (git, URL, file, link, workspace, another
registry), `overrides`, `resolutions`, `trustedDependencies`,
`patchedDependencies` or `workspaces`, a package declared at two specs, or a
lock that does not satisfy `package.json`. Vite also bundles `devDependencies`
the code imports, and nothing ties `dist/` to the lock, so the audit is hygiene
for honest publishers; the sandbox is the control.

Apps are found in `extensions/apps/` in the repo, in mounted extension sources and in pulled
extensions (`FilesystemAppCatalog`). The first one found wins, in that order. An
approval follows the name, so a pulled app must sit at
`<extension>/apps/<folder>/`, its extension must be at the path its manifest's name
gives, the manifest must list it, and the name must use that collective. An
extension nested at `<extension>/apps/` installs only while its parent ships no
apps, so a folder of its with an `app.yaml` resolves to a parent that lists none
and is refused. An
extension's `files/` is written verbatim, so at most it can pass as another
extension of its own collective. It never reaches another collective's names.

## Serving

`app.launch` returns `/app-files/<launch-token>/<file>`. The token is signed, not
stored: an app name, an expiry 8 hours out (as a dashboard session), and a stamp
of the approval it was made under, with HMAC-SHA256 over them, in base64url.
Under serve the key is `serve-app-launch-key` in the encrypted control-plane
vault, so a token made on one instance opens on any other sharing the control
plane; the local dashboard's child makes a key when it starts, so its launches
die with it. A revoke deletes nothing: the approval is checked on every file, and
a token from an earlier approval never matches a new one. A single launch cannot
be revoked; it lasts until it expires or the approval changes.

`serveAppRoute` (`src/serve/app_assets.ts`) serves only the entry's folder, and
checks the approval on every file. A missing file is a 404, never a page from the
dashboard. A path whose segment does not have a token's shape is refused before
any work; a token that is expired, forged or for another approval gets the same
404. Checking one costs an HMAC and no store read, so the route needs no
per-address limit. Every response from this route, refusals included, carries
`appResponseHeaders`
(`packages/app-sdk/headers.ts`):

- `sandbox` (`APP_SANDBOX`: `allow-scripts allow-forms allow-popups
  allow-popups-to-escape-sandbox`) is in the CSP, not only on the iframe, so an
  app URL opened in its own tab stays off the serve origin. The dashboard's iframe
  uses the same constant, since browsers apply the intersection.
  `allow-same-origin`, `allow-top-navigation` and `allow-modals` are never set.
- `allow-forms` is there only so `submit` events fire: a sandbox without it drops
  a submission before the event, so an app's `<form onSubmit>` never runs.
  `form-action 'none'` blocks every real submission, so forms add no way out of
  the frame that `connect-src` does not already give.
- `allow-popups` lets a click open a link in a new tab, e.g. an email thread or
  a calendar event, and `allow-popups-to-escape-sandbox` lets that tab load as
  an ordinary page rather than inheriting the sandbox. Popup blockers still
  require a user gesture. It adds no egress (`connect-src https:` already
  allows any https request). The cost is that an approved app could open a
  lookalike page in a new tab, which is one reason apps need operator approval.
  The popup keeps its opener; Chromium refuses its navigating the dashboard's
  tab, and dashboard documents send `Cross-Origin-Opener-Policy: same-origin`,
  which cuts the opener in every browser. App files and the platform do not.
- `script-src` is the app's own path, so a page of the app runs only the shipped
  bundle. A frame can still navigate itself elsewhere, which is why the dashboard
  gives one port per document and disconnects a built app that loads twice.
- `connect-src https: wss:` lets an app call external sites.
- `Access-Control-Allow-Origin: *` is required, because a frame's module scripts
  and fonts are CORS fetches from an opaque origin. Launch tokens cannot be forged, and
  no other serve route sends a CORS header.

The route reads no credentials. A frame's document request does carry the session
cookie, because its navigation starts on the dashboard. Subresources, sockets and
`fetch` from the frame do not.

An iframe load cannot send the hub's token, so the hub forwards
`/w/<workspace>/app-files/<launch-token>/…` without one, to a child that is
already running, and the launch token is the credential.

## Direct access to serve

`connect-src` lets an app try to reach serve itself over TLS. A sandboxed frame
sends `Origin: null`, which `validateOrigin` refuses because it does not parse.
That covers every socket upgrade in every auth mode, and no-auth HTTP. Serve sends
no CORS headers, so a frame cannot read other replies, and the frame has no
cookie and no token.

## The bridge

The SDK posts `swamp-app-ready` to its parent. The dashboard checks the message
came from that frame and answers with a `MessagePort`. The port carries ordinary
serve frames plus control messages for theme, navigation, connection state,
visibility and health (`packages/app-sdk/bridge.ts`). It is versioned, and it is
the only contract between an app and swamp, so apps stay independent of the
dashboard's React version.

Apps use `SwampClient` from `packages/client` on a `BridgeTransport`.
`useSwamp()` adds React state. A window connects once, because a second request
would make the host close the first port and StrictMode mounts twice.

`AppBroker` (`packages/dashboard/src/apps/broker.ts`):

- Refuses a frame no capability allows.
- Forwards a `cancel` only for a request that app issued, and ends that request.
  Serve treats a `cancel` carrying a run id as cancelling that run. A `cancel` of
  a request stops following it; the run goes on.
- Sends each request as `app:<n>`, never under the app's id, and returns the
  reply under the app's id: serve cancels a run when a `cancel` names its id and
  no request has it, so an app's id must never be a run's.
- Uses a socket of its own, opened when the app gets its port and closed with the
  broker, so serve's limits (100 requests, 8 `data.subscribe` streams) bound that
  app alone, and serve's `too_many_requests` reaches it unchanged.
- Sends `HTTP_REQUEST_TYPES` over the HTTP route.
- Fails in-flight requests when the socket goes, since the bridge stays open.
- Shares the dashboard's one health stream. A token gets 10.
- Sends only the fields an app may choose on a run, so it cannot skip checks or
  claim locks, and tags the run with `swamp.app`.
- Closing closes the socket, which ends what was in flight.

## Capabilities

| Capability | Allows |
| --- | --- |
| `runs:read` | `workflow.run.search`, `workflow.run.summary`, `model.usage.summary`, history reads, `run.attach` |
| `data:read` | `data.get`, `data.query`, `data.search`, `data.versions`, `model.output.search` |
| `catalog:read` | `workflow.search`, `workflow.get`, `model.search`, `model.get` |
| `health:read` | The shared health stream |
| `workers:read` | `worker.list` |
| `run:` list | `workflow.run` for the named workflows |
| `methods:` list | `model.method.run` of the listed method names, on the named behaviors, of the named type |

Anything else is refused by default, so a new request type stays denied until someone adds it
(`packages/app-sdk/capabilities.ts`). Read scopes are coarse because `data.query`
takes free-form expressions.

Serve evaluates expressions in run inputs as the viewer, which would reach past
the app's capabilities. The broker always sends `literalInputs` on a method run,
and refuses a workflow run whose inputs hold `${{`.

A method's type is pinned, because a listed name could otherwise be a
`command/shell` behavior that runs anything. The broker sends `expectedType` from
the grant, never from the app, and serve refuses a run whose behavior has another
type (`method_type_mismatch`). A behavior may appear once in `methods:`, and each
entry must list the methods it may run: any other is refused with
`app_capability_denied`, so an app given a behavior's `set_item` cannot call its
`delete`. The method lists are part of the capability key, so changing one sends
the app back for review. An app that
sends `typeArg` makes a direct run: the type must be the pinned one, and the run
may create the behavior or set its global arguments, as the viewer could.

`run.attach` follows a run's live events, which history reads already expose
once the run ends. Serve still requires the viewer's own `run` grant on the
workflow, and the broker never passes on a `cancel` naming a run, so following a
run can never stop it. `run.attached` carries a payload but opens the stream, so
neither the broker nor the client treats it as the end of the request.

Apps can reach external sites, so an app can send anything it may read to any
server. Capabilities decide what an app can read, not where that data goes. The
approval output says so. Calls that need an API key belong in a behavior, because
a key in a bundle is readable.

## Approval

An installed or built app stays off until an operator enables it, with `swamp app
approve` or the dashboard's Manage apps page. Both send `app.approve` and
`app.revoke`, which need `admin` on `access:swamp/app-approval`. They are refused
for anyone else. The broker never
exposes them. The page sends the capability key it showed, so an app that changed
meanwhile is refused.

An approval is a `ControlPlaneStore` record keyed by app name, holding the
capability key (`ControlPlaneAppApprovalRepository`). Every serve instance and the
CLI read the same record on each use, so a change needs no poller. A code update
with the same capabilities stays enabled. New capabilities send the app back to
review and stop it serving, and so does a new origin: the key records whether the
app is local, a mounted source or a pulled extension, so a pulled app never
inherits the approval of a local one with its name. `swamp app approve` shows
what the app asks for and asks first, unless given `--yes`.

Each app is its own resource, `access:swamp/apps/<name>`, and opening it needs
`read` there, or the approval right above. A grant on `access:swamp/apps/*`
covers every app, one on `access:swamp/apps/@acme/*` a collective's, and a deny
on one app beats a wider allow because every check names that app. A viewer
lists only the enabled apps they may read, without who approved them; one with
no grant sees an empty list. An integration token, or any viewer an operator
has not chosen, reaches no app. A
dashboard with an app open re-reads the list every 60 seconds, hidden or not, and
closes a frame whose app is gone.

On the local dashboard `app.approve` and `app.revoke` are hub actions that run the
CLI, like the other [local actions](./local-dashboard.md#actions). A v2 custom
datastore's store is reachable only through serve, so the CLI refuses and says so.

## Local development

`swamp app dev` starts Vite on loopback and writes a registration under
`.swamp/app-dev/`, touched every 5 seconds. The local dashboard's child follows it,
and its iframe loads the Vite URL with the real broker, so HMR runs inside the
real sandbox. A registration needs a loopback URL, a recent heartbeat, and an app
in the repo's own `extensions/apps/` folder at the same path. Serve never follows one.
Each app frame opens its own socket through the hub, under the same forwarded
reads.
The local dashboard forwards `data.subscribe`, which its child answers with
`data_feed_unavailable`, so `useDataChanges` polls; `run.attach` is not
available locally.

Bun is the only toolchain: the scaffold pins it in `mise.toml`, and `app build`
and `app dev` run Vite under Bun, through `mise exec` when the folder has a mise
config.

The `swampApp()` Vite plugin answers with `appResponseHeaders`, with three pinned
additions: the HMR socket, Vite's inline refresh script, and loopback frame
ancestors, because the hub is a different origin. Vite allows `Origin: null`, so
other sandboxed pages on the machine could read app source while it runs.

## Theme and components

The dashboard sends its tokens over the bridge, and the SDK sets them as
`--swamp-*`. `theme.css` maps those onto shadcn's variables. `--chart-1..5` is its
own categorical set: the dashboard's `--chart-bar-*` are status colours and fail a
colour-separation check as five series.

Both themes meet WCAG 2.2 AA: text tokens are at least 4.5:1 on every surface,
including status colours on their tints and white on the accent, and chart
series, status marks, idle tiles and control edges (`--border-strong`, which
`--input` maps to) at least 3:1. Card and divider borders are decorative and
stay faint.

`swamp app init` copies the full shadcn component set, the SDK and the client into
the app. The set came from `shadcn add --all`, with two changes for the sandbox:
`sonner` takes its mode from the bridge, and `sidebar` writes no cookie. Rendered
markdown takes the `swamp-prose` class, because Tailwind's reset strips lists. The `dashboard` and `gallery` templates are in
`packages/app-sdk/templates/`. The gallery holds one d3 example per data source.
React owns the DOM, and d3 does scales, shapes and layouts.

## The SDK

Every request an app may make is in `AppRequestMap`
(`packages/client/protocol.ts`) with its payload and reply, mirrored from serve's
own types, so `useRequest("data.query", …)` and `useSwamp().request` are typed by
name and a request outside the map does not compile. The SDK exports every
protocol type, the run reducer behind `useWorkflowRun()`, and `createMockHost`,
which plays scripted `streams` as well as single replies. A stream that ends early
or is aborted sends `cancel` for its request id, which stops following; the run
goes on. Serve stamps each run event with `at` when it is emitted, so a late
attach replays real timing; `runClock` gives "now" on serve's clock.

`useMethodRun()` runs a method listed under `methods:`. Unlike a workflow run,
calls overlap: each returns a promise for its own result, so an app can fire
several edits at once, and `state` (from `methodRunReducer`) shows the latest
call. It was added in platform 1.1.

`useDataChanges({ behaviors })` hears of data changes through `data.subscribe`,
which `data:read` allows: it sends names and versions, never content, filtered by
the viewer's current read access. A subscription from an old cursor replays the
log's retained window, so it can name items since deleted, which `data.query` no
longer finds; that metadata is the one thing it adds over a query. Its
`version` goes up on each change, so an app refetches when it moves instead of
polling. `followDataChanges` resubscribes from the last cursor when the stream
drops, starts afresh (and bumps `version`) when the gap was compacted, and polls
when serve answers `data_feed_unavailable`, as on a v2 datastore. The pages are
replies marked `done: false`, which `endsRequest` keeps open, so the broker and
the client hold the request until an error or a cancel. It was added in
platform 1.2.

The kit exports sonner's `toast` beside its `Toaster`, so both use the
platform's one sonner store; an app importing `sonner` itself would bundle a
second store its `Toaster` never reads. The scaffold mounts `<Toaster />`. It
was added in platform 1.3.

Platform 1.4 adds d3's interaction and format modules (`d3-selection`,
`d3-zoom`, `d3-brush`, `d3-drag`, `d3-format`, `d3-time-format`,
`d3-interpolate`, `d3-force`), so an app handles zoom and brush gestures with d3
while React keeps rendering: the gesture's transform goes into state. It leaves
out `d3-transition` and `d3-axis`, which write to nodes React owns.

## The app platform

Swamp serves what apps share, so it moves with the server instead of being frozen
into each app. An app bundles only its own code.

### What it holds

Platform 1 is React and ReactDOM, the SDK with its React hooks, the UI kit (the
shadcn components, compiled once as a library), the d3 modules, and the theme
with the kit's compiled CSS. Fast-moving libraries stay out: an app that wants
recharts bundles it, under the dependency audit.

### Serving

Serve answers `/app-platform/<major>/<file>` from the swamp binary, as it does the
dashboard; the hub and the local dashboard answer the same path. The path carries
the major only, so every app on a major gets the newest minor this swamp holds.
The files are not secret, so no launch token: they are answered with
`access-control-allow-origin: *`, because a frame's origin is opaque, and an
ETag. Hashed files (`chunks/`, `assets/`) are `immutable`; entry files keep fixed
names, so they are `no-cache` and revalidate, and an upgrade never leaves a
cached entry asking for a chunk that is gone. An app's `script-src`, `style-src` and `font-src` allow
`/app-platform/<major>/` beside its own files. The modules import each other by
relative path, so one React instance is shared.

### The contract

`app.yaml` names the platform it was built for: `platform: 1`, or `platform: "1.4"`
for an app using something added in 1.4. Serve refuses an app whose platform it
does not hold, or whose minimum minor is newer than its own, and says which.

- Within a major the platform only adds. A dependency's patch or minor release
  ships in the next minor, in place, to every app on that major.
- A breaking change, from swamp or a dependency, is a new major.
- Swamp is to carry the current major and the one before. A major leaving support
  is to be flagged by `swamp app list`, the registry and the dashboard for at
  least one release first; after that its apps are refused with "rebuild against
  platform N". Serving several majors works today (compile embeds every
  `dist/<major>/`, serve answers each), but the build, CI and the audit name
  major 1; a second major needs them to loop over `packages/app-platform/<n>/`.
- Apps get swamp's surface, not raw libraries (the kit's `Button`, not radix), so
  swamp can absorb an upstream break inside a major. Replacements are marked
  deprecated in the types and kept until the next major.

### Source, build and updates

`packages/app-platform/<major>/` holds each supported major: exact pins and a
lockfile for every outside library, the UI kit's source, and the entry module of
each served file. The SDK's source stays in `packages/app-sdk` and
`packages/client`. `deno run build-app-platform` bundles each major into
`packages/app-platform/dist/<major>/`, with a `platform.json` naming the exact
minor, every library version and each file's hash. CI and `verify-build` build
it before compile, and compile embeds it. Compile refuses a missing or stale
build (its minor differs from the source's) unless given `--no-app-platform`; a
binary built that way refuses apps saying it has no app platform.

The minor is kept in `packages/app-platform/<major>/platform.json`, and gates in
`verify-build` keep it honest (`integration/app_platform_rules_test.ts`):

- the export names of swamp's own modules (`sdk`, `sdk-react`, `ui`) are
  snapshotted in `surface.json`; removing one fails, and adding one fails until
  the minor is bumped and `deno run app-platform-surface` is rerun;
- each pinned library's major must match its major's promise (React 19 on 1),
  and the pins must match the lockfile;
- the pinned libraries pass the same OSV and npm trust audit as an extension.

The snapshot holds names, not signatures, so a narrowed type is not caught, and a
library module added to the platform (as the d3 modules in 1.4) bumps the minor
by hand. Fixture apps built against earlier minors are not yet run against the
current one.

An old major is frozen except for security patches, and its folder is deleted when
its window ends.

### Apps

`swampApp()` resolves the platform's modules ahead of Vite, so they never enter
the bundle: a build imports `/app-platform/<major>/<file>`, and `app dev` the
platform's development build, which its Vite server answers from the app's own
copy, so dev needs no dashboard and its CSP names only its own host. `swamp app
init`, `dev` and `build` rewrite `<app>/.swamp-platform/` (git-ignored, never
bundled) from the swamp running them: the SDK's source, the kit's declarations
with the declarations they reach in its libraries, and the dev build. Swamp
carries those last two as one deterministic `authoring.tar.gz` per major,
unpacked into the app; serve answers only the production files, never `dev/`. An app's
`package.json` holds its build tools, and React and d3 for `bun test`, pinned to
the versions the platform serves.

`swamp app init` writes `platform:` as the major and minor of the swamp running
it, and `swamp app build` warns when an app names none.

Apps build with Vite: its dev server carries HMR into the sandbox, and apps with
their own npm libraries need a real bundler. The cost is that build toolchain in
each app's audited dependencies.

## Tests

| Claim | Test |
| --- | --- |
| The client protocol matches serve | `packages/client/protocol_test.ts` |
| Every app reply type matches serve's, field for field | `integration/app_reply_types_parity_test.ts` |
| A stream that stops early stops following, never the run | `packages/client/stream_cancel_test.ts` |
| The exposed set is exactly this list, and each type exists in client and serve | `integration/app_capability_rules_test.ts` |
| Dev differs from production only as pinned | `packages/app-sdk/headers_test.ts` |
| The mock host and the broker behave alike | `packages/testing/app_bridge_conformance.ts` |
| The route keeps its security rules | `src/serve/app_assets_test.ts` |
| `Origin: null` is refused | `src/serve/origin_test.ts` |
| Approvals hold across instances | `integration/apps_test.ts` |

## Not yet

- Safari has not been tried. Chromium and Firefox have.
- A run cannot be started from an app on the local dashboard, so run flows are
  tried against the mock host or under serve.
