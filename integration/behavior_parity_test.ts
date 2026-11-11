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
 * drives both spellings in-process against one temp repo and checks the same
 * JSON and exit code; edit is not driven because it reads stdin, which an
 * in-process test cannot feed
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { createBehaviorCommand } from "../src/cli/commands/behavior.ts";
import { createModelCommand } from "../src/cli/commands/model.ts";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { messageFor } from "../src/domain/behavior_wording.ts";
import { commandSurfaceFromArgs } from "../src/cli/command_surface_args.ts";

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

async function root(): Promise<AnyCommand> {
  return registerCompletionTypes(new Command())
    .globalOption("--json", "JSON output")
    .command("behavior", await createBehaviorCommand())
    .command("model", await createModelCommand());
}

interface Result {
  json: unknown;
  exitCode: number;
}

/**
 * captures console.log, which holds because Deno runs the tests in a file one
 * at a time
 */
async function runJson(
  words: string[],
  extra: string[] = [],
): Promise<Result> {
  const printed: string[] = [];
  const originalLog = console.log;
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  let exitCode: number;
  try {
    await (await root()).parse([...words, ...extra, "--json"]);
  } finally {
    console.log = originalLog;
    exitCode = Deno.exitCode;
    Deno.exitCode = previousExitCode;
  }
  const documents = printed.flatMap((chunk) => {
    try {
      return [JSON.parse(chunk) as unknown];
    } catch {
      return [];
    }
  });
  assert(documents.length > 0, `no JSON printed for ${words.join(" ")}`);
  return { json: documents[documents.length - 1], exitCode };
}

function registerType(): ModelType {
  const type = ModelType.create(
    `@acme/behavior-parity-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type,
    version: "2026.10.13.1",
    globalArguments: z.object({ region: z.string().default("eu-west-1") }),
    methods: {
      ping: {
        description: "Answer a ping",
        arguments: z.object({}),
        execute: (_args, context) => {
          context.logger.info`ping answered`;
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  return type;
}

function normalize(value: unknown, swaps: Record<string, string>): unknown {
  let text = JSON.stringify(value);
  for (const [from, to] of Object.entries(swaps)) {
    text = text.replaceAll(from, to);
  }
  return JSON.parse(text);
}

Deno.test({
  name:
    "behavior commands: each gives the same JSON and exit code as its swamp model twin (swamp-club#3331)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repoDir = await initRepo(dir);
      const repo = ["--repo-dir", repoDir];
      const type = registerType();
      try {
        const createdLegacy = await runJson(
          ["model", "create", type.normalized, "legacy-def"],
          repo,
        );
        const createdPreferred = await runJson(
          ["behavior", "create", type.normalized, "preferred-def"],
          repo,
        );
        assertEquals(createdLegacy.exitCode, 0);
        assertEquals(createdPreferred.exitCode, 0);
        const legacyId = (createdLegacy.json as { id: string }).id;
        const preferredId = (createdPreferred.json as { id: string }).id;
        assertEquals(
          normalize(createdPreferred.json, {
            [preferredId]: "<id>",
            "preferred-def": "<name>",
          }),
          normalize(createdLegacy.json, {
            [legacyId]: "<id>",
            "legacy-def": "<name>",
          }),
        );

        const pairs: ReadonlyArray<readonly [string[], string[]]> = [
          [["model", "get", "legacy-def"], ["behavior", "get", "legacy-def"]],
          [["model", "get", "legacy-def"], ["behaviour", "get", "legacy-def"]],
          [
            ["model", "validate", "legacy-def"],
            ["behavior", "validate", "legacy-def"],
          ],
          [["model", "validate"], ["behavior", "validate"]],
          [
            ["model", "evaluate", "legacy-def"],
            ["behavior", "evaluate", "legacy-def"],
          ],
          [["model", "search"], ["behavior", "search"]],
          [["model", "list"], ["behavior", "list"]],
          [
            ["model", "method", "describe", "legacy-def", "ping"],
            ["behavior", "describe", "legacy-def", "ping"],
          ],
          [
            ["model", "type", "describe", type.normalized],
            ["behavior", "type", "describe", type.normalized],
          ],
          [
            ["model", "type", "search", "behavior-parity"],
            ["behavior", "type", "search", "behavior-parity"],
          ],
        ];
        for (const [legacyWords, preferredWords] of pairs) {
          // `type describe` reads the type registry and takes no --repo-dir.
          const extra = legacyWords.includes("describe") &&
              legacyWords.includes("type")
            ? []
            : repo;
          const legacy = await runJson(legacyWords, extra);
          const preferred = await runJson(preferredWords, extra);
          assertEquals(preferred, legacy, preferredWords.join(" "));
        }

        const failure = async (words: string[]) => {
          const error = await assertRejects(() => runJson(words, repo));
          return messageFor(error as Error, commandSurfaceFromArgs(words));
        };
        for (const word of ["get", "delete", "validate"]) {
          assertEquals(
            await failure(["behavior", word, "no-such-def"]),
            "Behavior not found: no-such-def",
            word,
          );
          assertEquals(
            await failure(["model", word, "no-such-def"]),
            "Model not found: no-such-def",
            word,
          );
        }
        assertStringIncludes(
          await failure(["behavior", "get", "no-such-def"]),
          "no-such-def",
        );

        const runLegacy = await runJson(
          ["model", "method", "run", "legacy-def", "ping"],
          repo,
        );
        const runPreferred = await runJson(
          ["behavior", "run", "legacy-def", "ping"],
          repo,
        );
        assertEquals(runLegacy.exitCode, 0);
        assertEquals(runPreferred.exitCode, 0);
        const runShape = (result: Result) => {
          const run = result.json as Record<string, unknown>;
          return {
            status: run.status,
            modelId: run.modelId,
            modelName: run.modelName,
            modelType: run.modelType,
            methodName: run.methodName,
          };
        };
        assertEquals(runShape(runPreferred), runShape(runLegacy));
        assertEquals(runShape(runLegacy).status, "succeeded");

        const latest: ReadonlyArray<readonly [string[], string[]]> = [
          [
            ["model", "method", "history", "legacy-def"],
            ["behavior", "history", "legacy-def"],
          ],
          [
            ["model", "method", "history", "get", "legacy-def"],
            ["behavior", "history", "get", "legacy-def"],
          ],
          [
            ["model", "method", "history", "logs", "legacy-def"],
            ["behavior", "history", "logs", "legacy-def"],
          ],
          [
            ["model", "method", "history", "search"],
            ["behavior", "history", "search"],
          ],
          [["model", "output", "legacy-def"], [
            "behavior",
            "output",
            "legacy-def",
          ]],
          [
            ["model", "output", "get", "legacy-def"],
            ["behavior", "output", "get", "legacy-def"],
          ],
          [["model", "output", "search"], ["behavior", "output", "search"]],
        ];
        for (const [legacyWords, preferredWords] of latest) {
          const legacy = await runJson(legacyWords, repo);
          const preferred = await runJson(preferredWords, repo);
          assertEquals(preferred, legacy, preferredWords.join(" "));
        }

        // Each run's method log lands in its own run log file the same way:
        // both spellings log under the ["model", "method", "run"] category
        // the run-file sink keys on.
        const logLines = async (result: Result) => {
          const { outputId } = result.json as { outputId: string };
          const logs = await runJson(
            ["behavior", "history", "logs", outputId],
            repo,
          );
          assertEquals(
            logs,
            await runJson(
              ["model", "method", "history", "logs", outputId],
              repo,
            ),
          );
          return (logs.json as { lines: string[] }).lines;
        };
        const legacyLines = await logLines(runLegacy);
        const preferredLines = await logLines(runPreferred);
        assert(
          legacyLines.some((line) => line.includes("ping answered")),
          legacyLines.join("\n"),
        );
        assertEquals(
          preferredLines.filter((line) => line.includes("ping answered"))
            .length,
          legacyLines.filter((line) => line.includes("ping answered")).length,
        );

        assertEquals(
          await runJson(["behavior", "cancel", "--all"], repo),
          await runJson(["model", "cancel", "--all"], repo),
        );

        for (
          const words of [
            ["model", "method", "run", "preferred-def", "ping"],
            ["behavior", "run", "preferred-def", "ping"],
          ]
        ) {
          assertEquals((await runJson(words, repo)).exitCode, 0);
        }
        const deletedLegacy = await runJson(
          ["model", "delete", "legacy-def", "--force"],
          repo,
        );
        const deletedPreferred = await runJson(
          ["behavior", "delete", "preferred-def", "--force"],
          repo,
        );
        assertEquals(deletedLegacy.exitCode, 0);
        assertEquals(deletedPreferred.exitCode, 0);
        assertEquals(
          normalize(deletedPreferred.json, {
            [preferredId]: "<id>",
            "preferred-def": "<name>",
          }),
          normalize(deletedLegacy.json, {
            [legacyId]: "<id>",
            "legacy-def": "<name>",
          }),
        );
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

interface CapturedRequest {
  type: string;
  payload: unknown;
}

function cannedServer(responses: Record<string, unknown>): {
  url: string;
  shutdown: () => Promise<void>;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          type: string;
          id: string;
          payload: unknown;
        };
        requests.push({ type: request.type, payload: request.payload });
        socket.send(JSON.stringify({
          type: request.type,
          id: request.id,
          payload: { data: responses[request.type] },
        }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    shutdown: () => server.shutdown(),
    requests,
  };
}

Deno.test({
  name:
    "behavior commands: get and delete send the same server request and print the same JSON as their model twins",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const server = cannedServer({
      "model.get": {
        id: "def-1",
        name: "my-server",
        type: "@acme/t",
        version: 1,
        tags: {},
        globalArguments: {},
      },
      "model.delete": {
        id: "def-1",
        name: "my-server",
        type: "@acme/t",
        inputPath: "models/my-server.yaml",
        resourceDeleted: false,
        outputsDeleted: 0,
        evaluatedInputDeleted: false,
        dataDeleted: false,
        expiredDataAutoCollected: 0,
      },
    });
    const remote = ["--server", server.url, "--token", "test.token"];
    try {
      for (
        const [legacyWords, preferredWords] of [
          [["model", "get", "my-server"], ["behavior", "get", "my-server"]],
          [
            ["model", "delete", "my-server", "--force"],
            ["behavior", "delete", "my-server", "--force"],
          ],
        ]
      ) {
        const before = server.requests.length;
        const legacy = await runJson(legacyWords, remote);
        const preferred = await runJson(preferredWords, remote);
        assertEquals(preferred, legacy, preferredWords.join(" "));
        const [legacyRequest, preferredRequest] = server.requests.slice(before);
        assertEquals(preferredRequest, legacyRequest);
      }
      assertEquals(server.requests.map((r) => r.type), [
        "model.get",
        "model.get",
        "model.delete",
        "model.delete",
      ]);
      assertEquals(server.requests[0].payload, { modelIdOrName: "my-server" });
      assertEquals(server.requests[2].payload, {
        modelIdOrName: "my-server",
        force: true,
      });
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "behavior cancel: with nothing running, log mode keeps the legacy line and says method run under behavior",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const repoDir = await initRepo(dir);
      const messages = async (group: string) => {
        const lines: string[] = [];
        const original = console.info;
        console.info = (...args: unknown[]) => {
          const line = args.map(String).join(" ");
          lines.push(line.slice(line.indexOf(": ") + 2));
        };
        try {
          await (await root()).parse([
            group,
            "cancel",
            "--all",
            "--repo-dir",
            repoDir,
          ]);
        } finally {
          console.info = original;
        }
        return lines;
      };
      assertEquals(await messages("model"), [
        "No running model method runs to cancel.",
      ]);
      assertEquals(await messages("behavior"), [
        "No running method runs to cancel.",
      ]);
    });
  },
});
