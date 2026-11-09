// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { assertEquals } from "@std/assert";
import type { WebhookConfigEntry } from "./serve_config.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  type WebhookEndpoint,
  WebhookEnvironmentError,
  WebhookService,
} from "./webhook.ts";
import {
  type RouteFileLoad,
  WebhookRoutesDirPlacementError,
} from "./webhook_route_files.ts";
import {
  buildWebhookRouteTable,
  createWebhookRouteApplier,
  createWebhookUpdater,
  FLAG_ROUTES_WARNING,
  type WebhookRouteApplyRecord,
} from "./webhook_reload.ts";

function entry(route: string): WebhookConfigEntry {
  return { route, workflow: "deploy", secret: "s3cret" };
}

function endpoint(route: string): WebhookEndpoint {
  return {
    route,
    workflowIdOrName: "deploy",
    secret: "s3cret",
    verifier: { scheme: "github" },
  };
}

function harness(
  source: "config" | "flag",
  options: {
    flagEndpoints?: WebhookEndpoint[];
    routeFiles?: RouteFileLoad;
    unresolvable?: string[];
  } = {},
) {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const parsed: (readonly WebhookConfigEntry[])[] = [];
  const updater = createWebhookUpdater({
    source,
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
      currentEndpoints: () => [],
    },
    parse: (configs) => {
      parsed.push(configs);
      const bad = configs.find((c) => options.unresolvable?.includes(c.route));
      if (bad) {
        return Promise.reject(new Error(`no vault key for ${bad.route}`));
      }
      return Promise.resolve(configs.map((c) => endpoint(c.route)));
    },
    ...(options.flagEndpoints ? { flagEndpoints: options.flagEndpoints } : {}),
    ...(options.routeFiles
      ? { loadRouteFiles: () => Promise.resolve(options.routeFiles!) }
      : {}),
  });
  return { updater, applied, parsed };
}

function routeFile(file: string, route: string) {
  return {
    file,
    entry: { route, workflow: "deploy", secret: "@vault=hooks:key" },
  };
}

Deno.test("createWebhookUpdater: adds the first route to a service that started with none", async () => {
  const { updater, applied } = harness("config");

  const result = await updater([entry("/hooks/first")]);

  assertEquals(result, { changed: 1, warnings: [], errors: [] });
  assertEquals(applied.map((a) => a.map((e) => e.route)), [["/hooks/first"]]);
  assertEquals(applied[0][0].source, "config");
});

Deno.test("createWebhookUpdater: an empty list clears config routes without parsing", async () => {
  const { updater, applied, parsed } = harness("config");

  const result = await updater([]);

  assertEquals(result, { changed: 0, warnings: [], errors: [] });
  assertEquals(applied, [[]]);
  assertEquals(parsed, []);
});

Deno.test("createWebhookUpdater: flag routes are kept and a serve config list is warned about", async () => {
  const { updater, applied, parsed } = harness("flag", {
    flagEndpoints: [endpoint("/hooks/flag")],
  });

  const result = await updater([entry("/hooks/from-config")]);

  assertEquals(result.warnings, [FLAG_ROUTES_WARNING]);
  assertEquals(
    applied.map((a) => a.map((e) => [e.route, e.source])),
    [[["/hooks/flag", "flag"]]],
  );
  assertEquals(parsed, []);
});

Deno.test("createWebhookUpdater: flag routes with no serve config list reload silently", async () => {
  const { updater } = harness("flag", {
    flagEndpoints: [endpoint("/hooks/flag")],
  });

  const result = await updater([]);

  assertEquals(result.warnings, []);
  assertEquals(result.errors, []);
});

Deno.test("createWebhookUpdater: route files reload in flag mode alongside the fixed flag routes", async () => {
  const { updater, applied } = harness("flag", {
    flagEndpoints: [endpoint("/hooks/flag")],
    routeFiles: { files: [routeFile("a.yaml", "/hooks/a")], refused: [] },
  });

  await updater([]);

  assertEquals(
    applied[0].map((e) => [e.route, e.source, e.file]),
    [["/hooks/flag", "flag", undefined], ["/hooks/a", "file", "a.yaml"]],
  );
});

Deno.test("createWebhookUpdater: a serve config route shadows a file route on the same path", async () => {
  const { updater, applied } = harness("config", {
    routeFiles: {
      files: [
        routeFile("gh.yaml", "/hooks/gh"),
        routeFile("b.yaml", "/hooks/b"),
      ],
      refused: [],
    },
  });

  const result = await updater([entry("/hooks/gh")]);

  assertEquals(
    applied[0].map((e) => [e.route, e.source]),
    [["/hooks/gh", "config"], ["/hooks/b", "file"]],
  );
  assertEquals(result.warnings, [
    "Shadowed webhook route file gh.yaml (route /hooks/gh): the serve config " +
    "defines the same route, which serve uses instead",
  ]);
});

Deno.test("createWebhookUpdater: a route file that fails to parse is refused alone", async () => {
  const { updater, applied } = harness("config", {
    routeFiles: {
      files: [routeFile("a.yaml", "/hooks/a"), routeFile("b.yaml", "/hooks/b")],
      refused: [{
        file: "c.yaml",
        message: "Refused webhook route file c.yaml: bad",
      }],
    },
    unresolvable: ["/hooks/a"],
  });

  const result = await updater([entry("/hooks/op")]);

  assertEquals(
    applied[0].map((e) => e.route),
    ["/hooks/op", "/hooks/b"],
  );
  assertEquals(result.errors, [
    "Refused webhook route file c.yaml: bad",
    "Refused webhook route file a.yaml (route /hooks/a): no vault key for /hooks/a",
  ]);
});

Deno.test("createWebhookUpdater: a parse failure leaves the routes untouched", async () => {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const updater = createWebhookUpdater({
    source: "config",
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
      currentEndpoints: () => [],
    },
    parse: () => Promise.reject(new Error("vault unreachable")),
  });

  let message = "";
  try {
    await updater([entry("/hooks/a")]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(message, "vault unreachable");
  assertEquals(applied, []);
});

Deno.test("createWebhookUpdater: a routes directory that cannot be used drops file routes but still applies operator routes", async () => {
  const applied: (readonly WebhookEndpoint[])[] = [];
  const updater = createWebhookUpdater({
    source: "config",
    service: {
      updateEndpoints: (endpoints) => {
        applied.push(endpoints);
        return endpoints.length;
      },
      currentEndpoints: () => [],
    },
    parse: (configs) => Promise.resolve(configs.map((c) => endpoint(c.route))),
    loadRouteFiles: () =>
      Promise.reject(
        new Error("Webhook routes directory x holds extension code"),
      ),
  });

  const result = await updater([entry("/hooks/op")]);

  assertEquals(applied.map((a) => a.map((e) => e.route)), [["/hooks/op"]]);
  assertEquals(result.errors, [
    "Webhook routes directory x holds extension code",
  ]);
});

function outageHarness(files: string[]) {
  const state = { vaultUp: true, files: [...files] };
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [],
  });
  const deps = {
    source: "config" as const,
    parse: (configs: readonly WebhookConfigEntry[]) =>
      state.vaultUp
        ? Promise.resolve(configs.map((c) => endpoint(c.route)))
        : Promise.reject(new WebhookEnvironmentError("backend timed out")),
    loadRouteFiles: () =>
      Promise.resolve({
        files: state.files.map((name) =>
          routeFile(`${name}.yaml`, `/hooks/${name}`)
        ),
        refused: [],
      }),
  };
  const updater = createWebhookUpdater({ ...deps, service });
  return { state, service, deps, updater };
}

const routes = (service: WebhookService) =>
  service.listEndpoints().map((e) => [e.route, e.source]);

Deno.test("createWebhookUpdater: a vault outage keeps unchanged file routes live and reports them", async () => {
  const { state, service, updater } = outageHarness(["a", "b"]);
  await updater([]);
  assertEquals(routes(service), [["/hooks/a", "file"], ["/hooks/b", "file"]]);

  state.vaultUp = false;
  const result = await updater([]);

  assertEquals(result.changed, 0);
  assertEquals(routes(service), [["/hooks/a", "file"], ["/hooks/b", "file"]]);
  assertEquals(result.errors, [
    "Kept the live endpoint for webhook route file a.yaml (route /hooks/a), unchanged since it last loaded: backend timed out",
    "Kept the live endpoint for webhook route file b.yaml (route /hooks/b), unchanged since it last loaded: backend timed out",
  ]);
});

Deno.test("createWebhookUpdater: routes kept through consecutive outages reload normally once the vault recovers", async () => {
  const { state, service, updater } = outageHarness(["a"]);
  await updater([]);
  state.vaultUp = false;
  await updater([]);
  const second = await updater([]);
  assertEquals(second.errors.length, 1);
  assertEquals(routes(service), [["/hooks/a", "file"]]);

  state.vaultUp = true;
  const recovered = await updater([]);

  assertEquals(recovered.errors, []);
  assertEquals(routes(service), [["/hooks/a", "file"]]);
});

Deno.test("createWebhookUpdater: a file deleted during an outage is removed", async () => {
  const { state, service, updater } = outageHarness(["a", "b"]);
  await updater([]);

  state.vaultUp = false;
  state.files = ["a"];
  const result = await updater([]);

  assertEquals(result.changed, 1);
  assertEquals(routes(service), [["/hooks/a", "file"]]);
});

Deno.test("buildWebhookRouteTable: an outage at startup refuses file routes, with no live table to keep", async () => {
  const { state, deps } = outageHarness(["a"]);
  state.vaultUp = false;

  const table = await buildWebhookRouteTable(deps, []);

  assertEquals(table.endpoints, []);
  assertEquals(table.kept, []);
  assertEquals(table.refused.map((r) => r.message), [
    "Refused webhook route file a.yaml (route /hooks/a): backend timed out",
  ]);
});

Deno.test("createWebhookUpdater: an outage with config routes fails the reload and leaves every route live", async () => {
  const { state, service, updater } = outageHarness(["a"]);
  await updater([entry("/hooks/op")]);
  assertEquals(routes(service), [["/hooks/op", "config"], [
    "/hooks/a",
    "file",
  ]]);

  state.vaultUp = false;
  let failed = false;
  try {
    await updater([entry("/hooks/op")]);
  } catch (error) {
    failed = error instanceof WebhookEnvironmentError;
  }

  assertEquals(failed, true);
  assertEquals(routes(service), [["/hooks/op", "config"], [
    "/hooks/a",
    "file",
  ]]);
});

type FileState =
  | { kind: "ok"; route: string; secret?: string; workflow?: string }
  | { kind: "broken" };

function lastGoodHarness(files: Record<string, FileState>) {
  const state = {
    files: { ...files },
    directory: "ok" as "ok" | "unreadable" | "placement",
    untrusted: new Set<string>(),
    // parse answers by route, so an unchanged file can start failing
    missing: new Set<string>(),
    down: new Set<string>(),
  };
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [],
  });
  const records: WebhookRouteApplyRecord[] = [];
  let outages = 0;
  const applier = createWebhookRouteApplier({
    source: "config",
    service,
    parse: (configs) => {
      const [config] = configs;
      if (
        config.secret.includes("missing") || state.missing.has(config.route)
      ) {
        return Promise.reject(new Error(`no key for ${config.route}`));
      }
      if (config.secret.includes("down") || state.down.has(config.route)) {
        outages++;
        return Promise.reject(
          new WebhookEnvironmentError(`vault timed out (request ${outages})`),
        );
      }
      return Promise.resolve(configs.map((c) => ({
        ...endpoint(c.route),
        workflowIdOrName: c.workflow,
      })));
    },
    loadRouteFiles: () => {
      if (state.directory === "unreadable") {
        return Promise.reject(new Error("Failed to read webhook routes dir"));
      }
      if (state.directory === "placement") {
        return Promise.reject(
          new WebhookRoutesDirPlacementError("routes dir is inside .swamp"),
        );
      }
      const loaded: { file: string; entry: WebhookConfigEntry }[] = [];
      const refused: { file: string; route?: string; message: string }[] = [];
      for (const [file, fs] of Object.entries(state.files).sort()) {
        if (fs.kind === "broken") {
          refused.push({
            file,
            message: `Refused webhook route file ${file}: bad YAML`,
          });
          continue;
        }
        loaded.push({
          file,
          entry: {
            route: fs.route,
            workflow: fs.workflow ?? "deploy",
            secret: fs.secret ?? "@vault=hooks:key",
          },
        });
      }
      const counts = new Map<string, number>();
      for (const l of loaded) {
        counts.set(l.entry.route, (counts.get(l.entry.route) ?? 0) + 1);
      }
      for (const l of loaded.filter((l) => counts.get(l.entry.route)! > 1)) {
        refused.push({
          file: l.file,
          route: l.entry.route,
          message:
            `Refused webhook route file ${l.file} (route ${l.entry.route}): another file claims this route`,
        });
      }
      return Promise.resolve({
        files: loaded.filter((l) => counts.get(l.entry.route) === 1),
        refused,
      });
    },
    keepRefusal: (ep) =>
      state.untrusted.has(ep.route) ? "its scheme is untrusted" : undefined,
    onApplied: (record) => records.push(record),
  });
  const live = () =>
    service.listEndpoints().map((e) => `${e.route}<-${e.file ?? e.source}`);
  const workflowOf = (route: string) =>
    service.currentEndpoints().find((e) => e.route === route)
      ?.workflowIdOrName;
  return { state, service, applier, records, live, workflowOf };
}

Deno.test("createWebhookRouteApplier: a route file edited into bad YAML keeps its last good route", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.files["a.yaml"] = { kind: "broken" };
  const result = await applier.update([]);

  assertEquals(live(), ["/hooks/a<-a.yaml"]);
  assertEquals(result.changed, 0);
  assertEquals(result.errors, [
    "Refused webhook route file a.yaml: bad YAML; its last good route /hooks/a keeps serving until the file loads",
  ]);
  assertEquals(applier.status().kept.map((k) => [k.file, k.reason]), [[
    "a.yaml",
    "last_good",
  ]]);
  assertEquals(applier.status().refused, []);
});

Deno.test("createWebhookRouteApplier: an edit refused at parse keeps the previous version serving", async () => {
  const { state, applier, live, workflowOf } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a", workflow: "v1" },
  });
  await applier.update([]);

  state.files["a.yaml"] = {
    kind: "ok",
    route: "/hooks/a",
    workflow: "v2",
    secret: "@vault=hooks:missing",
  };
  await applier.update([]);
  assertEquals(live(), ["/hooks/a<-a.yaml"]);
  assertEquals(workflowOf("/hooks/a"), "v1");

  state.files["a.yaml"] = { kind: "ok", route: "/hooks/a", workflow: "v2" };
  await applier.update([]);
  assertEquals(workflowOf("/hooks/a"), "v2");
  assertEquals(applier.status().kept, []);
});

Deno.test("createWebhookRouteApplier: an edit that fails during an outage keeps the previous version", async () => {
  const { state, applier, workflowOf } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a", workflow: "v1" },
  });
  await applier.update([]);

  state.files["a.yaml"] = {
    kind: "ok",
    route: "/hooks/a",
    workflow: "v2",
    secret: "@vault=hooks:down",
  };
  await applier.update([]);

  assertEquals(workflowOf("/hooks/a"), "v1");
  assertEquals(applier.status().kept[0].reason, "last_good");
});

Deno.test("createWebhookRouteApplier: an unchanged file whose vault key is gone is dropped", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.missing.add("/hooks/a");
  await applier.update([]);

  assertEquals(live(), []);
  assertEquals(applier.status().kept, []);
  assertEquals(applier.status().refused.map((r) => r.message), [
    "Refused webhook route file a.yaml (route /hooks/a): no key for /hooks/a",
  ]);
});

Deno.test("createWebhookRouteApplier: a deleted route file is removed even with a last good route", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
    "b.yaml": { kind: "ok", route: "/hooks/b" },
  });
  await applier.update([]);

  delete state.files["a.yaml"];
  const result = await applier.update([]);

  assertEquals(live(), ["/hooks/b<-b.yaml"]);
  assertEquals(result.changed, 1);
});

Deno.test("createWebhookRouteApplier: a new file clashing with a live route leaves the live route serving", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.files["b.yaml"] = { kind: "ok", route: "/hooks/a" };
  await applier.update([]);

  assertEquals(live(), ["/hooks/a<-a.yaml"]);
  assertEquals(applier.status().kept.map((k) => k.file), ["a.yaml"]);
  assertEquals(applier.status().refused.map((r) => r.file), ["b.yaml"]);
});

Deno.test("createWebhookRouteApplier: a file that loads beats a kept route on the same path", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
    "b.yaml": { kind: "ok", route: "/hooks/b" },
  });
  await applier.update([]);

  state.files["a.yaml"] = { kind: "broken" };
  state.files["b.yaml"] = { kind: "ok", route: "/hooks/a" };
  await applier.update([]);

  assertEquals(live(), ["/hooks/a<-b.yaml"]);
  assertEquals(applier.status().kept, []);
  assertEquals(applier.status().refused.map((r) => r.file), ["a.yaml"]);
});

Deno.test("createWebhookRouteApplier: a last good route whose scheme is no longer trusted is dropped", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.files["a.yaml"] = { kind: "broken" };
  state.untrusted.add("/hooks/a");
  await applier.update([]);

  assertEquals(live(), []);
  assertEquals(applier.status().kept, []);
  assertEquals(applier.status().refused.map((r) => r.file), ["a.yaml"]);
});

Deno.test("createWebhookRouteApplier: an outage-kept route whose scheme is no longer trusted is dropped", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.down.add("/hooks/a");
  await applier.update([]);
  assertEquals(live(), ["/hooks/a<-a.yaml"]);

  state.untrusted.add("/hooks/a");
  await applier.update([]);
  assertEquals(live(), []);
  assertEquals(applier.status().refused.map((r) => r.message), [
    "Refused webhook route file a.yaml (route /hooks/a): its scheme is untrusted",
  ]);
});

Deno.test("createWebhookRouteApplier: an unreadable routes directory keeps every file route", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
    "b.yaml": { kind: "ok", route: "/hooks/b" },
  });
  await applier.update([]);

  state.directory = "unreadable";
  const result = await applier.update([]);

  assertEquals(live(), ["/hooks/a<-a.yaml", "/hooks/b<-b.yaml"]);
  assertEquals(result.errors[0], "Failed to read webhook routes dir");
  assertEquals(applier.status().kept.map((k) => [k.file, k.reason]), [
    ["a.yaml", "outage"],
    ["b.yaml", "outage"],
  ]);
  assertEquals(
    applier.status().directoryError,
    "Failed to read webhook routes dir",
  );
});

Deno.test("createWebhookRouteApplier: a routes directory refused by placement drops the file routes", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.directory = "placement";
  await applier.update([]);

  assertEquals(live(), []);
  assertEquals(applier.status().kept, []);
});

Deno.test("createWebhookRouteApplier: reapplyRouteFiles keeps the live serve config routes", async () => {
  const { state, applier, live } = lastGoodHarness({});
  await applier.update([entry("/hooks/op")]);

  state.files["a.yaml"] = { kind: "ok", route: "/hooks/a" };
  await applier.reapplyRouteFiles({ trigger: "poll" });

  assertEquals(live(), ["/hooks/op<-config", "/hooks/a<-a.yaml"]);
  assertEquals(applier.status().lastApplied?.trigger, "poll");
});

Deno.test("createWebhookRouteApplier: records one apply per change, with its trigger and principal", async () => {
  const { state, applier, records } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([], {
    trigger: "reload",
    principal: { kind: "user", id: "ada" },
  });
  await applier.reapplyRouteFiles({ trigger: "poll" });
  assertEquals(records.length, 1);
  assertEquals(records[0].context.principal?.id, "ada");
  assertEquals(records[0].diff.added.map((c) => [c.route, c.file]), [[
    "/hooks/a",
    "a.yaml",
  ]]);
  assertEquals(records[0].outcome, "success");

  state.files["a.yaml"] = { kind: "broken" };
  await applier.reapplyRouteFiles({ trigger: "poll" });
  await applier.reapplyRouteFiles({ trigger: "poll" });
  assertEquals(records.length, 2);
  assertEquals(records[1].context.trigger, "poll");
  assertEquals(records[1].outcome, "failure");
  assertEquals(records[1].kept.map((k) => k.file), ["a.yaml"]);
});

Deno.test("createWebhookRouteApplier: a reload and a poll apply one after the other", async () => {
  const { state, service, applier } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  const seen: number[] = [];
  const original = service.currentEndpoints.bind(service);
  service.currentEndpoints = () => {
    seen.push(original().length);
    return original();
  };
  await Promise.all([
    applier.update([]),
    applier.reapplyRouteFiles({ trigger: "poll" }),
  ]);
  assertEquals(seen, [0, 1]);
  assertEquals(state.files["a.yaml"].kind, "ok");
});

Deno.test("createWebhookRouteApplier: health reports the startup table before any reload", () => {
  const service = new WebhookService({
    repoDir: "/tmp/fake",
    syncGate: undefined,
    repoContext: {} as RepositoryContext,
    datastoreConfig: {} as DatastoreConfig,
    endpoints: [],
  });
  const applier = createWebhookRouteApplier({
    source: "config",
    service,
    parse: () => Promise.resolve([]),
    initialTable: {
      endpoints: [],
      refused: [{
        file: "a.yaml",
        message: "Refused webhook route file a.yaml",
      }],
      kept: [],
      shadowed: [],
      retryable: false,
    },
    now: () => new Date("2026-11-09T00:00:00.000Z"),
  });
  assertEquals(applier.status().lastApplied, {
    at: "2026-11-09T00:00:00.000Z",
    trigger: "startup",
  });
  assertEquals(applier.status().refused.map((r) => r.file), ["a.yaml"]);
});

Deno.test("createWebhookRouteApplier: a new file refused during an outage asks to be applied again", async () => {
  const { state, applier, live } = lastGoodHarness({});
  await applier.update([]);

  state.files["a.yaml"] = { kind: "ok", route: "/hooks/a" };
  state.down.add("/hooks/a");
  const during = await applier.reapplyRouteFiles({ trigger: "poll" });
  assertEquals(during.retryable, true);
  assertEquals(live(), []);

  state.down.delete("/hooks/a");
  const after = await applier.reapplyRouteFiles({ trigger: "poll" });
  assertEquals(after.retryable, undefined);
  assertEquals(live(), ["/hooks/a<-a.yaml"]);
});

Deno.test("createWebhookRouteApplier: a content refusal does not ask to be applied again", async () => {
  const { state, applier } = lastGoodHarness({});
  state.files["a.yaml"] = { kind: "broken" };
  state.files["b.yaml"] = {
    kind: "ok",
    route: "/hooks/b",
    secret: "@vault=hooks:missing",
  };
  const result = await applier.reapplyRouteFiles({ trigger: "poll" });
  assertEquals(result.retryable, undefined);
  assertEquals(result.errors.length, 2);
});

Deno.test("createWebhookRouteApplier: a last good route whose vault key was revoked is not kept", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.files["a.yaml"] = { kind: "broken" };
  state.missing.add("/hooks/a");
  const result = await applier.update([]);

  assertEquals(live(), []);
  assertEquals(applier.status().kept, []);
  assertEquals(result.errors, [
    "Refused webhook route file a.yaml: bad YAML; its last good route /hooks/a was not kept: no key for /hooks/a",
  ]);
});

Deno.test("createWebhookRouteApplier: a last good route rechecked during an outage keeps serving", async () => {
  const { state, applier, live } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
  });
  await applier.update([]);

  state.files["a.yaml"] = { kind: "broken" };
  state.down.add("/hooks/a");
  await applier.update([]);

  assertEquals(live(), ["/hooks/a<-a.yaml"]);
  assertEquals(applier.status().kept.map((k) => k.reason), ["last_good"]);
});

Deno.test("createWebhookRouteApplier: a dropped last good route says why it was not kept", async () => {
  const { state, applier } = lastGoodHarness({
    "a.yaml": { kind: "ok", route: "/hooks/a" },
    "b.yaml": { kind: "ok", route: "/hooks/b" },
  });
  await applier.update([]);

  state.files["a.yaml"] = { kind: "broken" };
  state.files["b.yaml"] = { kind: "ok", route: "/hooks/a" };
  const result = await applier.update([]);

  assertEquals(result.errors, [
    "Refused webhook route file a.yaml: bad YAML; its last good route /hooks/a was not kept: b.yaml now serves it",
  ]);
});

Deno.test("createWebhookRouteApplier: a poll never re-parses serve config routes, so their vault outage cannot fail it", async () => {
  const { state, applier, live } = lastGoodHarness({});
  await applier.update([entry("/hooks/op")]);

  state.down.add("/hooks/op");
  state.files["a.yaml"] = { kind: "ok", route: "/hooks/a" };
  const result = await applier.reapplyRouteFiles({ trigger: "poll" });

  assertEquals(result.errors, []);
  assertEquals(live(), ["/hooks/op<-config", "/hooks/a<-a.yaml"]);
});

Deno.test("createWebhookRouteApplier: a refusal whose message changes between polls audits once", async () => {
  const { state, applier, records } = lastGoodHarness({});
  state.files["a.yaml"] = { kind: "ok", route: "/hooks/a" };
  state.down.add("/hooks/a");
  const first = await applier.reapplyRouteFiles({ trigger: "poll" });
  const second = await applier.reapplyRouteFiles({ trigger: "poll" });

  assertEquals(first.errors[0] === second.errors[0], false);
  assertEquals(records.length, 1);
});
