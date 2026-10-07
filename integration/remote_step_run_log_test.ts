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

// Wires the method execution service, the run logger and the run file sink
// together around a stub dispatcher. Pins that the output a remote worker
// streams back lands in the run log of the run that dispatched the step, and
// in no other run's log (swamp-club#3080).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { requireInitializedRepo } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import type {
  MethodContext,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { setRemoteStepDispatcher } from "../src/domain/remote/remote_dispatch.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  getRunLogger,
  initializeLogging,
  runFileSink,
} from "../src/infrastructure/logging/logger.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-remote-run-log-" });
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

const model: ModelDefinition = {
  type: ModelType.create("test/remote-run-log"),
  version: "1",
  methods: {
    run: {
      description: "Runs on a worker",
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    },
  },
};

Deno.test("remote step output: streamed lines land in the dispatching run's log only", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "test-home");
    const repoService = new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    });
    await repoService.init(RepoPath.create(dir), { tools: [] });
    const { repoContext } = await requireInitializedRepo({
      repoDir: dir,
      outputMode: "json",
      skipImplicitSync: true,
    });

    const runId = crypto.randomUUID();
    const otherRunId = crypto.randomUUID();
    const logPath = join(dir, "run.log");
    const otherLogPath = join(dir, "other-run.log");
    const handle = await runFileSink.register([], logPath, undefined, dir, {
      runId,
    });
    const otherHandle = await runFileSink.register(
      [],
      otherLogPath,
      undefined,
      dir,
      { runId: otherRunId },
    );
    setRemoteStepDispatcher({
      executeRemote: (request) => {
        const output = (line: string, stream: string, level?: string) =>
          request.onEvent?.({
            kind: "method_event",
            event: { type: "output", line, stream, level },
          });
        output("remote-3080 hello", "stdout", "info");
        output("remote-3080 failed a check", "stderr", "error");
        output("remote-3080 from an older worker", "stderr");
        return Promise.resolve({
          outputs: [],
          logs: [],
          durationMs: 1,
          workerName: "w1",
        });
      },
      releaseAffinity: () => {},
    });
    try {
      await initializeLogging({
        _reset: true,
        // Keep the OTel config out of Deno.env, which parallel tests share.
        _logsConfig: { exporterKind: "none" },
      });

      const definition = Definition.create({
        name: "remote-run-log",
        globalArguments: {},
      });
      const context: MethodContext = {
        signal: new AbortController().signal,
        repoDir: dir,
        modelType: model.type,
        modelId: definition.id,
        globalArgs: {},
        definition: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          tags: definition.tags,
        },
        methodName: "run",
        logger: getRunLogger(definition.name, "run", runId),
        dataRepository: repoContext.unifiedDataRepo,
        definitionRepository: repoContext.definitionRepo,
        extensionFile: () => {
          throw new Error("extensionFile is not used by a remote step");
        },
        createCelEnvironment: createExtensionCelEnvironment,
        placement: { labels: { pool: "test" } },
      };

      await new DefaultMethodExecutionService().executeWorkflow(
        definition,
        model,
        "run",
        context,
      );

      const lines = (await Deno.readTextFile(logPath)).trimEnd().split("\n")
        .filter((line) => line.includes("remote-3080"));
      assertEquals(lines.length, 3);
      assertStringIncludes(lines[0], "[INF]");
      assertStringIncludes(lines[0], "remote-3080 hello");
      assertStringIncludes(lines[1], "[ERR]");
      assertStringIncludes(lines[1], "remote-3080 failed a check");
      assertStringIncludes(lines[2], "[WRN]");
      assertStringIncludes(lines[2], "remote-3080 from an older worker");

      assertEquals(await Deno.readTextFile(otherLogPath), "");
    } finally {
      setRemoteStepDispatcher(null);
      runFileSink.unregister(handle);
      runFileSink.unregister(otherHandle);
    }
  });
});
