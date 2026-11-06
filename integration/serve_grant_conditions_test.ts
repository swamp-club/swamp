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
import "../src/domain/models/models.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  WorkflowRun,
  type WorkflowRunData,
} from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveGatedWorkflow,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const ALICE: Principal = { kind: "user", id: "alice" };
const BOB: Principal = { kind: "user", id: "bob" };
const NOBODY: Principal = { kind: "user", id: "nobody" };
const SELF = "principal.sub == run.initiator.sub";

function onWorkflows(name: string, overrides: Partial<Grant> = {}): Grant {
  return grant({
    subject: { kind: "user", name },
    actions: ["read", "run", "approve"],
    resource: { kind: "workflow", pattern: "*" },
    ...overrides,
  });
}

function selfDeny(name: string): Grant {
  return onWorkflows(name, {
    id: `deny-${name}`,
    effect: "deny",
    actions: ["approve"],
    condition: SELF,
  });
}

const POLICY = [
  onWorkflows("alice"),
  onWorkflows("bob"),
  selfDeny("alice"),
  selfDeny("bob"),
];

/** a suspended run at its gate, as a record with the given initiator */
async function suspendedRun(
  repo: ServeRepo,
  workflow: Workflow,
  overrides: Partial<WorkflowRunData>,
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const step = job.getStep("gate")!;
  step.start();
  step.waitForApproval();
  run.suspend();
  const stored = WorkflowRun.fromData({ ...run.toData(), ...overrides });
  await repo.repoContext.workflowRunRepo.save(workflow.id, stored);
  return stored;
}

function decide(
  ctx: ConnectionContext,
  type: "workflow.approve" | "workflow.reject",
  workflow: Workflow,
  runId: string,
  principal: Principal,
  client?: string,
): Promise<Frame[]> {
  return sendRequest(
    ctx,
    {
      type,
      id: crypto.randomUUID(),
      payload: { workflowIdOrName: workflow.name, stepName: "gate", runId },
    },
    principal,
    { client },
  );
}

function capturedAudit(ctx: ConnectionContext): AuditEvent[] {
  const audit: AuditEvent[] = [];
  (ctx as { auditEmitter?: unknown }).auditEmitter = {
    emit: (event: AuditEvent) => audit.push(event),
  };
  return audit;
}

function refusal(frames: Frame[]): string | undefined {
  return errorFrame(frames)?.error?.code;
}

async function gateStatus(
  repo: ServeRepo,
  workflow: Workflow,
  runId: string,
): Promise<string | undefined> {
  const run = await repo.repoContext.workflowRunRepo.findById(
    workflow.id,
    runId as never,
  );
  return run?.getJob("main")?.getStep("gate")?.status;
}

for (const type of ["workflow.approve", "workflow.reject"] as const) {
  Deno.test(`grant conditions: ${type} refuses a person on their own run and lets another decide`, async () => {
    await withServeRepo(async (repo) => {
      const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
      const run = await suspendedRun(repo, workflow, {
        initiatedBy: "user:alice",
      });
      const ctx = createServeCtx(repo, POLICY);
      const audit = capturedAudit(ctx);

      const refused = await decide(
        ctx,
        type,
        workflow,
        run.id,
        ALICE,
        "direct:cli",
      );
      assertEquals(refused.length, 1, JSON.stringify(refused));
      assertEquals(refusal(refused), "unauthorized");
      assertEquals(
        await gateStatus(repo, workflow, run.id),
        "waiting_approval",
      );
      const denied = audit.filter((e) => e.outcome === "denied");
      assertEquals(denied.length, 1);
      assertEquals(denied[0].principalId, "alice");
      assertEquals(denied[0].client, "direct:cli");
      assertEquals(denied[0].decision?.grantId, "deny-alice");

      const allowed = await decide(ctx, type, workflow, run.id, BOB);
      assertEquals(refusal(allowed), undefined, JSON.stringify(allowed));
      assert(allowed.some((f) => f.type === type));
    });
  });
}

Deno.test("grant conditions: an allow on the run admits another person and not the initiator", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
    const run = await suspendedRun(repo, workflow, {
      initiatedBy: "user:alice",
    });
    const allow = {
      actions: ["approve"],
      condition: "principal.sub != run.initiator.sub",
    } as Partial<Grant>;
    const ctx = createServeCtx(repo, [
      onWorkflows("alice", allow),
      onWorkflows("bob", allow),
    ]);
    assertEquals(
      refusal(await decide(ctx, "workflow.approve", workflow, run.id, ALICE)),
      "unauthorized",
    );
    assertEquals(
      refusal(await decide(ctx, "workflow.approve", workflow, run.id, BOB)),
      undefined,
    );
  });
});

for (
  const [label, initiatedBy] of [
    ["an older run with no initiator", undefined],
    ["a ghost initiator", "ghost"],
    ["an unparsable initiator", "alice"],
  ] as const
) {
  Deno.test(`grant conditions: ${label} fails closed for allow and deny`, async () => {
    await withServeRepo(async (repo) => {
      const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
      const run = await suspendedRun(repo, workflow, { initiatedBy });
      const denyCtx = createServeCtx(repo, POLICY);
      assertEquals(
        refusal(
          await decide(denyCtx, "workflow.approve", workflow, run.id, BOB),
        ),
        "unauthorized",
      );
      const allowCtx = createServeCtx(repo, [
        onWorkflows("bob", {
          actions: ["approve"],
          condition: "principal.sub != run.initiator.sub",
        }),
      ]);
      assertEquals(
        refusal(
          await decide(allowCtx, "workflow.approve", workflow, run.id, BOB),
        ),
        "unauthorized",
      );
      assertEquals(
        await gateStatus(repo, workflow, run.id),
        "waiting_approval",
      );
    });
  });
}

for (const id of ["scheduler", "service:scheduler", "bob"]) {
  Deno.test(`grant conditions: a service run can be decided by user ${id}, under an allow and a deny`, async () => {
    for (
      const policy of [
        [onWorkflows(id), selfDeny(id)],
        [onWorkflows(id, {
          actions: ["approve"],
          condition: "principal.sub != run.initiator.sub",
        })],
      ]
    ) {
      await withServeRepo(async (repo) => {
        const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
        const run = await suspendedRun(repo, workflow, {
          initiatedBy: "service:scheduler",
        });
        const ctx = createServeCtx(repo, policy);
        const frames = await decide(ctx, "workflow.approve", workflow, run.id, {
          kind: "user",
          id,
        });
        assertEquals(refusal(frames), undefined, JSON.stringify(frames));
      });
    }
  });
}

Deno.test("grant conditions: a person with no grant gets one reply whether or not the run exists, and no run is read", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
    const run = await suspendedRun(repo, workflow, {
      initiatedBy: "user:alice",
    });
    const ctx = createServeCtx(repo, POLICY);
    let reads = 0;
    const runRepo = repo.repoContext.workflowRunRepo;
    const findById = runRepo.findById.bind(runRepo);
    runRepo.findById = (...args) => {
      reads++;
      return findById(...args);
    };
    const reply = async (runId: string) => {
      const [frame] = await decide(
        ctx,
        "workflow.approve",
        workflow,
        runId,
        NOBODY,
      );
      return { ...frame, id: undefined };
    };
    const existing = await reply(run.id);
    const missing = await reply(crypto.randomUUID());
    assertEquals(existing, missing);
    assertEquals(existing.error?.code, "unauthorized");
    assertEquals(reads, 0);
  });
});

Deno.test("grant conditions: auth mode none applies no condition", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
    const run = await suspendedRun(repo, workflow, {
      initiatedBy: "user:alice",
    });
    const ctx = createServeCtx(repo);
    const frames = await decide(
      ctx,
      "workflow.approve",
      workflow,
      run.id,
      ALICE,
    );
    assertEquals(refusal(frames), undefined, JSON.stringify(frames));
  });
});

Deno.test("grant conditions: serveDriven lets an operator refuse a member-driven run", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
    const member = await suspendedRun(repo, workflow, {
      initiatedBy: "user:alice",
    });
    const driven = await suspendedRun(repo, workflow, {
      initiatedBy: "user:alice",
      instanceId: "instance-1",
    });
    const ctx = createServeCtx(repo, [
      onWorkflows("bob"),
      onWorkflows("bob", {
        effect: "deny",
        actions: ["approve"],
        condition: "!run.serveDriven",
      }),
    ]);
    assertEquals(
      refusal(await decide(ctx, "workflow.approve", workflow, member.id, BOB)),
      "unauthorized",
    );
    assertEquals(
      refusal(await decide(ctx, "workflow.approve", workflow, driven.id, BOB)),
      undefined,
    );
  });
});

Deno.test("grant conditions: the approvals list says per run who may decide, with a reason only for a run-level refusal", async () => {
  await withServeRepo(async (repo) => {
    const workflow = await saveGatedWorkflow(repo, "deploy", "gate");
    const own = await suspendedRun(repo, workflow, {
      initiatedBy: "user:alice",
    });
    const others = await suspendedRun(repo, workflow, {
      initiatedBy: "user:bob",
    });
    const ctx = createServeCtx(repo, [
      ...POLICY,
      onWorkflows("reader", { actions: ["read"] }),
    ]);
    const list = async (principal: Principal) => {
      const frames = await sendRequest(ctx, {
        type: "workflow.approvals",
        id: crypto.randomUUID(),
        payload: {},
      }, principal);
      const data = frames.find((f) => f.type === "workflow.approvals")?.payload
        ?.data as {
          approvals: {
            runId: string;
            canDecide?: boolean;
            canDecideReason?: string;
          }[];
        };
      return new Map(data.approvals.map((row) => [row.runId, row]));
    };
    const alice = await list(ALICE);
    assertEquals(alice.get(own.id)?.canDecide, false);
    assertEquals(alice.get(own.id)?.canDecideReason, "grant-condition");
    assertEquals(alice.get(others.id)?.canDecide, true);
    assertEquals(alice.get(others.id)?.canDecideReason, undefined);
    const reader = await list({ kind: "user", id: "reader" });
    assertEquals(reader.get(own.id)?.canDecide, false);
    assertEquals(reader.get(own.id)?.canDecideReason, undefined);
  });
});

const SLACK = "integration:slack";

Deno.test("grant conditions: an integration is refused on each kind it can reach, and a direct or absent client is not", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "deploy", "gate");
    await saveModel(repo, "m");
    const notSlack = {
      condition: `client == "${SLACK}"`,
      effect: "deny",
    } as const;
    const ctx = createServeCtx(repo, [
      grant({
        actions: ["read", "run"],
        resource: { kind: "workflow", pattern: "*" },
      }),
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
      grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
      grant({ actions: ["read"], resource: { kind: "vault", pattern: "*" } }),
      grant({
        actions: ["read", "run"],
        resource: { kind: "workflow", pattern: "*" },
        ...notSlack,
      }),
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "*" },
        ...notSlack,
      }),
      grant({
        actions: ["read"],
        resource: { kind: "data", pattern: "*" },
        ...notSlack,
      }),
      grant({
        actions: ["read"],
        resource: { kind: "vault", pattern: "*" },
        ...notSlack,
      }),
    ]);
    const requests = [
      { type: "workflow.get", payload: { workflowIdOrName: "deploy" } },
      { type: "workflow.run", payload: { workflowIdOrName: "deploy" } },
      { type: "model.get", payload: { modelIdOrName: "m" } },
      { type: "data.list", payload: { modelIdOrName: "m" } },
      { type: "vault.describe", payload: { vaultNameOrId: "v" } },
    ];
    for (const request of requests) {
      const send = (client?: string) =>
        sendRequest(ctx, { ...request, id: crypto.randomUUID() }, undefined, {
          client,
        });
      const slack = await send(SLACK);
      const codes = slack.map((f) => f.error?.code);
      assert(
        codes.includes("unauthorized") ||
          JSON.stringify(slack).includes('"entries":[]') ||
          JSON.stringify(slack).includes('"results":[]'),
        `${request.type}: ${JSON.stringify(slack)}`,
      );
      for (const client of ["direct:cli", undefined, "integration:other"]) {
        const direct = await send(client);
        assertEquals(
          direct.map((f) => f.error?.code).includes("unauthorized"),
          false,
          `${request.type} as ${client}: ${JSON.stringify(direct)}`,
        );
      }
    }
  });
});

Deno.test("grant conditions: type and schema endpoints check for an allow, so a client deny does not hide type definitions", async () => {
  await withServeRepo(async (repo) => {
    const ctx = createServeCtx(repo, [
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
      grant({
        actions: ["read"],
        resource: { kind: "model", pattern: "*" },
        effect: "deny",
        condition: `client == "${SLACK}"`,
      }),
    ]);
    const frames = await sendRequest(
      ctx,
      {
        type: "model.type.search",
        id: crypto.randomUUID(),
        payload: {},
      },
      undefined,
      { client: SLACK },
    );
    assertEquals(refusal(frames), undefined);
  });
});
