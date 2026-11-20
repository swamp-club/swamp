# App SDK reference

- [Imports](#imports)
- [Provider and context](#provider-and-context)
- [Hooks](#hooks)
- [Requests an app may send](#requests-an-app-may-send)
- [Streams on the client](#streams-on-the-client)
- [Testing with the mock host](#testing-with-the-mock-host)
- [Errors](#errors)

## Imports

| Specifier                   | Holds                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@swamp-club/app-sdk/react` | `SwampAppProvider`, `useSwamp`, `useRequest`, `useWorkflowRun`, `useMethodRun`, `useDataChanges`, `useHealth`, `useTheme`, and their result types (`UseWorkflowRun`…) |
| `@swamp-club/app-sdk`       | every protocol type (`DataRecord`, `WorkflowRunSearchItem`…), `createMockHost`, `connectApp`, `runClock`, `runReducer`, `methodRunReducer`, `SwampClientError`        |
| `@swamp-club/ui`            | the shadcn kit (`Button`, `Card`, `Table`, `Tabs`, `Dialog`, `Select`, `Sidebar`…), `Toaster` and `toast` (platform `"1.3"`), `cn`, `useIsMobile`                     |

Types resolve from `.swamp-platform/` through the scaffold's `tsconfig.json`
paths; run `bunx tsc --noEmit` to type-check. Import platform types with
`import type` from `@swamp-club/app-sdk`, never from `.swamp-platform/`.

## Provider and context

`src/main.tsx` from the scaffold wraps the app in `SwampAppProvider` (with a
`fallback` while connecting) and the kit's `TooltipProvider`, and mounts
`<Toaster />`. Keep all three; call `toast.success(…)` / `toast.error(…)` from
`@swamp-club/ui` for short notices.

`useSwamp()` returns:

| Field                 | Meaning                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app`                 | `name`, `title`, `capabilities`, `run`, `methods`, `local` (true on the local dashboard, where runs and methods are refused) |
| `connected`           | the dashboard's socket is up; requests wait or fail while it is down                                                         |
| `request(type, p?)`   | one typed request; same names and types as `useRequest`                                                                      |
| `client`              | the `SwampClient`, for streams                                                                                               |
| `path`, `navigate(p)` | the app's sub-path and a way to change it (deep links)                                                                       |
| `theme`, `visible`    | light/dark plus tokens; whether the tab is showing                                                                           |

Use `app.local` to disable write controls and say why, rather than letting the
click fail.

## Hooks

```ts
useRequest(type, payload?, { enabled? }) // { data, loading, error, refetch }
```

Re-sends whenever the payload (compared as JSON) or the connection changes.
`enabled: false` holds it until, say, a selection exists. `error` is a string
(the message), not an `Error`. `client.request` in tests is not typed by name:
write `client.request<DataQueryReply>("data.query", …)`.

```ts
useWorkflowRun(); // { run, following, start(payload), attach(runId), stop() }
```

One run at a time; starting or attaching drops the previous one. `start()` and
`attach()` resolve when the run ends or following stops, and never reject: a
stream error lands in `run.error`, so don't `await` them before updating the UI.
`run` is a `RunState`: `runId`, `status` (`idle`, `pending`, `running`,
`succeeded`, `failed`, `skipped`, `cancelled`), `jobs[jobId]`,
`steps["job/step"]` with `output: string[]` and `error`, `log[]`
(`{ at, kind, text, tone }`), `error`. Needs the workflow under `run:` to start,
`runs:read` to attach.

```ts
useMethodRun(); // { state, running, run(payload) } — platform "1.1"
```

`run({ modelIdOrName, methodName, inputs })` resolves with the finished run
(`status`, `dataArtifacts[]`) and rejects with the method's error; a refusal
rejects with a `SwampClientError` whose `code` says why
(`app_capability_denied`). Needs the method in that behavior's `methods:` list
(`app.methods[i]` is `{ behavior, type, methods }`).

```ts
useDataChanges({ behaviors, types, pollMs, enabled }); // { version, mode, changes } — platform "1.2"
```

`version` rises on each change or poll; refetch when it moves. `mode` is
`connecting`, `live` or `polling`. Needs `data:read`.

```ts
useHealth<T>(); // the shared health snapshot (untyped), needs health:read
useTheme(); // { mode, tokens }
```

## Requests an app may send

`useRequest` and `request` accept exactly these names; anything else does not
compile. Each needs the capability shown.

| Request                           | Capability     | Useful payload fields                                                                                                                 |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow.run.summary`            | `runs:read`    | `since`, `until`, `workflows[]`, `timeline`, `recentLimit`                                                                            |
| `workflow.run.search`             | `runs:read`    | `since`, `workflow`, `workflows[]`, `status`, `statuses[]`, `tags`, `limit`                                                           |
| `workflow.history.get`            | `runs:read`    | one run by id: `{ workflowIdOrName: runId, exactRun: true }`; without `exactRun` a workflow name gives its latest run                 |
| `workflow.history.logs`           | `runs:read`    | `{ runIdOrWorkflow, tail? }`; reply `type` is `log`, `no_log_file` or `empty_log`                                                     |
| `workflow.history.search`         | `runs:read`    |                                                                                                                                       |
| `model.usage.summary`             | `runs:read`    | method runs per behavior                                                                                                              |
| `data.query`                      | `data:read`    | `predicate` (CEL), `limit`, `select`, `sort`, `cursor`                                                                                |
| `data.get`                        | `data:read`    | `modelIdOrName`, `dataName`, `version`, `includeContent`                                                                              |
| `data.search`                     | `data:read`    | `query`, `model`, `type`, `tags`, `since`, `limit`                                                                                    |
| `data.versions`                   | `data:read`    | one item's versions: metadata only (`version`, `createdAt`, `size`); read content with `data.get` `version` or a `version >= 0` query |
| `model.output.search`             | `data:read`    |                                                                                                                                       |
| `workflow.search`, `workflow.get` | `catalog:read` | workflow definitions and declared inputs                                                                                              |
| `model.search`, `model.get`       | `catalog:read` | behavior definitions                                                                                                                  |
| `worker.list`                     | `workers:read` |                                                                                                                                       |
| `server.version`                  | none           | serve's version and capabilities                                                                                                      |

Predicate fields (`modelName`, `specName`, `version`, `tags.<k>`,
`attributes.<k>` for the written JSON, `createdAt`…) are in the
[data fields reference](../../data/references/fields.md).

## Streams on the client

The hooks wrap these; use them directly for custom handling. Each takes
`{ signal }`; aborting stops following, never the run.

```ts
client.workflowRunStream(payload, { signal });
client.runAttachStream({ runId }, { signal });
client.modelMethodRunStream(payload, { signal });
client.dataSubscribeStream({ behaviors, cursor }, { signal });
```

`dataSubscribeStream` never ends on its own; in a test, `break` after the pages
you expect or abort the signal, or the test hangs.

## Testing with the mock host

`createMockHost` plays the dashboard and refuses what the given grant would.
`bun test` runs `src/**/*.test.ts`.

```ts
import { connectApp, createMockHost } from "@swamp-club/app-sdk";

const host = createMockHost({
  app: {
    capabilities: ["data:read"],
    methods: [{
      behavior: "team-board",
      type: "@acme/board",
      methods: ["add"],
    }],
  },
  responses: { "data.query": { data: { results: [], total: 0 } } },
  // a function of the payload works too: (p) => ({ … })
  streams: {
    "model.method.run": [
      { kind: "started" },
      { kind: "completed", run: { status: "succeeded", dataArtifacts: [] } },
    ],
    // a failure: [{ kind: "error", error: { message: "no such item" } }]
  },
});
const { client } = await connectApp({}, host.port);
for await (
  const e of client.modelMethodRunStream({
    modelIdOrName: "team-board",
    methodName: "add",
  })
) {
  // started, completed
}
```

For `workflow.run`, script the events `runReducer` folds: `started`
(`{ runId }`), `job_started`/`job_completed`/`job_skipped` (`{ jobId }`),
`step_started`/`step_completed`/`step_failed`/`step_skipped`
(`{ jobId, stepId }`), `method_output`, `suspended`, then `completed` or
`cancelled` (`{ run }`) or `error`. Other kinds are ignored, so a misspelt kind
fails silently: assert on the folded `RunState`, e.g.
`events.reduce((s, e) => runReducer(s, { kind: "event", at: 0, event: e }), IDLE_RUN)`.
For `run.attach` the mock sends `run.attached` first, then the scripted events.
For `data.subscribe`, each entry is a page
`{ kind: "changes", changes, cursor, head }`.

Render tests of kit components are not supported (the kit is types only under
`bun test`); test logic modules and reducers (`runReducer`, `methodRunReducer`)
instead. To see the UI, run `swamp app dev`, or pass a mock host's port to
`SwampAppProvider` (`<SwampAppProvider port={host.port}>`) in a standalone page.

## Errors

| Code / message                                  | Cause                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `app_capability_denied`                         | the request, workflow or behavior is not in `app.yaml`                       |
| `too_many_requests`                             | more than 100 requests in flight from the app (serve's per-connection limit) |
| `not_available_locally`                         | a run, method run or stream the local dashboard does not serve               |
| `method_type_mismatch`                          | the behavior's type is not the one pinned under `methods:`                   |
| `data_feed_unavailable`                         | no change feed (non-v3 datastore); `useDataChanges` polls                    |
| `The app is not connected yet.`                 | `request` called before the provider connected; use `useRequest`             |
| `useSwamp must be used within SwampAppProvider` | a component rendered outside the provider                                    |
