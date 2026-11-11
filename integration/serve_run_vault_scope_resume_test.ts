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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type { Principal } from "../src/domain/access/principal.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { Group } from "../src/domain/models/access/group_model.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { DelegationDirectory } from "../src/domain/access/delegation_directory.ts";
import { delegationSessionName } from "../src/serve/delegated_token_auth.ts";
import { CONSENTED_TO_EVERYTHING } from "./serve_request_harness.ts";
import "../src/domain/models/models.ts";
import {
  BOT,
  grant,
  loadRun,
  revokeTokenRecord,
  roomcontrolOnly,
  ROOT,
  runnerGrants,
  saveTokenRecord,
  SECRETS,
  sendAs,
  type SessionSetup,
  stepOf,
  TEST_APP_CLIENT,
  vaultDenials,
  type VaultScopeFixture,
  withVaultScopeFixture,
} from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

function after(
  name: string,
  task: StepTask,
  dependsOn: string,
  condition = TriggerCondition.completed(),
): Step {
  return Step.create({
    name,
    task,
    dependsOn: [{ step: dependsOn, condition }],
  });
}

function gatedReads(name: string, autoResume = true): Workflow {
  return Workflow.create({
    name,
    autoResume,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
          Step.create({
            name: "erp",
            task: StepTask.model("erp-reader", "read"),
            dependsOn: [{
              step: "gate",
              condition: TriggerCondition.succeeded(),
            }],
          }),
          after("rc", StepTask.model("rc-reader", "read"), "erp"),
        ],
      }),
    ],
  });
}

function failingReads(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "rc",
            task: StepTask.model("rc-reader", "read"),
          }),
          after(
            "erp",
            StepTask.model("erp-reader", "read"),
            "rc",
            TriggerCondition.succeeded(),
          ),
        ],
      }),
    ],
  });
}

async function startRun(
  f: VaultScopeFixture,
  workflow: Workflow,
  principal: Principal,
  session: SessionSetup = {},
): Promise<WorkflowRun> {
  await f.repo.repoContext.workflowRepo.save(workflow);
  await sendAs(
    f.ctx,
    "workflow.run",
    { workflowIdOrName: workflow.name },
    principal,
    session,
  );
  const run = await f.repo.repoContext.workflowRunRepo.findLatestByWorkflowId(
    createWorkflowId(workflow.id),
  );
  if (!run) throw new Error(`no run of ${workflow.name}`);
  return run;
}

/**
 * Waits for `runId` to finish and returns it. A run's record turns terminal
 * before its resume has flushed and left the registry, so this also waits
 * for the registry to empty: the fixture removes the repo right after.
 */
async function settled(
  f: VaultScopeFixture,
  workflow: Workflow,
  runId: string,
): Promise<WorkflowRun> {
  let run: WorkflowRun | null = null;
  await waitFor(async () => {
    run = await loadRun(f, workflow, runId);
    return (run?.status === "succeeded" || run?.status === "failed") &&
      (f.ctx.activeRunRegistry?.size ?? 0) === 0;
  }, `run ${runId} to finish`);
  return run!;
}

function assertBotScoped(f: VaultScopeFixture, run: WorkflowRun): void {
  const erp = stepOf(run, "main", "erp");
  assertEquals(erp.status, "failed");
  assertStringIncludes(erp.error ?? "", "vault 'erp' is refused for user:bot");
  assertEquals(stepOf(run, "main", "rc").status, "succeeded");
  assertEquals(f.seen, [SECRETS.roomcontrol]);
}

Deno.test({
  name:
    "serve resume vault scope: approve-then-resume of a bot run stays scoped to the bot when the approver holds no vault grant",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = gatedReads("gated-bot");
      const suspended = await startRun(f, workflow, BOT);
      assertEquals(suspended.status, "suspended");
      await sendAs(f.ctx, "workflow.approve", {
        workflowIdOrName: workflow.name,
        runId: suspended.id,
        stepName: "gate",
      }, ROOT);
      assertBotScoped(f, await settled(f, workflow, suspended.id));
      const denial = vaultDenials(f.audits).find((d) =>
        d.resourceName === "erp"
      );
      assertEquals(denial?.principalId, "bot");
    }, { ctx: { detached: true } }),
});

for (const detached of [false, true]) {
  const path = detached ? "detached" : "attached";
  Deno.test({
    name:
      `serve resume vault scope: the ${path} resume of a failed bot run by root stays scoped to the bot`,
    ...SANITIZE,
    fn: () =>
      withVaultScopeFixture(async (f) => {
        const workflow = failingReads(`resume-${path}`);
        f.failNext.count = 1;
        const failed = await startRun(f, workflow, BOT);
        assertEquals(failed.status, "failed");
        await sendAs(f.ctx, "workflow.resume", {
          workflowIdOrName: workflow.name,
          runId: failed.id,
        }, ROOT);
        assertBotScoped(f, await settled(f, workflow, failed.id));
      }, { ctx: { detached } }),
  });
}

Deno.test({
  name:
    "serve resume vault scope: an OAuth principal scoped by an IdP group stays scoped after approve-then-resume",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = gatedReads("gated-oauth");
      const suspended = await startRun(f, workflow, BOT, {
        idpGroups: ["room-ops"],
      });
      assertEquals(suspended.triggeringPrincipal?.membership.idpGroups, [
        "room-ops",
      ]);
      await sendAs(f.ctx, "workflow.approve", {
        workflowIdOrName: workflow.name,
        runId: suspended.id,
        stepName: "gate",
      }, ROOT);
      assertBotScoped(f, await settled(f, workflow, suspended.id));
    }, {
      ctx: { detached: true },
      grants: [
        ...runnerGrants("user:bot"),
        ...runnerGrants("user:root"),
        grant("idp-group:room-ops", "vault", "roomcontrol"),
      ],
    }),
});

const CI_GROUP: Group = {
  name: "ci",
  members: [BOT],
  createdBy: { kind: "user", id: "admin" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

Deno.test({
  name:
    "serve resume vault scope: a server-token principal scoped by a local group is scoped, and stays scoped on resume",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const token = await saveTokenRecord(f.repo, BOT);
      const workflow = gatedReads("gated-token");
      const suspended = await startRun(f, workflow, BOT, { token });
      assertEquals(suspended.triggeringPrincipal?.membership.localGroups, [
        "ci",
      ]);
      assertEquals(suspended.triggeringPrincipal?.tokenBinding, token);
      await sendAs(f.ctx, "workflow.approve", {
        workflowIdOrName: workflow.name,
        runId: suspended.id,
        stepName: "gate",
      }, ROOT);
      assertBotScoped(f, await settled(f, workflow, suspended.id));
    }, {
      ctx: { detached: true },
      groups: [CI_GROUP],
      grants: [
        ...runnerGrants("user:bot"),
        ...runnerGrants("user:root"),
        grant("group:ci", "vault", "roomcontrol"),
      ],
    }),
});

Deno.test({
  name:
    "serve resume vault scope: a server-token run whose token is revoked while suspended is refused every vault read on approve-then-resume",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const token = await saveTokenRecord(f.repo, BOT);
      const workflow = gatedReads("gated-token-revoked");
      const suspended = await startRun(f, workflow, BOT, { token });
      assertEquals(suspended.status, "suspended");
      await revokeTokenRecord(f.repo, token);
      await sendAs(f.ctx, "workflow.approve", {
        workflowIdOrName: workflow.name,
        runId: suspended.id,
        stepName: "gate",
      }, ROOT);
      const resumed = await settled(f, workflow, suspended.id);
      // The vault the bot's group allows is refused too: the token that
      // triggered the run no longer vouches for it.
      const rc = stepOf(resumed, "main", "rc");
      assertEquals(rc.status, "failed");
      assertStringIncludes(
        rc.error ?? "",
        "vault 'roomcontrol' is refused for user:bot",
      );
      assertStringIncludes(rc.error ?? "", "memberships are unavailable");
      assertEquals(f.seen, []);
    }, {
      ctx: { detached: true },
      groups: [CI_GROUP],
      grants: [
        ...runnerGrants("user:bot"),
        ...runnerGrants("user:root"),
        grant("group:ci", "vault", "roomcontrol"),
      ],
    }),
});

Deno.test({
  name:
    "serve resume vault scope: the parent's auto-resume after a nested gate is approved stays scoped to the bot",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const child = Workflow.create({
        name: "nested-gate",
        autoResume: true,
        jobs: [
          Job.create({
            name: "child-job",
            steps: [
              Step.create({
                name: "gate",
                task: StepTask.manualApproval("ok?"),
              }),
            ],
          }),
        ],
      });
      await f.repo.repoContext.workflowRepo.save(child);
      const parent = Workflow.create({
        name: "parent-of-gate",
        autoResume: true,
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "call",
                task: StepTask.workflow("nested-gate"),
              }),
              after("erp", StepTask.model("erp-reader", "read"), "call"),
              after("rc", StepTask.model("rc-reader", "read"), "erp"),
            ],
          }),
        ],
      });
      const suspended = await startRun(f, parent, BOT);
      assertEquals(suspended.status, "suspended");
      const childRun = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(createWorkflowId(child.id));
      assertEquals(childRun?.status, "suspended");
      const rootToken = await saveTokenRecord(f.repo, ROOT);
      await sendAs(
        f.ctx,
        "workflow.approve",
        {
          workflowIdOrName: child.name,
          runId: childRun!.id,
          stepName: "gate",
        },
        ROOT,
        { token: rootToken },
      );
      assertBotScoped(f, await settled(f, parent, suspended.id));
    }, { ctx: { detached: true } }),
});

for (const withVaultGrants of [true, false]) {
  Deno.test({
    name:
      `serve resume vault scope: a resume of a run that recorded no principal ${
        withVaultGrants
          ? "fails closed once vault grants exist"
          : "runs as today without vault grants"
      }`,
    ...SANITIZE,
    fn: () =>
      withVaultScopeFixture(async (f) => {
        const workflow = failingReads(`legacy-${withVaultGrants}`);
        f.failNext.count = 1;
        const failed = await startRun(f, workflow, BOT);
        // As an older release or replica would have saved it.
        const { triggeringPrincipal: _dropped, ...legacy } = failed.toData();
        await f.repo.repoContext.workflowRunRepo.save(
          createWorkflowId(workflow.id),
          WorkflowRun.fromData(legacy),
        );
        await sendAs(f.ctx, "workflow.resume", {
          workflowIdOrName: workflow.name,
          runId: failed.id,
        }, ROOT);
        const resumed = await settled(f, workflow, failed.id);
        if (withVaultGrants) {
          const rc = stepOf(resumed, "main", "rc");
          assertEquals(rc.status, "failed");
          assertStringIncludes(
            rc.error ?? "",
            "triggering principal and memberships are unavailable",
          );
          assertEquals(f.seen, []);
        } else {
          assertEquals(resumed.status, "succeeded");
          assertEquals(f.seen, [SECRETS.roomcontrol, SECRETS.erp]);
        }
      }, {
        grants: withVaultGrants ? roomcontrolOnly() : [
          ...runnerGrants("user:bot"),
          ...runnerGrants("user:root"),
        ] as Grant[],
      }),
  });
}

const ALICE: Principal = { kind: "user", id: "alice" };
const BOB: Principal = { kind: "user", id: "bob" };

function crossUserGrants(): Grant[] {
  return [
    ...runnerGrants("user:alice"),
    grant("user:alice", "vault", "erp"),
    grant("user:alice", "vault", "roomcontrol"),
    ...runnerGrants("user:bob"),
    grant("user:bob", "vault", "roomcontrol"),
    ...runnerGrants("user:root"),
    grant("user:root", "access", "*", ["admin"]),
  ];
}

function gatedWithNote(name: string, autoResume = false): Workflow {
  const base = gatedReads(name, autoResume);
  return Workflow.create({
    name,
    autoResume,
    inputs: { properties: { note: { type: "string" } } },
    jobs: [...base.jobs],
  });
}

async function approvedAliceRun(
  f: VaultScopeFixture,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const suspended = await startRun(f, workflow, ALICE);
  assertEquals(suspended.status, "suspended");
  await sendAs(f.ctx, "workflow.approve", {
    workflowIdOrName: workflow.name,
    runId: suspended.id,
    stepName: "gate",
  }, BOB);
  return suspended;
}

function resumeOf(
  workflow: Workflow,
  runId: string,
  inputs?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    workflowIdOrName: workflow.name,
    runId,
    ...(inputs ? { inputs } : {}),
  };
}

function erpStep(run: WorkflowRun) {
  return stepOf(run, "main", "erp");
}

for (const detached of [false, true]) {
  const path = detached ? "detached" : "attached";

  Deno.test({
    name:
      `serve resume vault scope: the ${path} resume of another person's run is held to the resumer's vault access too`,
    ...SANITIZE,
    fn: () =>
      withVaultScopeFixture(async (f) => {
        const workflow = gatedWithNote(`cross-${path}`);
        const run = await approvedAliceRun(f, workflow);
        await sendAs(f.ctx, "workflow.resume", resumeOf(workflow, run.id), BOB);
        const resumed = await settled(f, workflow, run.id);
        assertEquals(erpStep(resumed).status, "failed");
        assertStringIncludes(
          erpStep(resumed).error ?? "",
          "vault 'erp' is refused for user:bob",
        );
        assertEquals(f.seen.includes(SECRETS.erp), false);
        const denial = vaultDenials(f.audits).find((d) =>
          d.resourceName === "erp"
        );
        assertEquals(denial?.principalId, "bob");
      }, { ctx: { detached }, grants: crossUserGrants() }),
  });

  for (const resumer of [ALICE, ROOT]) {
    Deno.test({
      name: `serve resume vault scope: the ${path} resume of alice's run by ${
        resumer === ALICE ? "alice herself" : "an access admin"
      } keeps the run's vault access and may add inputs`,
      ...SANITIZE,
      fn: () =>
        withVaultScopeFixture(async (f) => {
          const workflow = gatedWithNote(`own-${path}-${resumer.id}`);
          const run = await approvedAliceRun(f, workflow);
          await sendAs(
            f.ctx,
            "workflow.resume",
            resumeOf(workflow, run.id, { note: "added" }),
            resumer,
          );
          const resumed = await settled(f, workflow, run.id);
          assertEquals(erpStep(resumed).status, "succeeded");
          assertEquals(f.seen.includes(SECRETS.erp), true);
          assertEquals(resumed.inputs.note, "added");
        }, { ctx: { detached }, grants: crossUserGrants() }),
    });
  }

  Deno.test({
    name:
      `serve resume vault scope: the ${path} resume of another person's run with inputs is refused before anything runs`,
    ...SANITIZE,
    fn: () =>
      withVaultScopeFixture(async (f) => {
        const workflow = gatedWithNote(`inputs-${path}`);
        const run = await approvedAliceRun(f, workflow);
        const frames = await sendAs(
          f.ctx,
          "workflow.resume",
          resumeOf(workflow, run.id, { note: "set-by-bob" }),
          BOB,
        );
        const error = frames.find((frame) => frame.type === "error") as
          | {
            error?: {
              code?: string;
              message?: string;
              details?: Record<string, unknown>;
            };
          }
          | undefined;
        assertEquals(error?.error?.code, "workflow_resume_failed");
        assertEquals(error?.error?.details?.resumeRefusal, "inputs_refused");
        assertStringIncludes(error?.error?.message ?? "", "started this run");
        const after = await loadRun(f, workflow, run.id);
        assertEquals(after?.status, "suspended");
        assertEquals(after?.inputs.note, undefined);
        assertEquals(f.seen, []);
      }, { ctx: { detached }, grants: crossUserGrants() }),
  });
}

Deno.test({
  name:
    "serve resume vault scope: auto-resume after someone else approves still runs with the starter's vault access",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = gatedWithNote("cross-auto", true);
      const run = await approvedAliceRun(f, workflow);
      const resumed = await settled(f, workflow, run.id);
      assertEquals(erpStep(resumed).status, "succeeded");
      assertEquals(f.seen.includes(SECRETS.erp), true);
    }, { ctx: { detached: true }, grants: crossUserGrants() }),
});

Deno.test({
  name:
    "serve resume vault scope: a child run started inside someone else's resume is held to the resumer and records the starter",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const child = Workflow.create({
        name: "erp-child",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "erp",
                task: StepTask.model("erp-reader", "read"),
              }),
            ],
          }),
        ],
      });
      await f.repo.repoContext.workflowRepo.save(child);
      const parent = Workflow.create({
        name: "gated-parent",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "gate",
                task: StepTask.manualApproval("ok?"),
              }),
              after(
                "call",
                StepTask.workflow("erp-child"),
                "gate",
                TriggerCondition.succeeded(),
              ),
            ],
          }),
        ],
      });
      const run = await approvedAliceRun(f, parent);
      await sendAs(f.ctx, "workflow.resume", resumeOf(parent, run.id), BOB);
      await settled(f, parent, run.id);
      const childRun = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(createWorkflowId(child.id));
      assertEquals(childRun?.triggeringPrincipal?.id, "alice");
      assertStringIncludes(
        stepOf(childRun!, "main", "erp").error ?? "",
        "vault 'erp' is refused for user:bob",
      );
      assertEquals(f.seen.includes(SECRETS.erp), false);
    }, { ctx: { detached: true }, grants: crossUserGrants() }),
});

function delegatedSession(person: string): SessionSetup {
  const id = `link-${person}`;
  return {
    token: {
      name: delegationSessionName(id),
      createdAt: "2026-11-01T00:00:00.000Z",
      principalId: `user:${person}`,
    },
    delegation: { client: TEST_APP_CLIENT, id },
  };
}

function linkedPeople(): DelegationDirectory {
  return {
    standingOf: (id: string) => CONSENTED_TO_EVERYTHING.standingOf(id),
    recordOf: (id: string) => ({
      integrationId: "test-app",
      person: { sub: id.replace(/^link-/, "") },
    }),
  } as unknown as DelegationDirectory;
}

Deno.test({
  name:
    "serve resume vault scope: a delegated resumer is held to their own vault access and can't add inputs to another person's run",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      f.ctx.delegationDirectory = linkedPeople();
      const workflow = gatedWithNote("cross-delegated");
      const run = await approvedAliceRun(f, workflow);
      const refused = await sendAs(
        f.ctx,
        "workflow.resume",
        resumeOf(workflow, run.id, { note: "x" }),
        BOB,
        delegatedSession("bob"),
      );
      assertEquals(
        refused.some((frame) =>
          frame.type === "error" &&
          (frame as { error?: { details?: Record<string, unknown> } }).error
              ?.details?.resumeRefusal === "inputs_refused"
        ),
        true,
      );
      await sendAs(
        f.ctx,
        "workflow.resume",
        resumeOf(workflow, run.id),
        BOB,
        delegatedSession("bob"),
      );
      const resumed = await settled(f, workflow, run.id);
      assertStringIncludes(
        erpStep(resumed).error ?? "",
        "vault 'erp' is refused for user:bob",
      );
    }, { ctx: { detached: true }, grants: crossUserGrants() }),
});

Deno.test({
  name:
    "serve resume vault scope: a person resuming their own run through a delegation may add inputs, and an admin's delegation may not on another's",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      f.ctx.delegationDirectory = linkedPeople();
      const workflow = gatedWithNote("own-delegated");
      const run = await approvedAliceRun(f, workflow);
      const byAdminLink = await sendAs(
        f.ctx,
        "workflow.resume",
        resumeOf(workflow, run.id, { note: "x" }),
        ROOT,
        delegatedSession("root"),
      );
      assertEquals(
        byAdminLink.some((frame) =>
          frame.type === "error" &&
          (frame as { error?: { details?: Record<string, unknown> } }).error
              ?.details?.resumeRefusal === "inputs_refused"
        ),
        true,
      );
      await sendAs(
        f.ctx,
        "workflow.resume",
        resumeOf(workflow, run.id, { note: "mine" }),
        ALICE,
        delegatedSession("alice"),
      );
      const resumed = await settled(f, workflow, run.id);
      assertEquals(resumed.inputs.note, "mine");
      assertEquals(erpStep(resumed).status, "succeeded");
    }, { ctx: { detached: true }, grants: crossUserGrants() }),
});
