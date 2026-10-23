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
 * Typed secrets in the workflow passes, end to end; the harness lives in
 * typed_workflow_harness.ts.
 */
/**
 * Typed secrets in the workflow passes, end to end
 * (design/enablers/typed-secrets.md Sections 3.4, 5 and 7.1, typed-secrets
 * 4.1): guards, asserts, forEach items and identities, child workflow
 * bindings and the model.method consumer path run through a real
 * WorkflowExecutionService on a temp repository, against a vault that
 * answers existence itself and counts every value it hands out, so a load
 * is a load and a check costs nothing. The internal option is turned on by
 * passing the run its sensitive values over a typed registry, as only tests
 * may; every scenario also runs with the option off and asserts today's
 * behavior.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "../src/domain/models/models.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";

import {
  after,
  assertNothingLeaked,
  byHost,
  consume,
  type Fixture,
  gate,
  OUTPUT_HOST,
  OUTPUT_PASSWORD,
  PASSWORD,
  PASSWORD_CEL,
  quotes,
  type Run,
  SENTINEL_MARK,
  TOKEN,
  TOKEN_KEY,
  VAULT,
  withFixture,
  write,
  writeClass,
} from "./typed_workflow_harness.ts";

Deno.test("typed workflow passes: a guard whose result holds a secret refuses before any load, from a tagged field, a vault.get and a model.method result; with the option off it decides on plaintext", async () => {
  const guards = () =>
    Workflow.create({
      name: "guard-refuses",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume("by-data", {}, {
            guard: PASSWORD,
            allowFailure: true,
          }),
          consume("by-vault", {}, { guard: TOKEN, allowFailure: true }),
          consume("by-method", {}, {
            guard: "${{ model.method('writer', 'write', {}).password }}",
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(guards());
    // A refused guard fails its step, as any guard failure does, and a
    // failed guard is never an allowed failure, so the run fails.
    assertEquals(run.status, "failed");
    for (const step of ["by-data", "by-vault", "by-method"]) {
      const error = run.errors.get(step);
      assert(error, `${step} should have failed`);
      assertStringIncludes(error, "secret_destination_refused", step);
      assertStringIncludes(error, "guard or assert predicate result", step);
    }
    assertEquals(run.skipped.size, 0);
    assertEquals(f.received, []);
    // No guard loaded: not the tagged field, not the vault key, and the
    // write method's record is kept as stored for its step outputs, so
    // nothing was read back either (typed-secrets 4.2).
    assertEquals(f.loads, []);
    // The vault.get guard cost one existence check, answered by has().
    assertEquals(f.checks, [TOKEN_KEY]);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a guard comparing a secret to null passes with no load, and a step a guard skips makes no vault read", async () => {
  const workflow = () =>
    Workflow.create({
      name: "guard-skips",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume("skipped", { password: PASSWORD, note: TOKEN }, {
            guard: `\${{ ${PASSWORD_CEL} != null }}`,
          }),
          consume("runs", { password: PASSWORD, note: TOKEN }, {
            guard: `\${{ ${PASSWORD_CEL} == null }}`,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow());
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(run.skipped.get("skipped"), true);
    assertEquals(run.errors.size, 0);
    // The skipped step read nothing; the step that ran loaded each of its
    // two references exactly once, at delivery, and received the exact value.
    assertEquals(f.received, [{ password: quotes(f), note: f.token }]);
    assertEquals(f.loads.length, 2);
    assertEquals(f.loads.includes(TOKEN_KEY), true);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: an assert predicate holding a secret is refused, and an assert message holding one is masked in the event, the step error and the run record with zero loads", async () => {
  const seeded = () =>
    Workflow.create({
      name: "asserts",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "predicate",
            task: StepTask.assert(PASSWORD_CEL, "never shown"),
            allowFailure: true,
          }),
          Step.create({
            name: "message",
            task: StepTask.assert(
              "1 == 2",
              `token=${PASSWORD} vault=${TOKEN} plain=${"${{ 'p' }}"}`,
            ),
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(seeded());
    // The refused predicate fails its step and the run; the failed
    // assertion with a masked message is an allowed failure.
    assertEquals(run.status, "failed");
    assertStringIncludes(
      run.errors.get("predicate") ?? "",
      "secret_destination_refused",
    );
    assertEquals(run.asserts.get("message"), {
      passed: false,
      message: "token=*** vault=*** plain=p",
    });
    assertEquals(run.errors.get("message"), "token=*** vault=*** plain=p");
    assertEquals(f.loads, []);
    assertEquals(f.checks, [TOKEN_KEY]);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: forEach over tagged records binds each item as a Secret, names its steps sensitive-<index>, and delivers the exact canary of every class with one load per iteration", async () => {
  const workflow = () =>
    Workflow.create({
      name: "for-each",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume(
            "use-${{ self.c.attributes.password }}-${{ self.c.attributes.host }}",
            {
              password: "${{ self.c.attributes.password }}",
              note: "${{ self.c.attributes.host }}",
            },
            {
              forEach: {
                item: "c",
                in: "${{ data.findBySpec('writer', 'creds') }}",
              },
            },
          ),
          consume("compare-${{ self.c.attributes.host }}", {}, {
            forEach: {
              item: "c",
              in: "${{ data.findBySpec('writer', 'creds') }}",
            },
            guard: "${{ self.c.attributes.password == 'x' }}",
            allowFailure: true,
          }),
        ],
      })],
    });
  const expectedNames = (f: Fixture) =>
    f.canaries.map((_, index) => `use-sensitive-${index}-`);
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow());
    // The refused comparisons fail their steps and the run; every delivery
    // step completed.
    assertEquals(run.status, "failed");
    const byHost = new Map(f.received.map((r) => [r.note, r.password]));
    for (const canary of f.canaries) {
      assertEquals(
        byHost.get(canary.class),
        canary.value,
        `typed: ${canary.class}`,
      );
    }
    assertEquals(f.received.length, f.canaries.length);
    assertEquals(f.loads.length, f.canaries.length);
    const names = run.events.flatMap((e) =>
      e.kind === "step_completed" && e.stepId.startsWith("use-")
        ? [e.stepId]
        : []
    ).sort();
    assertEquals(names.length, f.canaries.length);
    for (const [index, name] of names.entries()) {
      assert(
        expectedNames(f).some((prefix) => name.startsWith(prefix)),
        `${index}: ${name}`,
      );
      assertEquals(name.includes(SENTINEL_MARK), false, name);
    }
    // The item binds as a Secret in the guard: the comparison is refused.
    const compared = [...run.errors].filter(([step]) =>
      step.startsWith("compare-")
    );
    assertEquals(compared.length, f.canaries.length);
    for (const [, error] of compared) {
      assertStringIncludes(error, "secret_operation_unsupported");
    }
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a child workflow binds a parent sentinel as a Secret, issues its own sentinel for a deferred vault.get input, and delivers each once", async () => {
  const child = () =>
    Workflow.create({
      name: "child-wf",
      inputs: {
        properties: {
          token: { type: "string" },
          viaVault: { type: "string" },
        },
      },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "compare",
            task: StepTask.model("writer", "consume", {}),
            guard: "${{ inputs.token == 'x' }}",
            allowFailure: true,
          }),
          Step.create({
            name: "deliver",
            task: StepTask.model("writer", "consume", {
              password: "${{ inputs.token }}",
              note: "${{ inputs.viaVault }}",
            }),
          }),
        ],
      })],
    });
  const parent = () =>
    Workflow.create({
      name: "parent-wf",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow("child-wf", {
              token: PASSWORD,
              viaVault: TOKEN,
            }),
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(parent(), [child()]);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertStringIncludes(
      run.errors.get("compare") ?? "",
      "secret_operation_unsupported",
    );
    assertEquals(f.received, [{ password: quotes(f), note: f.token }]);
    assertEquals(f.loads.length, 2);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a step name resolved at run start keeps the sensitive-<vault>.<key> stand-in, for a plain step and for the forEach template its iterations are recorded under", async () => {
  // Both names read a secret but no `self`, so the run-start pass resolves
  // them: the forEach template is the identity every iteration's events and
  // run record carry (`forEachTemplate`), and the plain name is a step's.
  const workflow = () =>
    Workflow.create({
      name: "name-stand-in",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume(`p-${PASSWORD}`, { note: "${{ self.c.attributes.host }}" }, {
            forEach: {
              item: "c",
              in: "${{ data.findBySpec('writer', 'creds') }}",
            },
          }),
          consume(`q-${PASSWORD}`, { note: "plain" }),
        ],
      })],
    });
  const templatesOf = (run: Run) =>
    new Set(
      run.events.flatMap((e) =>
        e.kind === "step_started" && e.forEachTemplate !== undefined
          ? [e.forEachTemplate]
          : []
      ),
    );
  const plainNamesOf = (run: Run) =>
    run.events.flatMap((e) =>
      e.kind === "step_started" && e.stepId.startsWith("q-") ? [e.stepId] : []
    );
  await withFixture(async (f) => {
    await f.seed();
    const key = await f.storedKey("c-quotes");
    const standIn = `sensitive-${VAULT}.${
      encodeURIComponent(key).replaceAll(".", "%2E")
    }`;
    const run = await f.run(workflow());
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals([...templatesOf(run)], [`p-${standIn}`]);
    assertEquals(plainNamesOf(run), [`q-${standIn}`]);
    assertEquals(f.received.length, f.canaries.length + 1);
    // The stand-in is taken from the sentinel: nothing is read for a name.
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a later step reads steps.<name>.outputs through the adapter, so every canary class is delivered exactly with one load each at delivery and none before, a plain sibling stays text, and a guard comparing the tagged field refuses; with the option off the outputs are read eagerly (typed-secrets 4.2)", async () => {
  const workflow = (f: Fixture) =>
    Workflow.create({
      name: "live-outputs",
      jobs: [Job.create({
        name: "main",
        steps: [
          ...f.canaries.flatMap((c) => [
            writeClass(c.class),
            consume(`u-${c.class}`, {
              password: `\${{ steps['w-${c.class}'].outputs.password }}`,
              note: `\${{ steps['w-${c.class}'].outputs.host }}`,
            }, { dependsOn: `w-${c.class}` }),
          ]),
          consume("compare", {}, {
            guard: "${{ steps['w-quotes'].outputs.password == 'x' }}",
            dependsOn: "w-quotes",
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(workflow(f));
    // The refused guard fails its step and the run; every delivery ran.
    assertEquals(run.status, "failed");
    assertEquals([...run.errors.keys()], ["compare"]);
    assertStringIncludes(
      run.errors.get("compare")!,
      "secret_operation_unsupported",
    );
    const delivered = byHost(f);
    for (const canary of f.canaries) {
      assertEquals(
        delivered.get(canary.class),
        canary.value,
        `typed: ${canary.class}`,
      );
    }
    assertEquals(f.received.length, f.canaries.length);
    // One load per delivery: the write steps read nothing back, the guard
    // loaded nothing, and a data-origin reference is never probed.
    assertEquals(f.loads.length, f.canaries.length);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a step output whose vault the run's access refuses fails the step that reads any field of the record before the result is used, with zero loads; with the option off the eager read-back is refused instead (typed-secrets 4.2)", async () => {
  const workflow = () =>
    Workflow.create({
      name: "denied-outputs",
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          consume("use", { note: OUTPUT_HOST }, { dependsOn: "write" }),
        ],
      })],
    });
  // A principal policy that lets the record be written, then refuses every
  // read of the vault: the vaults list cannot do this, since it is run-wide.
  const readsRefusedAfterWrite = (f: Fixture): RunVaultAccess => {
    let denyReads = false;
    f.hooks.afterWrite = () => {
      denyReads = true;
    };
    return RunVaultAccess.create({
      policy: {
        principal: "user:tester",
        decide: (_vault, action) => ({
          allowed: !(denyReads && action === "read"),
          reason: denyReads && action === "read"
            ? "reads are refused once the record is written"
            : "allowed",
        }),
      },
    });
  };
  await withFixture(async (f) => {
    const run = await runWithVaultAccess(
      readsRefusedAfterWrite(f),
      () => f.run(workflow()),
    );
    assertEquals(run.status, "failed");
    assertEquals([...run.errors.keys()], ["use"]);
    assertStringIncludes(run.errors.get("use")!, "refused");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: outputs reconstructed from the run record on resume read through the adapter: the resumed step delivers the exact canary with one load and no read at resume, a vaults list narrowed before the resume refuses the read before use, and a tag the writer could not have stored refuses with secret_reference_invalid; with the option off the resume reads the outputs eagerly (typed-secrets 4.2)", async () => {
  const NAME = "resume-outputs";
  const workflow = () =>
    Workflow.create({
      name: NAME,
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          gate(),
          consume("use", { password: OUTPUT_PASSWORD, note: OUTPUT_HOST }, {
            dependsOn: "gate",
          }),
        ],
      })],
    });
  /** Runs to the approval, approves it in the record, and hands back the ids. */
  const suspend = async (
    f: Fixture,
  ): Promise<{ runId: string; workflow: Workflow }> => {
    const wf = workflow();
    const run = await f.run(wf);
    assertEquals(run.status, "suspended", [...run.errors].join("\n"));
    assert(run.runId);
    await f.approve(NAME, run.runId);
    return { runId: run.runId, workflow: wf };
  };
  await withFixture(async (f) => {
    const { runId } = await suspend(f);
    assertEquals(f.loads, []);
    const resumed = await f.resume(NAME, runId);
    assertEquals(resumed.status, "succeeded", [...resumed.errors].join("\n"));
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    // The resume read the record back as stored; the one load is the
    // delivery's.
    assertEquals(f.loads.length, 1);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, resumed);
  });
  await withFixture(async (f) => {
    const { runId, workflow: wf } = await suspend(f);
    // An edit to the workflow narrows a suspended run (resumeVaultAccess).
    await f.saveWorkflow(
      Workflow.fromData(
        { ...wf.toData(), vaults: ["other"] } as Parameters<
          typeof Workflow.fromData
        >[0],
      ),
    );
    const resumed = await f.resume(NAME, runId);
    assertEquals(resumed.status, "failed");
    assertEquals([...resumed.errors.keys()], ["use"]);
    assertStringIncludes(resumed.errors.get("use")!, "refused");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
  });
  await withFixture(async (f) => {
    const { runId } = await suspend(f);
    // The run record's tag names a plain field, which the writer could not
    // have stored: the resumed read refuses, naming no value.
    await f.editRun(NAME, runId, (data) => {
      const jobs = data.jobs as Array<{
        steps: Array<{
          stepName: string;
          output?: {
            type?: string;
            resources?: Record<
              string,
              Record<string, { tags: Record<string, string> }>
            >;
          };
        }>;
      }>;
      let tagged = 0;
      for (const job of jobs) {
        for (const step of job.steps) {
          if (step.output?.type !== "model_method") continue;
          for (const instances of Object.values(step.output.resources ?? {})) {
            for (const record of Object.values(instances)) {
              record.tags["_swamp.sensitiveFields"] = JSON.stringify([
                "host",
              ]);
              tagged++;
            }
          }
        }
      }
      assertEquals(tagged, 1);
    });
    const resumed = await f.resume(NAME, runId);
    assertEquals(resumed.status, "failed");
    assertEquals([...resumed.errors.keys()], ["use"]);
    assertStringIncludes(
      resumed.errors.get("use")!,
      "secret_reference_invalid",
    );
    assertStringIncludes(resumed.errors.get("use")!, "(steps.write.outputs)");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, resumed);
  });
});

Deno.test("typed workflow passes: a parent reads a child workflow's outputs through the adapter, so the tagged field is delivered exactly with one load and a guard comparing it refuses; with the option off it is read eagerly (typed-secrets 4.2)", async () => {
  const child = () =>
    Workflow.create({
      name: "child-outputs",
      jobs: [Job.create({ name: "main", steps: [write()] })],
    });
  const parent = () =>
    Workflow.create({
      name: "parent-outputs",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow("child-outputs", {}),
          }),
          consume("use", {
            password: "${{ steps.call.outputs.write.password }}",
            note: "${{ steps.call.outputs.write.host }}",
          }, { dependsOn: "call" }),
          consume("compare", {}, {
            guard: "${{ steps.call.outputs.write.password == 'x' }}",
            dependsOn: "call",
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(parent(), [child()]);
    assertEquals(run.status, "failed");
    assertEquals([...run.errors.keys()], ["compare"]);
    assertStringIncludes(
      run.errors.get("compare")!,
      "secret_operation_unsupported",
    );
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    assertEquals(f.loads.length, 1);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a child input deferred from the parent that joins a vault.get with a parent step's tagged output delivers both once, the parent's outputs viewed through their persisted sources; with the option off the captured plaintext is delivered (typed-secrets 4.2)", async () => {
  const child = () =>
    Workflow.create({
      name: "child-deferred",
      inputs: { properties: { combo: { type: "string" } } },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deliver",
            task: StepTask.model("writer", "consume", {
              password: "${{ inputs.combo }}",
            }),
          }),
        ],
      })],
    });
  const parent = () =>
    Workflow.create({
      name: "parent-deferred",
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          Step.create({
            name: "call",
            task: StepTask.workflow("child-deferred", {
              combo: `\${{ vault.get('${VAULT}', '${TOKEN_KEY}') + ':' + ` +
                "steps.write.outputs.password }}",
            }),
            dependsOn: after("write"),
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(parent(), [child()]);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(f.received, [{ password: `${f.token}:${quotes(f)}` }]);
    // One load each at the child's delivery; the vault.get cost one
    // existence check, the data-origin reference none.
    assertEquals(f.loads.length, 2);
    assertEquals(f.checks, [TOKEN_KEY]);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: model.<name>.resource of a record a step wrote earlier in the run reads as a Secret through the model map view and is delivered once, instead of refusing; with the option off it holds plaintext (typed-secrets 4.2)", async () => {
  const workflow = () =>
    Workflow.create({
      name: "model-map-live",
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          consume("use", {
            password:
              "${{ model.writer.resource.creds.main.attributes.password }}",
            note: "${{ model.writer.resource.creds.main.attributes.host }}",
          }, { dependsOn: "write" }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(workflow());
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    assertEquals(f.loads.length, 1);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: a child step name repeated across jobs: the parent reads the later job's outputs, with the option on and off (typed-secrets 4.2)", async () => {
  const classes = (f: Fixture) =>
    f.canaries.filter((c) => c.unique).slice(0, 2).map((c) => c.class);
  const child = (f: Fixture) => {
    const [first, second] = classes(f);
    return Workflow.create({
      name: "child-repeat",
      jobs: [
        Job.create({
          name: "a",
          steps: [Step.create({
            name: "w",
            task: StepTask.model("writer", "writeClass", { cls: first }),
          })],
        }),
        Job.create({
          name: "b",
          dependsOn: [{ job: "a", condition: TriggerCondition.succeeded() }],
          steps: [Step.create({
            name: "w",
            task: StepTask.model("writer", "writeClass", { cls: second }),
          })],
        }),
      ],
    });
  };
  const parent = () =>
    Workflow.create({
      name: "parent-repeat",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow("child-repeat", {}),
          }),
          consume("use", {
            password: "${{ steps.call.outputs.w.password }}",
            note: "${{ steps.call.outputs.w.host }}",
          }, { dependsOn: "call" }),
        ],
      })],
    });
  {
    await withFixture(async (f) => {
      const [, second] = classes(f);
      const run = await f.run(parent(), [child(f)]);
      assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
      const expected = f.canaries.find((c) => c.class === second)!;
      assertEquals(f.received, [{ password: expected.value, note: second }]);
      {
        assertEquals(f.loads.length, 1);
        await assertNothingLeaked(f, run);
      }
    });
  }
});
