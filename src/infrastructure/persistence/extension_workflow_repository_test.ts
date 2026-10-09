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

/** Runs fn with warnings from the repository captured, returning them. */
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
    // Write a valid workflow
    const validData = createWorkflowYaml("valid-workflow");
    await Deno.writeTextFile(
      join(dir, "valid.yaml"),
      stringifyYaml(validData),
    );

    // Write an invalid YAML file
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
      // Base dir has one workflow
      const baseWorkflow = createWorkflowYaml("base-workflow");
      await Deno.writeTextFile(
        join(baseDir, "base.yaml"),
        stringifyYaml(baseWorkflow),
      );

      const repo = new ExtensionWorkflowRepository(baseDir);
      let workflows = await repo.findAll();
      assertEquals(workflows.length, 1);
      assertEquals(workflows[0].name, "base-workflow");

      // Additional dir has another workflow
      const additionalWorkflow = createWorkflowYaml("additional-workflow");
      await Deno.writeTextFile(
        join(additionalDir, "additional.yaml"),
        stringifyYaml(additionalWorkflow),
      );

      // Update dirs to include the additional directory
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

    // Replace additional dirs with empty list
    repo.updateAdditionalDirs([]);
    const workflows = await repo.findAll();

    // Base dir workflow is still found
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

        // Replace dirA with dirB
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
