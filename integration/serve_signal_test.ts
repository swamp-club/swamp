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

/**
 * Signals delivered through `swamp serve` (swamp-club#3094): the `signal`
 * access action, the `workflow.signal` and `workflow.waits` requests, and
 * what a caller is told. Requests go through `handleMessage`, the real
 * dispatch path, against a real repository whose wait records live in the
 * filesystem control-plane store.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { createConditionEvaluator } from "../src/domain/access/policy_snapshot_loader.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import {
  handleSignalHttpRequest,
  matchSignalRoute,
  MAX_SIGNAL_BODY_BYTES,
  type SignalHttpDeps,
} from "../src/serve/signal_http.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string" as const, enum: ["ship", "fix"] },
    note: { type: "string" as const },
  },
};

const UNKNOWN_WAIT = "00000000-0000-4000-8000-000000000000";

interface Waiting {
  workflow: Workflow;
  runId: string;
  waitId: string;
}

/**
 * Saves a workflow whose one step waits for a signal and runs it through
 * serve, with authorization off, until it suspends on the wait.
 */
async function suspendOnWait(
  repo: ServeRepo,
  name = `signal-${crypto.randomUUID().slice(0, 8)}`,
  tags: Record<string, string> = {},
): Promise<Waiting> {
  const workflow = Workflow.create({
    name,
    tags,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, SCHEMA),
          }),
        ],
      }),
    ],
  });
  await repo.repoContext.workflowRepo.save(workflow);
  const frames = await sendRequest(createServeCtx(repo), {
    type: "workflow.run",
    id: `run-${crypto.randomUUID()}`,
    payload: { workflowIdOrName: name },
  }, null);
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const suspended = await repo.repoContext.workflowRunRepo
    .findSummariesByStatus(workflow.id, "suspended");
  assertEquals(suspended.length, 1, JSON.stringify(frames));
  const run = await repo.repoContext.workflowRunRepo.findById(
    workflow.id,
    createWorkflowRunId(suspended[0].id),
  );
  const wait = run!.findSignalWaits()[0].wait;
  assert(wait, "the run holds a readable wait");
  return { workflow, runId: run!.id, waitId: wait.id };
}

function workflowGrant(
  actions: Grant["actions"],
  pattern = "*",
  effect: Grant["effect"] = "allow",
): Grant {
  return grant({ actions, effect, resource: { kind: "workflow", pattern } });
}

/** A token-mode context enforcing `grants`, optionally recording audit events. */
function ctxWith(
  repo: ServeRepo,
  grants: Grant[],
  options: { runImpliesSignal?: boolean; audit?: AuditEvent[] } = {},
): ConnectionContext {
  const ctx = createServeCtx(repo, grants);
  return {
    ...ctx,
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
        { runImpliesSignal: options.runImpliesSignal ?? true },
      ),
    } as unknown as PolicySnapshotLoader,
    ...(options.audit
      ? {
        auditEmitter: {
          emit: (event: AuditEvent) => options.audit!.push(event),
        } as unknown as AuditEmitter,
        instanceId: "test-instance",
      }
      : {}),
  };
}

function signal(
  ctx: ConnectionContext,
  waitId: string,
  payload: unknown,
): Promise<Frame[]> {
  return sendRequest(ctx, {
    type: "workflow.signal",
    id: `signal-${crypto.randomUUID()}`,
    payload: { waitId, payload },
  });
}

function dataOf(frames: Frame[]): Record<string, unknown> {
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === "workflow.signal");
  assert(frame, JSON.stringify(frames));
  return frame.payload!.data as Record<string, unknown>;
}

function refusalOf(
  frames: Frame[],
): { code: string; message: string; details?: Record<string, unknown> } {
  const frame = errorFrame(frames);
  assert(frame?.error, `expected a refusal, got ${JSON.stringify(frames)}`);
  return frame.error as {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Resumes the run through serve with authorization off. */
async function resume(repo: ServeRepo, w: Waiting): Promise<Frame[]> {
  return await sendRequest(createServeCtx(repo), {
    type: "workflow.resume",
    id: `resume-${crypto.randomUUID()}`,
    payload: { workflowIdOrName: w.workflow.name, runId: w.runId },
  }, null);
}

async function stepOf(repo: ServeRepo, w: Waiting) {
  const run = await repo.repoContext.workflowRunRepo.findById(
    createWorkflowId(w.workflow.id),
    createWorkflowRunId(w.runId),
  );
  return { run: run!, step: run!.getJob("main")!.getStep("review")! };
}

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name:
    "serve signal: a signal-only grant delivers, learns nothing of the run, and the next resume applies the payload",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);

      const data = dataOf(await signal(ctx, w.waitId, { verdict: "ship" }));

      assertEquals(Object.keys(data).sort(), ["signal", "waitId"]);
      assertEquals(data.waitId, w.waitId);
      const receipt = data.signal as Record<string, string>;
      assertEquals(receipt.waitId, w.waitId);
      assertEquals(receipt.submittedBy, "user:caller");

      // The run record is unchanged until a resume applies the outcome.
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);
      assertEquals(errorFrame(await resume(repo, w)), undefined);
      const { run, step } = await stepOf(repo, w);
      assertEquals(run.status, "succeeded");
      assertEquals(step.status, "succeeded");
      const output = step.output as {
        payload: unknown;
        signal: { id: string; submittedBy: string };
      };
      assertEquals(output.payload, { verdict: "ship" });
      assertEquals(output.signal.id, receipt.id);
      assertEquals(output.signal.submittedBy, "user:caller");
    });
  },
});

Deno.test({
  name:
    "serve signal: a signal-only grant cannot run, approve, resume, read or list",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);
      const name = w.workflow.name;

      const refused: Array<[string, Record<string, unknown> | undefined]> = [
        ["workflow.run", { workflowIdOrName: name }],
        ["workflow.resume", { workflowIdOrName: name, runId: w.runId }],
        ["workflow.approve", {
          workflowIdOrName: name,
          stepName: "review",
          runId: w.runId,
        }],
        ["workflow.get", { workflowIdOrName: name }],
        ["workflow.history.get", { workflowIdOrName: name }],
        ["workflow.waits", undefined],
        ["workflow.approvals", undefined],
      ];
      for (const [type, payload] of refused) {
        const frames = await sendRequest(ctx, {
          type,
          id: `${type}-${crypto.randomUUID()}`,
          ...(payload ? { payload } : {}),
        });
        const frame = errorFrame(frames);
        assert(frame, `${type} was not refused: ${JSON.stringify(frames)}`);
        assertEquals(frame.error!.code, "unauthorized", type);
      }
      // Nothing above settled or touched the wait.
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);
      dataOf(await signal(ctx, w.waitId, { verdict: "fix" }));
    });
  },
});

Deno.test({
  name:
    "serve signal: an unknown wait and a wait the caller may not signal get the same answer",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const audit: AuditEvent[] = [];
      // Every action on another workflow, and read on this one, but no signal.
      const ctx = ctxWith(repo, [
        workflowGrant(["signal", "run", "read", "approve"], "@other/*"),
        workflowGrant(["read"], w.workflow.name),
      ], { audit });

      for (
        const payload of [{ verdict: "ship" }, { verdict: "nonsense" }, 7, null]
      ) {
        const unauthorized = refusalOf(await signal(ctx, w.waitId, payload));
        const unknown = refusalOf(await signal(ctx, UNKNOWN_WAIT, payload));
        assertEquals(unauthorized, unknown);
        assertEquals(unauthorized.code, "not_found");
        assertEquals(JSON.stringify(unauthorized).includes(w.runId), false);
        assertEquals(
          JSON.stringify(unauthorized).includes(w.workflow.name),
          false,
        );
      }

      // The refusal is audited with the workflow the caller was denied.
      const denial = audit.find((e) => e.outcome === "denied");
      assert(denial, JSON.stringify(audit));
      assertEquals(denial.action, "signal");
      assertEquals(denial.resourceName, w.workflow.name);

      // The wait is still open: an authorized caller delivers to it.
      dataOf(
        await signal(
          ctxWith(repo, [workflowGrant(["signal"])]),
          w.waitId,
          { verdict: "ship" },
        ),
      );
    });
  },
});

Deno.test({
  name:
    "serve signal: a caller who may also read the workflow is told where the signal went",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal", "read"])]);

      const data = dataOf(await signal(ctx, w.waitId, { verdict: "ship" }));

      assertEquals(data.workflowName, w.workflow.name);
      assertEquals(data.runId, w.runId);
      assertEquals(data.jobName, "main");
      assertEquals(data.stepName, "review");
      assertEquals(data.awaitingResume, true);
      assertEquals(data.runRecordAvailable, true);
      assertStringIncludes(data.resumeCommand as string, w.runId);
    });
  },
});

Deno.test({
  name:
    "serve signal: a run grant implies signal unless the server requires an explicit grant",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const grants = [workflowGrant(["run"])];

      const strict = ctxWith(repo, grants, { runImpliesSignal: false });
      assertEquals(
        refusalOf(await signal(strict, w.waitId, { verdict: "ship" })).code,
        "not_found",
      );
      // The explicit grant is honoured under the strict policy.
      const explicit = ctxWith(repo, [workflowGrant(["signal"])], {
        runImpliesSignal: false,
      });
      const other = await suspendOnWait(repo);
      dataOf(await signal(explicit, other.waitId, { verdict: "ship" }));

      dataOf(
        await signal(ctxWith(repo, grants), w.waitId, { verdict: "ship" }),
      );
    });
  },
});

Deno.test({
  name:
    "serve signal: a deny on run denies signal, even beside an explicit signal grant",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [
        workflowGrant(["signal"]),
        workflowGrant(["run"], w.workflow.name, "deny"),
      ]);

      assertEquals(
        refusalOf(await signal(ctx, w.waitId, { verdict: "ship" })).code,
        "not_found",
      );
    });
  },
});

Deno.test({
  name:
    "serve signal: a refused payload lists its errors and leaves the wait open",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);

      const refusal = refusalOf(
        await signal(ctx, w.waitId, { verdict: "nonsense" }),
      );

      assertEquals(refusal.code, "workflow_signal_refused");
      assertEquals(refusal.details?.refusal, "invalid_payload");
      assert((refusal.details?.errors as string[]).length > 0);
      dataOf(await signal(ctx, w.waitId, { verdict: "ship" }));
    });
  },
});

Deno.test({
  name:
    "serve signal: an oversized payload is refused before the wait is looked up",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);
      const refusal = refusalOf(
        await signal(ctx, UNKNOWN_WAIT, {
          verdict: "ship",
          note: "x".repeat(20_000),
        }),
      );
      assertEquals(refusal.code, "workflow_signal_refused");
      assertEquals(refusal.details?.refusal, "invalid_payload");
    });
  },
});

Deno.test({
  name:
    "serve signal: a second signal is answered already settled, with the receipt only for a reader",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const sender = ctxWith(repo, [workflowGrant(["signal"])]);
      const first = dataOf(await signal(sender, w.waitId, { verdict: "ship" }));
      const receiptId = (first.signal as { id: string }).id;

      const blind = refusalOf(
        await signal(sender, w.waitId, { verdict: "fix" }),
      );
      assertEquals(blind.code, "workflow_signal_refused");
      assertEquals(blind.details, { refusal: "already_settled" });
      assertEquals(JSON.stringify(blind).includes(receiptId), false);
      assertEquals(JSON.stringify(blind).includes(w.runId), false);

      const reader = ctxWith(repo, [workflowGrant(["signal", "read"])]);
      const seen = refusalOf(
        await signal(reader, w.waitId, { verdict: "fix" }),
      );
      assertEquals(seen.details?.refusal, "already_settled");
      assertEquals((seen.details?.receipt as { id: string }).id, receiptId);
      assertStringIncludes(seen.message, w.runId);

      // The first signal is the one a resume applies.
      await resume(repo, w);
      const output = (await stepOf(repo, w)).step.output as {
        payload: unknown;
      };
      assertEquals(output.payload, { verdict: "ship" });
    });
  },
});

Deno.test({
  name: "serve signal: a wait ID that is not a UUID never reaches the handler",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const audit: AuditEvent[] = [];
      const ctx = ctxWith(repo, [workflowGrant(["signal"])], { audit });
      const frames = await signal(ctx, "../../etc/passwd", { verdict: "ship" });
      assertEquals(refusalOf(frames).code, "invalid_request");
      assertEquals(JSON.stringify(audit).includes("passwd"), false);

      // Any UUID is a well-formed wait ID, whatever its version digits: it
      // is answered as an unknown wait, as the HTTP route answers it.
      assertEquals(
        refusalOf(
          await signal(ctx, "00000000-0000-0000-0000-000000000001", {
            verdict: "ship",
          }),
        ).code,
        "not_found",
      );
    });
  },
});

Deno.test({
  name:
    "serve signal: a delivery is audited with its receipt and never its payload",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const audit: AuditEvent[] = [];
      const ctx = ctxWith(repo, [workflowGrant(["signal"])], { audit });

      const data = dataOf(
        await signal(ctx, w.waitId, {
          verdict: "ship",
          note: "PAYLOAD-MARKER",
        }),
      );

      const delivered = audit.find((e) =>
        e.action === "workflow.signal.delivered"
      );
      assert(delivered, JSON.stringify(audit));
      assertEquals(delivered.resourceName, w.workflow.name);
      assertEquals(delivered.principalId, "caller");
      assertStringIncludes(
        delivered.detail ?? "",
        (data.signal as { id: string }).id,
      );
      assertStringIncludes(delivered.detail ?? "", w.waitId);
      assertEquals(JSON.stringify(audit).includes("PAYLOAD-MARKER"), false);
    });
  },
});

Deno.test({
  name:
    "serve waits: a reader lists the waits of the workflows they may read, and only those",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const mine = await suspendOnWait(repo);
      const theirs = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["read"], mine.workflow.name)]);

      const frames = await sendRequest(ctx, {
        type: "workflow.waits",
        id: "waits-1",
      });

      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const data = frames.find((f) => f.type === "workflow.waits")!.payload!
        .data as { waits: Array<Record<string, unknown>> };
      assertEquals(data.waits.map((wait) => wait.waitId), [mine.waitId]);
      assertEquals(data.waits[0].workflowName, mine.workflow.name);
      assertEquals(JSON.stringify(data).includes(theirs.waitId), false);
    });
  },
});

Deno.test({
  name: "serve waits: a wait a signal settled is no longer listed",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["read", "signal"])]);
      dataOf(await signal(ctx, w.waitId, { verdict: "ship" }));

      const frames = await sendRequest(ctx, {
        type: "workflow.waits",
        id: "waits-1",
      });

      const data = frames.find((f) => f.type === "workflow.waits")!.payload!
        .data as { waits: unknown[] };
      assertEquals(data.waits, []);
    });
  },
});

Deno.test({
  name: "serve signal: with authorization off a signal is delivered",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const frames = await sendRequest(createServeCtx(repo), {
        type: "workflow.signal",
        id: "signal-1",
        payload: { waitId: w.waitId, payload: { verdict: "ship" } },
      }, null);
      const data = dataOf(frames);
      assertEquals(data.workflowName, w.workflow.name);
      assert((data.signal as { submittedBy: string }).submittedBy.length > 0);
    });
  },
});

// --- The HTTP route, through its handler: no socket is bound. ---

const TOKEN = "caller-token.secret";

function httpDeps(ctx: ConnectionContext): SignalHttpDeps {
  return {
    ctx,
    authenticate: (token) =>
      Promise.resolve(
        token === TOKEN
          ? {
            ok: true as const,
            principalId: "user:caller",
            collectives: [],
            groups: [],
            tokenName: "caller-token",
            tokenCreatedAt: "2026-01-01T00:00:00.000Z",
          }
          : {
            ok: false as const,
            error: "Unknown token",
            reason: "secret-mismatch" as const,
          },
      ),
  };
}

async function post(
  ctx: ConnectionContext,
  waitId: string,
  body: unknown,
  options: { token?: string | null; raw?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> | string }> {
  const matched = matchSignalRoute(`/api/v1/signal/${waitId}`);
  assert(matched, "the path is the signal route");
  const token = options.token === undefined ? TOKEN : options.token;
  const response = await handleSignalHttpRequest(
    new Request(`http://serve.test/api/v1/signal/${waitId}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: options.raw ?? JSON.stringify(body),
    }),
    matched,
    "198.51.100.7",
    httpDeps(ctx),
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

Deno.test({
  name:
    "serve signal over HTTP: a signal-only token delivers and the next resume applies the payload",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);

      const reply = await post(ctx, w.waitId, { payload: { verdict: "fix" } });

      assertEquals(reply.status, 200, JSON.stringify(reply));
      const body = reply.body as Record<string, unknown>;
      assertEquals(body.status, "delivered");
      const data = body.data as Record<string, unknown>;
      assertEquals(Object.keys(data).sort(), ["signal", "waitId"]);
      assertEquals(
        (data.signal as { submittedBy: string }).submittedBy,
        "user:caller",
      );

      await resume(repo, w);
      const output = (await stepOf(repo, w)).step.output as {
        payload: unknown;
      };
      assertEquals(output.payload, { verdict: "fix" });
    });
  },
});

Deno.test({
  name: "serve signal over HTTP: no token and a bad token are refused 401",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);
      const body = { payload: { verdict: "ship" } };

      assertEquals(
        (await post(ctx, w.waitId, body, { token: null })).status,
        401,
      );
      assertEquals(
        (await post(ctx, w.waitId, body, { token: "other.secret" })).status,
        401,
      );
      // Neither attempt settled the wait.
      assertEquals((await post(ctx, w.waitId, body)).status, 200);
    });
  },
});

Deno.test({
  name:
    "serve signal over HTTP: an unknown wait and a wait the caller may not signal get the same 404",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["read", "run"], "@other/*")]);
      const body = { payload: { verdict: "ship" } };

      const unauthorized = await post(ctx, w.waitId, body);
      const unknown = await post(ctx, UNKNOWN_WAIT, body);

      assertEquals(unauthorized.status, 404);
      assertEquals(unauthorized, unknown);
    });
  },
});

Deno.test({
  name: "serve signal over HTTP: each refusal has its own status",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);

      const malformed = await post(ctx, w.waitId, null, { raw: "{not json" });
      assertEquals(malformed.status, 400);
      const noPayload = await post(ctx, w.waitId, { verdict: "ship" });
      assertEquals(noPayload.status, 400);
      const huge = await post(ctx, w.waitId, {
        payload: { verdict: "ship", note: "x".repeat(MAX_SIGNAL_BODY_BYTES) },
      });
      assertEquals(huge.status, 413);

      const invalid = await post(ctx, w.waitId, {
        payload: { verdict: "nonsense" },
      });
      assertEquals(invalid.status, 422);
      assert(
        ((invalid.body as Record<string, unknown>).errors as string[]).length >
          0,
      );

      assertEquals(
        (await post(ctx, w.waitId, { payload: { verdict: "ship" } })).status,
        200,
      );
      const again = await post(ctx, w.waitId, { payload: { verdict: "fix" } });
      assertEquals(again.status, 409);
      assertEquals(again.body, {
        status: "already_settled",
        message: "The wait is already settled.",
      });
    });
  },
});

Deno.test({
  name: "serve signal over HTTP: with authorization off no token is needed",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const reply = await post(
        createServeCtx(repo),
        w.waitId,
        { payload: { verdict: "ship" } },
        { token: null },
      );
      assertEquals(reply.status, 200, JSON.stringify(reply));
    });
  },
});

Deno.test({
  name:
    "serve signal over HTTP: the response is audited without the payload, and a denial names the workflow",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const audit: AuditEvent[] = [];
      const denied = ctxWith(repo, [workflowGrant(["read"], "@other/*")], {
        audit,
      });
      await post(denied, w.waitId, {
        payload: { verdict: "ship", note: "PAYLOAD-MARKER" },
      });
      const denial = audit.find((e) => e.outcome === "denied");
      assert(denial, JSON.stringify(audit));
      assertEquals(denial.resourceName, w.workflow.name);
      const response = audit.find((e) => e.action === "workflow.signal");
      assert(response, JSON.stringify(audit));
      assertEquals(response.outcome, "failure");
      // The response event does not name the workflow the caller was denied.
      assertEquals(response.resourceName, w.waitId);
      assertEquals(JSON.stringify(audit).includes("PAYLOAD-MARKER"), false);
    });
  },
});

// --- Conditional grants decide on the workflow's complete fields. ---

/** Allow signal and read on every workflow; deny both where env is prod. */
const TAG_GRANTS: Grant[] = [
  workflowGrant(["signal", "read"]),
  {
    ...workflowGrant(["signal", "read"], "*", "deny"),
    condition: 'tags.env == "prod"',
  },
];

Deno.test({
  name:
    "serve signal: a deny on the workflow's tags refuses the signal as an unknown wait",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const prod = await suspendOnWait(repo, undefined, { env: "prod" });
      const dev = await suspendOnWait(repo);
      const ctx = createServeCtx(repo, TAG_GRANTS);

      const refused = refusalOf(
        await signal(ctx, prod.waitId, { verdict: "ship" }),
      );
      assertEquals(
        refused,
        refusalOf(await signal(ctx, UNKNOWN_WAIT, { verdict: "ship" })),
      );
      assertEquals((await stepOf(repo, prod)).step.isSignalWait, true);
      dataOf(await signal(ctx, dev.waitId, { verdict: "ship" }));
    });
  },
});

Deno.test({
  name: "serve waits: a deny on the workflow's tags leaves its waits out",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const prod = await suspendOnWait(repo, undefined, { env: "prod" });
      const dev = await suspendOnWait(repo);
      const frames = await sendRequest(createServeCtx(repo, TAG_GRANTS), {
        type: "workflow.waits",
        id: "waits-1",
      });
      const data = frames.find((f) => f.type === "workflow.waits")!.payload!
        .data as { waits: Array<{ waitId: string }> };
      assertEquals(data.waits.map((wait) => wait.waitId), [dev.waitId]);
      assertEquals(JSON.stringify(frames).includes(prod.waitId), false);
    });
  },
});

// --- `--restricted-commands workflow.signal` holds on both transports. ---

Deno.test({
  name:
    "serve signal: a restricted workflow.signal refuses a non-admin over WebSocket and over HTTP alike",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const restrict = (grants: Grant[]): ConnectionContext => {
        const ctx = ctxWith(repo, grants);
        return {
          ...ctx,
          authConfig: {
            ...ctx.authConfig,
            restrictedCommands: ["workflow.signal"],
          },
        };
      };
      const nonAdmin = restrict([workflowGrant(["signal", "run", "read"])]);

      assertEquals(
        refusalOf(await signal(nonAdmin, w.waitId, { verdict: "ship" })).code,
        "unauthorized",
      );
      const overHttp = await post(nonAdmin, w.waitId, {
        payload: { verdict: "ship" },
      });
      assertEquals(overHttp.status, 403, JSON.stringify(overHttp));
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);
      const waits = repo.repoContext.signalWaits;
      assert(waits?.supported, "the test repository holds wait records");
      assertEquals((await waits.store.findOutcome(w.waitId)).kind, "absent");

      const admin = restrict([
        grant({
          actions: ["admin"],
          resource: { kind: "access", pattern: "*" },
        }),
      ]);
      const delivered = await post(admin, w.waitId, {
        payload: { verdict: "ship" },
      });
      assertEquals(delivered.status, 200, JSON.stringify(delivered));
    });
  },
});
