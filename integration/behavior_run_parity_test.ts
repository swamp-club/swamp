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
 * `swamp behavior run` and `swamp model method run` are two spellings of one
 * invocation (swamp-club#3265). This drives both leaves in-process against a
 * temp repository and checks that a local run — definition lookup, locks, the
 * run record and the method itself — comes out the same.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { behaviorCommand } from "../src/cli/commands/behavior.ts";
import { modelMethodCommand } from "../src/cli/commands/model_method_run.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { ModelNameType } from "../src/cli/completion_types.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function initRepo(dir: string): Promise<string> {
  const repoDir = join(dir, "repo");
  await Deno.mkdir(join(repoDir, "models"), { recursive: true });
  await new RepoMarkerRepository().write(RepoPath.create(repoDir), {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    repoId: crypto.randomUUID(),
    tools: [],
  });
  return repoDir;
}

interface RunResult {
  modelId: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: string;
}

/** The root as runCli wires it: both groups, the model_name type, --json. */
function root(): AnyCommand {
  return new Command()
    .globalOption("--json", "JSON output")
    .globalType("model_name", new ModelNameType())
    .command("behavior", behaviorCommand)
    .command("model", new Command().command("method", modelMethodCommand));
}

/**
 * Runs the given command words in-process with `--json` and returns the run
 * record the renderer prints on completion. Captures console.log the way
 * integration/model_get_datastore_auto_definition_test.ts does, which holds
 * because Deno runs the tests in a file one at a time.
 *
 * The legacy direct-type words are given post-rewrite (`model method run
 * @type ...`): `rewriteDirectTypeArgs` runs in `runCli`, before Cliffy, and
 * has its own unit tests.
 */
async function runJson(repoDir: string, words: string[]): Promise<RunResult> {
  const printed: string[] = [];
  const originalLog = console.log;
  const previousExitCode = Deno.exitCode;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    await root().parse([...words, "--repo-dir", repoDir, "--json"]);
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
  }
  for (const chunk of printed) {
    try {
      const parsed = JSON.parse(chunk) as Partial<RunResult>;
      if (typeof parsed.status === "string") return parsed as RunResult;
    } catch {
      // Not the run record — progress lines are logged, not JSON.
    }
  }
  throw new Error(`no run record printed; got:\n${printed.join("\n")}`);
}

/** A type whose method records what it was called with, in process. */
function registerType(
  executions: Record<string, unknown>[],
): ModelType {
  const type = ModelType.create(
    `@acme/behavior-parity-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type,
    version: "2026.10.12.1",
    methods: {
      ping: {
        description: "Record the call",
        arguments: z.object({ value: z.string() }),
        execute: (args) => {
          executions.push(args as Record<string, unknown>);
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  return type;
}

Deno.test({
  name:
    "behavior run: a named-definition run matches model method run through both spellings (swamp-club#3265)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repoDir = await initRepo(dir);
      const executions: Record<string, unknown>[] = [];
      const type = registerType(executions);
      try {
        const definition = Definition.create({
          name: "parity-model",
          type: type.normalized,
          globalArguments: {},
        });
        await new YamlDefinitionRepository(repoDir, undefined, undefined, false)
          .save(type, definition);

        const legacy = await runJson(repoDir, [
          "model",
          "method",
          "run",
          "parity-model",
          "ping",
          "--input",
          "value=a",
        ]);
        const preferred = await runJson(repoDir, [
          "behavior",
          "run",
          "parity-model",
          "ping",
          "--input",
          "value=a",
        ]);
        const alias = await runJson(repoDir, [
          "behaviour",
          "run",
          "parity-model",
          "ping",
          "--input",
          "value=a",
        ]);

        for (const run of [legacy, preferred, alias]) {
          assertEquals(run.status, "succeeded");
          assertEquals(run.modelId, definition.id);
          assertEquals(run.modelName, "parity-model");
          assertEquals(run.modelType, type.normalized);
          assertEquals(run.methodName, "ping");
        }
        assertEquals(executions, [
          { value: "a" },
          { value: "a" },
          { value: "a" },
        ]);
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

Deno.test({
  name:
    "behavior run: direct-type execution auto-creates the definition that model method run then finds (swamp-club#3265)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repoDir = await initRepo(dir);
      const executions: Record<string, unknown>[] = [];
      const type = registerType(executions);
      try {
        const first = await runJson(repoDir, [
          "behavior",
          "run",
          type.normalized,
          "ping",
          "auto-def",
          "--input",
          "value=b",
        ]);
        const second = await runJson(repoDir, [
          "model",
          "method",
          "run",
          type.normalized,
          "ping",
          "auto-def",
          "--input",
          "value=c",
        ]);

        assertEquals(first.status, "succeeded");
        assertEquals(second.status, "succeeded");
        assertEquals(first.modelName, "auto-def");
        assertEquals(second.modelId, first.modelId);
        assertEquals(second.modelType, type.normalized);
        assertEquals(executions, [{ value: "b" }, { value: "c" }]);
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

// ---------------------------------------------------------------------------
// The --server path: both leaves send the same request to a swamp serve
// endpoint. A port-0 WebSocket server stands in for serve.
// ---------------------------------------------------------------------------

/**
 * Captures the payload sent over the WebSocket by the --server path and
 * answers with a scripted run result.
 */
function payloadCapturingServer(run: Record<string, unknown>): {
  url: string;
  shutdown: () => Promise<void>;
  payloads: Record<string, unknown>[];
} {
  const payloads: Record<string, unknown>[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          id: string;
          payload: Record<string, unknown>;
        };
        payloads.push(request.payload);
        socket.send(JSON.stringify({
          type: "event",
          id: request.id,
          event: { kind: "completed", run },
        }));
        socket.send(JSON.stringify({ type: "done", id: request.id }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
    payloads,
  };
}

const REMOTE_ARGS = (positionals: string[], url: string) => [
  ...positionals,
  "--input",
  "env=prod",
  "--tag",
  "team=core",
  "--skip-checks",
  "--json",
  "--server",
  url,
  "--token",
  "test.token",
];

Deno.test({
  name:
    "behaviorRunCommand: sends the same server payload as model method run, through both spellings",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = payloadCapturingServer({ status: "succeeded" });
    const previousExitCode = Deno.exitCode;
    Deno.exitCode = 0;
    try {
      for (
        const positionals of [
          ["model", "method", "run", "@swamp/echo", "echo", "my-def"],
          ["behavior", "run", "@swamp/echo", "echo", "my-def"],
          ["behaviour", "run", "@swamp/echo", "echo", "my-def"],
        ]
      ) {
        await root().parse(REMOTE_ARGS(positionals, server.url));
      }
      assertEquals(server.payloads.length, 3);
      const [legacy, behavior, alias] = server.payloads;
      assertEquals(legacy.typeArg, "@swamp/echo");
      assertEquals(legacy.definitionName, "my-def");
      assertEquals(legacy.modelIdOrName, "my-def");
      assertEquals(legacy.methodName, "echo");
      assertEquals(legacy.inputs, { env: "prod" });
      assertEquals(legacy.skipAllChecks, true);
      assertEquals(behavior, legacy);
      assertEquals(alias, legacy);
      assertEquals(Deno.exitCode, 0);
    } finally {
      Deno.exitCode = previousExitCode;
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "both run leaves set Deno.exitCode 1 when the server-side run fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = payloadCapturingServer({ status: "failed" });
    const previousExitCode = Deno.exitCode;
    try {
      for (
        const positionals of [
          ["model", "method", "run", "echo-model", "echo"],
          ["behavior", "run", "echo-model", "echo"],
        ]
      ) {
        Deno.exitCode = 0;
        await root().parse(REMOTE_ARGS(positionals, server.url));
        assertEquals(Deno.exitCode, 1, positionals.join(" "));
      }
    } finally {
      Deno.exitCode = previousExitCode;
      await server.shutdown();
    }
  },
});
