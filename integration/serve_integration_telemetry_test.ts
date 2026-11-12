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
import { waitFor } from "@swamp-club/swamp-testing";
import { integrationCredentialHash } from "../src/domain/access/integration_credential.ts";
import { integrationDefinitionName } from "../src/domain/models/access/integration_model.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import type { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../src/domain/telemetry/repositories.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../src/cli/telemetry_integration.ts";
import { handleMessage } from "../src/serve/connection.ts";
import {
  type ConnectionContext,
  setConnectionClient,
  setConnectionDelegation,
} from "../src/serve/handlers/shared.ts";
import { setServeCollectivesSource } from "../src/serve/telemetry.ts";
import { IntegrationDirectory } from "../src/domain/access/integration_directory.ts";
import { ClubHeartbeatService } from "../src/serve/club_heartbeat_service.ts";
import {
  registerInstance,
  sendInstanceHeartbeat,
} from "../src/serve/oauth_client.ts";
import {
  beatOnIntegrationChange,
  withReportedIntegrations,
} from "../src/serve/club_integration_report.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../src/serve/active_run_registry.ts";
import "../src/domain/models/models.ts";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import type { DelegationLookup } from "../src/domain/access/delegation_directory.ts";
import type { DelegationRecord } from "../src/domain/models/access/delegation_model.ts";
import {
  CALLER,
  createServeCtx,
  type Frame,
  grant,
  saveGatedWorkflow,
  saveModel,
  saveWorkflow,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const INTEGRATION_ID = "acme-slack";
const INTEGRATION_CLIENT = `integration:${INTEGRATION_ID}`;

class CapturingRepository implements TelemetryRepository {
  saved: TelemetryEntry[] = [];
  save(entry: TelemetryEntry): Promise<void> {
    this.saved.push(entry);
    return Promise.resolve();
  }
  findByDate(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  findByDateRange(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  deleteOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  deleteAllOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
  findUnflushed(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }
  markFlushed(): Promise<boolean> {
    return Promise.resolve(true);
  }
  quarantine(): Promise<void> {
    return Promise.resolve();
  }
  deleteQuarantinedOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
}

async function withTelemetry(
  fn: (repo: CapturingRepository) => Promise<void>,
  options: { enabled?: boolean } = {},
): Promise<void> {
  const repo = new CapturingRepository();
  if (options.enabled !== false) {
    setActiveTelemetryService(new TelemetryService(repo, "1.0.0"));
  }
  const restore = setServeCollectivesSource(() => ["acme"]);
  try {
    await fn(repo);
  } finally {
    restore();
    clearActiveTelemetryService();
  }
}

interface Caller {
  client?: string;
  delegation?: string;
}

/** like the harness's sendRequest, but with a delegation id of its own */
async function send(
  ctx: ConnectionContext,
  type: string,
  payload: Record<string, unknown>,
  caller: Caller,
): Promise<Frame[]> {
  const id = crypto.randomUUID();
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  if (caller.client !== undefined) setConnectionClient(socket, caller.client);
  if (caller.delegation !== undefined) {
    setConnectionDelegation(socket, caller.delegation);
  }
  const active = new Map<string, AbortController>();
  await handleMessage(
    socket,
    ctx,
    active,
    new MessageEvent("message", {
      data: JSON.stringify({ type, id, payload }),
    }),
    CALLER,
  );
  await waitFor(() => !active.has(id), `${type} ${id} finished`);
  return sent
    .map((raw) => JSON.parse(raw) as Frame)
    .filter((frame) => frame.id === undefined || frame.id === id);
}

function runIdOf(frames: Frame[]): string {
  for (const frame of frames) {
    const event = frame.event as { runId?: unknown } | undefined;
    if (typeof event?.runId === "string") return event.runId;
  }
  throw new Error(`no run id in ${JSON.stringify(frames)}`);
}

// every delegation in these tests belongs to the one integration
const DELEGATIONS: DelegationLookup = {
  standingOf: () => ({
    kind: "standing",
    ceiling: Ceiling.parse({
      version: 1,
      ceiling: [{
        actions: ["approve", "read", "run", "signal"],
        resource: "workflow:*",
      }],
    }),
  }),
  recordOf: () => ({ integrationId: INTEGRATION_ID }) as DelegationRecord,
};

const WORKFLOWS = grant({
  actions: ["read", "run", "approve", "signal", "write"],
  resource: { kind: "workflow", pattern: "*" },
});

const MODELS = grant({
  actions: ["read", "run", "write"],
  resource: { kind: "model", pattern: "*" },
});

const ADMIN = grant({
  actions: ["admin"],
  resource: { kind: "access", pattern: "*" },
});

function eventsOf(repo: CapturingRepository) {
  return repo.saved.map((entry) => entry.toData());
}

function pathOf(data: ReturnType<TelemetryEntry["toData"]>): string {
  return (data.invocation.commandPath ?? []).join(" ");
}

/** a run, a method run and every gate and run control, made by one caller */
async function everyAction(
  repo: ServeRepo,
  ctx: ConnectionContext,
  caller: Caller,
): Promise<void> {
  const model = await saveModel(repo, `m-${crypto.randomUUID().slice(0, 8)}`);
  // an integration's ceiling covers workflows only, so its method runs are steps
  if (!caller.client?.startsWith("integration:")) {
    await send(ctx, "model.method.run", {
      modelIdOrName: model.name,
      methodName: "noop",
      inputs: {},
    }, caller);
  }
  const stepped = `s-${crypto.randomUUID().slice(0, 8)}`;
  await saveWorkflow(repo, stepped, model);
  await send(ctx, "workflow.run", { workflowIdOrName: stepped }, caller);

  const workflow = `w-${crypto.randomUUID().slice(0, 8)}`;
  await saveGatedWorkflow(repo, workflow, "gate");
  const gate = (runId: string) => ({
    workflowIdOrName: workflow,
    stepName: "gate",
    runId,
  });
  const approved = runIdOf(
    await send(ctx, "workflow.run", { workflowIdOrName: workflow }, caller),
  );
  await send(ctx, "workflow.approve", gate(approved), caller);
  const rejected = runIdOf(
    await send(ctx, "workflow.run", { workflowIdOrName: workflow }, caller),
  );
  await send(ctx, "workflow.reject", gate(rejected), caller);
  const cancelled = runIdOf(
    await send(ctx, "workflow.run", { workflowIdOrName: workflow }, caller),
  );
  await send(ctx, "workflow.cancel", {
    runId: cancelled,
    workflowIdOrName: workflow,
  }, caller);
  await send(ctx, "workflow.resume", {
    workflowIdOrName: workflow,
    runId: cancelled,
  }, caller);
  await send(ctx, "workflow.signal", {
    workflow,
    key: "nobody-waits",
    payload: {},
  }, caller);
}

const ACTIONS = [
  "workflow run",
  "workflow approve",
  "workflow reject",
  "workflow cancel",
  "workflow resume",
  "workflow signal",
];

Deno.test("serve telemetry: every action through a delegated token sends one event naming the integration, and never the delegation", async () => {
  await withServeRepo(async (repo) => {
    await withTelemetry(async (telemetry) => {
      const ctx = createServeCtx(repo, [WORKFLOWS, MODELS], {
        delegations: DELEGATIONS,
      });
      const delegation = `d-${crypto.randomUUID()}`;
      await everyAction(repo, ctx, {
        client: INTEGRATION_CLIENT,
        delegation,
      });

      const parents = eventsOf(telemetry).filter((data) =>
        data.parentInvocationId === undefined
      );
      for (const action of ACTIONS) {
        const matching = parents.filter((data) => pathOf(data) === action);
        const expected = action === "workflow run" ? 4 : 1;
        assertEquals(matching.length, expected, action);
      }
      const steps = eventsOf(telemetry).filter((data) =>
        data.parentInvocationId !== undefined
      );
      assertEquals(steps.length, 1, "the model step's own entry");
      assertEquals(parents.length, ACTIONS.length + 3);
      for (const data of eventsOf(telemetry)) {
        assertEquals(data.client, "integration", pathOf(data));
        assertEquals(data.integrationId, INTEGRATION_ID, pathOf(data));
        assertEquals(data.serveCollectives, ["acme"], pathOf(data));
        assertEquals(data.initiatedBy, `user:${CALLER.id}`, pathOf(data));
      }
      const sent = JSON.stringify(eventsOf(telemetry));
      assertEquals(sent.includes(delegation), false);
      assertEquals(
        sent.split(INTEGRATION_ID).length - 1,
        eventsOf(telemetry).length,
        "the id appears once per event, as integrationId",
      );
    });
  });
});

Deno.test("serve telemetry: the same actions from the CLI and the dashboard carry their own kind and no integration id", async () => {
  await withServeRepo(async (repo) => {
    for (const client of ["direct:cli", "direct:dashboard"]) {
      await withTelemetry(async (telemetry) => {
        const ctx = createServeCtx(repo, [WORKFLOWS, MODELS]);
        await everyAction(repo, ctx, { client });
        const parents = eventsOf(telemetry).filter((data) =>
          data.parentInvocationId === undefined
        );
        assertEquals(
          parents.filter((data) => pathOf(data) === "model method run").length,
          1,
        );
        assertEquals(parents.length, ACTIONS.length + 4);
        for (const data of eventsOf(telemetry)) {
          assertEquals(data.client, client, pathOf(data));
          assertEquals("integrationId" in data, false, pathOf(data));
        }
      });
    }
  });
});

Deno.test("serve telemetry: a refusal is counted once, with its code and no message", async () => {
  await withServeRepo(async (repo) => {
    await withTelemetry(async (telemetry) => {
      const ctx = createServeCtx(repo, [], { delegations: DELEGATIONS });
      await saveGatedWorkflow(repo, "gated", "gate");
      await send(ctx, "workflow.approve", {
        workflowIdOrName: "gated",
        stepName: "gate",
        runId: crypto.randomUUID(),
      }, { client: INTEGRATION_CLIENT, delegation: "d-1" });
      await send(ctx, "workflow.resume", {
        workflowIdOrName: "gated",
        runId: crypto.randomUUID(),
      }, { client: INTEGRATION_CLIENT, delegation: "d-1" });

      const sent = eventsOf(telemetry);
      assertEquals(sent.map(pathOf), ["workflow approve", "workflow resume"]);
      for (const data of sent) {
        assertEquals(data.result.status, "user_error", pathOf(data));
        assert(data.result.errorType, pathOf(data));
        assertEquals(data.result.errorMessage, undefined, pathOf(data));
      }
    });
  });
});

Deno.test("serve telemetry: with telemetry off, no action is recorded", async () => {
  await withServeRepo(async (repo) => {
    await withTelemetry(async (telemetry) => {
      const ctx = createServeCtx(repo, [WORKFLOWS, MODELS], {
        delegations: DELEGATIONS,
      });
      await everyAction(repo, ctx, {
        client: INTEGRATION_CLIENT,
        delegation: "d-2",
      });
      assertEquals(telemetry.saved.length, 0);
    }, { enabled: false });
  });
});

Deno.test("serve telemetry: integration and group method runs send their type, and a failure names neither", async () => {
  await withServeRepo(async (repo) => {
    await withTelemetry(async (telemetry) => {
      const ctx = createServeCtx(repo, [ADMIN, WORKFLOWS, MODELS]);
      const direct = { client: "direct:token" };
      const type = "@swamp/integration";
      const name = integrationDefinitionName(INTEGRATION_ID);
      await send(ctx, "model.method.run", {
        modelIdOrName: type,
        typeArg: type,
        definitionName: name,
        methodName: "register",
        inputs: {
          id: INTEGRATION_ID,
          name: "Acme Slack",
          ceiling: {
            version: 1,
            ceiling: [{ actions: ["read"], resource: "workflow:*" }],
          },
          credentialHash: await integrationCredentialHash("swi1.acme.secret"),
        },
      }, direct);
      await send(ctx, "model.method.run", {
        modelIdOrName: name,
        methodName: "revoke",
        inputs: {},
      }, direct);
      const ceilingFrames = await send(ctx, "model.method.run", {
        modelIdOrName: name,
        methodName: "setCeiling",
        inputs: {
          ceiling: { version: 1, ceiling: [] },
        },
      }, direct);
      assert(
        ceilingFrames.some((frame) =>
          frame.type === "error" ||
          (frame.event as { kind?: string } | undefined)?.kind === "error"
        ),
        JSON.stringify(ceilingFrames),
      );

      const group = "payroll-admins";
      await send(ctx, "model.method.run", {
        modelIdOrName: "@swamp/group",
        typeArg: "@swamp/group",
        definitionName: group,
        methodName: "create",
        inputs: { createdBy: "user:caller" },
      }, direct);
      await send(ctx, "model.method.run", {
        modelIdOrName: group,
        methodName: "add-member",
        inputs: { principal: "user:someone" },
      }, direct);

      const sent = eventsOf(telemetry);
      assert(sent.length >= 4, JSON.stringify(sent));
      const serialized = JSON.stringify(sent);
      assertEquals(serialized.includes(INTEGRATION_ID), false, serialized);
      assertEquals(serialized.includes(group), false, serialized);
      assertEquals(serialized.includes("Acme Slack"), false, serialized);
    });
  });
});

Deno.test("serve telemetry: the dashboard's cancel of a live run is counted by the run's kind", async () => {
  await withServeRepo(async (repo) => {
    await withTelemetry(async (telemetry) => {
      const model = await saveModel(repo, "live-model");
      const registry = new ActiveRunRegistry();
      const runId = crypto.randomUUID();
      registry.register({
        runId,
        kind: "method-run",
        resourceName: model.name,
        resourceId: model.id,
        methodName: "noop",
        controller: new AbortController(),
        eventLog: [],
        subscribers: new Set(),
      } as unknown as ActiveRun);
      const ctx = createServeCtx(repo, [MODELS], {
        activeRunRegistry: registry,
      });
      // a cancel of an id nothing runs under is not counted
      await send(ctx, "cancel", {}, { client: "direct:dashboard" });
      const sent: string[] = [];
      const ws = {
        readyState: WebSocket.OPEN,
        send: (data: string) => sent.push(data),
        close() {},
      } as unknown as WebSocket;
      setConnectionClient(ws, "direct:dashboard");
      const active = new Map<string, AbortController>();
      handleMessage(
        ws,
        ctx,
        active,
        new MessageEvent("message", {
          data: JSON.stringify({ type: "cancel", id: runId }),
        }),
        CALLER,
      );
      await waitFor(
        () => telemetry.saved.length > 0 && !active.has(runId),
        "the cancel to be recorded",
      );

      const events = eventsOf(telemetry);
      assertEquals(events.map(pathOf), ["model method cancel"]);
      assertEquals(events[0].result.status, "success");
      assertEquals(events[0].client, "direct:dashboard");
    });
  });
});

Deno.test("swamp-club report: registration and a revoke reach swamp-club with ids, states and dates, and no name", async () => {
  for (const knowsField of [true, false]) {
    await withServeRepo(async (repo) => {
      const bodies: { path: string; body: Record<string, unknown> }[] = [];
      const club = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen() {} },
        async (req) => {
          const body = await req.json() as Record<string, unknown>;
          bodies.push({ path: new URL(req.url).pathname, body });
          // an older swamp-club reads only the fields it knows
          const seen = knowsField ? body : { ...body, integrations: undefined };
          return Response.json({
            oauthClientId: "clt-1",
            instanceId: seen.instanceId,
            registeredAt: "2026-11-12T00:00:00.000Z",
            startedAt: "2026-11-12T00:00:00.000Z",
            lastHeartbeatAt: "2026-11-12T00:00:00.000Z",
            heartbeatCount: bodies.length,
          });
        },
      );
      const provider = `http://127.0.0.1:${club.addr.port}`;
      const directory = new IntegrationDirectory(
        repo.repoContext.unifiedDataRepo,
        { eventBus: repo.repoContext.eventBus },
      );
      const heartbeat = new ClubHeartbeatService({
        providerUrl: provider,
        oauthClientId: "clt-1",
        instanceId: "inst-1",
        intervalMs: 3_600_000,
        getAccessToken: () => Promise.resolve("club-key"),
        sendHeartbeat: sendInstanceHeartbeat,
        reportedIntegrations: () => directory.reported(),
        reregister: () => Promise.resolve(),
      });
      try {
        await directory.reload();
        beatOnIntegrationChange(directory, () => heartbeat);
        const ctx = createServeCtx(repo, [ADMIN, WORKFLOWS], {
          integrations: directory,
        });
        (ctx as { integrationDirectory?: unknown }).integrationDirectory =
          directory;
        const direct = { client: "direct:token" };
        const type = "@swamp/integration";
        const name = integrationDefinitionName(INTEGRATION_ID);
        await send(ctx, "model.method.run", {
          modelIdOrName: type,
          typeArg: type,
          definitionName: name,
          methodName: "register",
          inputs: {
            id: INTEGRATION_ID,
            name: "Acme Slack",
            ceiling: {
              version: 1,
              ceiling: [{ actions: ["read"], resource: "workflow:*" }],
            },
            credentialHash: await integrationCredentialHash("swi1.acme.s"),
          },
        }, direct);
        await registerInstance(
          provider,
          "club-key",
          withReportedIntegrations({
            oauthClientId: "clt-1",
            instanceId: "inst-1",
            collectiveSlugs: ["acme"],
            hostname: "h",
            version: "1",
            deploymentMode: "local",
          }, directory),
          AbortSignal.timeout(5_000),
        );
        await heartbeat.settled();
        const registration = bodies.find((entry) =>
          entry.path === "/api/v1/serve/instances"
        );
        assertEquals(
          (registration?.body.integrations as { id: string; state: string }[])
            .map(({ id, state }) => ({ id, state })),
          [{ id: INTEGRATION_ID, state: "active" }],
        );
        bodies.length = 0;

        await send(ctx, "model.method.run", {
          modelIdOrName: name,
          methodName: "revoke",
          inputs: {},
        }, direct);
        await waitFor(() => bodies.length > 0, "the extra heartbeat");
        await heartbeat.settled();

        const beat = bodies.at(-1)!;
        assertEquals(beat.path, "/api/v1/serve/instances/clt-1/heartbeat");
        const [reported] = beat.body.integrations as Record<string, unknown>[];
        assertEquals(Object.keys(reported).sort(), [
          "createdAt",
          "id",
          "revokedAt",
          "state",
        ]);
        assertEquals(reported.id, INTEGRATION_ID);
        assertEquals(reported.state, "revoked");
        assertEquals(JSON.stringify(bodies).includes("Acme Slack"), false);
      } finally {
        heartbeat.stop();
        await heartbeat.settled();
        await directory.dispose();
        await club.shutdown();
      }
    });
  }
});
