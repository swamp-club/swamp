# App patterns

Recipes for the shapes most apps take. Each one names the `app.yaml` it needs;
ask for nothing more.

- [The shape of every app](#the-shape-of-every-app)
- [Read-only overview](#read-only-overview)
- [Live data view](#live-data-view)
- [Interactive app backed by a behavior](#interactive-app-backed-by-a-behavior)
- [Run launcher and run monitor](#run-launcher-and-run-monitor)
- [External data](#external-data)
- [Charts](#charts)
- [Views and deep links](#views-and-deep-links)
- [Large result sets](#large-result-sets)
- [Platform modules and extra packages](#platform-modules-and-extra-packages)

## The shape of every app

A behavior is the backend, swamp data is the database, and the app is the view.
The app reads data and runs history, and it changes things only by running a
method or workflow named in `app.yaml`. Anything needing a secret, a server-side
API, or validation runs in a behavior.

```
viewer ── app (sandboxed iframe) ── broker ── serve ── behavior methods ── data
             reads: data.query, run history         writes: method.run, workflow.run
```

Keep data logic in plain `.ts` modules (`src/<feature>/*.ts`) and components
thin, so `bun test` covers the logic without rendering the UI kit.

## Read-only overview

```yaml
capabilities: [runs:read]
```

```tsx
const { data, loading, error } = useRequest("workflow.run.summary", {
  since: "7d",
  workflows: ["nightly"], // optional; exact names
  timeline: true, // hourly buckets in data.timeline
});
const t = data?.data.totals; // runs, succeeded, failed, cancelled, running…
```

Recent runs: `useRequest("workflow.run.search", { since: "24h", limit: 50 })`
gives `data.results[]` with `runId`, `workflowName`, `status`, `startedAt`,
`duration`, `failedStep`, `failureReason`, `stepProgress`.

## Live data view

```yaml
platform: "1.2"
capabilities: [data:read]
```

```tsx
const { data, error, refetch } = useRequest("data.query", {
  predicate: 'modelName == "inventory" && specName == "host"',
  limit: 500,
});
const { version } = useDataChanges({ behaviors: ["inventory"] });
useEffect(() => {
  if (version > 0) refetch();
}, [version, refetch]);
const hosts = data?.data.results.map((r) => r.content) ?? [];
```

- A query returns each item's latest version unless the predicate names
  `version`; add `version >= 0` for history. In predicates, fields of the
  written JSON are `attributes.<k>` (`attributes.status == "down"`).
- In the reply, `content` is the parsed JSON a method wrote; validate its shape
  before use, since an older version of the behavior may have written something
  else.
- Filter `useDataChanges` by `behaviors` (names) or `types`, matching the query,
  so unrelated writes do not refetch.

## Interactive app backed by a behavior

The app writes only by running a method. Write the behavior first
([behavior guide](../../behavior/guide.md),
[extension guide](../../extension/guide.md)): each method validates its
arguments with zod and writes a resource per item.

```yaml
platform: "1.2"
capabilities: [data:read]
methods:
  - behavior: team-board # the name `swamp behavior create` gave it
    type: "@acme/board" # pinned: a behavior of any other type is refused
    methods: [add_ticket, move_ticket] # every other method is refused
```

```tsx
const method = useMethodRun();
async function move(ticket: Ticket, column: Column) {
  try {
    await method.run({
      modelIdOrName: "team-board",
      methodName: "move_ticket",
      inputs: { id: ticket.id, title: ticket.title, column },
    });
  } catch (e) {
    setFailure(e instanceof Error ? e.message : String(e));
  }
}
// method.running disables buttons; the data-change refetch shows the result
```

- Treat method arguments as untrusted input from any viewer allowed to run the
  method. Validate in the behavior's zod `arguments` schema, not in the app, and
  `.parse` what you write: `writeResource` only warns when data does not match
  the resource schema.
- Inputs arrive as literal data: `${{ … }}` in a value is never evaluated.
- Calls overlap; each `run()` resolves or rejects on its own. Methods on one
  behavior instance run one at a time under its lock
  ([concurrency](../../behavior/references/concurrency.md)), so give each action
  its own targeted method (`set_item { release, item, done }`) that reads,
  changes and writes inside the method (read the current items with
  `context.readModelData(context.definition.name, "<spec>")`; see the
  [behavior API](../../extension/references/model/api.md)). Two viewers ticking
  different items then never overwrite each other; send the target state, not a
  toggle. For destructive actions pass the revision the viewer saw and refuse if
  it moved.
- List only the methods the app calls; leave admin methods (delete, reset) off
  the list so the app can never run them. Changing the list sends the app back
  for review.
- Neither the method nor the app is told who the viewer is. Each version a
  method writes carries `tags.initiatedBy` (e.g. `user:alice`), recorded by
  swamp, so show "who" from the reply's `tags`, never from a name the app sends.
- Method failures: `run()` rejects with the error's message on an `error` event,
  or with "<method> finished <status>" when the run ends unsuccessfully.
- Let the change feed refresh the view instead of patching local state from the
  method's reply; it also picks up edits made from the CLI or another viewer.
- A viewer still needs the serve grant to run the method; the app adds no
  rights. The local dashboard refuses method runs, so try writes under
  `swamp serve --dashboard` or against `createMockHost`.

## Run launcher and run monitor

```yaml
run: ["@acme/deploy-site"] # enough to start it and follow what it does
capabilities: [
  runs:read,
  catalog:read,
] # only to attach or list runs, and read inputs
```

```tsx
const { run, following, start, attach, stop } = useWorkflowRun();
await start({
  workflowIdOrName: "@acme/deploy-site",
  inputs: { env: "staging" },
});
// run.status, run.jobs[jobId], run.steps["job/step"].status/.output, run.log
```

- Follow a run started elsewhere: find it with
  `useRequest("workflow.run.search", { workflow: "deploy-site", status: "running" })`
  then `attach(runId)`. Attaching needs `runs:read` only.
- `stop()` or unmounting stops following; the run goes on. An app cannot cancel
  a run.
- Workflow inputs must not contain `${{`; the run is refused.
- Durations: `runClock(run)` is "now" on serve's clock, so
  `runClock(run) - (step.startedAt ?? 0)` ticks correctly on a skewed laptop.
- Build forms from definitions (needs `catalog:read`): `workflow.get` gives a
  workflow's declared inputs, `model.get` a behavior's `methods[].arguments`.

## External data

Never fetch an API that needs a key from the app: the bundle is readable and
apps have no vault. Fetch it in a behavior that reads the key from a vault,
writes the result as data, and runs on a schedule in a workflow. The app reads
the data like any other (Live data view) and may list that workflow under `run:`
for a "refresh now" button.

Plain `fetch` from the app works only for keyless HTTPS APIs that answer CORS
for `Origin: null`. Tell the operator: an app can send anything it can read to
any HTTPS site.

## Charts

Use d3 as a calculator and let React render: d3 scales map values to pixels,
shape generators (`line`, `area`, `arc`) return SVG path strings, and layouts
(`treemap`, `stratify`) compute positions; the component returns `<svg>` JSX
using those numbers. Never `d3.select(…).append(…)`: d3 and React would both own
the same DOM nodes. Every scaffold has the `src/charts/chart_parts.tsx` helpers;
`--template gallery` adds one example per data source. The helpers are
`useChartWidth`, `Legend`, `ChartTooltip`, `AXIS_TEXT` and `AXIS_GRID`.

```tsx
const { ref, width } = useChartWidth();
const x = scaleTime().domain(extent(points, (p) => p.day) as [Date, Date])
  .range([28, width - 8]);
const y = scaleLinear().domain([0, max(points, (p) => p.count) ?? 1]).nice()
  .range([140, 8]);
<div ref={ref}>
  <svg width={width} height={160} role="img" aria-label="Items per day">
    <path
      d={line<P>().x((p) => x(p.day)).y((p) => y(p.count))(points) ?? ""}
      fill="none"
      stroke="var(--chart-1)"
    />
  </svg>
</div>;
```

- Series colours: `var(--chart-1)` … `var(--chart-5)`. Run status:
  `var(--swamp-success)`, `var(--swamp-danger)`, `var(--swamp-running)`,
  `var(--swamp-cancelled)`, `var(--swamp-warning)`. Never literal colours; both
  themes must work.
- Use `role="img"` with an `aria-label` for a static chart; when marks are
  clickable, use `role="group"` and make each mark focusable.
- Show a legend or direct labels: colour alone never identifies a series. Every
  theme colour is at least 3:1 on the card in both modes.
- Use `max`/`extent` from `d3-array`, never `Math.max(...values)` (stack limit
  on large arrays).

### Axes, labels and formats

Draw axes in JSX from `scale.ticks(n)` and label them with `d3-format`
(`format(".2s")`) or `d3-time-format` (`timeFormat("%b %d")`); `d3-axis` is not
needed and would not theme.

### Interaction: d3 handles the gesture, React keeps the state

`d3-zoom`, `d3-brush` and `d3-drag` handle wheel, pinch, touch and extents.
Attach them to a ref and copy what they report into state; React still renders
every mark (platform `"1.4"`).

```tsx
const svg = useRef<SVGSVGElement>(null);
const [t, setT] = useState<ZoomTransform>(zoomIdentity);
useEffect(() => {
  const node = select(svg.current!);
  node.call(
    zoom<SVGSVGElement, unknown>().scaleExtent([1, 40])
      .translateExtent([[0, 0], [width, height]])
      .on("zoom", (e) => setT(e.transform)),
  );
  return () => void node.on(".zoom", null);
}, [width, height]);
const x = t.rescaleX(baseX); // render with x as usual; clip the plot area
```

A brush works the same way: `brushX().on("end", (e) => setRange(e.selection))`,
but d3-brush adds its own nodes, so call it on an empty `<g ref>` React never
fills, and restyle its `.selection` with theme variables in CSS (it sets literal
colours). To keep zoom and brush in step, ignore events whose `sourceEvent` is
null: those are your own programmatic moves.

### Animation

Use CSS transitions on SVG attributes (`transition: d 300ms`, or on `transform`)
or interpolate in `requestAnimationFrame` with `d3-interpolate`. Do not use
`d3-transition`: it changes nodes React owns.

### Force layouts and large data

Run `forceSimulation(nodes)` from `d3-force` without a DOM, copy positions into
state on `tick` (or into a ref and repaint per frame when large), and render in
JSX. Past a few thousand marks draw into a `<canvas>` from a `useEffect` with
the same scales, keeping SVG for axes and overlays.

### When d3 may own a node

Only to port an existing d3 example or for complex enter/exit choreography:
render an empty `<svg ref={ref} />` that React never fills, draw into it with
`select(ref.current).selectAll(…).data(…).join(…)` in a `useEffect`, and keep it
to one component.

## Views and deep links

`useSwamp()` gives `path` (the part of the address after `/apps/<name>`) and
`navigate(path)`, which updates the dashboard's address bar so a view can be
bookmarked and shared. Switch views on `path`; there is no router to install.

```tsx
const { path, navigate } = useSwamp();
const runId = path.startsWith("/runs/") ? path.slice(6) : null;
<Button onClick={() => navigate(`/runs/${id}`)}>Open</Button>;
```

## Large result sets

- `select` projects fields and answers in `data.projected`, not `results`:
  `{ predicate, select: "content.status" }`.
- Page a sorted query: pass `sort: { field: "createdAt", direction: "desc" }`
  and `limit`; when `data.nextCursor` is set, send it back as `cursor`.
- `data.query` returns each item's whole `content`. When items are large, have
  the method also write a small summary resource and query that; fetch one full
  item with `data.get` (`modelIdOrName`, `dataName`) when the viewer opens it.

## Platform modules and extra packages

Swamp serves these, so they never enter the bundle and need no dependency entry
beyond the scaffold's: `react`, `react-dom`, `@swamp-club/app-sdk`,
`@swamp-club/app-sdk/react`, `@swamp-club/ui` (every shadcn component, plus
`cn`), `d3-array`, `d3-scale`, `d3-shape`, `d3-hierarchy`, and from platform
`"1.4"` `d3-selection`, `d3-zoom`, `d3-brush`, `d3-drag`, `d3-format`,
`d3-time-format`, `d3-interpolate`, `d3-force`.

`platform.json` also lists libraries the kit uses inside itself (`lucide-react`,
`date-fns`, `zod`, radix…); those are not importable. Anything else
(`lucide-react` icons, `d3-transition`, `date-fns`, recharts) must be added with
`bun add` (into `dependencies`, which push audits with everything it pulls in),
is bundled into the app, and must come from the npm registry, pinned by
`bun.lock`. Prefer `Intl.DateTimeFormat` and `Intl.NumberFormat` over a date
library. Never add `react` or the UI kit's own libraries (radix, base-ui) as
runtime dependencies; a second React breaks hooks.
