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
 * Sensitive values read through CEL expressions (swamp-club#2171).
 *
 * A model writes a schema-marked sensitive field, which is stored as a vault
 * reference; later steps read it with `data.latest()`. Runs the real
 * workflow execution path in-process against a temp repo with a local
 * encryption vault, and spawns real `sh` for the command/shell steps.
 *
 * For every case: the value reaches the command (checked inside the shell),
 * swamp's spawned `sh -c` argv holds an environment reference instead of the
 * value, and no file swamp writes under `.swamp` holds the value.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/mod.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";

await initializeLogging({});

const SECRET = "Pl41nT3xt-S3cr3t-2171";

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-2171-" });
  try {
    await initializeTestRepo(repoDir);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), "secrets", "local_encryption", {
        auto_generate: true,
        base_dir: repoDir,
      }),
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Registers a per-run model type whose `write` method stores a sensitive token. */
function registerWriter(value: string = SECRET): string {
  const type = ModelType.create(`test/secret-writer-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.09.30.1",
    globalArguments: z.object({}),
    resources: {
      creds: {
        description: "Credentials",
        schema: z.object({
          name: z.string(),
          token: z.string().meta({ sensitive: true }),
        }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      write: {
        description: "Writes a sensitive token",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!("creds", "main", {
            name: "app",
            token: value,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
  return type.normalized;
}

function writeStep(type: string): Step {
  return Step.create({
    name: "write",
    task: StepTask.directExecution(type, "writer", "write", {}),
  });
}

function shellStep(name: string, run: string, after = "write"): Step {
  return Step.create({
    name,
    task: StepTask.directExecution(
      "command/shell",
      `${name}-shell`,
      "execute",
      {
        run,
      },
    ),
    dependsOn: [{ step: after, condition: TriggerCondition.succeeded() }],
  });
}

const TOKEN = "data.latest('writer', 'main').attributes.token";

/**
 * A shell snippet that prints `<label>_OK` when `word` expands to the secret,
 * checked by length and prefix so the secret itself is never authored text.
 */
function checkValue(word: string, label: string): string {
  return `v=${word}; [ \${#v} -eq ${SECRET.length} ] && ` +
    `case "$v" in ${SECRET.slice(0, 5)}*) echo ${label}_OK;; esac`;
}

/**
 * Prints the step shell's own command line. The trailing `&& true` keeps `ps`
 * from being the last command of the `-c` string, which bash would exec in
 * place of the shell, so `$$` still names the shell on every `/bin/sh`.
 */
const SHOW_ARGV = "ps -o args= -p $$ && true";

async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
  options: { lastEvaluated?: boolean } = {},
): Promise<
  {
    status?: string;
    runId?: string;
    errors: string[];
    events: WorkflowRunEvent[];
  }
> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  let status: string | undefined;
  let runId: string | undefined;
  const errors: string[] = [];
  const events: WorkflowRunEvent[] = [];
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    {
      workflowIdOrName: workflow.name,
      lastEvaluated: options.lastEvaluated,
    },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      events.push(event);
      if (event.kind === "started") runId = event.runId;
      if (event.kind === "completed") status = event.run.status;
      if (event.kind === "suspended") status = "suspended";
      if (event.kind !== "started") {
        errors.push(JSON.stringify(event).slice(0, 600));
      }
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  return { status, runId, errors, events };
}

/** The persisted stdout of the named shell step's latest result. */
async function shellStdout(
  repoDir: string,
  modelName: string,
): Promise<string> {
  const outputs: string[] = [];
  for await (
    const entry of walk(join(repoDir, ".swamp", "data", "command", "shell"), {
      includeDirs: false,
    })
  ) {
    if (!entry.path.endsWith("raw")) continue;
    const text = await Deno.readTextFile(entry.path);
    try {
      const parsed = JSON.parse(text) as { stdout?: string };
      if (parsed.stdout !== undefined) outputs.push(parsed.stdout);
    } catch {
      // not a result file
    }
  }
  const byName = outputs.filter((o) => o.includes(`STEP=${modelName}`));
  return byName.join("\n");
}

/** Paths of files under .swamp (other than vault storage) holding the value. */
async function filesHolding(repoDir: string, value: string): Promise<string[]> {
  const found: string[] = [];
  for await (
    const entry of walk(join(repoDir, ".swamp"), { includeDirs: false })
  ) {
    if (entry.path.includes(`${join(".swamp", "secrets")}`)) continue;
    if (entry.path.includes(`${join(".swamp", "vault")}`)) continue;
    const bytes = await Deno.readFile(entry.path);
    if (new TextDecoder("latin1").decode(bytes).includes(value)) {
      found.push(entry.path.slice(repoDir.length));
    }
  }
  return found;
}

const posix = { ignore: Deno.build.os === "windows" };

/** The run record file's text. */
async function findRunRecord(repoDir: string, runId: string): Promise<string> {
  for await (
    const entry of walk(join(repoDir, ".swamp", "workflow-runs"), {
      includeDirs: false,
    })
  ) {
    if (entry.name.includes(runId) && entry.name.endsWith(".yaml")) {
      return await Deno.readTextFile(entry.path);
    }
  }
  throw new Error(`run record ${runId} not found`);
}

/**
 * Writes the sensitive data in a run of its own, for workflows that read it
 * at workflow or job start (tags, forEach.in), before any step runs.
 */
async function seed(repoDir: string, type: string): Promise<void> {
  const seeded = await runWorkflow(
    repoDir,
    Workflow.create({
      name: `seed-${crypto.randomUUID().slice(0, 8)}`,
      jobs: [Job.create({ name: "main", steps: [writeStep(type)] })],
    }),
  );
  assertEquals(seeded.status, "succeeded", seeded.errors.join("\n"));
}

/** A workflow whose writer runs first and whose other steps depend on it. */
function flow(name: string, type: string, steps: Step[]): Workflow {
  return Workflow.create({
    name,
    jobs: [Job.create({ name: "main", steps: [writeStep(type), ...steps] })],
  });
}

/** A workflow of one shell step that reads data written by an earlier run. */
function reader(
  name: string,
  run: string,
  extra: { tags?: Record<string, string> } = {},
  step: Partial<{ forEach: { item: string; in: string } }> = {},
): Workflow {
  return Workflow.create({
    name,
    ...extra,
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({
          name,
          ...step,
          task: StepTask.directExecution(
            "command/shell",
            `${name}-shell`,
            "execute",
            { run },
          ),
        }),
      ],
    })],
  });
}

Deno.test(
  "sensitive data: a shell step receives data.latest values through the environment",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      const { status, errors } = await runWorkflow(
        repoDir,
        flow("deliver", type, [
          shellStep(
            "consume",
            `echo STEP=consume; ` +
              `${checkValue(`"\${{ ${TOKEN} }}"`, "DOUBLE")}; ` +
              `${checkValue(`'\${{ ${TOKEN} }}'`, "SINGLE")}; ` +
              SHOW_ARGV,
          ),
        ]),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      const stdout = await shellStdout(repoDir, "consume");
      assertStringIncludes(stdout, "DOUBLE_OK");
      assertStringIncludes(stdout, "SINGLE_OK");
      // The spawned command line carries references, never the value (which
      // the redactor would have shown as ***).
      const argv = stdout.split("\n").find((line) => line.includes("sh -c"));
      assert(argv, stdout);
      assertStringIncludes(argv, "__SWAMP_VAULT_");
      assertEquals(argv.includes("***"), false, argv);
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: live step outputs reach a later step through the environment",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      const { status, errors } = await runWorkflow(
        repoDir,
        flow("outputs", type, [
          shellStep(
            "from-outputs",
            `echo STEP=from-outputs; ` +
              `${checkValue(`"\${{ steps.write.outputs.token }}"`, "OUT")}; ` +
              SHOW_ARGV,
          ),
        ]),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      const stdout = await shellStdout(repoDir, "from-outputs");
      assertStringIncludes(stdout, "OUT_OK");
      assertEquals(stdout.includes("***"), false, stdout);
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: forEach over secrets names steps with placeholders",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      const { status, runId, errors } = await runWorkflow(
        repoDir,
        reader(
          "each",
          `echo STEP=each; ${checkValue('"${{ self.tok }}"', "ITEM")}`,
          {},
          { forEach: { item: "tok", in: `\${{ [${TOKEN}] }}` } },
        ),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      assertStringIncludes(await shellStdout(repoDir, "each"), "ITEM_OK");
      assertStringIncludes(await findRunRecord(repoDir, runId!), "sensitive-0");
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: a multi-line secret inside an embedded object stays valid JSON",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const pem = '-----BEGIN KEY-----\nabc"def\n-----END KEY-----';
      const type = registerWriter(pem);
      const { status, errors } = await runWorkflow(
        repoDir,
        flow("json", type, [
          shellStep(
            "json",
            "echo STEP=json; cat <<EOF | python3 -c " +
              `'import json,sys; d=json.load(sys.stdin); ` +
              `print("JSON_OK" if d["token"].startswith("-----BEGIN") else "BAD")'\n` +
              "${{ data.latest('writer', 'main').attributes }}\nEOF",
          ),
        ]),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      assertStringIncludes(await shellStdout(repoDir, "json"), "JSON_OK");
      assertEquals(await filesHolding(repoDir, "BEGIN KEY"), []);
    });
  },
);

Deno.test(
  "sensitive data: --last-evaluated replays references like a fresh run",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      const workflow = reader(
        "replayed",
        `echo STEP=replayed; ` +
          `${checkValue(`'\${{ ${TOKEN} }}'`, "REPLAY")}; ${SHOW_ARGV}`,
      );
      const fresh = await runWorkflow(repoDir, workflow);
      assertEquals(fresh.status, "succeeded", fresh.errors.join("\n"));
      const replay = await runWorkflow(repoDir, workflow, {
        lastEvaluated: true,
      });
      assertEquals(replay.status, "succeeded", replay.errors.join("\n"));
      const stdout = await shellStdout(repoDir, "replayed");
      assertEquals(
        stdout.split("\n").filter((line) => line === "REPLAY_OK").length,
        2,
        stdout,
      );
      assertEquals(stdout.includes("***"), false, stdout);
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: workflow tags reading a secret carry a placeholder",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      const { status, runId, errors } = await runWorkflow(
        repoDir,
        reader("tagged", "echo STEP=tagged", {
          tags: { owner: `\${{ ${TOKEN} }}` },
        }),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      assertStringIncludes(
        await findRunRecord(repoDir, runId!),
        "sensitive-secrets.",
      );
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: a nested workflow receives a parent's value through the environment",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      await new YamlWorkflowRepository(repoDir).save(Workflow.create({
        name: "child",
        inputs: { type: "object", properties: { tok: { type: "string" } } },
        jobs: [Job.create({
          name: "main",
          steps: [shellStep(
            "child",
            `echo STEP=child; ${checkValue('"${{ inputs.tok }}"', "CHILD")}; ` +
              SHOW_ARGV,
          )].map((step) => Step.create({ name: step.name, task: step.task })),
        })],
      }));
      const { status, errors } = await runWorkflow(
        repoDir,
        Workflow.create({
          name: "parent",
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "call-child",
              task: StepTask.workflow("child", { tok: `\${{ ${TOKEN} }}` }),
            })],
          })],
        }),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      const stdout = await shellStdout(repoDir, "child");
      assertStringIncludes(stdout, "CHILD_OK");
      assertEquals(stdout.includes("***"), false, stdout);
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: derived reads and mixed runtime expressions see real values",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      const { status, errors } = await runWorkflow(
        repoDir,
        flow("derived", type, [
          shellStep(
            "derived",
            `echo STEP=derived; ` +
              `echo LEN=\${{ size(${TOKEN}) }}; ` +
              `${
                checkValue(`"\${{ env["HOME"] + "/" + ${TOKEN} }}"`, "MIXED")
                  .replace(`-eq ${SECRET.length}`, `-gt ${SECRET.length}`)
                  .replace(`${SECRET.slice(0, 5)}*`, "*/Pl41n*")
              }; ${SHOW_ARGV}`,
          ),
        ]),
      );
      assertEquals(status, "succeeded", errors.join("\n"));
      const stdout = await shellStdout(repoDir, "derived");
      assertStringIncludes(stdout, `LEN=${SECRET.length}`);
      assertStringIncludes(stdout, "MIXED_OK");
      assertEquals(stdout.includes("***"), false, stdout);
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

Deno.test(
  "sensitive data: direct-type global arguments are stored as references and reused without churn",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      const workflow = Workflow.create({
        name: "globals",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "globals",
            task: StepTask.directExecution(
              "command/shell",
              "globals-shell",
              "execute",
              {
                run: `echo STEP=globals; ` +
                  checkValue('"${{ self.globalArguments.tok }}"', "GLOBAL"),
              },
              { tok: `\${{ ${TOKEN} }}` },
            ),
          })],
        })],
      });
      for (let i = 0; i < 2; i++) {
        const { status, errors } = await runWorkflow(repoDir, workflow);
        assertEquals(status, "succeeded", errors.join("\n"));
      }
      assertEquals(await filesHolding(repoDir, SECRET), []);
      const autoDefs: string[] = [];
      for await (
        const entry of walk(repoDir, { includeDirs: false, exts: [".yaml"] })
      ) {
        if (entry.path.includes("globals-shell")) {
          autoDefs.push(await Deno.readTextFile(entry.path));
        }
      }
      assert(autoDefs.length > 0, "auto definition not found");
      assertStringIncludes(autoDefs.join("\n"), "vault.get('secrets'");
    });
  },
);

Deno.test(
  "sensitive data: --last-evaluated refuses a cache written before the fix",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      const workflow = reader("prefix", `echo STEP=prefix \${{ ${TOKEN} }}`);
      const fresh = await runWorkflow(repoDir, workflow);
      assertEquals(fresh.status, "succeeded", fresh.errors.join("\n"));
      // Rewrite the cached workflow as an older swamp wrote it: no format
      // marker, and plaintext where the reference now sits.
      for await (
        const entry of walk(join(repoDir, ".swamp", "workflows-evaluated"), {
          includeDirs: false,
          exts: [".yaml"],
        })
      ) {
        if (entry.path.includes(`${join("runs")}`)) continue;
        const text = await Deno.readTextFile(entry.path);
        await Deno.writeTextFile(
          entry.path,
          text.replace(/^sensitiveFormat: .*$/m, "")
            .replace(/^writtenReferences:[\s\S]*?(?=^\S)/m, ""),
        );
      }
      const replay = await runWorkflow(repoDir, workflow, {
        lastEvaluated: true,
      });
      assertEquals(replay.status, undefined);
      assertStringIncludes(replay.errors.join("\n"), "older swamp");
    });
  },
);

Deno.test(
  "sensitive data: a run suspended on an approval that reads a secret resumes with real values",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const type = registerWriter();
      await seed(repoDir, type);
      const shellType = ModelType.create("command/shell");
      await new YamlDefinitionRepository(repoDir).save(
        shellType,
        Definition.create({
          name: "after-gate",
          type: shellType.normalized,
          methods: {
            execute: {
              arguments: {
                run: `echo STEP=after-gate; ` +
                  `${checkValue(`'\${{ ${TOKEN} }}'`, "RESUMED")}; ` +
                  SHOW_ARGV,
              },
            },
          },
        }),
      );
      const workflow = Workflow.create({
        name: "gated",
        jobs: [Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval(`deploy with \${{ ${TOKEN} }}?`),
            }),
            Step.create({
              name: "after",
              task: StepTask.model("after-gate", "execute"),
              dependsOn: [{
                step: "gate",
                condition: TriggerCondition.succeeded(),
              }],
            }),
          ],
        })],
      });
      const started = await runWorkflow(repoDir, workflow);
      assertEquals(started.status, "suspended", started.errors.join("\n"));
      assertEquals(await filesHolding(repoDir, SECRET), []);

      const runRepo = new YamlWorkflowRunRepository(repoDir);
      const run = await runRepo.findById(
        createWorkflowId(workflow.id),
        createWorkflowRunId(started.runId!),
      );
      assert(run);
      // As `swamp workflow approve` does, in a process with no record: the

      // stored references are written back unchanged.

      const gate = run.getJob("main")!.getStep("gate")!;

      gate.recordApprovalDecision({
        approved: true,

        decidedAt: new Date().toISOString(),
      });

      gate.succeed();
      await runRepo.save(createWorkflowId(workflow.id), run);

      const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
      try {
        const service = new WorkflowExecutionService(
          new YamlWorkflowRepository(repoDir),
          runRepo,
          repoDir,
          undefined,
          undefined,
          catalogStore,
        );
        let status: string | undefined;
        for await (const event of service.resume("gated", started.runId!)) {
          if (event.kind === "completed") status = event.run.status;
        }
        assertEquals(status, "succeeded");
      } finally {
        catalogStore.close();
      }
      const stdout = await shellStdout(repoDir, "after-gate");
      assertStringIncludes(stdout, "RESUMED_OK");
      assertEquals(stdout.includes("***"), false, stdout);
      assertEquals(await filesHolding(repoDir, SECRET), []);
    });
  },
);

/** Whether a run raised the warning for a single-quoted vault expression. */
function warnedSingleQuote(events: WorkflowRunEvent[]): boolean {
  return events.some((event) =>
    event.kind === "method_event" &&
    event.event.type === "vault_single_quote_warning"
  );
}

Deno.test(
  "sensitive data: a vault.get secret used in two quote contexts expands as one word in each",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const value = "two  words *";
      const vault = await VaultService.fromRepository(repoDir);
      await vault.put("secrets", "MIXED", value);
      const expr = "${{ vault.get('secrets', 'MIXED') }}";

      // Single-quoted first: the double-quoted use is still one quoted word.
      const singleFirst = await runWorkflow(
        repoDir,
        reader(
          "single-first",
          `echo STEP=single-first; b='${expr}'; set -- "${expr}"; ` +
            `echo "ARGC=$#"; for x in "$@"; do echo "ARG=[$x]"; done`,
        ),
      );
      assertEquals(
        singleFirst.status,
        "succeeded",
        singleFirst.errors.join("\n"),
      );
      const stdout = await shellStdout(repoDir, "single-first");
      assertStringIncludes(stdout, "ARGC=1");
      assertStringIncludes(stdout, "ARG=[***]");
      // Word-splitting would print fragments the redactor cannot match.
      assertEquals(stdout.includes("words"), false, stdout);
      assertEquals(warnedSingleQuote(singleFirst.events), true);

      // Double-quoted first: the later single-quoted use is still warned of.
      const doubleFirst = await runWorkflow(
        repoDir,
        reader(
          "double-first",
          `echo STEP=double-first; a="${expr}"; b='${expr}'`,
        ),
      );
      assertEquals(
        doubleFirst.status,
        "succeeded",
        doubleFirst.errors.join("\n"),
      );
      assertEquals(warnedSingleQuote(doubleFirst.events), true);

      // An apostrophe in a comment between two double-quoted uses changes
      // neither placement and raises no warning.
      const commented = await runWorkflow(
        repoDir,
        reader(
          "commented",
          `echo STEP=commented; set -- "${expr}"\n# don't log it\n` +
            `set -- "$@" "${expr}"; echo "ARGC=$#"`,
        ),
      );
      assertEquals(commented.status, "succeeded", commented.errors.join("\n"));
      assertStringIncludes(await shellStdout(repoDir, "commented"), "ARGC=2");
      assertEquals(warnedSingleQuote(commented.events), false);
    });
  },
);
