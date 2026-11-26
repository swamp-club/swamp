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

import { assert, assertEquals } from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { join } from "@std/path";
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import { buildCommandTree } from "../src/cli/mod.ts";
import {
  type AnyCommand,
  buildCliSchema,
  type CliCommandSchema,
} from "../src/cli/cli_schema.ts";
import {
  resolveServeRoutes,
  SERVE_ROUTES,
} from "../src/cli/commands/serve_routes.ts";
import { createServeCommand } from "../src/cli/commands/serve_group.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../src/domain/serve/federation_gate.ts";
import {
  loadServeConfig,
  mergeServeOptions,
} from "../src/serve/serve_config.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { modelRegistry } from "../src/domain/models/models.ts";
import { registerFederationModelTypes } from "../src/domain/serve/federation_model_types.ts";
import { resolveHttpRoute } from "../src/serve/http_request_span.ts";
import {
  FEDERATION_CHECK_IN_PATH,
  FEDERATION_HUB_ROUTES,
  FEDERATION_JOIN_PATH,
  routeFederationRequest,
} from "../src/serve/federation/hub_routes.ts";
import {
  buildServeFederationHub,
  type ServeFederationHubDeps,
} from "../src/cli/commands/serve_federation_hub.ts";
import {
  serverRequestPayloadFields,
  serverRequestSchemas,
  validateServerRequest,
} from "../src/serve/connection.ts";
import {
  createServeCtx,
  errorFrame,
  grant,
  sendRequest,
  type ServeRequest,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

/**
 * Every surface Serve Federation adds. Each unit appends what it adds; with
 * the gate off none of them may be reachable.
 */
export const FEDERATION_SURFACES = {
  serveSubcommands: ["fingerprint", "member"],
  serveYamlKeys: ["version", "federation"],
  modelTypes: ["swamp/serve-member"],
  httpRoutes: ["/federation/v1/join", "/federation/v1/check-in"],
  requestTypes: [
    "federation.member.list",
    "federation.member.get",
    "federation.member.remove",
    "federation.token.create",
    "federation.token.list",
    "federation.token.revoke",
  ],
} as const;

// what swamp serve had before federation; a change here changes every serve
const SERVE_ROUTE_NAMES = [
  "reload",
  "check-config",
  "daemon",
  "host",
  "provision-workspace",
  "workspace",
];

// the request types a serve without a federation hub accepts; a change here
// changes what every serve accepts, gate off included
const NON_HUB_REQUEST_TYPES = [
  "access.can-i",
  "access.check",
  "access.delegation.end",
  "access.delegation.list",
  "access.grant.list",
  "access.group.list",
  "access.group.list-idp",
  "access.integration.list",
  "access.reload",
  "access.token.list",
  "access.token.mint",
  "access.token.reveal",
  "access.token.revoke",
  "access.token.rotate",
  "app.approve",
  "app.launch",
  "app.list",
  "app.revoke",
  "audit.alerts",
  "audit.export",
  "audit.query",
  "audit.report",
  "audit.rotate-key",
  "audit.subscribe",
  "audit.timeline",
  "audit.unsubscribe",
  "audit.verify",
  "cancel",
  "cluster.instances",
  "commits.head",
  "commits.subscribe",
  "data.delete",
  "data.gc",
  "data.get",
  "data.list",
  "data.prune",
  "data.query",
  "data.rename",
  "data.search",
  "data.subscribe",
  "data.versions",
  "datastore.claim",
  "datastore.namespace.list",
  "datastore.release",
  "datastore.setup.extension",
  "datastore.status",
  "doctor.datastores",
  "doctor.extensions",
  "doctor.secrets",
  "doctor.vaults",
  "doctor.workflows",
  "extension.info",
  "extension.install",
  "extension.list",
  "extension.outdated",
  "extension.pull",
  "extension.rm",
  "extension.search",
  "extension.update",
  "model.create",
  "model.delete",
  "model.edit",
  "model.evaluate",
  "model.get",
  "model.method.describe",
  "model.method.history.get",
  "model.method.history.logs",
  "model.method.history.search",
  "model.method.run",
  "model.output.data",
  "model.output.get",
  "model.output.logs",
  "model.output.search",
  "model.search",
  "model.type.describe",
  "model.type.search",
  "model.usage.summary",
  "model.validate",
  "report.describe",
  "report.get",
  "report.search",
  "report.type.search",
  "run.attach",
  "run.doctor",
  "run.gc",
  "run.history",
  "serve.config",
  "serve.reload",
  "server.version",
  "summarise",
  "vault.annotate",
  "vault.audit-trail",
  "vault.create",
  "vault.delete",
  "vault.describe",
  "vault.edit",
  "vault.get",
  "vault.inspect",
  "vault.list-keys",
  "vault.migrate",
  "vault.put",
  "vault.read-secret",
  "vault.search",
  "vault.type.search",
  "worker.lease.list",
  "worker.list",
  "worker.prune",
  "worker.queue.list",
  "worker.token.create",
  "worker.token.list",
  "worker.token.reveal",
  "worker.token.revoke",
  "worker.token.rotate",
  "worker.verify",
  "workflow.approvals",
  "workflow.approve",
  "workflow.cancel",
  "workflow.create",
  "workflow.delete",
  "workflow.edit",
  "workflow.evaluate",
  "workflow.get",
  "workflow.history.get",
  "workflow.history.logs",
  "workflow.history.search",
  "workflow.reject",
  "workflow.resume",
  "workflow.run",
  "workflow.run.search",
  "workflow.run.summary",
  "workflow.schedule.list",
  "workflow.schedule.pause",
  "workflow.schedule.resume",
  "workflow.schema",
  "workflow.search",
  "workflow.signal",
  "workflow.trigger.get",
  "workflow.trigger.remove",
  "workflow.trigger.set",
  "workflow.validate",
  "workflow.waits",
  "workspace.create",
  "workspace.delete",
  "workspace.get",
  "workspace.list",
  "workspace.resume",
  "workspace.sign-in",
  "workspace.suspend",
];

const GATE_OFF = { [FEDERATION_GATE_VARIABLE]: undefined };
const GATE_ON = { [FEDERATION_GATE_VARIABLE]: "1" };
const gateEnv = (gate: string | undefined) => (name: string) =>
  name === FEDERATION_GATE_VARIABLE ? gate : undefined;

function requestSample(type: string): ServeRequest {
  return {
    type,
    id: "same-id",
    payload: type.endsWith(".list") ? {} : { name: "edge-1" },
  };
}

function hubDeps(
  gate: string | undefined,
): ServeFederationHubDeps {
  return {
    env: gateEnv(gate),
    merged: { federation: { role: "hub" } },
  } as unknown as ServeFederationHubDeps;
}

function serveChildren(node: AnyCommand | undefined): string[] {
  return (node?.getCommands(true) ?? []).map((c: AnyCommand) => c.getName());
}

function schemaCommandPaths(
  node: CliCommandSchema,
  prefix: string[] = [],
): string[] {
  const path = [...prefix, node.name];
  return [
    path.join(" "),
    ...node.subcommands.flatMap((child) => schemaCommandPaths(child, path)),
  ];
}

Deno.test("federation gate: with the gate off, swamp serve resolves no federation subcommand", async () => {
  const routes = resolveServeRoutes(() => undefined);
  assertEquals(routes, SERVE_ROUTES);
  const names = await withMockedEnv(
    GATE_OFF,
    async () => serveChildren(await createServeCommand()),
  );
  for (const surface of FEDERATION_SURFACES.serveSubcommands) {
    assert(!routes.some((route) => route.name === surface), surface);
    assert(!names.includes(surface), surface);
  }
});

Deno.test("federation gate: with the gate off, the help schema has no federation command, hidden or not", async () => {
  const tree = await withMockedEnv(GATE_OFF, () => buildCommandTree());
  for (const includeHidden of [false, true]) {
    const paths = schemaCommandPaths(
      buildCliSchema(tree, VERSION, { includeHidden }).root,
    );
    for (const surface of FEDERATION_SURFACES.serveSubcommands) {
      assert(
        !paths.some((path) => path.endsWith(`serve ${surface}`)),
        `${surface} (includeHidden: ${includeHidden})`,
      );
    }
  }
});

async function loadWithWarnings(
  yaml: string,
): Promise<{ config: Record<string, unknown> | null; warned: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-federation-gate-" });
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{
      category: ["serve", "config"],
      lowestLevel: "warning",
      sinks: ["capture"],
    }],
    reset: true,
  });
  try {
    await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".swamp", "serve.yaml"), yaml);
    const config = withMockedEnv(
      GATE_OFF,
      () => loadServeConfig(undefined, dir),
    ) as Record<string, unknown> | null;
    const warned = captured
      .filter((r) => String(r.rawMessage).includes("Unknown key"))
      .map((r) => String(r.properties.key));
    return { config, warned };
  } finally {
    await initializeLogging({ _reset: true });
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("federation gate: with the gate off, version and federation load as unknown keys and change nothing", async () => {
  const plain = "port: 9191\nschedule: false\n";
  const withSurfaces = "version: 2\nfederation:\n  role: hub\n" + plain;

  const before = await loadWithWarnings(plain);
  const after = await loadWithWarnings(withSurfaces);
  assertEquals(after.warned, [...FEDERATION_SURFACES.serveYamlKeys]);
  assertEquals(before.warned, []);

  const { version: _v, federation: _f, ...rest } = after.config ?? {};
  assertEquals(rest, before.config);

  const merged = withMockedEnv(
    GATE_OFF,
    () => mergeServeOptions(after.config, {}, new Set()),
  );
  assertEquals("federation" in merged, false);
  assertEquals(
    merged,
    withMockedEnv(
      GATE_OFF,
      () => mergeServeOptions(before.config, {}, new Set()),
    ),
  );
});

Deno.test("federation gate: with the gate off, swamp serve's routes are those it had before federation", () => {
  assertEquals(SERVE_ROUTES.map((route) => route.name), SERVE_ROUTE_NAMES);
});

Deno.test("federation gate: with the gate off, the federation model types stay unregistered", async () => {
  await withMockedEnv(GATE_OFF, async () => {
    for (const type of FEDERATION_SURFACES.modelTypes) {
      assertEquals(modelRegistry.has(type), false, type);
    }
    assertEquals(await registerFederationModelTypes(gateEnv(undefined)), false);
    for (const type of FEDERATION_SURFACES.modelTypes) {
      assertEquals(modelRegistry.has(type), false, type);
    }
  });
});

Deno.test("federation gate: with the gate off, no hub is built and the federation paths fall through to today's 404", async () => {
  assertEquals(
    [...FEDERATION_HUB_ROUTES].sort(),
    [FEDERATION_JOIN_PATH, FEDERATION_CHECK_IN_PATH].sort(),
  );
  assertEquals(await buildServeFederationHub(hubDeps(undefined)), undefined);
  for (const path of FEDERATION_SURFACES.httpRoutes) {
    assertEquals(resolveHttpRoute(path), undefined, path);
    assertEquals(
      await routeFederationRequest(
        new Request(`http://serve.test${path}`, { method: "POST", body: "{}" }),
        { hub: undefined, clientAddress: () => "127.0.0.1" },
      ),
      null,
      path,
    );
  }
});

Deno.test("federation gate: without a hub, the request types are exactly those every serve accepted before federation", () => {
  assertEquals(
    [...serverRequestPayloadFields().keys()].sort(),
    NON_HUB_REQUEST_TYPES,
  );
  assertEquals(serverRequestSchemas().length, NON_HUB_REQUEST_TYPES.length);
  for (const type of FEDERATION_SURFACES.requestTypes) {
    assert(!serverRequestPayloadFields().has(type), type);
  }
});

Deno.test("federation gate: without a hub, each federation request type is refused exactly as a made-up type is", async () => {
  const madeUp = validateServerRequest(requestSample("federation.made.up"));
  assertEquals(typeof madeUp, "string");
  for (const type of FEDERATION_SURFACES.requestTypes) {
    assertEquals(validateServerRequest(requestSample(type)), madeUp, type);
  }
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [grant({
      actions: ["read", "admin"],
      resource: { kind: "access", pattern: "swamp/federation" },
    })]);
    const unknown = errorFrame(
      await sendRequest(ctx, requestSample("federation.made.up")),
    );
    assertEquals(
      (unknown?.error as Record<string, unknown>).code,
      "invalid_request",
    );
    for (const type of FEDERATION_SURFACES.requestTypes) {
      const refused = errorFrame(await sendRequest(ctx, requestSample(type)));
      assertEquals(refused?.error, unknown?.error, type);
    }
  });
});

Deno.test("federation gate: only the gate module names the gate variable", async () => {
  const naming: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    if ((await Deno.readTextFile(file)).includes(FEDERATION_GATE_VARIABLE)) {
      naming.push(repoRelative(file));
    }
  }
  assertEquals(naming, ["src/domain/serve/federation_gate.ts"]);
});

// serve.ts exports one command instance that the group loader registers
// subcommands on, so gate-on trees are built only after every gate-off one
Deno.test("federation gate: with the gate on, swamp serve resolves the federation subcommands", async () => {
  const names = await withMockedEnv(
    GATE_ON,
    async () => serveChildren(await createServeCommand()),
  );
  for (const surface of FEDERATION_SURFACES.serveSubcommands) {
    assert(names.includes(surface), surface);
  }
});

Deno.test("federation gate: with the gate on, the help schema lists the federation commands", async () => {
  const tree = await withMockedEnv(GATE_ON, () => buildCommandTree());
  const paths = schemaCommandPaths(
    buildCliSchema(tree, VERSION).root,
  );
  for (const surface of FEDERATION_SURFACES.serveSubcommands) {
    assert(paths.some((path) => path.endsWith(`serve ${surface}`)), surface);
  }
});

Deno.test("federation gate: with the gate on, a hub registers the member type, routes its paths and accepts the federation requests", async () => {
  try {
    assert(await registerFederationModelTypes(gateEnv("1")));
    for (const type of FEDERATION_SURFACES.modelTypes) {
      assert(modelRegistry.has(type), type);
    }
  } finally {
    for (const type of FEDERATION_SURFACES.modelTypes) {
      modelRegistry.invalidateType(type);
    }
  }
  for (const path of FEDERATION_SURFACES.httpRoutes) {
    assertEquals(resolveHttpRoute(path, FEDERATION_HUB_ROUTES), path);
  }
  const onHub = serverRequestPayloadFields({ federationHub: true });
  assertEquals(
    [...onHub.keys()].sort(),
    [...NON_HUB_REQUEST_TYPES, ...FEDERATION_SURFACES.requestTypes].sort(),
  );
  for (const type of FEDERATION_SURFACES.requestTypes) {
    const validated = validateServerRequest(requestSample(type), {
      federationHub: true,
    });
    assert(typeof validated !== "string", `${type}: ${validated}`);
  }
});
