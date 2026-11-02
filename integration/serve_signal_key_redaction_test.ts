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
import { dirname, join } from "@std/path";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { redactingFor } from "../src/serve/handlers/nested_run_redaction.ts";
import type { SerializedEvent } from "../src/serve/protocol.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { SIGNAL_WAITS_NOT_CONFIGURED } from "../src/domain/workflows/signal_wait_store.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowSignalDeps,
  workflowSignal,
} from "../src/libswamp/workflows/signal.ts";
import {
  CALLER,
  errorFrame,
  type Frame,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";
import { ctxWith, workflowGrant } from "./serve_signal_harness.ts";

await initializeLogging({});

const opts = { sanitizeOps: false, sanitizeResources: false };

const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

const KEY = "release-key";
const AUDIT_KEY = "audit-key";
const HOTFIX_KEY = "hotfix-key";

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function keyedChild(): Workflow {
  return Workflow.create({
    name: unique("child"),
    jobs: [
      Job.create({
        name: "release",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, SCHEMA, KEY),
          }),
        ],
      }),
    ],
  });
}

function calling(child: Workflow): Workflow {
  return Workflow.create({
    name: unique("parent"),
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call-nested",
            task: StepTask.workflow(child.name),
          }),
        ],
      }),
    ],
  });
}

async function savePair(
  repo: ServeRepo,
): Promise<{ parent: Workflow; child: Workflow }> {
  const child = keyedChild();
  const parent = calling(child);
  await repo.repoContext.workflowRepo.save(child);
  await repo.repoContext.workflowRepo.save(parent);
  return { parent, child };
}

async function runAs(
  ctx: ConnectionContext,
  workflow: Workflow,
): Promise<Frame[]> {
  const frames = await sendRequest(ctx, {
    type: "workflow.run",
    id: `run-${crypto.randomUUID()}`,
    payload: { workflowIdOrName: workflow.name },
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  return frames;
}

function eventsOf(frames: Frame[]): SerializedEvent[] {
  return frames.filter((f) => f.type === "event").map((f) =>
    f.event as SerializedEvent
  );
}

function suspendedOf(frames: Frame[]): SerializedEvent {
  const suspended = eventsOf(frames).findLast((e) => e.kind === "suspended");
  assert(suspended, JSON.stringify(frames));
  return suspended;
}

function keyRefusalOf(frames: Frame[]): SerializedEvent {
  const failed = eventsOf(frames).find((e) =>
    e.kind === "step_failed" && e.stepId === "review"
  );
  assert(failed, JSON.stringify(frames));
  assertEquals(failed.error, "wait_key_held");
  return failed;
}

async function asSeenBy(
  ctx: ConnectionContext,
  event: SerializedEvent,
): Promise<SerializedEvent> {
  const socket = {
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  } as unknown as WebSocket;
  const redact = redactingFor(ctx, socket, CALLER);
  assert(redact, "a token-mode context redacts the stream");
  return await redact(event);
}

function readerOf(
  repo: ServeRepo,
  parent: Workflow,
  child?: Workflow,
): ConnectionContext {
  return ctxWith(repo, [
    workflowGrant(["run", "read"], parent.name),
    ...(child ? [workflowGrant(["read"], child.name)] : []),
  ]);
}

Deno.test({
  name:
    "serve key redaction: a nested run's keyed wait, key included, is named only to a reader of the child's workflow",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      // Each caller runs a parent and child of its own: a second run of the
      // same child would be refused the key, which the next test covers.
      const shown = await savePair(repo);
      const hidden = await savePair(repo);

      const reader = readerOf(repo, shown.parent, shown.child);
      const suspended = suspendedOf(await runAs(reader, shown.parent));
      const waits = suspended.nestedSignalWaits as Array<
        Record<string, unknown>
      >;
      assertEquals(waits.length, 1, JSON.stringify(suspended));
      assertEquals(waits[0].workflowName, shown.child.name);
      assertEquals(waits[0].stepId, "review");
      assertEquals(waits[0].key, KEY);

      const parentOnly = readerOf(repo, hidden.parent);
      const frames = await runAs(parentOnly, hidden.parent);
      assertEquals("nestedSignalWaits" in suspendedOf(frames), false);
      assertEquals(JSON.stringify(frames).includes(KEY), false);

      const before = structuredClone(suspended);
      const seen = await asSeenBy(
        readerOf(repo, shown.parent),
        suspended,
      );
      assertEquals(seen.kind, "suspended");
      assertEquals("nestedSignalWaits" in seen, false);
      assertEquals(JSON.stringify(seen).includes(KEY), false);
      assertEquals(suspended, before);
    });
  },
});

Deno.test({
  name:
    "serve key redaction: a run refused a held key names the holding wait only to a reader of its workflow",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const { parent, child } = await savePair(repo);
      const reader = readerOf(repo, parent, child);
      const holding = suspendedOf(await runAs(reader, parent));
      const holder = (holding.nestedSignalWaits as Array<
        Record<string, string>
      >)[0];

      const refused = keyRefusalOf(await runAs(reader, parent));
      assertEquals(refused.waitKeyHolder, {
        workflowId: child.id,
        workflowName: child.name,
        key: KEY,
        runId: holder.runId,
        stepName: "review",
        waitId: holder.waitId,
      });

      const parentOnly = readerOf(repo, parent);
      const frames = await runAs(parentOnly, parent);
      const bare = keyRefusalOf(frames);
      assertEquals("waitKeyHolder" in bare, false);
      assertEquals(JSON.stringify(frames).includes(holder.runId), false);

      const before = structuredClone(refused);
      const seen = await asSeenBy(parentOnly, refused);
      assertEquals("waitKeyHolder" in seen, false);
      assertEquals(seen.error, "wait_key_held");
      assertEquals(refused, before);

      const direct = keyRefusalOf(
        await runAs(
          ctxWith(repo, [workflowGrant(["run", "read"], child.name)]),
          child,
        ),
      );
      assertEquals(direct.waitKeyHolder, refused.waitKeyHolder);
    });
  },
});

function early(id?: string): Workflow {
  return Workflow.create({
    ...(id !== undefined ? { id } : {}),
    name: unique("early"),
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "review",
            task: StepTask.waitForSignal(3600, SCHEMA, KEY, 600),
          }),
          Step.create({
            name: "audit",
            task: StepTask.waitForSignal(3600, SCHEMA, AUDIT_KEY, 600),
          }),
          Step.create({
            name: "hotfix",
            task: StepTask.waitForSignal(3600, SCHEMA, HOTFIX_KEY, 600),
          }),
        ],
      }),
    ],
  });
}

/**
 * A copy of `original` under another name that keeps its ID, written by
 * hand as a copied file is: saving it through the repository would rename
 * the original.
 */
async function copyOf(repo: ServeRepo, original: Workflow): Promise<string> {
  const name = unique("copy");
  const path = repo.repoContext.workflowRepo.getPath(
    createWorkflowId(original.id),
  );
  await Deno.writeTextFile(
    join(dirname(path), `workflow-${name}.yaml`),
    (await Deno.readTextFile(path)).replace(
      `name: ${original.name}`,
      `name: ${name}`,
    ),
  );
  return name;
}

async function holdThroughServe(
  repo: ServeRepo,
  workflow: string,
  key: string,
): Promise<string> {
  const frames = await sendRequest(
    ctxWith(repo, [workflowGrant(["signal"])]),
    {
      type: "workflow.signal",
      id: `signal-${crypto.randomUUID()}`,
      payload: {
        workflow,
        key,
        payload: { verdict: "ship" },
        acceptsPending: true,
        acceptsReceipt: true,
      },
    },
  );
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const reply = frames.find((f) => f.type === "workflow.signal");
  const accepted = reply?.payload?.accepted as
    | { signal: { id: string } }
    | undefined;
  assert(accepted, JSON.stringify(frames));
  return accepted.signal.id;
}

async function holdLocally(
  repo: ServeRepo,
  workflow: string,
  key: string,
): Promise<string> {
  const deps = createWorkflowSignalDeps(
    repo.repoContext.workflowRunRepo,
    repo.repoContext.signalWaits ?? SIGNAL_WAITS_NOT_CONFIGURED,
    repo.repoContext.workflowRepo,
  );
  for await (
    const event of workflowSignal(createLibSwampContext(), deps, {
      workflow,
      key,
      payload: { verdict: "ship" },
      submittedBy: "local-user",
    })
  ) {
    if (event.kind === "pending") return event.data.signal.id;
    assert(event.kind === "resolving", JSON.stringify(event));
  }
  throw new Error("the signal was not held");
}

async function pendingFor(
  ctx: ConnectionContext,
): Promise<Array<[string, string, string]>> {
  const frames = await sendRequest(ctx, {
    type: "workflow.waits",
    id: `waits-${crypto.randomUUID()}`,
    payload: { includePending: true },
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const data = frames.find((f) => f.type === "workflow.waits")!.payload!
    .data as { pending: Array<Record<string, string>> };
  return data.pending
    .map((p): [string, string, string] => [p.receiptId, p.workflowName, p.key])
    .sort();
}

Deno.test({
  name:
    "serve key redaction: a held signal is listed only to a reader of the workflow it is for, never under another that shares its ID",
  ...opts,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const original = early();
      await repo.repoContext.workflowRepo.save(original);
      const copy = await copyOf(repo, original);
      const alone = early();
      await repo.repoContext.workflowRepo.save(alone);

      // The duplicate ID is what the cases below rely on.
      const sameId = await repo.repoContext.workflowRepo.findAllById!(
        createWorkflowId(original.id),
      );
      assertEquals(
        sameId.map((w) => w.name).sort(),
        [copy, original.name].sort(),
      );

      const toOriginal = await holdThroughServe(repo, original.name, KEY);
      const toCopy = await holdThroughServe(repo, copy, AUDIT_KEY);
      // Sent through the local command, it is bound to none: it is listed
      // under the one workflow that declares its ID, so on a shared ID to no
      // one, as no single name can authorize a reader for it.
      const localAlone = await holdLocally(repo, alone.name, KEY);
      const localShared = await holdLocally(repo, original.name, HOTFIX_KEY);

      const pendingAs = (...patterns: string[]) =>
        pendingFor(
          ctxWith(repo, patterns.map((p) => workflowGrant(["read"], p))),
        );
      assertEquals(await pendingAs(original.name), [
        [toOriginal, original.name, KEY],
      ]);
      assertEquals(await pendingAs(copy), [[toCopy, copy, AUDIT_KEY]]);
      assertEquals(await pendingAs(alone.name), [
        [localAlone, alone.name, KEY],
      ]);
      const everything = await pendingAs("*");
      assertEquals(
        everything,
        [
          [toOriginal, original.name, KEY],
          [toCopy, copy, AUDIT_KEY],
          [localAlone, alone.name, KEY],
        ].sort() as Array<[string, string, string]>,
      );
      assertEquals(JSON.stringify(everything).includes(localShared), false);
      assertEquals(await pendingAs(unique("nothing")), []);
    });
  },
});
