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
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  CLI_ARGS,
  isolatedHomeEnv,
  UNREACHABLE_TELEMETRY_ENDPOINT,
  waitForTelemetrySender,
} from "./test_helpers.ts";
import { writeGateCredential } from "./auth_gate_fixture.ts";

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
  configDir: string,
): Promise<Record<string, unknown>[]> {
  // Telemetry is user-global: parent and child entries spool under
  // <config>/swamp/telemetry, never under the repo.
  const dir = join(configDir, "swamp", "telemetry");
  const entries: Record<string, unknown>[] = [];
  for await (const file of Deno.readDir(dir)) {
    if (
      !file.isFile || !file.name.startsWith("telemetry-") ||
      !file.name.endsWith(".json")
    ) continue;
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
    try {
      await waitForTelemetrySender(join(dir, "xdg"));
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
}

function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  // Every run, repo init included, stays off the default endpoint, and entries
  // stay on disk for the test to inspect.
  env.SWAMP_TELEMETRY_ENDPOINT = UNREACHABLE_TELEMETRY_ENDPOINT;
  return env;
}

async function keepFlushedTelemetry(repoDir: string): Promise<void> {
  // Preserves the file even if a flush did somehow succeed (renamed to
  // .flushed.json).
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker + "\ntelemetryKeepFlushed: true\n",
  );
}

async function createShellModel(
  repoDir: string,
  name: string,
  runCommand: string,
): Promise<void> {
  const modelData = {
    // no typeVersion: this fixture is hand-written YAML, like a checked-in
    // definition under models/
    type: "command/shell",
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
  endpoint?: string;
  result: { status: string };
  parentInvocationId?: string;
  workflowContext?: {
    workflowName: string;
    runId: string;
    jobName: string;
    stepName: string;
    modelType?: string;
  };
  durationMs: number;
}

Deno.test({
  name:
    "workflow run persists per-step child telemetry entries with workflowContext",
  // uses POSIX echo/exit built-ins via command/shell, which exit with code
  // -65536 on Windows; the bridge logic is platform-independent and covered by
  // telemetry_bridge_test.ts
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      // Isolate the user-global telemetry spool (and identity/auth) to a temp
      // config dir so the test never touches the developer's real ~/.config.
      const configDir = join(repoDir, "xdg");
      // The auth gate needs a swamp-club credential in that config dir.
      await writeGateCredential(join(configDir, "swamp"));
      const childEnvWith = (extra: Record<string, string> = {}) => ({
        ...baseChildEnv(),
        // `repo init --tool claude` installs bundled skills into the child's
        // ~/.claude/skills. Root them here.
        ...isolatedHomeEnv(join(repoDir, "home")),
        XDG_CONFIG_HOME: configDir,
        ...extra,
      });

      const init = await runCli(
        ["--json", "repo", "init", "--tool", "claude"],
        repoDir,
        childEnvWith(),
      );
      assertEquals(init.code, 0, `repo init failed: ${init.stderr}`);
      await keepFlushedTelemetry(repoDir);

      await createShellModel(repoDir, "echo-ok", "echo hello");
      await createShellModel(repoDir, "echo-fail", "exit 1");

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

      const env = childEnvWith();
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

      const persisted = await readPersistedEntries(
        configDir,
      ) as unknown as PersistedEntry[];

      for (const entry of persisted) {
        assertEquals(entry.endpoint, UNREACHABLE_TELEMETRY_ENDPOINT);
      }

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

      const children = persisted.filter((entry) =>
        entry.parentInvocationId === parentId
      );

      assertEquals(
        children.length,
        4,
        `expected 4 child entries, got ${children.length}: ${
          JSON.stringify(children.map((c) => c.workflowContext?.stepName))
        }`,
      );

      for (const child of children) {
        assertEquals(child.invocation.command, "model");
        assertEquals(child.invocation.subcommand, "method");
        assertEquals(child.invocation.args[0], "run");
        assert(
          ["echo-ok", "echo-fail"].includes(child.invocation.args[1]),
          `unexpected model name ${child.invocation.args[1]}`,
        );
        assertEquals(child.invocation.args[2], "execute");
        assert(
          child.workflowContext !== undefined,
          "child missing workflowContext",
        );
        assertEquals(child.workflowContext!.workflowName, "telemetry-test-wf");
        assertEquals(child.workflowContext!.jobName, "main");
      }

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

      const stepNames = children.map((c) => c.workflowContext!.stepName);
      assert(
        fanoutA!.workflowContext!.stepName !==
          fanoutB!.workflowContext!.stepName,
        `forEach iterations should have distinct stepNames; got ${
          JSON.stringify(stepNames)
        }`,
      );

      const runIds = new Set(
        children.map((c) => c.workflowContext!.runId),
      );
      assertEquals(runIds.size, 1, "all children share one workflow run id");

      for (const child of children) {
        assertEquals(child.workflowContext!.modelType, "command/shell");
      }
    });
  },
});
