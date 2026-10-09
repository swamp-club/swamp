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
import { dirname, join } from "@std/path";
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
  keyed: { key?: string; id?: string } = {},
): Promise<Waiting> {
  const workflow = Workflow.create({
    ...(keyed.id !== undefined ? { id: keyed.id } : {}),
    name,
    tags,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, SCHEMA, keyed.key),
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
  name:
    "serve waits: includeSignalled lists a signalled wait with its receipt, to a reader of its workflow only",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const mine = await suspendOnWait(repo);
      const theirs = await suspendOnWait(repo);
      const signaller = ctxWith(repo, [workflowGrant(["read", "signal"])]);
      const receipt = dataOf(
        await signal(signaller, mine.waitId, { verdict: "ship" }),
      ).signal as { id: string };
      const hidden = dataOf(
        await signal(signaller, theirs.waitId, { verdict: "ship" }),
      ).signal as { id: string };
      const reader = ctxWith(repo, [
        workflowGrant(["read"], mine.workflow.name),
      ]);

      const frames = await sendRequest(reader, {
        type: "workflow.waits",
        id: "waits-1",
        payload: { includeSignalled: true },
      });

      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const data = frames.find((f) => f.type === "workflow.waits")!.payload!
        .data as {
          waits: unknown[];
          signalled: Array<Record<string, unknown>>;
        };
      assertEquals(data.waits, []);
      assertEquals(data.signalled.map((w) => w.waitId), [mine.waitId]);
      assertEquals((data.signalled[0].signal as { id: string }).id, receipt.id);
      assertEquals(data.signalled[0].awaitingResume, true);
      assertEquals(JSON.stringify(frames).includes(theirs.waitId), false);
      assertEquals(JSON.stringify(frames).includes(hidden.id), false);
    });
  },
});

Deno.test({
  name:
    "serve waits: without includeSignalled the reply carries no signalled list, as a client that predates it expects",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["read", "signal"])]);
      dataOf(await signal(ctx, w.waitId, { verdict: "ship" }));

      for (
        const payload of [undefined, {}, { includeSignalled: false }] as const
      ) {
        const frames = await sendRequest(ctx, {
          type: "workflow.waits",
          id: "waits-1",
          ...(payload ? { payload } : {}),
        });
        const data = frames.find((f) => f.type === "workflow.waits")!.payload!
          .data as Record<string, unknown>;
        assertEquals(Object.keys(data).sort(), ["unreadableWaits", "waits"]);
      }
    });
  },
});

Deno.test({
  name:
    "serve history get: a step signalled since the run suspended shows the receipt before any resume",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["read", "signal"])]);
      const receipt = dataOf(await signal(ctx, w.waitId, { verdict: "ship" }))
        .signal as { id: string };

      const frames = await sendRequest(ctx, {
        type: "workflow.history.get",
        id: "get-1",
        payload: { workflowIdOrName: w.runId },
      });

      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const run = frames.find((f) => f.type === "workflow.history.get")!
        .payload!.data as {
          jobs: Array<{
            steps: Array<{
              status: string;
              wait?: { id: string; receipt?: { id: string } };
            }>;
          }>;
        };
      const step = run.jobs.flatMap((j) => j.steps).find((s) => s.wait)!;
      assertEquals(step.status, "waiting");
      assertEquals(step.wait?.id, w.waitId);
      assertEquals(step.wait?.receipt?.id, receipt.id);
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);
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

Deno.test({
  name:
    "serve signal over HTTP: the body cap bounds the read, and the payload limit is judged on the payload",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);

      // Under the body cap, over the payload limit: the payload is refused.
      const tooBig = await post(ctx, w.waitId, {
        payload: { verdict: "ship", note: "x".repeat(17_000) },
      });
      assertEquals(tooBig.status, 422, JSON.stringify(tooBig).slice(0, 200));

      // A payload under its limit whose body is larger than the limit,
      // because the client escaped every non-ASCII character and indented.
      const note = "水".repeat(4000);
      const raw = JSON.stringify(
        { payload: { verdict: "ship", note } },
        null,
        4,
      ).replace(
        /[\u0080-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      assert(raw.length > 17_408, "the body is over the old cap");
      const escaped = await post(ctx, w.waitId, null, { raw });
      assertEquals(escaped.status, 200, JSON.stringify(escaped).slice(0, 200));

      await resume(repo, w);
      const output = (await stepOf(repo, w)).step.output as {
        payload: { note: string };
      };
      assertEquals(output.payload.note, note);
    });
  },
});

Deno.test({
  name:
    "serve signal over HTTP: audit events name the user the token's login identified",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await suspendOnWait(repo);
      const audit: AuditEvent[] = [];
      const identity = { username: "zed", email: "zed@example.test" };
      const withIdentity = (ctx: ConnectionContext): SignalHttpDeps => ({
        ctx,
        authenticate: () =>
          Promise.resolve({
            ok: true as const,
            principalId: "user:caller",
            collectives: [],
            groups: [],
            tokenName: "caller-token",
            tokenCreatedAt: "2026-01-01T00:00:00.000Z",
            oauthIdentity: identity,
          }),
      });
      const send = (ctx: ConnectionContext) =>
        handleSignalHttpRequest(
          new Request(`http://serve.test/api/v1/signal/${w.waitId}`, {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ payload: { verdict: "ship" } }),
          }),
          { waitId: w.waitId },
          "198.51.100.9",
          withIdentity(ctx),
        );

      // Refused first, then delivered: the denial, the delivery and both
      // response events carry the identity.
      const denied = await send(
        ctxWith(repo, [workflowGrant(["read"], "@other/*")], { audit }),
      );
      assertEquals(denied.status, 404);
      await denied.body?.cancel();
      const delivered = await send(
        ctxWith(repo, [workflowGrant(["signal"])], { audit }),
      );
      assertEquals(delivered.status, 200);
      await delivered.body?.cancel();

      assertEquals(audit.length, 4, JSON.stringify(audit.map((e) => e.action)));
      for (const event of audit) {
        assertEquals(event.principalUsername, identity.username, event.action);
        assertEquals(event.principalEmail, identity.email, event.action);
      }
    });
  },
});

// --- A signal addressed by workflow and key (swamp-club#3211). ---

const KEY = "verdict";
const BY_KEY_REFUSAL = { code: "not_found", message: "Signal wait not found" };

function keyed(repo: ServeRepo, name?: string, tags = {}): Promise<Waiting> {
  return suspendOnWait(repo, name, tags, { key: KEY });
}

function signalByKey(
  ctx: ConnectionContext,
  workflow: string,
  key: string,
  payload: unknown,
): Promise<Frame[]> {
  return sendRequest(ctx, {
    type: "workflow.signal",
    id: `signal-${crypto.randomUUID()}`,
    payload: { workflow, key, payload },
  });
}

async function postByKey(
  ctx: ConnectionContext,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> | string }> {
  const matched = matchSignalRoute("/api/v1/signal");
  assert(matched, "the path is the by-key signal route");
  const response = await handleSignalHttpRequest(
    new Request("http://serve.test/api/v1/signal", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
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
    "serve signal by key: a signal-only grant delivers with no earlier lookup, and the next resume applies the payload",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await keyed(repo);
      const audit: AuditEvent[] = [];
      const ctx = ctxWith(repo, [workflowGrant(["signal"], w.workflow.name)], {
        audit,
      });

      const data = dataOf(
        await signalByKey(ctx, w.workflow.name, KEY, { verdict: "ship" }),
      );

      // The caller may not read the workflow: the wait and the receipt only.
      assertEquals(Object.keys(data).sort(), ["signal", "waitId"]);
      assertEquals(data.waitId, w.waitId);
      const delivered = audit.find((e) =>
        e.action === "workflow.signal.delivered"
      );
      assert(delivered, JSON.stringify(audit));
      assertStringIncludes(delivered.detail ?? "", `key=${KEY}`);
      assertEquals(JSON.stringify(audit).includes("ship"), false);

      assertEquals(errorFrame(await resume(repo, w)), undefined);
      const { run, step } = await stepOf(repo, w);
      assertEquals(run.status, "succeeded");
      assertEquals(
        (step.output as { payload: unknown }).payload,
        { verdict: "ship" },
      );
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a caller who may read the workflow is told the key, the run and the step",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await keyed(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal", "read"])]);

      // Named by its ID, the workflow is authorized under its name.
      const data = dataOf(
        await signalByKey(ctx, w.workflow.id, KEY, { verdict: "ship" }),
      );

      assertEquals(data.key, KEY);
      assertEquals(data.workflowName, w.workflow.name);
      assertEquals(data.runId, w.runId);
      assertEquals(data.stepName, "review");
    });
  },
});

Deno.test({
  name:
    "serve signal by key: another workflow's key, an undeclared key, an unknown workflow and a malformed key get one answer",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const mine = await keyed(repo);
      const other = await keyed(repo);
      const audit: AuditEvent[] = [];
      const ctx = ctxWith(repo, [
        workflowGrant(["signal"], mine.workflow.name),
        workflowGrant(["read"]),
      ], { audit });
      const payload = { verdict: "ship" };

      const answers = [
        await signalByKey(ctx, other.workflow.name, KEY, payload),
        await signalByKey(ctx, other.workflow.id, KEY, payload),
        await signalByKey(ctx, mine.workflow.name, "undeclared", payload),
        await signalByKey(ctx, "no-such-workflow", KEY, payload),
        await signalByKey(ctx, mine.workflow.name, "Not A Key", payload),
        await signalByKey(ctx, other.workflow.name, "Not A Key", payload),
      ].map(refusalOf);
      for (const answer of answers) assertEquals(answer, BY_KEY_REFUSAL);

      // The denial is audited with the workflow, under its name even when
      // the request named it by ID; the reply never carried it.
      const denied = audit.filter((e) => e.outcome === "denied").map((e) =>
        e.resourceName
      );
      assert(denied.includes(other.workflow.name), JSON.stringify(denied));
      assertEquals(denied.includes(other.workflow.id), false);
      assert(denied.includes("no-such-workflow"));
      // The request's own audit events name the same resource as its denial.
      assertEquals(
        audit.some((e) => e.resourceName === other.workflow.id),
        false,
        JSON.stringify(audit.map((e) => [e.action, e.resourceName])),
      );

      // Nothing was stored: both waits are open.
      assertEquals((await stepOf(repo, other)).step.isSignalWait, true);
      dataOf(await signalByKey(ctx, mine.workflow.name, KEY, payload));
    });
  },
});

Deno.test({
  name:
    "serve signal by key: an unknown workflow reads as not found to a caller who may signal every workflow",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await keyed(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);
      const payload = { verdict: "ship" };

      assertEquals(
        refusalOf(await signalByKey(ctx, "no-such-workflow", KEY, payload)),
        BY_KEY_REFUSAL,
      );
      assertEquals(
        refusalOf(await signalByKey(ctx, w.workflow.name, "other", payload)),
        BY_KEY_REFUSAL,
      );
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a key nothing has waited on is refused as no_open_wait, with nothing said of a last wait",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const workflow = Workflow.create({
        name: `signal-${crypto.randomUUID().slice(0, 8)}`,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "review",
                task: StepTask.waitForSignal(3600, SCHEMA, KEY),
              }),
            ],
          }),
        ],
      });
      await repo.repoContext.workflowRepo.save(workflow);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);

      const early = refusalOf(
        await signalByKey(ctx, workflow.name, KEY, { verdict: "ship" }),
      );
      assertEquals(early.code, "workflow_signal_refused");
      assertEquals(early.details, { refusal: "no_open_wait" });
      assertEquals(early.message.includes("last wait"), false);
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a retry after a delivery is no_open_wait and names the wait the first signal settled",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await keyed(repo);
      const signalOnly = ctxWith(repo, [workflowGrant(["signal"])]);
      const reader = ctxWith(repo, [workflowGrant(["signal", "read"])]);
      const payload = { verdict: "ship" };
      const first = dataOf(
        await signalByKey(signalOnly, w.workflow.name, KEY, payload),
      );
      const receipt = first.signal as { id: string };

      // A sender whose reply was lost can tell its signal landed: the last
      // wait under the key was settled when it sent.
      const plain = refusalOf(
        await signalByKey(signalOnly, w.workflow.name, KEY, payload),
      );
      assertEquals(plain.code, "workflow_signal_refused");
      assertEquals(plain.details?.refusal, "no_open_wait");
      const last = plain.details?.lastWait as Record<string, unknown>;
      assertEquals(Object.keys(last).sort(), [
        "settledAs",
        "settledAt",
        "waitId",
      ]);
      assertEquals(last.waitId, w.waitId);
      assertEquals(last.settledAs, "accepted");
      assertEquals(plain.message.includes(w.workflow.name), false);
      assertEquals(JSON.stringify(plain).includes(receipt.id), false);
      // The message says when, too: the CLI prints the message, and the
      // refusal also reaches a sender who is early for the next run.
      assertStringIncludes(
        plain.message,
        `settled by a signal at ${last.settledAt}.`,
      );
      assertEquals(plain.message.includes("has already landed"), false);

      // A caller who may read the workflow is told which signal it was.
      const told = refusalOf(
        await signalByKey(reader, w.workflow.name, KEY, payload),
      );
      assertEquals(told.details?.refusal, "no_open_wait");
      assertStringIncludes(told.message, w.workflow.name);
      assertStringIncludes(
        told.message,
        `settled by signal ${receipt.id} at ${last.settledAt}.`,
      );
      // The reader's message names the command that reaches the server.
      assertStringIncludes(
        told.message,
        'Run "swamp workflow waits --server <server>"',
      );
      assertEquals(
        ((told.details?.lastWait as Record<string, unknown>).receipt as {
          id: string;
        }).id,
        receipt.id,
      );
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a run grant alone does not deliver when the server requires an explicit grant",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await keyed(repo);
      const grants = [workflowGrant(["run"])];
      const payload = { verdict: "ship" };

      assertEquals(
        refusalOf(
          await signalByKey(
            ctxWith(repo, grants, { runImpliesSignal: false }),
            w.workflow.name,
            KEY,
            payload,
          ),
        ),
        BY_KEY_REFUSAL,
      );
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);
      dataOf(
        await signalByKey(ctxWith(repo, grants), w.workflow.name, KEY, payload),
      );
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a deny by name and a deny on tags reach a request that names the workflow by ID",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const prod = await keyed(repo, undefined, { env: "prod" });
      const named = await keyed(repo);
      const payload = { verdict: "ship" };
      const tags = createServeCtx(repo, TAG_GRANTS);
      const byName = ctxWith(repo, [
        workflowGrant(["signal", "read"]),
        workflowGrant(["signal"], named.workflow.name, "deny"),
      ]);

      for (
        const [ctx, w] of [[tags, prod], [byName, named]] as const
      ) {
        for (const workflow of [w.workflow.id, w.workflow.name]) {
          assertEquals(
            refusalOf(await signalByKey(ctx, workflow, KEY, payload)),
            BY_KEY_REFUSAL,
          );
        }
        assertEquals((await stepOf(repo, w)).step.isSignalWait, true);
      }
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a workflow named with another workflow's ID does not redirect the signal",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const target = await keyed(repo);
      // A workflow whose name is the target's ID, with no such key.
      const decoy = Workflow.create({
        name: target.workflow.id,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "review",
                task: StepTask.waitForSignal(3600, SCHEMA, "other"),
              }),
            ],
          }),
        ],
      });
      await repo.repoContext.workflowRepo.save(decoy);
      const ctx = ctxWith(repo, [workflowGrant(["signal"], decoy.name)]);

      assertEquals(
        refusalOf(
          await signalByKey(ctx, target.workflow.id, KEY, { verdict: "ship" }),
        ),
        BY_KEY_REFUSAL,
      );
      assertEquals((await stepOf(repo, target)).step.isSignalWait, true);
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a caller allowed on a copy that shares a workflow's ID does not reach the original's wait",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const original = await keyed(repo);
      // A copied file keeps its ID, and key claims are kept per ID. The
      // copy is written by hand, as a copied file is: saving it through the
      // repository would rename the original.
      const copy = { name: `copy-${crypto.randomUUID().slice(0, 8)}` };
      const path = repo.repoContext.workflowRepo.getPath(original.workflow.id);
      await Deno.writeTextFile(
        join(dirname(path), `workflow-${copy.name}.yaml`),
        (await Deno.readTextFile(path)).replace(
          `name: ${original.workflow.name}`,
          `name: ${copy.name}`,
        ),
      );
      const both = await repo.repoContext.workflowRepo.findAll();
      assertEquals(
        both.filter((w) => w.id === original.workflow.id).map((w) => w.name)
          .sort(),
        [copy.name, original.workflow.name].sort(),
      );
      const audit: AuditEvent[] = [];
      const ctx = ctxWith(repo, [workflowGrant(["signal"], copy.name)], {
        audit,
      });

      assertEquals(
        refusalOf(await signalByKey(ctx, copy.name, KEY, { verdict: "ship" })),
        BY_KEY_REFUSAL,
      );
      assertEquals((await stepOf(repo, original)).step.isSignalWait, true);
      const denial = audit.find((e) => e.outcome === "denied");
      assertEquals(denial?.resourceName, original.workflow.name);

      // The answer is the same once the original's wait is settled, so the
      // caller cannot tell whether the original has a wait open.
      dataOf(
        await signalByKey(
          ctxWith(repo, [workflowGrant(["signal"])]),
          original.workflow.name,
          KEY,
          { verdict: "ship" },
        ),
      );
      assertEquals(
        refusalOf(await signalByKey(ctx, copy.name, KEY, { verdict: "ship" })),
        BY_KEY_REFUSAL,
      );
    });
  },
});

Deno.test({
  name:
    "serve signal by key: a wait ID, when a request carries one, is the address",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const w = await keyed(repo);
      const other = await keyed(repo);
      const send = (ctx: ConnectionContext, payload: Record<string, unknown>) =>
        sendRequest(ctx, {
          type: "workflow.signal",
          id: `signal-${crypto.randomUUID()}`,
          payload: { ...payload, payload: { verdict: "ship" } },
        });

      // A wait ID that is not a UUID is malformed, as it always was: the
      // request does not fall through to the key beside it.
      const allowed = ctxWith(repo, [workflowGrant(["signal"])]);
      const malformed = refusalOf(
        await send(allowed, {
          waitId: "not-a-uuid",
          workflow: w.workflow.name,
          key: KEY,
        }),
      );
      assertEquals(malformed.code, "invalid_request");
      // The refusal says what an address is, not only that the input is bad.
      assertStringIncludes(malformed.message, "waitId");
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);

      // Authorized and delivered by the wait ID: a grant on the workflow
      // named beside it does not carry the signal to another workflow's wait.
      const onOther = ctxWith(repo, [
        workflowGrant(["signal"], other.workflow.name),
      ]);
      assertEquals(
        refusalOf(
          await send(onOther, {
            waitId: w.waitId,
            workflow: other.workflow.name,
            key: KEY,
          }),
        ),
        BY_KEY_REFUSAL,
      );
      assertEquals((await stepOf(repo, other)).step.isSignalWait, true);

      // A client that sends extra context beside a wait ID keeps working,
      // as against a server from before the key form.
      const data = dataOf(
        await send(allowed, { waitId: w.waitId, workflow: "anything" }),
      );
      assertEquals(data.waitId, w.waitId);
      assertEquals((await stepOf(repo, other)).step.isSignalWait, true);
    });
  },
});

Deno.test({
  name:
    "serve signal by key over HTTP: a signal-only token delivers, and each not-found case is the same 404",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const mine = await keyed(repo);
      const other = await keyed(repo);
      const ctx = ctxWith(repo, [
        workflowGrant(["signal"], mine.workflow.name),
      ]);
      const payload = { verdict: "ship" };

      const refused = [
        await postByKey(ctx, {
          workflow: other.workflow.name,
          key: KEY,
          payload,
        }),
        await postByKey(ctx, {
          workflow: mine.workflow.name,
          key: "nope",
          payload,
        }),
        await postByKey(ctx, {
          workflow: "no-such-workflow",
          key: KEY,
          payload,
        }),
        await postByKey(ctx, {
          workflow: mine.workflow.name,
          key: "No Key",
          payload,
        }),
      ];
      for (const reply of refused) {
        assertEquals(reply, {
          status: 404,
          body: { status: "not_found", message: "Signal wait not found" },
        });
      }
      assertEquals((await stepOf(repo, other)).step.isSignalWait, true);

      const reply = await postByKey(ctx, {
        workflow: mine.workflow.name,
        key: KEY,
        payload,
      });
      assertEquals(reply.status, 200, JSON.stringify(reply));
      const body = reply.body as Record<string, unknown>;
      assertEquals(body.status, "delivered");
      const data = body.data as Record<string, unknown>;
      assertEquals(Object.keys(data).sort(), ["signal", "waitId"]);
      assertEquals(data.waitId, mine.waitId);

      await resume(repo, mine);
      assertEquals(
        ((await stepOf(repo, mine)).step.output as { payload: unknown })
          .payload,
        payload,
      );
    });
  },
});

Deno.test({
  name:
    "serve signal by key over HTTP: no open wait is 409, and a body that does not name a workflow and a key is 400",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      resetRateLimitState();
      const w = await keyed(repo);
      const ctx = ctxWith(repo, [workflowGrant(["signal"])]);
      const payload = { verdict: "ship" };
      const address = { workflow: w.workflow.name, key: KEY };

      for (
        const body of [
          { payload },
          { workflow: w.workflow.name, payload },
          { key: KEY, payload },
          { workflow: 7, key: KEY, payload },
          { ...address, key: "k".repeat(65), payload },
          { ...address, workflow: "w".repeat(257), payload },
          { ...address, waitId: w.waitId, payload },
          address,
        ]
      ) {
        assertEquals((await postByKey(ctx, body)).status, 400);
      }
      assertEquals((await stepOf(repo, w)).step.isSignalWait, true);

      assertEquals((await postByKey(ctx, { ...address, payload })).status, 200);
      const again = await postByKey(ctx, { ...address, payload });
      assertEquals(again.status, 409);
      const body = again.body as Record<string, unknown>;
      assertEquals(body.status, "no_open_wait");
      assertEquals(String(body.message).includes(w.workflow.name), false);
      const last = body.lastWait as Record<string, unknown>;
      assertEquals(last.waitId, w.waitId);
      assertEquals(last.settledAs, "accepted");
      assertEquals("receipt" in last, false);
    });
  },
});
