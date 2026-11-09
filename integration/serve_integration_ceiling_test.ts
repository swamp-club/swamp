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
import { Ceiling } from "../src/domain/access/ceiling.ts";
import {
  INTEGRATION_CEILING_GRANT_ID,
} from "../src/domain/access/grant_based_access_decision_service.ts";
import { IntegrationDirectory } from "../src/domain/access/integration_directory.ts";
import {
  integrationCredentialHash,
} from "../src/domain/access/integration_credential.ts";
import {
  integrationDefinitionName,
} from "../src/domain/models/access/integration_model.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type AccessCaller,
  type ConnectionContext,
  refuseIntegrationCaller,
} from "../src/serve/handlers/shared.ts";
import { decideRunCancel } from "../src/serve/run_cancel_authorization.ts";
import "../src/domain/models/models.ts";
import {
  CALLER,
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveGatedWorkflow,
  saveRun,
  sendRequest,
  type ServeRepo,
  testDelegationOf,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const CLIENT = "integration:app";

const ALL = ["approve", "read", "run", "signal"];

function ceiling(
  ...entries: { actions: string[]; resource: string }[]
): Ceiling {
  return Ceiling.parse({ version: 1, ceiling: entries });
}

const ADMIN = grant({
  actions: ["admin"],
  resource: { kind: "access", pattern: "*" },
});

const WORKFLOWS = grant({
  actions: ["read", "run", "approve", "signal", "write"],
  resource: { kind: "workflow", pattern: "*" },
});

function ctxWith(
  repo: ServeRepo,
  grants: ReturnType<typeof grant>[],
  standing: () => Ceiling | "revoked",
  options: { restrictedCommands?: string[] } = {},
): { ctx: ConnectionContext; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const ctx = createServeCtx(repo, grants, {
    ...options,
    integrations: {
      standingOf: () => {
        const now = standing();
        return now === "revoked"
          ? { kind: "revoked" }
          : { kind: "active", ceiling: now };
      },
    },
  });
  (ctx as { auditEmitter?: unknown }).auditEmitter = {
    emit: (event: AuditEvent) => events.push(event),
    durableStalled: false,
  };
  (ctx as { instanceId?: string }).instanceId = "test";
  return { ctx, events };
}

function send(
  ctx: ConnectionContext,
  type: string,
  payload: Record<string, unknown>,
  client: string | undefined = CLIENT,
): Promise<Frame[]> {
  return sendRequest(ctx, { type, id: crypto.randomUUID(), payload }, CALLER, {
    client,
    awaitRuns: false,
  });
}

function refused(frames: Frame[]): boolean {
  return errorFrame(frames)?.error?.code === "unauthorized";
}

const CALLER_ACCESS: AccessCaller = {
  principal: CALLER,
  collectives: [],
  groups: [],
  sourceIp: "127.0.0.1",
  client: CLIENT,
  delegation: testDelegationOf(CLIENT),
};

Deno.test("ceiling: an admin person with an empty ceiling is refused, and the audit event names the principal, client and ceiling", async () => {
  await withServeRepo(async (repo) => {
    const { ctx, events } = ctxWith(repo, [ADMIN], () => Ceiling.empty());
    assert(refused(await send(ctx, "access.token.list", {})));
    const denied = events.filter((event) => event.outcome === "denied");
    assert(denied.length > 0, JSON.stringify(events));
    assertEquals(denied[0].client, CLIENT);
    assertEquals(denied[0].principalId, CALLER.id);
    assertEquals(
      JSON.stringify(denied[0]).includes(INTEGRATION_CEILING_GRANT_ID),
      true,
      JSON.stringify(denied[0]),
    );
    assertEquals(
      refused(await send(ctx, "access.token.list", {}, "direct:token")),
      false,
    );
  });
});

Deno.test("ceiling: lists show only what the ceiling allows, and refuse without read", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "seen", "gate");
    await saveGatedWorkflow(repo, "hidden", "gate");
    let current = ceiling({ actions: ["read"], resource: "workflow:seen" });
    const { ctx } = ctxWith(repo, [WORKFLOWS], () => current);
    const body = JSON.stringify(await send(ctx, "workflow.search", {}));
    assert(body.includes("seen"), body);
    assert(!body.includes("hidden"), body);
    assert(
      refused(await send(ctx, "workflow.get", { workflowIdOrName: "hidden" })),
    );
    current = ceiling({ actions: ["run"], resource: "workflow:seen" });
    assert(refused(await send(ctx, "workflow.search", {})));
    assert(
      refused(await send(ctx, "workflow.get", { workflowIdOrName: "seen" })),
    );
  });
});

Deno.test("ceiling: the commit feed is refused for an integration token and audited", async () => {
  await withServeRepo(async (repo) => {
    const wide = ceiling({ actions: ALL, resource: "workflow:*" });
    const { ctx, events } = ctxWith(repo, [ADMIN, WORKFLOWS], () => wide);
    assert(refused(await send(ctx, "commits.head", {})));
    assert(refused(await send(ctx, "commits.subscribe", { cursor: 0 })));
    assertEquals(
      events.filter((e) => e.outcome === "denied" && e.client === CLIENT)
        .length,
      2,
    );
    assertEquals(
      errorFrame(await send(ctx, "commits.head", {}, "direct:cli"))?.error
        ?.code ===
        "unauthorized",
      false,
    );
  });
});

Deno.test("ceiling: workflow.signal is refused without signal in the ceiling, by key", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "signalled", "gate");
    const { ctx, events } = ctxWith(
      repo,
      [WORKFLOWS],
      () => ceiling({ actions: ["run", "read"], resource: "workflow:*" }),
    );
    const frames = await send(ctx, "workflow.signal", {
      workflow: "signalled",
      key: "a-key",
      payload: {},
    });
    assert(errorFrame(frames), JSON.stringify(frames));
    assert(
      events.some((e) =>
        e.outcome === "denied" &&
        JSON.stringify(e).includes(INTEGRATION_CEILING_GRANT_ID)
      ),
      JSON.stringify(events),
    );
  });
});

Deno.test("ceiling: run in a ceiling can cancel, and without it a cancel reads as a missing run and is audited", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "cancelled", "gate");
    const run = await saveRun(repo, workflow);
    let current = ceiling({ actions: ["run"], resource: "workflow:cancelled" });
    const { ctx, events } = ctxWith(repo, [WORKFLOWS], () => current);
    assertEquals(
      await decideRunCancel(ctx, CALLER_ACCESS, run.id, crypto.randomUUID()),
      "allowed",
    );
    current = ceiling({ actions: ["read"], resource: "workflow:cancelled" });
    assertEquals(
      await decideRunCancel(ctx, CALLER_ACCESS, run.id, crypto.randomUUID()),
      "refused",
    );
    const denied = events.filter((e) => e.outcome === "denied");
    assertEquals(denied.at(-1)?.client, CLIENT);
    assertEquals(denied.at(-1)?.principalId, CALLER.id);
    const notFound = await send(ctx, "workflow.cancel", {
      runId: "11111111-1111-4111-8111-999999999999",
      workflowIdOrName: "cancelled",
    });
    const asRefused = await send(ctx, "workflow.cancel", {
      runId: run.id,
      workflowIdOrName: "cancelled",
    });
    const message = (frames: Frame[]) =>
      errorFrame(frames)?.error?.message?.replace(/[0-9a-f-]{36}/g, "<id>");
    assertEquals(message(asRefused), message(notFound));
  });
});

Deno.test("ceiling: a restricted workflow.cancel is refused for an integration token, even for an admin person", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "restricted", "gate");
    const run = await saveRun(repo, workflow);
    const wide = ceiling({ actions: ALL, resource: "workflow:*" });
    const { ctx } = ctxWith(repo, [ADMIN, WORKFLOWS], () => wide, {
      restrictedCommands: ["workflow.cancel"],
    });
    assert(
      refused(
        await send(ctx, "workflow.cancel", {
          runId: run.id,
          workflowIdOrName: "restricted",
        }),
      ),
    );
    assertEquals(
      refused(
        await send(ctx, "workflow.cancel", {
          runId: run.id,
          workflowIdOrName: "restricted",
        }, "direct:token"),
      ),
      false,
    );
  });
});

Deno.test("ceiling: with the widest ceiling, behavior requests are refused though grants allow them", async () => {
  await withServeRepo(async (repo) => {
    const { ctx } = ctxWith(
      repo,
      [
        ADMIN,
        WORKFLOWS,
        grant({
          actions: ["read", "write", "run"],
          resource: { kind: "model", pattern: "*" },
        }),
      ],
      () => ceiling({ actions: ALL, resource: "workflow:*" }),
    );
    for (
      const [type, payload] of [
        ["model.search", {}],
        ["model.get", { modelIdOrName: "m" }],
        ["model.method.run", { modelIdOrName: "m", methodName: "x" }],
        ["model.create", { typeArg: "x/y", name: "m" }],
      ] as const
    ) {
      assert(
        refused(await send(ctx, type, payload)),
        type,
      );
    }
  });
});

Deno.test("ceiling: a vault expression in workflow inputs stays inert for an integration token", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "inputs", "gate");
    const expression = "${{ vault.get('v', 'k') }}";
    const { ctx } = ctxWith(
      repo,
      [WORKFLOWS],
      () => ceiling({ actions: ALL, resource: "workflow:*" }),
    );
    const evaluated = JSON.stringify(
      await send(ctx, "workflow.evaluate", {
        workflowIdOrName: "inputs",
        inputs: { value: expression },
      }),
    );
    assert(!evaluated.includes("vault_not_found"), evaluated);
    assert(!evaluated.includes("Vault"), evaluated);
    const ran = await send(ctx, "workflow.run", {
      workflowIdOrName: "inputs",
      inputs: { value: expression },
    });
    assert(!JSON.stringify(ran).includes("Vault"), JSON.stringify(ran));
  });
});

Deno.test("refuseIntegrationCaller: refuses and audits an integration, and passes a direct caller", async () => {
  await withServeRepo((repo) => {
    const wide = ceiling({ actions: ALL, resource: "workflow:*" });
    const { ctx, events } = ctxWith(repo, [ADMIN], () => wide);
    assertEquals(
      refuseIntegrationCaller(CALLER_ACCESS, "r1", "datastore-api", ctx),
      true,
    );
    assertEquals(events.at(-1)?.client, CLIENT);
    assertEquals(events.at(-1)?.outcome, "denied");
    assertEquals(
      refuseIntegrationCaller(
        { ...CALLER_ACCESS, client: "direct:token" },
        "r2",
        "datastore-api",
        ctx,
      ),
      false,
    );
    return Promise.resolve();
  });
});

Deno.test("directory: a registered integration applies through the real behavior path, and a revoke needs no grant reload", async () => {
  await withServeRepo(async (repo) => {
    const directory = new IntegrationDirectory(
      repo.repoContext.unifiedDataRepo,
      {
        eventBus: repo.repoContext.eventBus,
      },
    );
    await directory.reload();
    const ctx = createServeCtx(repo, [ADMIN, WORKFLOWS], {
      integrations: directory,
    });
    (ctx as { integrationDirectory?: unknown }).integrationDirectory =
      directory;
    await saveGatedWorkflow(repo, "live", "gate");
    const search = () => send(ctx, "workflow.search", {});
    assert(refused(await search()), "unknown before it is registered");

    const type = "@swamp/integration";
    const name = integrationDefinitionName("app");
    const registered = await sendRequest(
      ctx,
      {
        type: "model.method.run",
        id: crypto.randomUUID(),
        payload: {
          modelIdOrName: type,
          typeArg: type,
          definitionName: name,
          methodName: "register",
          inputs: {
            id: "app",
            name: "App",
            ceiling: {
              version: 1,
              ceiling: [{ actions: ["read"], resource: "workflow:*" }],
            },
            credentialHash: await integrationCredentialHash("swi1.app.secret"),
          },
        },
      },
      CALLER,
      { client: "direct:token", awaitRuns: false },
    );
    assertEquals(errorFrame(registered), undefined, JSON.stringify(registered));
    assertEquals(directory.standingOf("app").kind, "active");
    assertEquals(refused(await search()), false);

    const revoked = await sendRequest(
      ctx,
      {
        type: "model.method.run",
        id: crypto.randomUUID(),
        payload: { modelIdOrName: name, methodName: "revoke", inputs: {} },
      },
      CALLER,
      { client: "direct:token", awaitRuns: false },
    );
    assertEquals(errorFrame(revoked), undefined, JSON.stringify(revoked));
    assertEquals(directory.standingOf("app").kind, "revoked");
    assert(refused(await search()), "refused at once, with no reload");
    await directory.dispose();
  });
});

Deno.test("directory: on the detached path serve always uses, a revoke applies before the reply and audits its digests", async () => {
  await withServeRepo(async (repo) => {
    const directory = new IntegrationDirectory(
      repo.repoContext.unifiedDataRepo,
      {
        eventBus: repo.repoContext.eventBus,
      },
    );
    await directory.reload();
    const ctx = createServeCtx(repo, [ADMIN, WORKFLOWS], {
      integrations: directory,
      detached: true,
    });
    const events: AuditEvent[] = [];
    (ctx as { auditEmitter?: unknown }).auditEmitter = {
      emit: (event: AuditEvent) => events.push(event),
      durableStalled: false,
    };
    (ctx as { integrationDirectory?: unknown }).integrationDirectory =
      directory;
    await saveGatedWorkflow(repo, "live", "gate");
    const search = () => send(ctx, "workflow.search", {});
    assert(refused(await search()), "unknown before it is registered");

    const type = "@swamp/integration";
    const name = integrationDefinitionName("app");
    const registered = await sendRequest(
      ctx,
      {
        type: "model.method.run",
        id: crypto.randomUUID(),
        payload: {
          modelIdOrName: type,
          typeArg: type,
          definitionName: name,
          methodName: "register",
          inputs: {
            id: "app",
            name: "App",
            ceiling: {
              version: 1,
              ceiling: [{ actions: ["read"], resource: "workflow:*" }],
            },
            credentialHash: await integrationCredentialHash("swi1.app.secret"),
          },
        },
      },
      CALLER,
      { client: "direct:token", awaitRuns: false },
    );
    assertEquals(errorFrame(registered), undefined, JSON.stringify(registered));
    assertEquals(directory.standingOf("app").kind, "active");
    assertEquals(refused(await search()), false);

    const revoked = await sendRequest(
      ctx,
      {
        type: "model.method.run",
        id: crypto.randomUUID(),
        payload: { modelIdOrName: name, methodName: "revoke", inputs: {} },
      },
      CALLER,
      { client: "direct:token", awaitRuns: false },
    );
    assertEquals(errorFrame(revoked), undefined, JSON.stringify(revoked));
    assertEquals(directory.standingOf("app").kind, "revoked");
    assert(refused(await search()), "refused at once, with no reload");
    const detail = events.map((event) => event.detail).find((text) =>
      text?.includes("state=revoked")
    );
    assert(detail?.includes("ceiling=sha256:"), JSON.stringify(events));
    await directory.dispose();
  });
});

Deno.test("the record: model delete and data delete refuse it, so a revoked id stays reserved", async () => {
  await withServeRepo(async (repo) => {
    const directory = new IntegrationDirectory(
      repo.repoContext.unifiedDataRepo,
    );
    await directory.reload();
    const ctx = createServeCtx(repo, [
      ADMIN,
      grant({
        actions: ["read", "write", "run"],
        resource: { kind: "model", pattern: "*" },
      }),
      grant({
        actions: ["read", "write"],
        resource: { kind: "data", pattern: "*" },
      }),
    ], { integrations: directory });
    (ctx as { integrationDirectory?: unknown }).integrationDirectory =
      directory;
    const type = "@swamp/integration";
    const name = integrationDefinitionName("kept");
    const direct = (kind: string, payload: Record<string, unknown>) =>
      sendRequest(
        ctx,
        { type: kind, id: crypto.randomUUID(), payload },
        CALLER,
        {
          client: "direct:token",
          awaitRuns: false,
        },
      );
    assertEquals(
      errorFrame(
        await direct("model.method.run", {
          modelIdOrName: type,
          typeArg: type,
          definitionName: name,
          methodName: "register",
          inputs: {
            id: "kept",
            name: "Kept",
            ceiling: { version: 1, ceiling: [] },
            credentialHash: await integrationCredentialHash("swi1.kept.s"),
          },
        }),
      ),
      undefined,
    );
    for (
      const [kind, payload] of [
        ["model.delete", { modelIdOrName: name, force: true }],
        ["data.delete", { modelIdOrName: name, dataName: "integration-main" }],
        ["data.rename", {
          modelIdOrName: name,
          oldName: "integration-main",
          newName: "elsewhere",
        }],
      ] as const
    ) {
      const frames = await direct(kind, payload);
      const message = errorFrame(frames)?.error?.message ?? "";
      assert(
        message.includes("reserved"),
        `${kind}: ${JSON.stringify(frames)}`,
      );
    }
    assertEquals(directory.standingOf("kept").kind, "active");
    await directory.dispose();
  });
});

Deno.test("access.integration.list: admin only, one current row per integration, and no hash", async () => {
  await withServeRepo(async (repo) => {
    const directory = new IntegrationDirectory(
      repo.repoContext.unifiedDataRepo,
    );
    await directory.reload();
    const ctx = createServeCtx(repo, [ADMIN], { integrations: directory });
    (ctx as { integrationDirectory?: unknown }).integrationDirectory =
      directory;
    const type = "@swamp/integration";
    const name = integrationDefinitionName("listed");
    const hash = await integrationCredentialHash("swi1.listed.s");
    const direct = (kind: string, payload: Record<string, unknown>) =>
      sendRequest(
        ctx,
        { type: kind, id: crypto.randomUUID(), payload },
        CALLER,
        {
          client: "direct:token",
          awaitRuns: false,
        },
      );
    await direct("model.method.run", {
      modelIdOrName: type,
      typeArg: type,
      definitionName: name,
      methodName: "register",
      inputs: {
        id: "listed",
        name: "Listed",
        ceiling: { version: 1, ceiling: [] },
        credentialHash: hash,
      },
    });
    await direct("model.method.run", {
      modelIdOrName: name,
      methodName: "setCeiling",
      inputs: {
        ceiling: {
          version: 1,
          ceiling: [{ actions: ["read"], resource: "workflow:*" }],
        },
      },
    });
    await direct("model.method.run", {
      modelIdOrName: name,
      methodName: "revoke",
      inputs: {},
    });
    const frames = await direct("access.integration.list", {});
    const reply = frames.find((f) => f.type === "access.integration.list");
    assert(reply, JSON.stringify(frames));
    const rows = (reply.payload as {
      data: { integrations: { id: string; state: string }[] };
    }).data.integrations;
    assertEquals(rows.map((r) => [r.id, r.state]), [["listed", "revoked"]]);
    assertEquals(JSON.stringify(reply).includes(hash), false);
    assertEquals(JSON.stringify(reply).includes("credentialHash"), false);
    const person = createServeCtx(repo, [WORKFLOWS], {
      integrations: directory,
    });
    assert(
      refused(
        await sendRequest(
          person,
          {
            type: "access.integration.list",
            id: crypto.randomUUID(),
            payload: {},
          },
          CALLER,
          { client: "direct:token", awaitRuns: false },
        ),
      ),
    );
    await directory.dispose();
  });
});
