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
import { registerFederationModelTypes } from "../src/domain/models/serve/federation_model_types.ts";
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
  buildServeFederationMember,
  type ServeFederationMemberDeps,
} from "../src/cli/commands/serve_federation_member.ts";
import {
  serverRequestPayloadFields,
  serverRequestSchemas,
  validateServerRequest,
} from "../src/serve/connection.ts";
import { exposedRequestTypes } from "../packages/app-sdk/capabilities.ts";
import { consumeStream } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  appApprove,
  type AppDeps,
  appLaunch,
  type AppLaunchData,
  appList,
  type AppListData,
} from "../src/libswamp/apps/apps.ts";
import {
  APP_SOURCE_DIR,
  parseAppDescriptor,
} from "../src/domain/apps/app_descriptor.ts";
import { initializeControlPlaneVault } from "../src/domain/vaults/control_plane_vault_init.ts";
import { ControlPlaneAppApprovalRepository } from "../src/infrastructure/persistence/control_plane_app_store.ts";
import { FilesystemAppCatalog } from "../src/infrastructure/persistence/filesystem_app_catalog.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { VaultAppLaunchKey } from "../src/serve/app_launch_key.ts";
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
  serveSubcommands: ["fingerprint", "member", "hub"],
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
  memberRequestTypes: ["federation.link.get"],
  appCapabilities: ["federation:read"],
} as const;

const EVERY_FEDERATION_REQUEST_TYPE = [
  ...FEDERATION_SURFACES.requestTypes,
  ...FEDERATION_SURFACES.memberRequestTypes,
];

// pinned: the routes every serve has with the gate off; a change here changes every serve
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
  "datastore.history.compact",
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
    payload: type.endsWith(".list") || type === "federation.link.get"
      ? {}
      : { name: "edge-1" },
  };
}

interface Touched {
  requests: number;
  storeCalls: number;
  vaultCalls: number;
}

// every way a member could reach out: the network, the control-plane store, the vault
function memberDeps(
  gate: string | undefined,
  federation: Record<string, unknown> | undefined,
): { deps: ServeFederationMemberDeps; touched: Touched } {
  const touched: Touched = { requests: 0, storeCalls: 0, vaultCalls: 0 };
  const count = (field: keyof Touched) => () => {
    touched[field]++;
    return Promise.reject(new Error("touched"));
  };
  const deps = {
    env: gateEnv(gate),
    merged: federation === undefined ? {} : { federation },
    instanceId: crypto.randomUUID(),
    fetch: count("requests"),
    store: {
      get: count("storeCalls"),
      put: count("storeCalls"),
      delete: count("storeCalls"),
      list: count("storeCalls"),
    },
    tokenSecrets: {
      get: count("vaultCalls"),
      put: count("vaultCalls"),
      delete: count("vaultCalls"),
    },
  } as unknown as ServeFederationMemberDeps;
  return { deps, touched };
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

Deno.test("federation gate: with the gate off, a serve.yaml naming a hub builds no member and makes no outbound request", () => {
  const { deps, touched } = memberDeps(undefined, {
    hub: "https://hub.example.com",
    "join-token-file": "/tmp/join-token.txt",
  });
  assertEquals(buildServeFederationMember(deps), undefined);
  assertEquals(touched, { requests: 0, storeCalls: 0, vaultCalls: 0 });
});

Deno.test("federation gate: with the gate on and no federation block, or a hub's, no member is built and nothing is touched", () => {
  for (const federation of [undefined, { role: "hub" }]) {
    const { deps, touched } = memberDeps("1", federation);
    assertEquals(buildServeFederationMember(deps), undefined);
    assertEquals(touched, { requests: 0, storeCalls: 0, vaultCalls: 0 });
  }
});

Deno.test("federation gate: building a member touches no store, vault or network until it is started", () => {
  const { deps, touched } = memberDeps("1", { hub: "https://hub.example.com" });
  const member = buildServeFederationMember(deps);
  assert(member !== undefined);
  assertEquals(touched, { requests: 0, storeCalls: 0, vaultCalls: 0 });
});

Deno.test("federation gate: without a hub or member, the request types are exactly those every serve accepted before federation", () => {
  assertEquals(
    [...serverRequestPayloadFields().keys()].sort(),
    NON_HUB_REQUEST_TYPES,
  );
  assertEquals(serverRequestSchemas().length, NON_HUB_REQUEST_TYPES.length);
  for (const type of EVERY_FEDERATION_REQUEST_TYPE) {
    assert(!serverRequestPayloadFields().has(type), type);
  }
});

Deno.test("federation gate: without a hub or member, each federation request type is refused exactly as a made-up type is", async () => {
  const madeUp = validateServerRequest(requestSample("federation.made.up"));
  assertEquals(typeof madeUp, "string");
  for (const type of EVERY_FEDERATION_REQUEST_TYPE) {
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
    for (const type of EVERY_FEDERATION_REQUEST_TYPE) {
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

Deno.test("federation gate: with the gate on, a member accepts federation.link.get and none of the hub's requests", () => {
  const onMember = serverRequestPayloadFields({ federationMember: true });
  assertEquals(
    [...onMember.keys()].sort(),
    [...NON_HUB_REQUEST_TYPES, ...FEDERATION_SURFACES.memberRequestTypes]
      .sort(),
  );
  for (const type of FEDERATION_SURFACES.memberRequestTypes) {
    const validated = validateServerRequest(requestSample(type), {
      federationMember: true,
    });
    assert(typeof validated !== "string", `${type}: ${validated}`);
  }
});

const FEDERATION_APP_YAML = `name: "@acme/hub"
title: Hub
bridge: 1
capabilities: [${FEDERATION_SURFACES.appCapabilities.join(", ")}, data:read]
`;

async function withFederationApp(
  fn: (deps: AppDeps & { launchKey: VaultAppLaunchKey }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-federation-app-" });
  try {
    const app = join(repoDir, APP_SOURCE_DIR, "hub");
    await Deno.mkdir(join(app, "dist"), { recursive: true });
    await Deno.writeTextFile(join(app, "app.yaml"), FEDERATION_APP_YAML);
    await Deno.writeTextFile(join(app, "dist", "index.html"), "<html>");
    const store = new FileSystemControlPlaneStore(join(repoDir, ".swamp"));
    const { provider } = await initializeControlPlaneVault(store, false);
    await fn({
      catalog: new FilesystemAppCatalog({ repoDir }),
      approvals: new ControlPlaneAppApprovalRepository(store),
      launchKey: new VaultAppLaunchKey(provider),
      now: () => new Date("2026-11-26T12:00:00.000Z"),
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function finish<T>(
  stream: AsyncIterable<
    { kind: "completed"; data: T } | {
      kind: "error";
      error: { message: string };
    }
  >,
): Promise<{ data?: T; error?: string }> {
  let result: { data?: T; error?: string } = {};
  await consumeStream(stream, {
    completed: (event) => {
      result = { data: event.data };
    },
    error: (event) => {
      result = { error: event.error.message };
    },
  });
  return result;
}

Deno.test("federation gate: with the gate off, an app.yaml naming federation:read is refused as an unknown capability", () => {
  withMockedEnv(GATE_OFF, () => {
    let message = "";
    try {
      parseAppDescriptor(FEDERATION_APP_YAML, "app.yaml");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(message, "app.yaml: capabilities.0: Unknown capability");
  });
  for (const capability of FEDERATION_SURFACES.appCapabilities) {
    assertEquals(
      [...exposedRequestTypes()].some((type) => type.startsWith("federation.")),
      false,
      capability,
    );
  }
});

Deno.test("federation gate: with the gate off, a federation:read app is a catalog problem, never listed, approved or launched", async () => {
  await withFederationApp(async (deps) => {
    await withMockedEnv(GATE_OFF, async () => {
      const ctx = createLibSwampContext();
      const listed = await finish<AppListData>(appList(ctx, deps));
      assertEquals(listed.data!.apps, []);
      assertEquals(listed.data!.problems.length, 1);
      assert(
        listed.data!.problems[0].message.includes("Unknown capability"),
        listed.data!.problems[0].message,
      );
      const approved = await finish(
        appApprove(ctx, deps, { name: "@acme/hub", approvedBy: "user:op" }),
      );
      assert(approved.error !== undefined);
      const launched = await finish<AppLaunchData>(
        appLaunch(ctx, deps, { name: "@acme/hub" }),
      );
      assertEquals(launched.data, undefined);
    });
  });
});

Deno.test("federation gate: with the gate on, the same app lists, approves and launches with federation:read", async () => {
  await withFederationApp(async (deps) => {
    await withMockedEnv(GATE_ON, async () => {
      const ctx = createLibSwampContext();
      const listed = await finish<AppListData>(appList(ctx, deps));
      assertEquals(listed.data!.problems, []);
      assertEquals(listed.data!.apps[0].capabilities, [
        "federation:read",
        "data:read",
      ]);
      const approved = await finish(
        appApprove(ctx, deps, { name: "@acme/hub", approvedBy: "user:op" }),
      );
      assertEquals(approved.error, undefined);
      const launched = await finish<AppLaunchData>(
        appLaunch(ctx, deps, { name: "@acme/hub" }),
      );
      assertEquals(launched.data!.capabilities, [
        "federation:read",
        "data:read",
      ]);
    });
  });
});
