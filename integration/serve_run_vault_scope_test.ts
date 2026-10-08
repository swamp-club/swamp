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
 * Serve runs are held to the triggering principal's vault grants
 * (swamp-club#2676), end to end: requests go through serve's real handlers
 * against a real repository with local_encryption vaults, and the tests
 * assert on step status, the error message and the denied audit event (the
 * in-process executor stringifies errors, so never on the error class).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { MockVaultProvider } from "../src/domain/vaults/mock_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import "../src/domain/models/models.ts";
import {
  ADMIN,
  BOT,
  grant,
  loadRun,
  methodError,
  resumeAs,
  roomcontrolOnly,
  ROOT,
  runMethodAs,
  runnerGrants,
  runWorkflowAs,
  saveDefinition,
  SECRETS,
  stepOf,
  vaultDenials,
  vaultRef,
  type VaultScopeFixture,
  withVaultScopeFixture,
} from "./serve_run_vault_scope_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

function step(name: string, task: StepTask, after?: string): Step {
  return Step.create({
    name,
    task,
    ...(after
      ? {
        dependsOn: [{ step: after, condition: TriggerCondition.completed() }],
      }
      : {}),
  });
}

function workflowOf(name: string, steps: Step[]): Workflow {
  return Workflow.create({
    name,
    jobs: [Job.create({ name: "main", steps })],
  });
}

Deno.test({
  name:
    "serve run vault scope: workflow.run by a roomcontrol-only principal refuses erp and audits it, roomcontrol reads",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = workflowOf("read-both", [
        step("erp", StepTask.model("erp-reader", "read")),
        step("rc", StepTask.model("rc-reader", "read"), "erp"),
      ]);
      const { run } = await runWorkflowAs(f, workflow, BOT);
      const erp = stepOf(run, "main", "erp");
      assertEquals(erp.status, "failed");
      assertStringIncludes(erp.error ?? "", "vault 'erp' is refused");
      assertStringIncludes(erp.error ?? "", "user:bot");
      assertEquals(stepOf(run, "main", "rc").status, "succeeded");
      assertEquals(f.seen, [SECRETS.roomcontrol]);
      const denials = vaultDenials(f.audits);
      assertEquals(denials.length, 1);
      assertEquals(denials[0].resourceName, "erp");
      assertEquals(denials[0].principalId, "bot");
      assertStringIncludes(denials[0].detail ?? "", `run=${run.id}`);
    }),
});

Deno.test({
  name:
    "serve run vault scope: model.method.run by a roomcontrol-only principal refuses erp and audits it, roomcontrol reads",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const refused = await runMethodAs(f, "erp-reader", "read", BOT);
      assertStringIncludes(
        methodError(refused) ?? "",
        "vault 'erp' is refused",
      );
      const allowed = await runMethodAs(f, "rc-reader", "read", BOT);
      assertEquals(methodError(allowed), undefined);
      assertEquals(f.seen, [SECRETS.roomcontrol]);
      const denials = vaultDenials(f.audits);
      assertEquals(denials.map((d) => d.resourceName), ["erp"]);
    }),
});

const WRITE_OPS = [
  "put",
  "delete",
  "putAnnotation",
  "deleteAnnotation",
  "putRefreshHook",
  "deleteRefreshHook",
];
const READ_OPS = ["get", "list", "getAnnotation", "getRefreshHook"];

Deno.test({
  name:
    "serve run vault scope: every context.vaultService operation on erp is refused; roomcontrol allows reads only",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = workflowOf("ops", [
        step("erp", StepTask.model("ops", "ops", { vault: "erp" })),
        step(
          "rc",
          StepTask.model("ops", "ops", { vault: "roomcontrol" }),
          "erp",
        ),
      ]);
      const { run } = await runWorkflowAs(f, workflow, BOT);
      assertEquals(run.status, "succeeded");
      const [erp, rc] = f.ops;
      for (const op of [...READ_OPS, ...WRITE_OPS]) {
        assertStringIncludes(erp[op], "vault 'erp' is refused", op);
      }
      for (const op of READ_OPS) {
        assertEquals(rc[op].includes("is refused"), false, `${op}: ${rc[op]}`);
      }
      for (const op of WRITE_OPS) {
        assertStringIncludes(
          rc[op],
          "Writing vault 'roomcontrol' is refused",
          op,
        );
      }
      // Nothing reached the refused vaults.
      const vaults = await f.vaults();
      assertEquals(await vaults.get("erp", "password"), SECRETS.erp);
      assertEquals(
        await vaults.get("roomcontrol", "password"),
        SECRETS.roomcontrol,
      );
      assertEquals((await vaults.list("erp")).includes("written"), false);
      // One audit per distinct vault, key and action.
      const erpDenials = vaultDenials(f.audits).filter((d) =>
        d.resourceName === "erp"
      );
      assertEquals(
        new Set(erpDenials.map((d) => d.action)),
        new Set(["vault.read", "vault.write"]),
      );
    }),
});

/** bot reads and writes its outputs vault and reads roomcontrol. */
function outputsGrants() {
  return [
    ...roomcontrolOnly(),
    grant("user:bot", "vault", "outputs", ["read", "write"]),
  ];
}

Deno.test({
  name:
    "serve run vault scope: a bot granted its outputs vault writes a sensitive output that a later step, a later run and a restarted resume read back",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = workflowOf("mint-and-read", [
        step("mint", StepTask.model("minter", "mint")),
        step("read", StepTask.model("creds-reader", "read"), "mint"),
      ]);
      const first = await runWorkflowAs(f, workflow, BOT);
      assertEquals(
        first.run.status,
        "succeeded",
        JSON.stringify(first.run.toData()).slice(0, 2000),
      );
      assertEquals(f.seen, ["minted-1"]);
      // The stored value lives in the outputs vault, not in the record.
      const vaults = await f.vaults();
      assertEquals((await vaults.list("outputs")).length, 2);

      const later = workflowOf("read-later", [
        step("read", StepTask.model("creds-reader", "read")),
      ]);
      assertEquals(
        (await runWorkflowAs(f, later, BOT)).run.status,
        "succeeded",
      );
      assertEquals(f.seen, ["minted-1", "minted-1"]);

      // A run that fails after the write, resumed by root (no vault grant)
      // through a restarted serve: the resume reads back as the bot.
      f.failNext.count = 1;
      const failed = await runWorkflowAs(f, workflow, BOT);
      assertEquals(failed.run.status, "failed");
      const restarted = await f.restartedCtx();
      await resumeAs(f, workflow, failed.run.id, ROOT, restarted);
      const resumed = await loadRun(f, workflow, failed.run.id);
      assertEquals(resumed?.status, "succeeded");
      assertEquals(f.seen, ["minted-1", "minted-1", "minted-2"]);
      assertEquals(vaultDenials(f.audits), []);
    }, { grants: outputsGrants() }),
});

Deno.test({
  name:
    "serve run vault scope: without a grant on the outputs vault the method is refused before it runs, leaving no record and no vault value",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const frames = await runMethodAs(f, "minter", "mint", BOT);
      const message = methodError(frames) ?? "";
      assertStringIncludes(message, "vault 'outputs'");
      assertStringIncludes(
        message,
        "add a vault:outputs allow grant for write to this principal. Or " +
          "point the output at a vault the principal holds.",
      );
      assertEquals(f.sideEffects.count, 0);
      const minter = await f.repo.repoContext.definitionRepo.findByNameGlobal(
        "minter",
      );
      assertEquals(
        await f.repo.repoContext.unifiedDataRepo.findByName(
          f.type,
          minter!.definition.id,
          "main",
        ),
        null,
      );
      assertEquals(await (await f.vaults()).list("outputs"), []);
      assertEquals(
        vaultDenials(f.audits).map((d) => d.resourceName),
        ["outputs"],
      );
    }),
});

Deno.test({
  name:
    "serve run vault scope: a grant revoked while the method runs refuses the sensitive write before any field is stored",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      f.hooks.beforeMintWrite = () => f.setPolicy(roomcontrolOnly());
      const frames = await runMethodAs(f, "minter", "mint", BOT);
      const message = methodError(frames) ?? "";
      assertStringIncludes(message, "Writing vault 'outputs' is refused");
      assertEquals(f.sideEffects.count, 1);
      // Neither of the two sensitive fields was stored.
      assertEquals(await (await f.vaults()).list("outputs"), []);
      assertEquals(
        vaultDenials(f.audits).map((d) => [d.resourceName, d.action]),
        [["outputs", "vault.write"]],
      );
    }, { grants: outputsGrants() }),
});

Deno.test({
  name:
    "serve run vault scope: a grant revoked mid-run refuses the run's next read",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      // After the first read, roomcontrol is revoked; bot stays scoped.
      f.hooks.afterRead = () => {
        f.hooks.afterRead = undefined;
        f.setPolicy([
          ...runnerGrants("user:bot"),
          grant("user:bot", "vault", "outputs"),
        ]);
      };
      const workflow = workflowOf("revoke-mid-run", [
        step("first", StepTask.model("rc-reader", "read")),
        step("second", StepTask.model("rc-reader", "read"), "first"),
      ]);
      const { run } = await runWorkflowAs(f, workflow, BOT);
      assertEquals(stepOf(run, "main", "first").status, "succeeded");
      const second = stepOf(run, "main", "second");
      assertEquals(second.status, "failed");
      assertStringIncludes(
        second.error ?? "",
        "Reading vault 'roomcontrol' is refused",
      );
      assertEquals(f.seen, [SECRETS.roomcontrol]);
    }),
});

Deno.test({
  name:
    "serve run vault scope: a sensitive output the bot may not read fails every step reading it back, audited once per run",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      // Minted by an unscoped run (auth off) into outputs.
      const { run: minted } = await runWorkflowAs(
        f,
        workflowOf("admin-mint", [
          step("mint", StepTask.model("minter", "mint")),
        ]),
        null,
        { ...f.ctx, authConfig: { ...f.ctx.authConfig, mode: "none" } },
      );
      assertEquals(minted.status, "succeeded");
      const workflow = workflowOf("read-outputs", [
        step("latest", StepTask.model("creds-reader", "read")),
        step("again", StepTask.model("creds-reader", "read"), "latest"),
      ]);
      const { run } = await runWorkflowAs(f, workflow, BOT);
      for (const name of ["latest", "again"]) {
        const s = stepOf(run, "main", name);
        assertEquals(s.status, "failed", name);
        assertStringIncludes(
          s.error ?? "",
          "Reading vault 'outputs' is refused",
          name,
        );
      }
      assertEquals(f.seen, []);
      // Both steps read the same key in one run: audited once.
      assertEquals(
        vaultDenials(f.audits).map((d) => [d.resourceName, d.action]),
        [["outputs", "vault.read"]],
      );
    }),
});

Deno.test({
  name:
    "serve run vault scope: a nested workflow's steps are held to the triggering principal, and the child run records it",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const child = workflowOf("child-reads", [
        step("erp", StepTask.model("erp-reader", "read")),
        step("rc", StepTask.model("rc-reader", "read"), "erp"),
      ]);
      await f.repo.repoContext.workflowRepo.save(child);
      const parent = workflowOf("parent-calls", [
        step("call", StepTask.workflow("child-reads")),
      ]);
      const { run } = await runWorkflowAs(f, parent, BOT);
      assertEquals(stepOf(run, "main", "call").status, "failed");
      const childRun = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(child.id);
      assertEquals(stepOf(childRun!, "main", "erp").status, "failed");
      assertStringIncludes(
        stepOf(childRun!, "main", "erp").error ?? "",
        "vault 'erp' is refused for user:bot",
      );
      assertEquals(stepOf(childRun!, "main", "rc").status, "succeeded");
      assertEquals(childRun!.triggeringPrincipal?.id, "bot");
      assertEquals(f.seen, [SECRETS.roomcontrol]);
    }),
});

Deno.test({
  name:
    "serve run vault scope: a failing assert's message reads vaults under the scope: a refused vault is audited and never resolved",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      // A guard cannot call vault.get at all (no overload); an assert's
      // message, evaluated when it fails, is the workflow-level expression
      // that reads vaults.
      const workflow = workflowOf("asserts", [
        step(
          "assert-erp",
          StepTask.assert("false", `token ${vaultRef("erp")}`),
        ),
        step(
          "assert-rc",
          StepTask.assert("false", `token ${vaultRef("roomcontrol")}`),
          "assert-erp",
        ),
      ]);
      const { run } = await runWorkflowAs(f, workflow, BOT);
      // The refused reference is left as written; the allowed one resolved
      // (and is redacted from the record).
      const erp = stepOf(run, "main", "assert-erp");
      assertEquals(erp.status, "failed");
      assertStringIncludes(erp.error ?? "", vaultRef("erp"));
      const rc = stepOf(run, "main", "assert-rc");
      assertEquals(rc.status, "failed");
      assertEquals(rc.error?.includes("vault.get"), false, rc.error);
      assertEquals(rc.error?.includes(SECRETS.roomcontrol), false);
      assertEquals(
        vaultDenials(f.audits).map((d) => d.resourceName),
        ["erp"],
      );
    }),
});

Deno.test({
  name:
    "serve run vault scope: replaying an evaluated definition from the cache reads its vault values under the caller's scope",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      // An unscoped run caches the evaluated definitions.
      const none = {
        ...f.ctx,
        authConfig: { ...f.ctx.authConfig, mode: "none" as const },
      };
      for (const reader of ["erp-reader", "rc-reader"]) {
        assertEquals(
          methodError(await runMethodAs(f, reader, "read", null, {}, none)),
          undefined,
        );
      }
      f.seen.length = 0;
      const replay = { lastEvaluated: true };
      const refused = await runMethodAs(
        f,
        "erp-reader",
        "read",
        BOT,
        {},
        f.ctx,
        replay,
      );
      assertStringIncludes(
        methodError(refused) ?? "",
        "vault 'erp' is refused",
      );
      const allowed = await runMethodAs(
        f,
        "rc-reader",
        "read",
        BOT,
        {},
        f.ctx,
        replay,
      );
      assertEquals(methodError(allowed), undefined);
      assertEquals(f.seen, [SECRETS.roomcontrol]);
      assertEquals(
        vaultDenials(f.audits).map((d) => d.resourceName),
        ["erp"],
      );
    }),
});

Deno.test({
  name:
    "serve run vault scope: a principal with only a deny grant loses just the denied vault",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = workflowOf("deny-only", [
        step("erp", StepTask.model("erp-reader", "read")),
        step("rc", StepTask.model("rc-reader", "read"), "erp"),
        step("mint", StepTask.model("minter", "mint"), "rc"),
      ]);
      const { run } = await runWorkflowAs(f, workflow, BOT);
      assertEquals(stepOf(run, "main", "erp").status, "failed");
      assertStringIncludes(
        stepOf(run, "main", "erp").error ?? "",
        "vault 'erp' is refused",
      );
      assertEquals(stepOf(run, "main", "rc").status, "succeeded");
      // Unscoped for every other vault: the outputs vault takes the write.
      assertEquals(stepOf(run, "main", "mint").status, "succeeded");
      assertEquals(f.seen, [SECRETS.roomcontrol]);
      assertEquals(
        vaultDenials(f.audits).map((d) => d.resourceName),
        ["erp"],
      );
    }, {
      grants: [
        ...runnerGrants("user:bot"),
        grant("user:bot", "vault", "erp", ["read"], "deny"),
      ],
    }),
});

Deno.test({
  name:
    "serve run vault scope: a read grant revoked after the write fails the writing step's own read-back",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      f.hooks.beforeMintWrite = () =>
        f.setPolicy([
          ...roomcontrolOnly(),
          grant("user:bot", "vault", "outputs", ["write"]),
        ]);
      const { run } = await runWorkflowAs(
        f,
        workflowOf("mint-readback", [
          step("mint", StepTask.model("minter", "mint")),
        ]),
        BOT,
      );
      const mint = stepOf(run, "main", "mint");
      assertEquals(mint.status, "failed");
      assertStringIncludes(
        mint.error ?? "",
        "Reading vault 'outputs' is refused",
      );
    }, { grants: outputsGrants() }),
});

/** A reader whose vault and key are the caller's method inputs. */
async function saveDynamicReader(f: VaultScopeFixture): Promise<void> {
  await saveDefinition(f, "dyn-reader", {
    inputs: {
      type: "object",
      properties: { vault: { type: "string" }, key: { type: "string" } },
    },
    methods: {
      read: {
        arguments: { value: "${{ vault.get(inputs.vault, inputs.key) }}" },
      },
    },
  });
}

/** Runs `fn` with the reserved token-secrets vault registered, as serve boot does. */
async function withReservedVault(fn: () => Promise<void>): Promise<void> {
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "mock",
    new MockVaultProvider(TOKEN_SECRETS_VAULT_NAME, {
      "token-key": "reserved-secret-value",
    }),
  );
  try {
    await fn();
  } finally {
    VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
  }
}

const RUNNER: Principal = { kind: "user", id: "runner" };
const RESERVED_INPUTS = { vault: TOKEN_SECRETS_VAULT_NAME, key: "token-key" };

for (
  const [label, extra] of [
    ["with no vault grant in the policy", [] as Grant[]],
    ["with vault grants in the policy", [
      grant("user:bot", "vault", "roomcontrol"),
    ]],
  ] as const
) {
  Deno.test({
    name:
      `serve run vault scope: the reserved vault is refused to a run-only caller's method inputs ${label}; an access admin reads it`,
    ...SANITIZE,
    fn: () =>
      withReservedVault(() =>
        withVaultScopeFixture(async (f) => {
          await saveDynamicReader(f);
          const refused = await runMethodAs(
            f,
            "dyn-reader",
            "read",
            RUNNER,
            RESERVED_INPUTS,
          );
          assertStringIncludes(
            methodError(refused) ?? "",
            "'_token-secrets' is a reserved vault",
          );
          // The same caller still reads an ordinary vault as today.
          const ordinary = await runMethodAs(f, "dyn-reader", "read", RUNNER, {
            vault: "erp",
            key: "password",
          });
          assertEquals(methodError(ordinary), undefined);
          const admin = await runMethodAs(
            f,
            "dyn-reader",
            "read",
            ADMIN,
            RESERVED_INPUTS,
          );
          assertEquals(methodError(admin), undefined);
          assertEquals(f.seen, [SECRETS.erp, "reserved-secret-value"]);
          assertEquals(
            vaultDenials(f.audits).map((d) => [d.resourceName, d.principalId]),
            [[TOKEN_SECRETS_VAULT_NAME, "runner"]],
          );
        }, {
          grants: [
            grant("user:runner", "model", "*", ["run"]),
            grant("user:admin", "access", "*", ["admin"]),
            ...extra,
          ],
        })
      ),
  });
}

Deno.test({
  name:
    "serve run vault scope: with no vault grant every non-reserved vault resolves exactly as in an unscoped run",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const none = {
        ...f.ctx,
        authConfig: { ...f.ctx.authConfig, mode: "none" as const },
      };
      const observe = async (
        principal: Principal | null,
        ctx: typeof f.ctx,
      ) => {
        f.seen.length = 0;
        f.ops.length = 0;
        const workflow = workflowOf(`differential-${crypto.randomUUID()}`, [
          step("erp", StepTask.model("erp-reader", "read")),
          step("rc", StepTask.model("rc-reader", "read"), "erp"),
          step("ops-erp", StepTask.model("ops", "ops", { vault: "erp" }), "rc"),
          step("mint", StepTask.model("minter", "mint"), "ops-erp"),
          step("read-back", StepTask.model("creds-reader", "read"), "mint"),
        ]);
        const { run } = await runWorkflowAs(f, workflow, principal, ctx);
        return {
          status: run.status,
          steps: run.getJob("main")!.steps.map((s) => [s.stepName, s.status]),
          seen: [...f.seen],
          ops: f.ops.map((o) => ({ ...o })),
        };
      };
      const scoped = await observe(BOT, f.ctx);
      const unscoped = await observe(null, none);
      // The minted values differ only by run count.
      assertEquals(scoped.seen.slice(0, 2), [SECRETS.erp, SECRETS.roomcontrol]);
      assertEquals(
        { ...scoped, seen: scoped.seen.slice(0, 2) },
        { ...unscoped, seen: unscoped.seen.slice(0, 2) },
      );
      assertEquals(scoped.status, "succeeded");
      assertEquals(vaultDenials(f.audits), []);
    }, {
      // Grants of every other kind, but none on vaults.
      grants: [
        ...runnerGrants("user:bot"),
        grant("user:bot", "data", "erp", ["read"], "deny"),
      ],
    }),
});

function listedWorkflow(
  name: string,
  vaults: string[],
  steps: Step[],
): Workflow {
  return Workflow.create({
    name,
    vaults,
    jobs: [Job.create({ name: "main", steps })],
  });
}

/** Runs `workflow` as a local CLI run would: no serve, no principal. */
async function runLocally(
  f: VaultScopeFixture,
  workflow: Workflow,
): Promise<WorkflowRun> {
  await f.repo.repoContext.workflowRepo.save(workflow);
  const deps = await createWorkflowRunDeps(
    f.repo.repoDir,
    f.repo.repoContext,
    f.repo.datastoreConfig,
  );
  const service = deps.createExecutionService(
    f.repo.repoContext.workflowRepo,
    f.repo.repoContext.workflowRunRepo,
    f.repo.repoDir,
    f.repo.repoContext.catalogStore,
  );
  await collect(service.run(workflow.name));
  return (await f.repo.repoContext.workflowRunRepo.findLatestByWorkflowId(
    workflow.id,
  ))!;
}

const READ_BOTH = () => [
  step("erp", StepTask.model("erp-reader", "read")),
  step("rc", StepTask.model("rc-reader", "read"), "erp"),
];

Deno.test({
  name:
    "serve run vault scope: a workflow's vaults list bounds a serve run of a principal holding no vault grant, and is audited",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const workflow = listedWorkflow("listed", ["roomcontrol"], READ_BOTH());
      const { run } = await runWorkflowAs(f, workflow, BOT);
      const erp = stepOf(run, "main", "erp");
      assertEquals(erp.status, "failed");
      assertStringIncludes(
        erp.error ?? "",
        "it is not in the vaults list of workflow 'listed'",
      );
      assertEquals(stepOf(run, "main", "rc").status, "succeeded");
      const denials = vaultDenials(f.audits);
      assertEquals(denials.map((d) => d.resourceName), ["erp"]);
      assertStringIncludes(denials[0].detail ?? "", "workflow=listed");
    }, { grants: runnerGrants("user:bot") }),
});

Deno.test({
  name:
    "serve run vault scope: a workflow's vaults list bounds a local run, and a nested workflow's list intersects its parent's",
  ...SANITIZE,
  fn: () =>
    withVaultScopeFixture(async (f) => {
      const local = await runLocally(
        f,
        listedWorkflow("listed-local", ["roomcontrol"], READ_BOTH()),
      );
      assertStringIncludes(
        stepOf(local, "main", "erp").error ?? "",
        "it is not in the vaults list of workflow 'listed-local'",
      );
      assertEquals(stepOf(local, "main", "rc").status, "succeeded");

      // child allows roomcontrol and outputs; parent allows roomcontrol
      // and erp: only roomcontrol survives inside the child.
      const child = listedWorkflow("listed-child", ["roomcontrol", "outputs"], [
        ...READ_BOTH(),
        step("mint", StepTask.model("minter", "mint"), "rc"),
      ]);
      await f.repo.repoContext.workflowRepo.save(child);
      const parent = listedWorkflow("listed-parent", ["roomcontrol", "erp"], [
        step("own-erp", StepTask.model("erp-reader", "read")),
        step("call", StepTask.workflow("listed-child"), "own-erp"),
      ]);
      const parentRun = await runLocally(f, parent);
      assertEquals(stepOf(parentRun, "main", "own-erp").status, "succeeded");
      const childRun = await f.repo.repoContext.workflowRunRepo
        .findLatestByWorkflowId(child.id);
      assertStringIncludes(
        stepOf(childRun!, "main", "erp").error ?? "",
        "not in the vaults list of workflow 'listed-child'",
      );
      assertEquals(stepOf(childRun!, "main", "rc").status, "succeeded");
      const mint = stepOf(childRun!, "main", "mint");
      assertEquals(mint.status, "failed");
      assertStringIncludes(
        mint.error ?? "",
        "not in the vaults list of workflow 'listed-parent'",
      );
      assertEquals(f.sideEffects.count, 0);
      assertEquals(f.seen, [
        SECRETS.roomcontrol,
        SECRETS.erp,
        SECRETS.roomcontrol,
      ]);
    }),
});
