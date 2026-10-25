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
 * The v3 gate for the definition, workflow and evaluated repositories
 * (swamp-club#3256). The real repositories run on v3, inside a commit-log
 * root over a v3 context hook, with managed config registered at the
 * namespace root's `config` directory. Every write stages typed changes, the
 * unit commits them to a real `commits.db` and filesystem `storage/1`, and a
 * read model catches up into a second directory: its files (bytes) must
 * equal what the repositories wrote, and its catalog stays empty, as these
 * records are not data.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../src/domain/datastore_v3/partition_key.ts";
import {
  ConfigChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import {
  Definition,
  type DefinitionData,
} from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  Workflow,
  type WorkflowData,
} from "../src/domain/workflows/workflow.ts";
import { runInCommitLogRoot } from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import type { CommitSink } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  registerManagedConfig,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import {
  runInUnitOfWork,
  stageTyped,
} from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { recordingUnitOfWork } from "../src/infrastructure/persistence/test_helpers/staged_change_helpers.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import {
  catalogV3Path,
  readCatalog,
  readTree,
  type V3Env,
  withAuditedV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

const TYPE = ModelType.create("test/example");
const RUN_ID = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";

/** One v3 repository context's definition-side repositories. */
class ConfigWriter {
  readonly dir: string;
  readonly root: string;
  readonly hook = contextHook();
  readonly namespace: Namespace;

  constructor(
    readonly env: V3Env,
    readonly namespaceName: string,
    name = "writer",
  ) {
    this.dir = join(env.dir, name);
    this.namespace = namespaceName === ""
      ? SOLO_NAMESPACE
      : restoreNamespace(namespaceName);
    this.root = namespaceName === ""
      ? swampPath(this.dir)
      : swampPath(this.dir, namespaceName);
    registerManagedConfig(this.dir, true, join(this.root, "config"));
  }

  /** The managed-config definitions, with auto-definitions as secondary. */
  definitions(): YamlDefinitionRepository {
    return new YamlDefinitionRepository(
      this.dir,
      undefined,
      join(this.root, "config", "models"),
      join(this.root, "auto-definitions"),
      this.hook,
    );
  }

  /** The repository direct execution builds over the auto-definitions. */
  autoDefinitions(): YamlDefinitionRepository {
    return new YamlDefinitionRepository(
      this.dir,
      undefined,
      join(this.root, "auto-definitions"),
      false,
      this.hook,
    );
  }

  /** Git-tracked definitions outside the datastore, on the same hook. */
  gitDefinitions(): YamlDefinitionRepository {
    return new YamlDefinitionRepository(
      this.dir,
      undefined,
      join(this.dir, "models"),
      false,
      this.hook,
    );
  }

  workflows(): YamlWorkflowRepository {
    return new YamlWorkflowRepository(
      this.dir,
      undefined,
      join(this.root, "config", "workflows"),
      this.hook,
    );
  }

  evaluatedDefinitions(): YamlEvaluatedDefinitionRepository {
    return new YamlEvaluatedDefinitionRepository(
      this.dir,
      join(this.root, "definitions-evaluated"),
      this.hook,
    );
  }

  evaluatedWorkflows(): YamlEvaluatedWorkflowRepository {
    return new YamlEvaluatedWorkflowRepository(
      this.dir,
      join(this.root, "workflows-evaluated"),
      this.hook,
    );
  }

  /** Runs `fn` in a commit-log root over this context, committing after. */
  run<T>(fn: () => Promise<T>, sink: CommitSink = this.env.store): Promise<T> {
    return runInCommitLogRoot(
      { markDirty: this.hook },
      unitOptions(sink, this.env.storage, {
        namespace: this.namespace,
        signal: AbortSignal.timeout(60_000),
      }),
      fn,
    );
  }
}

/** Catches the read model up and checks it holds what the writer wrote. */
async function assertMatches(writer: ConfigWriter): Promise<void> {
  await catchUp(writer.env);
  assertEquals(
    await readTree(writer.env.cacheRoot(writer.namespaceName)),
    await readTree(writer.root),
  );
  assertEquals(readCatalog(catalogV3Path(writer.env)).rows, []);
}

async function catchUp(env: V3Env): Promise<void> {
  const readModel = env.openReadModel();
  try {
    await readModel.catchUp(AbortSignal.timeout(60_000));
  } finally {
    await readModel.close();
  }
}

/** The commits of a partition, oldest first. */
async function commitsOf(
  writer: ConfigWriter,
  partition: PartitionKey,
): Promise<Commit[]> {
  return (await writer.env.store.readPartition(
    writer.namespaceName,
    partition,
    1,
    1_000,
  )).map((change) => change.commit);
}

/** Every commit in feed order, as partition strings. */
async function feedPartitions(env: V3Env): Promise<string[]> {
  return (await env.store.changesSince(0, 10_000)).map((change) =>
    change.commit.partition.toString()
  );
}

function definition(name: string, value = "value"): Definition {
  return Definition.create({ name, globalArguments: { key: value } });
}

/** The same definition (same id) under another name or arguments. */
function changed(
  from: Definition,
  changes: Partial<DefinitionData>,
): Definition {
  return Definition.fromData({ ...from.toData(), ...changes });
}

function workflow(name: string): Workflow {
  return renamed(
    Workflow.create({
      name: "placeholder",
      jobs: [
        Job.create({
          name: "job1",
          steps: [
            Step.create({ name: "step1", task: StepTask.model("m", "run") }),
          ],
        }),
      ],
    }),
    name,
  );
}

function renamed(from: Workflow, name: string): Workflow {
  return Workflow.fromData({ ...from.toData(), name } as WorkflowData);
}

const configModel = (name: string) =>
  partitionOf({ kind: "config", definitionKind: "model", name });
const configWorkflow = (name: string) =>
  partitionOf({ kind: "config", definitionKind: "workflow", name });

for (const namespace of ["", "infra"]) {
  const label = namespace === "" ? "an unnamespaced" : "a namespaced";

  Deno.test(`v3 config staging: managed-config definition writes match the read model for ${label} datastore`, async () => {
    await withAuditedV3Env(async (env) => {
      const writer = new ConfigWriter(env, namespace);
      const repo = writer.definitions();

      // Create, edit, and an unchanged save, which writes and stages nothing.
      const vpc = definition("vpc");
      await writer.run(() => repo.save(TYPE, vpc));
      await writer.run(() =>
        repo.save(
          TYPE,
          changed(vpc, {
            globalArguments: { key: "edited" },
          }),
        )
      );
      const before = (await commitsOf(writer, configModel("vpc"))).length;
      await writer.run(() =>
        repo.save(
          TYPE,
          changed(vpc, {
            globalArguments: { key: "edited" },
          }),
        )
      );
      assertEquals(
        (await commitsOf(writer, configModel("vpc"))).length,
        before,
      );
      await assertMatches(writer);

      // A rename between two filename-safe names: two keys, two partitions.
      await writer.run(() => repo.save(TYPE, changed(vpc, { name: "net" })));
      await assertMatches(writer);
      // A cold repository renames back: its id cache is empty, so the old
      // file stays, as on v2, and the rename is a create.
      await writer.run(() =>
        writer.definitions().save(TYPE, changed(vpc, { name: "vpc" }))
      );
      await assertMatches(writer);

      // A rename between two scoped names, both stored at the uuid path: one
      // key written by two partitions.
      const scoped = definition("@team/vpc");
      await writer.run(() => repo.save(TYPE, scoped));
      await writer.run(() =>
        repo.save(TYPE, changed(scoped, { name: "@team/net" }))
      );
      await assertMatches(writer);
      // ...and the same rename from a cold repository.
      await writer.run(() =>
        writer.definitions().save(
          TYPE,
          changed(scoped, { name: "@team/vpc" }),
        )
      );
      await assertMatches(writer);

      // A scoped name renamed to a filename-safe one moves the file.
      await writer.run(() =>
        repo.save(TYPE, changed(scoped, { name: "team-vpc" }))
      );
      await assertMatches(writer);

      // Deletes.
      await writer.run(() => repo.delete(TYPE, scoped.id));
      await writer.run(() => writer.definitions().delete(TYPE, vpc.id));
      await assertMatches(writer);
    });
  });

  Deno.test(`v3 config staging: a legacy file moved to its name path, and a save across tiers, match the read model for ${label} datastore`, async () => {
    await withAuditedV3Env(async (env) => {
      const writer = new ConfigWriter(env, namespace);
      // A definition committed earlier at its legacy uuid path.
      const legacy = definition("legacy");
      const modelsDir = join(
        writer.root,
        "config",
        "models",
        "test",
        "example",
      );
      await ensureDir(modelsDir);
      const legacyYaml = stringifyYaml(
        JSON.parse(
          JSON.stringify({ ...legacy.toData(), type: TYPE.normalized }),
        ),
      );
      await Deno.writeTextFile(
        join(modelsDir, `${legacy.id}.yaml`),
        legacyYaml,
      );
      await writer.run(() =>
        stageTyped(writer.hook, () => [
          new ConfigChanges("model", "legacy").write(
            "definition.create",
            recordKeyOf([
              "config",
              "models",
              "test",
              "example",
              `${legacy.id}.yaml`,
            ]),
            new TextEncoder().encode(legacyYaml),
            "absent",
          ),
        ])
      );
      await assertMatches(writer);
      // Saving it moves it to its name path: an edit of the new key and a
      // tombstone of the legacy one, in the same partition.
      await writer.run(() =>
        writer.definitions().save(
          TYPE,
          changed(legacy, {
            globalArguments: { key: "moved" },
          }),
        )
      );
      await assertMatches(writer);
      assertEquals(
        (await commitsOf(writer, configModel("legacy"))).at(-1)?.ops.map((op) =>
          op.kind
        ),
        ["put", "tombstone"],
      );

      // An auto-definition that also gets a primary legacy file: the save
      // writes the primary name path and removes the auto-definition file,
      // whose tombstone is the auto-definition's.
      const both = definition("both");
      await writer.run(() => writer.autoDefinitions().save(TYPE, both));
      const repo = writer.definitions();
      // Cache the auto-definition path as the definition's previous path.
      assert(await repo.findById(TYPE, both.id));
      const bothYaml = stringifyYaml(
        JSON.parse(JSON.stringify({ ...both.toData(), type: TYPE.normalized })),
      );
      await Deno.writeTextFile(join(modelsDir, `${both.id}.yaml`), bothYaml);
      await writer.run(() =>
        stageTyped(writer.hook, () => [
          new ConfigChanges("model", "both").write(
            "definition.create",
            recordKeyOf([
              "config",
              "models",
              "test",
              "example",
              `${both.id}.yaml`,
            ]),
            new TextEncoder().encode(bothYaml),
            "absent",
          ),
        ])
      );
      await writer.run(() =>
        repo.save(TYPE, changed(both, { globalArguments: { key: "x" } }))
      );
      await assertMatches(writer);
      const auto = partitionOf({ kind: "definition", id: both.id });
      assertEquals(
        (await commitsOf(writer, auto)).at(-1)?.ops.map((op) =>
          op.kind === "tombstone" ? op.intent.kind : op.kind
        ),
        ["auto-definition.delete"],
      );
    });
  });

  Deno.test(`v3 config staging: auto-definitions and git-tracked definitions for ${label} datastore`, async () => {
    await withAuditedV3Env(async (env) => {
      const writer = new ConfigWriter(env, namespace);
      // Direct execution's repository over the auto-definitions directory.
      const auto = writer.autoDefinitions();
      const echo = definition("echo");
      await writer.run(() => auto.save(TYPE, echo));
      await writer.run(() =>
        auto.save(TYPE, changed(echo, { globalArguments: { key: "again" } }))
      );
      // A rename inside the auto-definitions directory moves its key in the
      // same partition.
      await writer.run(() => auto.save(TYPE, changed(echo, { name: "echo2" })));
      await assertMatches(writer);
      // A delete through the definitions repository, which finds it in its
      // secondary directory.
      await writer.run(() => writer.definitions().delete(TYPE, echo.id));
      await assertMatches(writer);
      const partition = partitionOf({ kind: "definition", id: echo.id });
      for (const commit of await commitsOf(writer, partition)) {
        for (const op of commit.ops) {
          assert(op.kind === "put" || op.kind === "tombstone");
          assertEquals(op.expect, undefined);
        }
      }

      // A git-tracked definition on the same v3 hook: not refused, and it
      // stages nothing.
      const feed = (await env.store.changesSince(0, 10_000)).length;
      await writer.run(() =>
        writer.gitDefinitions().save(TYPE, definition("git"))
      );
      await writer.run(async () => {
        const git = writer.gitDefinitions();
        const found = await git.findByName(TYPE, "git");
        assert(found);
        await git.delete(TYPE, found.id);
      });
      assertEquals((await env.store.changesSince(0, 10_000)).length, feed);
      await assertMatches(writer);
    });
  });

  Deno.test(`v3 config staging: managed-config workflow writes match the read model for ${label} datastore`, async () => {
    await withAuditedV3Env(async (env) => {
      const writer = new ConfigWriter(env, namespace);
      const repo = writer.workflows();
      const deploy = workflow("deploy");
      await writer.run(() => repo.save(deploy));
      await writer.run(() =>
        repo.save(Workflow.fromData({
          ...deploy.toData(),
          description: "edited",
        } as WorkflowData))
      );
      await writer.run(() => repo.save(renamed(deploy, "release")));
      await assertMatches(writer);
      const scoped = workflow("@team/deploy");
      await writer.run(() => repo.save(scoped));
      await writer.run(() => repo.save(renamed(scoped, "@team/release")));
      await writer.run(() =>
        writer.workflows().save(renamed(scoped, "@team/ship"))
      );
      await assertMatches(writer);
      await writer.run(() => repo.delete(deploy.id));
      await writer.run(() => writer.workflows().delete(scoped.id));
      await assertMatches(writer);
    });
  });

  Deno.test(`v3 config staging: evaluated definition and workflow writes match the read model for ${label} datastore`, async () => {
    await withAuditedV3Env(async (env) => {
      const writer = new ConfigWriter(env, namespace);
      const defs = writer.evaluatedDefinitions();
      const vpc = definition("vpc");
      const scoped = definition("@team/vpc");
      await writer.run(() => defs.save(TYPE, vpc, undefined));
      await writer.run(() => defs.save(TYPE, scoped, undefined));
      await writer.run(() =>
        defs.save(TYPE, changed(vpc, { name: "net" }), undefined)
      );
      await assertMatches(writer);
      await writer.run(() => defs.delete(TYPE, vpc.id));
      await assertMatches(writer);
      await writer.run(() => defs.save(TYPE, vpc, undefined));
      await writer.run(() => defs.clearAll());
      await assertMatches(writer);

      // Evaluated workflows, each step from a fresh repository, as CLI
      // commands build one.
      const deploy = workflow("deploy");
      const scopedWf = workflow("@team/deploy");
      await writer.run(() =>
        writer.evaluatedWorkflows().save(deploy, undefined)
      );
      await writer.run(() =>
        writer.evaluatedWorkflows().save(scopedWf, undefined)
      );
      await writer.run(() =>
        writer.evaluatedWorkflows().save(
          renamed(scopedWf, "@team/ship"),
          undefined,
        )
      );
      await writer.run(async () => {
        const repo = writer.evaluatedWorkflows();
        await repo.save(deploy, undefined);
        await repo.save(renamed(deploy, "release"), undefined);
      });
      await assertMatches(writer);

      // Run snapshots: a save and a delete, a non-UUID directory and a
      // missing snapshot, neither of which aborts nor stages anything.
      await writer.run(() =>
        writer.evaluatedWorkflows().saveForRun(RUN_ID, deploy)
      );
      await assertMatches(writer);
      await ensureDir(
        join(writer.root, "workflows-evaluated", "runs", "stray"),
      );
      await ensureDir(
        join(
          writer.root,
          "workflows-evaluated",
          "runs",
          "6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
        ),
      );
      await writer.run(async () => {
        const repo = writer.evaluatedWorkflows();
        await repo.deleteForRun(RUN_ID);
        await repo.deleteForRun("stray");
        await repo.deleteForRun("6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f");
      });
      await assertMatches(writer);
      await writer.run(() =>
        writer.evaluatedWorkflows().saveForRun(RUN_ID, deploy)
      );
      await writer.run(() => writer.evaluatedWorkflows().delete(deploy.id));
      await writer.run(() => writer.evaluatedWorkflows().clear());
      await assertMatches(writer);
    });
  });
}

/** A sink that refuses every commit of one partition. */
function refusing(env: V3Env, partition: PartitionKey): CommitSink {
  return {
    append: (commit) =>
      commit.partition.equals(partition)
        ? Promise.reject(new Error("the store went away"))
        : env.store.append(commit),
    head: (namespace, key) => env.store.head(namespace, key),
  };
}

Deno.test("v3 config staging: a rename lands the new name before the old name's tombstone", async () => {
  await withAuditedV3Env(async (env) => {
    const writer = new ConfigWriter(env, "");
    const vpc = definition("vpc");
    await writer.run(() => writer.definitions().save(TYPE, vpc));
    const before = (await feedPartitions(env)).length;
    const repo = writer.definitions();
    await repo.findById(TYPE, vpc.id);
    await writer.run(() => repo.save(TYPE, changed(vpc, { name: "net" })));
    assertEquals((await feedPartitions(env)).slice(before), [
      configModel("net").toString(),
      configModel("vpc").toString(),
    ]);
  });
});

Deno.test("v3 config staging: a crash between a rename's two commits keeps both names, and nothing is lost", async () => {
  await withAuditedV3Env(async (env) => {
    const writer = new ConfigWriter(env, "");
    const vpc = definition("vpc");
    await writer.run(() => writer.definitions().save(TYPE, vpc));
    const repo = writer.definitions();
    await repo.findById(TYPE, vpc.id);
    await assertRejects(() =>
      writer.run(
        () => repo.save(TYPE, changed(vpc, { name: "net" })),
        refusing(env, configModel("vpc")),
      )
    );
    await catchUp(env);
    const files = [...(await readTree(env.cacheRoot(""))).keys()];
    assertEquals(files, [
      "config/models/test/example/net.yaml",
      "config/models/test/example/vpc.yaml",
    ]);
    // A repository over the read model's files resolves it by id.
    const reader = new YamlDefinitionRepository(
      env.repoDir,
      undefined,
      join(env.cacheRoot(""), "config", "models"),
      false,
    );
    assertEquals((await reader.findById(TYPE, vpc.id))?.id, vpc.id);
  });
});

Deno.test("v3 config staging: a crash in a same-key rename leaves one file with the new name, and deleting it later removes it", async () => {
  await withAuditedV3Env(async (env) => {
    const writer = new ConfigWriter(env, "");
    const scoped = definition("@team/vpc");
    await writer.run(() => writer.definitions().save(TYPE, scoped));
    const net = changed(scoped, { name: "@team/net" });
    await assertRejects(() =>
      writer.run(
        () => writer.definitions().save(TYPE, net),
        refusing(env, configModel("@team/vpc")),
      )
    );
    await catchUp(env);
    const key = `config/models/test/example/${scoped.id}.yaml`;
    // Two live records of one key; the file is the new name's.
    assertEquals([...(await readTree(env.cacheRoot(""))).keys()], [key]);
    const reader = new YamlDefinitionRepository(
      env.repoDir,
      undefined,
      join(env.cacheRoot(""), "config", "models"),
      false,
    );
    assertEquals((await reader.findById(TYPE, scoped.id))?.name, "@team/net");
    // Deleting the new name removes the file; the old name's orphaned
    // record does not keep it.
    await writer.run(() => writer.definitions().delete(TYPE, scoped.id));
    await catchUp(env);
    assertEquals([...(await readTree(env.cacheRoot(""))).keys()], []);
  });
});

Deno.test("v3 config staging: a stale edit or a concurrent create is refused, and the store keeps the other writer's bytes", async () => {
  await withAuditedV3Env(async (env) => {
    const first = new ConfigWriter(env, "", "first");
    const second = new ConfigWriter(env, "", "second");
    const vpc = definition("vpc");
    await first.run(() => first.definitions().save(TYPE, vpc));
    // The second checkout holds the same bytes (as a catch-up would leave).
    const rel = join("config", "models", "test", "example", "vpc.yaml");
    await ensureDir(join(second.root, "config", "models", "test", "example"));
    await Deno.copyFile(join(first.root, rel), join(second.root, rel));

    await first.run(() =>
      first.definitions().save(
        TYPE,
        changed(vpc, {
          globalArguments: { key: "first" },
        }),
      )
    );
    const error = await assertRejects(
      () =>
        second.run(() =>
          second.definitions().save(
            TYPE,
            changed(vpc, {
              globalArguments: { key: "second" },
            }),
          )
        ),
      CommitRejectedError,
    );
    assertEquals(error.reason, "expect-failed");
    // The message names the record key and the partition.
    assert(error.message.includes("config/models/test/example/vpc.yaml"));
    assert(error.message.includes("config--model--vpc"));
    await catchUp(env);
    assertEquals(
      await Deno.readTextFile(join(env.cacheRoot(""), rel)),
      await Deno.readTextFile(join(first.root, rel)),
    );

    // A create of a name another checkout already created.
    await first.run(() => first.definitions().save(TYPE, definition("db")));
    const created = await assertRejects(
      () => second.run(() => second.definitions().save(TYPE, definition("db"))),
      CommitRejectedError,
    );
    assertEquals(created.reason, "expect-failed");
  });
});

Deno.test("v3 config staging: a local file out of step with the store refuses the next save, and a rename of a name v3 never saw refuses its second commit", async () => {
  await withAuditedV3Env(async (env) => {
    const writer = new ConfigWriter(env, "");
    const vpc = definition("vpc");
    await writer.run(() => writer.definitions().save(TYPE, vpc));
    // An out-of-band edit of the local file.
    const path = join(
      writer.root,
      "config",
      "models",
      "test",
      "example",
      "vpc.yaml",
    );
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)) + "# hand\n",
    );
    const edited = await assertRejects(
      () =>
        writer.run(() =>
          writer.definitions().save(
            TYPE,
            changed(vpc, {
              globalArguments: { key: "after hand edit" },
            }),
          )
        ),
      CommitRejectedError,
    );
    assertEquals(edited.reason, "expect-failed");

    // A definition written by a hook-less writer, then renamed on v3: the
    // new name lands, and the old name's tombstone is refused.
    const quiet = definition("quiet");
    await new YamlDefinitionRepository(
      writer.dir,
      undefined,
      join(writer.root, "config", "models"),
      false,
    ).save(TYPE, quiet);
    const repo = writer.definitions();
    await repo.findById(TYPE, quiet.id);
    const renamedAway = await assertRejects(
      () => writer.run(() => repo.save(TYPE, changed(quiet, { name: "loud" }))),
      CommitRejectedError,
    );
    assertEquals(renamedAway.reason, "expect-failed");
    assertEquals((await commitsOf(writer, configModel("loud"))).length, 1);
    assertEquals((await commitsOf(writer, configModel("quiet"))).length, 0);
  });
});

Deno.test("v3 config staging: a workflow rename and a definition edit carry their intents and preconditions", async () => {
  await withAuditedV3Env(async (env) => {
    const writer = new ConfigWriter(env, "");
    const deploy = workflow("deploy");
    await writer.run(() => writer.workflows().save(deploy));
    const repo = writer.workflows();
    await repo.findById(deploy.id);
    await writer.run(() => repo.save(renamed(deploy, "release")));
    const [created] = await commitsOf(writer, configWorkflow("release"));
    const op = created.ops[0];
    assert(op.kind === "put");
    assertEquals(op.intent.kind, "definition.rename-to");
    assertEquals(op.expect, "absent");
    const [, removed] = await commitsOf(writer, configWorkflow("deploy"));
    const tomb = removed.ops[0];
    assert(tomb.kind === "tombstone");
    assertEquals(tomb.intent.kind, "definition.rename-from");
    assertEquals(tomb.expect, "present");
  });
});

Deno.test({
  name:
    "v3 config staging: v2 reads no file a v3 save reads first, under no hook and a legacy unit",
  // An unreadable file stands for a read: chmod does not stop a read on
  // Windows or as root.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withAuditedV3Env(async (env) => {
      const writer = new ConfigWriter(env, "");
      const workflowsDir = join(writer.root, "config", "workflows");
      const evaluatedDir = join(writer.root, "workflows-evaluated");
      const deploy = workflow("deploy");
      await new YamlWorkflowRepository(writer.dir, undefined, workflowsDir)
        .save(deploy);
      const evaluated = new YamlEvaluatedWorkflowRepository(
        writer.dir,
        evaluatedDir,
      );
      await evaluated.save(deploy, undefined);
      await evaluated.saveForRun(RUN_ID, deploy);
      const files = [
        join(workflowsDir, "workflow-deploy.yaml"),
        join(evaluatedDir, "workflow-deploy.yaml"),
        join(evaluatedDir, "runs", RUN_ID, "evaluated-workflow.yaml"),
      ];
      const lock = async () => {
        for (const file of files) {
          try {
            await Deno.chmod(file, 0o000);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      };
      const edited = Workflow.fromData({
        ...deploy.toData(),
        description: "edited",
      } as WorkflowData);
      const saves = (hook: typeof writer.hook | undefined) => async () => {
        await lock();
        await new YamlWorkflowRepository(
          writer.dir,
          undefined,
          workflowsDir,
          hook,
        ).save(edited);
        await lock();
        await new YamlEvaluatedWorkflowRepository(
          writer.dir,
          evaluatedDir,
          hook,
        )
          .save(edited, undefined);
      };

      // v2: no hook, and a legacy unit over a hook.
      await saves(undefined)();
      const { markDirty, uow } = recordingUnitOfWork();
      await runInUnitOfWork(uow, saves(markDirty));
      await lock();
      await runInUnitOfWork(
        uow,
        () =>
          new YamlEvaluatedWorkflowRepository(
            writer.dir,
            evaluatedDir,
            markDirty,
          )
            .deleteForRun(RUN_ID),
      );

      // v3 reads them first, so the same saves fail on the unreadable file.
      await assertRejects(
        () => writer.run(saves(writer.hook)),
        Deno.errors.PermissionDenied,
      );
    });
  },
});

/** Writes a definition file at `rel` under the writer's root and commits it. */
async function seed(
  writer: ConfigWriter,
  rel: readonly string[],
  def: Definition,
): Promise<void> {
  const yaml = stringifyYaml(
    JSON.parse(JSON.stringify({ ...def.toData(), type: TYPE.normalized })),
  );
  const path = join(writer.root, ...rel);
  await ensureDir(join(path, ".."));
  await Deno.writeTextFile(path, yaml);
  await writer.run(() =>
    stageTyped(writer.hook, () => [
      new ConfigChanges("model", def.name).write(
        "definition.create",
        recordKeyOf([...rel]),
        new TextEncoder().encode(yaml),
        "absent",
      ),
    ])
  );
}

Deno.test("v3 config staging: a delete keeps a same-id file of another definition, and tombstones a cached file by its real path", async () => {
  await withAuditedV3Env(async (env) => {
    const writer = new ConfigWriter(env, "");
    // Two definitions sharing an id (a copied file): one at its name path,
    // the other at the uuid path.
    const mine = definition("mine");
    const copy = changed(mine, { name: "copy" });
    await seed(
      writer,
      ["config", "models", "test", "example", "mine.yaml"],
      mine,
    );
    await seed(writer, [
      "config",
      "models",
      "test",
      "example",
      `${mine.id}.yaml`,
    ], copy);
    // A definition filed outside its type directory, found by a lookup.
    const odd = definition("odd");
    await seed(writer, ["config", "models", "elsewhere", "odd.yaml"], odd);
    await assertMatches(writer);

    const repo = writer.definitions();
    await writer.run(() => repo.delete(TYPE, mine.id, "mine"));
    await assertMatches(writer);
    assert(
      (await readTree(env.cacheRoot(""))).has(
        `config/models/test/example/${mine.id}.yaml`,
      ),
    );

    assert(await repo.findByNameGlobal("odd"));
    await writer.run(() => repo.delete(TYPE, odd.id));
    await assertMatches(writer);
    const [, removed] = await commitsOf(writer, configModel("odd"));
    const op = removed.ops[0];
    assert(op.kind === "tombstone");
    assertEquals(op.key.toString(), "config/models/elsewhere/odd.yaml");
  });
});
