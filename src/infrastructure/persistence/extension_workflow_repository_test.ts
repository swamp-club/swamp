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

import { assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  extensionWorkflowFiles,
  ExtensionWorkflowRepository,
} from "./extension_workflow_repository.ts";
import { assertPathArrayEquals } from "./path_test_helpers.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { UserError } from "../../domain/errors.ts";
import { configure, type LogRecord } from "@logtape/logtape";
import { initializeLogging } from "../logging/logger.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-ext-workflow-test-",
  });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["extension-workflow-repo"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return records.map((r) => r.message.map((p) => String(p)).join(""));
}

function createWorkflowYaml(
  name: string,
  id?: string,
): Record<string, unknown> {
  return {
    id: id ?? crypto.randomUUID(),
    name,
    version: 1,
    jobs: [
      {
        name: "test-job",
        steps: [
          {
            name: "test-step",
            task: {
              type: "model_method",
              modelIdOrName: "test-model",
              methodName: "test-method",
            },
          },
        ],
      },
    ],
  };
}

Deno.test("ExtensionWorkflowRepository discovers YAML workflows from directory", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("my-extension-workflow");
    await Deno.writeTextFile(
      join(dir, "my-workflow.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "my-extension-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository discovers .yml workflow files", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("yml-workflow");
    await Deno.writeTextFile(
      join(dir, "deploy.yml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "yml-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository discovers workflows in subdirectories", async () => {
  await withTempDir(async (dir) => {
    const subdir = join(dir, "aws");
    await ensureDir(subdir);

    const workflowData = createWorkflowYaml("aws-deploy");
    await Deno.writeTextFile(
      join(subdir, "deploy.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "aws-deploy");
  });
});

Deno.test("ExtensionWorkflowRepository returns empty for empty directory", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 0);
  });
});

Deno.test("ExtensionWorkflowRepository returns empty for non-existent directory", async () => {
  const repo = new ExtensionWorkflowRepository("/nonexistent/path");
  const workflows = await repo.findAll();

  assertEquals(workflows.length, 0);
});

Deno.test("ExtensionWorkflowRepository skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    const validData = createWorkflowYaml("valid-workflow");
    await Deno.writeTextFile(
      join(dir, "valid.yaml"),
      stringifyYaml(validData),
    );

    await Deno.writeTextFile(
      join(dir, "broken.yaml"),
      "this is: not: valid: yaml: [",
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "valid-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository findByName returns matching workflow", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("find-me");
    await Deno.writeTextFile(
      join(dir, "findme.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = await repo.findByName("find-me");

    assertEquals(workflow?.name, "find-me");
  });
});

Deno.test("ExtensionWorkflowRepository findByName returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = await repo.findByName("nonexistent");

    assertEquals(workflow, null);
  });
});

Deno.test("ExtensionWorkflowRepository findById returns matching workflow", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    const workflowData = createWorkflowYaml("by-id-workflow", id);
    await Deno.writeTextFile(
      join(dir, "byid.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = await repo.findById(
      id as ReturnType<typeof repo.nextId>,
    );

    assertEquals(workflow?.name, "by-id-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository save throws UserError", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = Workflow.create({ name: "test" });

    await assertRejects(
      () => repo.save(workflow),
      UserError,
      "read-only",
    );
  });
});

Deno.test("ExtensionWorkflowRepository findAll skips manifest.yaml", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("real-workflow");
    await Deno.writeTextFile(
      join(dir, "deploy.yaml"),
      stringifyYaml(workflowData),
    );
    await Deno.writeTextFile(
      join(dir, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/my-ext",
        version: "1.0.0",
      }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "real-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository findAll skips manifest.yml", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("real-workflow");
    await Deno.writeTextFile(
      join(dir, "deploy.yaml"),
      stringifyYaml(workflowData),
    );
    await Deno.writeTextFile(
      join(dir, "manifest.yml"),
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/my-ext",
        version: "1.0.0",
      }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "real-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository findPath skips manifest.yaml", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(
      join(dir, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: 1,
        name: "@test/my-ext",
        id,
      }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const path = await repo.findPath(
      id as ReturnType<typeof repo.nextId>,
    );

    assertEquals(path, null);
  });
});

Deno.test("ExtensionWorkflowRepository findAll skips non-workflow YAML without warning", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "deploy.yaml"),
      stringifyYaml(createWorkflowYaml("real-workflow")),
    );
    await Deno.writeTextFile(
      join(dir, "test-factory.yaml"),
      stringifyYaml({ networks: ["default"], tests: [{ name: "smoke" }] }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    let workflows: Workflow[] = [];
    const warnings = await captureWarnings(async () => {
      workflows = await repo.findAll();
    });

    assertEquals(workflows.map((w) => w.name), ["real-workflow"]);
    assertEquals(warnings, []);
  });
});

Deno.test("ExtensionWorkflowRepository findPath skips non-workflow YAML", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(
      join(dir, "test-factory.yaml"),
      stringifyYaml({ id, tests: [] }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const path = await repo.findPath(
      id as ReturnType<typeof repo.nextId>,
    );

    assertEquals(path, null);
  });
});

Deno.test("ExtensionWorkflowRepository warns once per broken workflow across scans", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "deploy.yaml"),
      stringifyYaml(createWorkflowYaml("real-workflow")),
    );
    const brokenPath = join(dir, "broken.yaml");
    await Deno.writeTextFile(
      brokenPath,
      stringifyYaml({ name: "broken", jobs: [] }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const warnings = await captureWarnings(async () => {
      await repo.findAll();
      await repo.findByName("real-workflow");
      await repo.findByName("missing");
    });

    assertEquals(warnings.length, 1);
    assertEquals(warnings[0].includes("broken.yaml"), true);
  });
});

Deno.test("ExtensionWorkflowRepository warns again when a broken workflow's error changes", async () => {
  await withTempDir(async (dir) => {
    const brokenPath = join(dir, "broken.yaml");
    await Deno.writeTextFile(
      brokenPath,
      stringifyYaml({ name: "broken", jobs: [] }),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const warnings = await captureWarnings(async () => {
      await repo.findAll();
      await Deno.writeTextFile(brokenPath, "jobs: [\n");
      await repo.findAll();
      await repo.findAll();
    });

    assertEquals(warnings.length, 2);
  });
});

Deno.test("ExtensionWorkflowRepository updateAdditionalDirs: discovers workflows from newly added dirs", async () => {
  await withTempDir(async (baseDir) => {
    await withTempDir(async (additionalDir) => {
      const baseWorkflow = createWorkflowYaml("base-workflow");
      await Deno.writeTextFile(
        join(baseDir, "base.yaml"),
        stringifyYaml(baseWorkflow),
      );

      const repo = new ExtensionWorkflowRepository(baseDir);
      let workflows = await repo.findAll();
      assertEquals(workflows.length, 1);
      assertEquals(workflows[0].name, "base-workflow");

      const additionalWorkflow = createWorkflowYaml("additional-workflow");
      await Deno.writeTextFile(
        join(additionalDir, "additional.yaml"),
        stringifyYaml(additionalWorkflow),
      );

      repo.updateAdditionalDirs([additionalDir]);
      workflows = await repo.findAll();
      assertEquals(workflows.length, 2);

      const names = workflows.map((w) => w.name).sort();
      assertEquals(names, ["additional-workflow", "base-workflow"]);
    });
  });
});

Deno.test("ExtensionWorkflowRepository updateAdditionalDirs: preserves base dir", async () => {
  await withTempDir(async (baseDir) => {
    const baseWorkflow = createWorkflowYaml("base-workflow");
    await Deno.writeTextFile(
      join(baseDir, "base.yaml"),
      stringifyYaml(baseWorkflow),
    );

    const repo = new ExtensionWorkflowRepository(baseDir, ["/nonexistent"]);

    repo.updateAdditionalDirs([]);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "base-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository updateAdditionalDirs: replaces previous additional dirs", async () => {
  await withTempDir(async (baseDir) => {
    await withTempDir(async (dirA) => {
      await withTempDir(async (dirB) => {
        const workflowA = createWorkflowYaml("workflow-a");
        await Deno.writeTextFile(
          join(dirA, "a.yaml"),
          stringifyYaml(workflowA),
        );
        const workflowB = createWorkflowYaml("workflow-b");
        await Deno.writeTextFile(
          join(dirB, "b.yaml"),
          stringifyYaml(workflowB),
        );

        const repo = new ExtensionWorkflowRepository(baseDir, [dirA]);
        let workflows = await repo.findAll();
        assertEquals(
          workflows.map((w) => w.name),
          ["workflow-a"],
        );

        repo.updateAdditionalDirs([dirB]);
        workflows = await repo.findAll();
        assertEquals(
          workflows.map((w) => w.name),
          ["workflow-b"],
        );
      });
    });
  });
});

Deno.test("ExtensionWorkflowRepository delete throws UserError", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);

    await assertRejects(
      () => repo.delete(repo.nextId()),
      UserError,
      "read-only",
    );
  });
});

Deno.test("extensionWorkflowFiles: yields nested .yaml and .yml files except manifests", async () => {
  await withTempDir(async (dir) => {
    await ensureDir(join(dir, "ns", "deeper"));
    await Deno.writeTextFile(join(dir, "top.yaml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns", "nested.yml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns", "deeper", "deep.yaml"), "a: 1");
    await Deno.writeTextFile(join(dir, "manifest.yaml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns", "manifest.yml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns", "README.md"), "# readme");

    const files: string[] = [];
    for await (const path of extensionWorkflowFiles(dir)) files.push(path);

    assertPathArrayEquals(
      files.sort(),
      [
        join(dir, "ns", "deeper", "deep.yaml"),
        join(dir, "ns", "nested.yml"),
        join(dir, "top.yaml"),
      ].sort(),
    );
  });
});

Deno.test("extensionWorkflowFiles: throws NotFound for a missing directory", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(async () => {
      for await (const _ of extensionWorkflowFiles(join(dir, "missing"))) {
        // drain
      }
    }, Deno.errors.NotFound);
  });
});

Deno.test("ExtensionWorkflowRepository getWorkflowDirs: reflects updateAdditionalDirs", () => {
  const repo = new ExtensionWorkflowRepository("base", ["source-a"]);
  assertEquals(repo.getWorkflowDirs(), ["base", "source-a"]);

  repo.updateAdditionalDirs(["pulled-a", "pulled-b"]);
  assertEquals(repo.getWorkflowDirs(), ["base", "pulled-a", "pulled-b"]);
});

Deno.test("extensionWorkflowFiles: yields paths in per-level name order", async () => {
  await withTempDir(async (dir) => {
    await ensureDir(join(dir, "ns"));
    await ensureDir(join(dir, "ns1"));
    await Deno.writeTextFile(join(dir, "zebra.yaml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns1", "apple.yaml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns", "mango.yml"), "a: 1");
    await Deno.writeTextFile(join(dir, "ns", "banana.yaml"), "a: 1");
    await Deno.writeTextFile(join(dir, "apple.yaml"), "a: 1");

    const files: string[] = [];
    for await (const path of extensionWorkflowFiles(dir)) files.push(path);

    assertPathArrayEquals(files, [
      join(dir, "apple.yaml"),
      join(dir, "ns", "banana.yaml"),
      join(dir, "ns", "mango.yml"),
      join(dir, "ns1", "apple.yaml"),
      join(dir, "zebra.yaml"),
    ]);
  });
});

Deno.test({
  name:
    "extensionWorkflowFiles: yields the files before an unreadable subdirectory, then throws",
  // chmod does not restrict reads on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const locked = join(dir, "locked");
      await ensureDir(locked);
      await Deno.writeTextFile(join(dir, "apple.yaml"), "a: 1");
      await Deno.writeTextFile(join(locked, "inside.yaml"), "a: 1");
      await Deno.writeTextFile(join(dir, "zebra.yaml"), "a: 1");
      await Deno.chmod(locked, 0o000);
      try {
        // A privileged user can still read the directory; nothing to observe.
        try {
          await Array.fromAsync(Deno.readDir(locked));
          return;
        } catch {
          // Unreadable, as intended.
        }

        const files: string[] = [];
        await assertRejects(async () => {
          for await (const path of extensionWorkflowFiles(dir)) {
            files.push(path);
          }
        }, Deno.errors.PermissionDenied);

        assertPathArrayEquals(files, [join(dir, "apple.yaml")]);
      } finally {
        await Deno.chmod(locked, 0o755);
      }
    });
  },
});

class CountingExtensionWorkflowRepository extends ExtensionWorkflowRepository {
  scans = 0;
  fullReads = 0;
  reads: string[] = [];
  afterScan: (() => Promise<void>) | undefined;

  protected override async scanListings() {
    this.scans++;
    const scanned = await super.scanListings();
    await this.afterScan?.();
    return scanned;
  }

  protected override readWorkflowFile(path: string): Promise<string> {
    this.reads.push(path);
    return super.readWorkflowFile(path);
  }

  override findAll(): Promise<Workflow[]> {
    this.fullReads++;
    return super.findAll();
  }

  async readsDuring<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
    const before = this.reads.length;
    const result = await fn();
    return [result, this.reads.slice(before)];
  }
}

async function settleFiles(dir: string): Promise<void> {
  const when = new Date(Date.now() - 60_000);
  for await (const path of extensionWorkflowFiles(dir)) {
    await Deno.utime(path, when, when);
  }
}

async function writeWorkflow(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(path, stringifyYaml(data));
}

Deno.test("ExtensionWorkflowRepository.memoizedView: reads nothing until a lookup, then scans once for lookups started together", async () => {
  await withTempDir(async (dir) => {
    const a = createWorkflowYaml("a");
    const b = createWorkflowYaml("b");
    await Deno.writeTextFile(join(dir, "a.yaml"), stringifyYaml(a));
    await Deno.writeTextFile(join(dir, "b.yaml"), stringifyYaml(b));
    const repo = new CountingExtensionWorkflowRepository(dir);

    const view = repo.memoizedView();
    assertEquals(repo.scans, 0);
    assertEquals(repo.reads.length, 0);

    const [byName, byId, missing, all] = await Promise.all([
      view.findByName("a"),
      view.findById(b.id as WorkflowId),
      view.findByName("absent"),
      view.findAll(),
    ]);
    await view.findByName("b");

    assertEquals(repo.scans, 1);
    assertEquals(repo.fullReads, 1);
    assertEquals(byName?.id, a.id);
    assertEquals(byId?.name, "b");
    assertEquals(missing, null);
    assertEquals(all.map((w) => w.name), ["a", "b"]);
  });
});

Deno.test("ExtensionWorkflowRepository.memoizedView: finds what the repository finds, the first directory winning a name", async () => {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, "base");
    const additionalDir = join(dir, "additional");
    await ensureDir(baseDir);
    await ensureDir(additionalDir);
    const base = createWorkflowYaml("shared");
    const shadowed = createWorkflowYaml("shared");
    await Deno.writeTextFile(join(baseDir, "s.yaml"), stringifyYaml(base));
    await Deno.writeTextFile(
      join(additionalDir, "s.yaml"),
      stringifyYaml(shadowed),
    );
    const repo = new ExtensionWorkflowRepository(baseDir, [additionalDir]);
    const view = repo.memoizedView();

    assertEquals(
      (await view.findByName("shared"))?.id,
      (await repo.findByName("shared"))?.id,
    );
    assertEquals((await view.findByName("shared"))?.id, base.id);
    assertEquals(await view.findById(shadowed.id as WorkflowId), null);
    assertEquals(await repo.findById(shadowed.id as WorkflowId), null);
    assertEquals(
      (await view.findAllListings!()).map((l) => l.id),
      [base.id],
    );
  });
});

Deno.test("ExtensionWorkflowRepository.memoizedView: a failed scan fails every lookup in the view", async () => {
  class FailingRepository extends ExtensionWorkflowRepository {
    scans = 0;
    protected override scanListings() {
      this.scans++;
      return Promise.reject(new UserError("Failed to read extension workflow"));
    }
  }
  const repo = new FailingRepository("unused");
  const view = repo.memoizedView();

  await assertRejects(() => view.findByName("a"), UserError);
  await assertRejects(
    () => view.findById(crypto.randomUUID() as WorkflowId),
    UserError,
  );
  assertEquals(repo.scans, 1);
});

Deno.test("ExtensionWorkflowRepository.memoizedView: a new view sees workflows added after an earlier view read", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "a.yaml"),
      stringifyYaml(createWorkflowYaml("a")),
    );
    const repo = new CountingExtensionWorkflowRepository(dir);
    const first = repo.memoizedView();
    assertEquals(await first.findByName("late"), null);

    await Deno.writeTextFile(
      join(dir, "late.yaml"),
      stringifyYaml(createWorkflowYaml("late")),
    );

    assertEquals(await first.findByName("late"), null);
    assertEquals((await repo.memoizedView().findByName("late"))?.name, "late");
    assertEquals(repo.scans, 2);
  });
});

Deno.test("ExtensionWorkflowRepository.memoizedView: a lookup reads only the matched file once the listings are kept", async () => {
  await withTempDir(async (dir) => {
    const target = createWorkflowYaml("target");
    await writeWorkflow(join(dir, "target.yaml"), target);
    for (let i = 0; i < 5; i++) {
      await writeWorkflow(
        join(dir, `noise-${i}.yaml`),
        createWorkflowYaml(`noise-${i}`),
      );
    }
    await settleFiles(dir);
    const repo = new CountingExtensionWorkflowRepository(dir);
    await repo.findAllListings();

    const view = repo.memoizedView();
    const [found, reads] = await repo.readsDuring(() =>
      view.findById(target.id as WorkflowId)
    );

    assertEquals(found?.name, "target");
    assertPathArrayEquals(reads, [join(dir, "target.yaml")]);
  });
});

Deno.test("ExtensionWorkflowRepository: with listings kept, findByName and findById read only the matched file and findAllListings reads none", async () => {
  await withTempDir(async (dir) => {
    const target = createWorkflowYaml("target");
    await writeWorkflow(join(dir, "target.yaml"), target);
    for (let i = 0; i < 5; i++) {
      await writeWorkflow(
        join(dir, `noise-${i}.yaml`),
        createWorkflowYaml(`noise-${i}`),
      );
    }
    await settleFiles(dir);
    const repo = new CountingExtensionWorkflowRepository(dir);

    const [warm, warmReads] = await repo.readsDuring(() =>
      repo.findAllListings()
    );
    assertEquals(warm.length, 6);
    assertEquals(warmReads.length, 6);

    const [byName, nameReads] = await repo.readsDuring(() =>
      repo.findByName("target")
    );
    assertEquals(byName?.id, target.id);
    assertPathArrayEquals(nameReads, [join(dir, "target.yaml")]);

    const [byId, idReads] = await repo.readsDuring(() =>
      repo.findById(target.id as WorkflowId)
    );
    assertEquals(byId?.name, "target");
    assertPathArrayEquals(idReads, [join(dir, "target.yaml")]);

    const [missing, missingReads] = await repo.readsDuring(() =>
      repo.findByName("absent")
    );
    assertEquals(missing, null);
    assertEquals(missingReads, []);

    const [listings, listingReads] = await repo.readsDuring(() =>
      repo.findAllListings()
    );
    assertEquals(listings.map((l) => l.name), warm.map((l) => l.name));
    assertEquals(listingReads, []);
    assertEquals(repo.fullReads, 0);
  });
});

Deno.test("ExtensionWorkflowRepository: a lookup never returns the same Workflow instance twice", async () => {
  await withTempDir(async (dir) => {
    await writeWorkflow(join(dir, "a.yaml"), createWorkflowYaml("a"));
    await settleFiles(dir);
    const repo = new ExtensionWorkflowRepository(dir);

    const first = await repo.findByName("a");
    const second = await repo.findByName("a");

    assertEquals(first?.id, second?.id);
    assertEquals(first === second, false);
  });
});

Deno.test("ExtensionWorkflowRepository: an in-place rename is seen by findByName, findById and findAllListings", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a.yaml");
    const data = createWorkflowYaml("before");
    await writeWorkflow(path, data);
    await settleFiles(dir);
    const repo = new ExtensionWorkflowRepository(dir);
    assertEquals((await repo.findByName("before"))?.id, data.id);

    await writeWorkflow(path, { ...data, name: "after-the-rename" });

    assertEquals(await repo.findByName("before"), null);
    assertEquals((await repo.findByName("after-the-rename"))?.id, data.id);
    assertEquals(
      (await repo.findById(data.id as WorkflowId))?.name,
      "after-the-rename",
    );
    assertEquals(
      (await repo.findAllListings()).map((l) => l.name),
      ["after-the-rename"],
    );
  });
});

Deno.test({
  name:
    "ExtensionWorkflowRepository: an atomic replace that keeps mtime and size is seen",
  // Windows reports no inode or change time, the limit the primary repository also accepts.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "a.yaml");
      const id = crypto.randomUUID() as WorkflowId;
      await writeWorkflow(path, createWorkflowYaml("name-one", id));
      await settleFiles(dir);
      const before = await Deno.stat(path);
      const repo = new ExtensionWorkflowRepository(dir);
      assertEquals((await repo.findByName("name-one"))?.id, id);

      const staged = join(dir, "staged.tmp");
      await writeWorkflow(staged, createWorkflowYaml("name-two", id));
      assertEquals((await Deno.stat(staged)).size, before.size);
      await Deno.utime(staged, before.atime!, before.mtime!);
      await Deno.rename(staged, path);

      assertEquals(await repo.findByName("name-one"), null);
      assertEquals((await repo.findByName("name-two"))?.id, id);
    });
  },
});

Deno.test("ExtensionWorkflowRepository: added and deleted files are seen once listings are kept", async () => {
  await withTempDir(async (dir) => {
    const doomed = createWorkflowYaml("doomed");
    await writeWorkflow(join(dir, "doomed.yaml"), doomed);
    await settleFiles(dir);
    const repo = new CountingExtensionWorkflowRepository(dir);
    assertEquals((await repo.findByName("doomed"))?.id, doomed.id);
    assertEquals(await repo.findByName("newcomer"), null);

    await Deno.remove(join(dir, "doomed.yaml"));
    const added = createWorkflowYaml("newcomer");
    await writeWorkflow(join(dir, "newcomer.yaml"), added);

    assertEquals(await repo.findByName("doomed"), null);
    assertEquals(await repo.findById(doomed.id as WorkflowId), null);
    assertEquals((await repo.findByName("newcomer"))?.id, added.id);
    assertEquals(
      (await repo.findAllListings()).map((l) => l.name),
      ["newcomer"],
    );
    assertEquals(repo.fullReads, 0);
  });
});

Deno.test("ExtensionWorkflowRepository: a file modified inside the racy window is read again on the next lookup", async () => {
  await withTempDir(async (dir) => {
    await writeWorkflow(join(dir, "settled.yaml"), createWorkflowYaml("old"));
    await settleFiles(dir);
    await writeWorkflow(join(dir, "fresh.yaml"), createWorkflowYaml("fresh"));
    const repo = new CountingExtensionWorkflowRepository(dir);
    await repo.findAllListings();

    const [, reads] = await repo.readsDuring(() => repo.findAllListings());

    assertPathArrayEquals(reads, [join(dir, "fresh.yaml")]);
  });
});

Deno.test("ExtensionWorkflowRepository: a name shadowed by an earlier dir is not found by its id, and is found once the earlier file is renamed", async () => {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, "base");
    const pulledDir = join(dir, "pulled");
    await ensureDir(baseDir);
    await ensureDir(pulledDir);
    const winner = createWorkflowYaml("shared");
    const shadowed = createWorkflowYaml("shared");
    await writeWorkflow(join(baseDir, "s.yaml"), winner);
    await writeWorkflow(join(pulledDir, "s.yaml"), shadowed);
    await settleFiles(dir);
    const repo = new ExtensionWorkflowRepository(baseDir, [pulledDir]);

    assertEquals((await repo.findByName("shared"))?.id, winner.id);
    assertEquals(await repo.findById(shadowed.id as WorkflowId), null);
    assertEquals(
      (await repo.findAllListings()).map((l) => l.id),
      [winner.id],
    );

    await writeWorkflow(join(baseDir, "s.yaml"), {
      ...winner,
      name: "renamed-away",
    });

    assertEquals((await repo.findByName("shared"))?.id, shadowed.id);
    assertEquals(
      (await repo.findById(shadowed.id as WorkflowId))?.name,
      "shared",
    );
  });
});

Deno.test("ExtensionWorkflowRepository: a broken file never claims a name", async () => {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, "base");
    const pulledDir = join(dir, "pulled");
    await ensureDir(baseDir);
    await ensureDir(pulledDir);
    await writeWorkflow(join(baseDir, "s.yaml"), { name: "shared", jobs: [] });
    const valid = createWorkflowYaml("shared");
    await writeWorkflow(join(pulledDir, "s.yaml"), valid);
    await settleFiles(dir);
    const repo = new ExtensionWorkflowRepository(baseDir, [pulledDir]);

    await captureWarnings(async () => {
      assertEquals((await repo.findByName("shared"))?.id, valid.id);
      assertEquals((await repo.findById(valid.id as WorkflowId))?.id, valid.id);
    });
  });
});

Deno.test("ExtensionWorkflowRepository: lookups skip broken YAML with one warning and skip non-workflow YAML silently", async () => {
  await withTempDir(async (dir) => {
    await writeWorkflow(join(dir, "ok.yaml"), createWorkflowYaml("ok"));
    await Deno.writeTextFile(join(dir, "broken.yaml"), "jobs: [\n");
    await writeWorkflow(join(dir, "data.yaml"), { name: "data", items: [1] });
    await settleFiles(dir);
    const repo = new ExtensionWorkflowRepository(dir);

    const warnings = await captureWarnings(async () => {
      assertEquals(
        (await repo.findAllListings()).map((l) => l.name),
        ["ok"],
      );
      assertEquals(await repo.findByName("data"), null);
      assertEquals((await repo.findByName("ok"))?.name, "ok");
      await repo.findAll();
    });

    assertEquals(warnings.length, 1);
    assertEquals(warnings[0].includes("broken.yaml"), true);
  });
});

Deno.test("ExtensionWorkflowRepository: a broken file is not read again until its stat changes", async () => {
  await withTempDir(async (dir) => {
    const brokenPath = join(dir, "broken.yaml");
    await writeWorkflow(join(dir, "ok.yaml"), createWorkflowYaml("ok"));
    await Deno.writeTextFile(brokenPath, "jobs: [\n");
    await settleFiles(dir);
    const repo = new CountingExtensionWorkflowRepository(dir);

    await captureWarnings(async () => {
      await repo.findAllListings();
      const [, unchanged] = await repo.readsDuring(() =>
        repo.findByName("missing")
      );
      assertEquals(unchanged, []);

      await Deno.writeTextFile(brokenPath, "jobs: [[\n");
      const [, changed] = await repo.readsDuring(() =>
        repo.findByName("missing")
      );
      assertPathArrayEquals(changed, [brokenPath]);
    });
  });
});

Deno.test("ExtensionWorkflowRepository: a symlinked workflow file is followed, as findAll follows it, and read without a full walk", async () => {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      const target = join(outside, "linked.yaml");
      const linked = createWorkflowYaml("linked");
      await writeWorkflow(target, linked);
      const path = join(dir, "linked.yaml");
      await Deno.symlink(target, path, { type: "file" });
      await settleFiles(dir);
      const repo = new CountingExtensionWorkflowRepository(dir);
      assertEquals((await repo.findAll()).map((w) => w.id), [linked.id]);
      await repo.findAllListings();

      const [byName, nameReads] = await repo.readsDuring(() =>
        repo.findByName("linked")
      );
      const [byId, idReads] = await repo.readsDuring(() =>
        repo.findById(linked.id as WorkflowId)
      );

      assertEquals(byName?.id, linked.id);
      assertEquals(byId?.name, "linked");
      assertPathArrayEquals(nameReads, [path]);
      assertPathArrayEquals(idReads, [path]);
      assertEquals(repo.fullReads, 1);
    });
  });
});

Deno.test("ExtensionWorkflowRepository: a matched file renamed after the scan is not returned, and findAll answers", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "target.yaml");
    const original = createWorkflowYaml("target");
    await writeWorkflow(path, original);
    await settleFiles(dir);
    const repo = new CountingExtensionWorkflowRepository(dir);
    repo.afterScan = async () => {
      repo.afterScan = undefined;
      await writeWorkflow(path, { ...original, name: "renamed" });
    };

    const found = await repo.findByName("target");

    assertEquals(found, null);
    assertEquals(repo.fullReads, 1);
  });
});

Deno.test("ExtensionWorkflowRepository: a file found by id and renamed after the scan into a name an earlier dir holds is not returned, as findAll drops it", async () => {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, "base");
    const pulledDir = join(dir, "pulled");
    await ensureDir(baseDir);
    await ensureDir(pulledDir);
    await writeWorkflow(
      join(baseDir, "taken.yaml"),
      createWorkflowYaml("taken"),
    );
    const pulledPath = join(pulledDir, "mine.yaml");
    const pulled = createWorkflowYaml("mine");
    await writeWorkflow(pulledPath, pulled);
    await settleFiles(dir);
    const repo = new CountingExtensionWorkflowRepository(baseDir, [pulledDir]);
    repo.afterScan = async () => {
      repo.afterScan = undefined;
      await writeWorkflow(pulledPath, { ...pulled, name: "taken" });
    };

    const found = await repo.findById(pulled.id as WorkflowId);

    assertEquals(found, null);
    assertEquals(repo.fullReads, 1);
    assertEquals(
      (await repo.findAll()).find((w) => w.id === pulled.id),
      undefined,
    );
  });
});

Deno.test("ExtensionWorkflowRepository: an unreadable file fails a lookup with the same error as findAll", async () => {
  class UnreadableRepository extends ExtensionWorkflowRepository {
    protected override readWorkflowFile(_path: string): Promise<string> {
      return Promise.reject(
        Object.assign(new Error("Too many open files (os error 24)"), {
          code: "EMFILE",
        }),
      );
    }
  }
  await withTempDir(async (dir) => {
    await writeWorkflow(join(dir, "a.yaml"), createWorkflowYaml("a"));
    const repo = new UnreadableRepository(dir);

    const fromFindAll = await assertRejects(() => repo.findAll(), UserError);
    const fromName = await assertRejects(() => repo.findByName("a"), UserError);
    const fromId = await assertRejects(
      () => repo.findById(crypto.randomUUID() as WorkflowId),
      UserError,
    );
    const fromListings = await assertRejects(
      () => repo.findAllListings(),
      UserError,
    );

    assertEquals(fromName.message, fromFindAll.message);
    assertEquals(fromId.message, fromFindAll.message);
    assertEquals(fromListings.message, fromFindAll.message);
  });
});

Deno.test("ExtensionWorkflowRepository: updateAdditionalDirs to a new set drops the workflows of removed dirs", async () => {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, "base");
    const oldDir = join(dir, "old");
    const newDir = join(dir, "new");
    for (const d of [baseDir, oldDir, newDir]) await ensureDir(d);
    const gone = createWorkflowYaml("gone");
    await writeWorkflow(join(oldDir, "gone.yaml"), gone);
    await writeWorkflow(
      join(newDir, "arrived.yaml"),
      createWorkflowYaml("arrived"),
    );
    await settleFiles(dir);
    const repo = new ExtensionWorkflowRepository(baseDir, [oldDir]);
    assertEquals((await repo.findByName("gone"))?.id, gone.id);

    repo.updateAdditionalDirs([newDir]);

    assertEquals(await repo.findByName("gone"), null);
    assertEquals(await repo.findById(gone.id as WorkflowId), null);
    assertEquals(
      (await repo.findAllListings()).map((l) => l.name),
      ["arrived"],
    );
  });
});
