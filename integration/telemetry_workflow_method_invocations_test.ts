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
 * End-to-end verification that running a workflow persists per-step
 * telemetry entries linked to the parent CLI invocation.
 *
 * Covers the bridge in src/libswamp/workflows/telemetry_bridge.ts:
 * one parent entry plus one child entry per workflow YAML step that
 * resolves to a model method. The shell model is the natural fixture
 * because it ships in-tree and exit codes drive success vs failure.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";

interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CliRunResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
    env,
    clearEnv: true,
  });
  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function readPersistedEntries(
  repoDir: string,
): Promise<Record<string, unknown>[]> {
  const dir = join(repoDir, ".swamp", "telemetry");
  const entries: Record<string, unknown>[] = [];
  for await (const file of Deno.readDir(dir)) {
    if (!file.isFile || !file.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(join(dir, file.name));
    entries.push(JSON.parse(text) as Record<string, unknown>);
  }
  return entries;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-tel-wf-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function pinTelemetryEndpoint(repoDir: string): Promise<void> {
  // Pin telemetry to a localhost port nothing listens on so the
  // post-command flush dies fast and entries stay on disk for us to
  // inspect. keepFlushed: true preserves the file even if a flush did
  // somehow succeed (renamed to .flushed.json).
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker +
      "\ntelemetryEndpoint: http://127.0.0.1:1\ntelemetryKeepFlushed: true\n",
  );
}

async function createShellModel(
  repoDir: string,
  name: string,
  runCommand: string,
): Promise<void> {
  const modelData = {
    type: "command/shell",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: {
      execute: {
        arguments: { run: runCommand },
      },
    },
  };

  const modelDir = join(repoDir, "models/command/shell");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

interface PersistedEntry {
  id: string;
  invocation: { command: string; subcommand?: string; args: string[] };
  result: { status: string };
  parentInvocationId?: string;
  workflowContext?: {
    workflowName: string;
    runId: string;
    jobName: string;
    stepName: string;
    modelType?: string;
    driver?: string;
  };
  durationMs: number;
}

Deno.test({
  name:
    "workflow run persists per-step child telemetry entries with workflowContext",
  // Uses the POSIX `echo` / `exit` shell built-ins via the command/shell
  // model, which exit with code -65536 on Windows. The bridge logic
  // itself is platform-independent and covered by
  // src/libswamp/workflows/telemetry_bridge_test.ts which runs on all
  // platforms.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      // 1. Initialize a single-tool repo
      const init = await runCli(
        ["--json", "repo", "init", "--tool", "claude"],
        repoDir,
        baseChildEnv(),
      );
      assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);
      await pinTelemetryEndpoint(repoDir);

      // 2. Create two shell models: one that succeeds, one that exits 1
      await createShellModel(repoDir, "echo-ok", "echo hello");
      await createShellModel(repoDir, "echo-fail", "exit 1");

      // 3. Create a workflow with three steps:
      //    (a) success step
      //    (b) post-method-executing failure (allowFailure so workflow continues)
      //    (c) forEach with two iterations
      const workflowData = {
        id: crypto.randomUUID(),
        name: "telemetry-test-wf",
        version: 1,
        inputs: {
          properties: {
            envs: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
          },
          required: ["envs"],
        },
        jobs: [
          {
            name: "main",
            steps: [
              {
                name: "ok-step",
                task: {
                  type: "model_method",
                  modelIdOrName: "echo-ok",
                  methodName: "execute",
                },
                dependsOn: [],
                weight: 0,
              },
              {
                name: "fail-step",
                task: {
                  type: "model_method",
                  modelIdOrName: "echo-fail",
                  methodName: "execute",
                },
                allowFailure: true,
                dependsOn: [],
                weight: 0,
              },
              {
                name: "fanout-${{self.env}}",
                forEach: {
                  item: "env",
                  in: "${{ inputs.envs }}",
                },
                task: {
                  type: "model_method",
                  modelIdOrName: "echo-ok",
                  methodName: "execute",
                },
                dependsOn: [],
                weight: 0,
              },
            ],
            dependsOn: [],
            weight: 0,
          },
        ],
      };
      const workflowDir = join(repoDir, "workflows");
      await ensureDir(workflowDir);
      await Deno.writeTextFile(
        join(workflowDir, `workflow-${workflowData.id}.yaml`),
        stringifyYaml(workflowData as Record<string, unknown>),
      );

      // 4. Run the workflow
      const env = baseChildEnv();
      const run = await runCli(
        [
          "--json",
          "workflow",
          "run",
          "telemetry-test-wf",
          "--repo-dir",
          repoDir,
          "--input",
          '{"envs": ["a", "b"]}',
          "--skip-reports",
          "--skip-checks",
        ],
        Deno.cwd(),
        env,
      );
      // Workflow may exit non-zero if a non-allowed failure surfaces; for
      // this fixture all failures are allowed, so expect success.
      assertEquals(
        run.code,
        0,
        `workflow run failed: stdout=${run.stdout} stderr=${run.stderr}`,
      );

      // 5. Read persisted telemetry
      const persisted = await readPersistedEntries(
        repoDir,
      ) as unknown as PersistedEntry[];

      // Find the parent entry for `workflow run`. It carries no
      // workflowContext (workflowContext is for child entries only).
      const parents = persisted.filter((entry) =>
        entry.invocation.command === "workflow" &&
        entry.invocation.subcommand === "run" &&
        !entry.workflowContext
      );
      assertEquals(
        parents.length,
        1,
        "expected exactly one workflow run parent",
      );
      const parentId = parents[0].id;

      // Find child entries linked to this parent
      const children = persisted.filter((entry) =>
        entry.parentInvocationId === parentId
      );

      // Expect: 1 ok-step + 1 fail-step + 2 forEach iterations = 4 children
      assertEquals(
        children.length,
        4,
        `expected 4 child entries, got ${children.length}: ${
          JSON.stringify(children.map((c) => c.workflowContext?.stepName))
        }`,
      );

      // All children should look like a direct `model method run` invocation
      for (const child of children) {
        assertEquals(child.invocation.command, "model");
        assertEquals(child.invocation.subcommand, "method");
        assertEquals(child.invocation.args[0], "run");
        assertEquals(child.invocation.args[1], "<REDACTED>");
        assertEquals(child.invocation.args[2], "execute");
        assert(
          child.workflowContext !== undefined,
          "child missing workflowContext",
        );
        assertEquals(child.workflowContext!.workflowName, "telemetry-test-wf");
        assertEquals(child.workflowContext!.jobName, "main");
      }

      // Identify each child by stepName
      const okChild = children.find((c) =>
        c.workflowContext!.stepName === "ok-step"
      );
      const failChild = children.find((c) =>
        c.workflowContext!.stepName === "fail-step"
      );
      // Match by exact suffix — `includes("a")` would also match "fanout-b"
      // because the prefix "fanout-" itself contains the letter "a", and
      // directory iteration order is non-deterministic across platforms.
      const fanoutA = children.find((c) =>
        c.workflowContext!.stepName === "fanout-a"
      );
      const fanoutB = children.find((c) =>
        c.workflowContext!.stepName === "fanout-b"
      );

      assert(okChild, "missing ok-step child");
      assert(failChild, "missing fail-step child");
      assert(fanoutA, "missing fanout iteration a");
      assert(fanoutB, "missing fanout iteration b");

      assertEquals(okChild!.result.status, "success");
      // fail-step has allowFailure: true but the child entry records the
      // method outcome (error). The parent records workflow success.
      assertEquals(failChild!.result.status, "error");
      assertEquals(parents[0].result.status, "success");

      // forEach iterations have distinct stepNames
      const stepNames = children.map((c) => c.workflowContext!.stepName);
      assert(
        fanoutA!.workflowContext!.stepName !==
          fanoutB!.workflowContext!.stepName,
        `forEach iterations should have distinct stepNames; got ${
          JSON.stringify(stepNames)
        }`,
      );

      // Children carry runId pointing to the same workflow run
      const runIds = new Set(
        children.map((c) => c.workflowContext!.runId),
      );
      assertEquals(runIds.size, 1, "all children share one workflow run id");

      // Children carry modelType for the shell model
      for (const child of children) {
        assertEquals(child.workflowContext!.modelType, "command/shell");
      }
    });
  },
});
