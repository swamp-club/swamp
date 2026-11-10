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

import "../src/domain/models/models.ts";
import { Command } from "@cliffy/command";
import { z } from "zod";
import {
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
} from "../src/cli/commands/model_method_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { endCommand, withClientEnv } from "./serve_upstream_fixtures.ts";

/** a second member's `model method run`, in its own thread as in its own process */
export type MethodRunWorkerRequest = {
  readonly kind: "run";
  readonly configDir: string;
  readonly repoDir: string;
  readonly env: Record<string, string | undefined>;
  readonly modelType: string;
  readonly model: string;
  readonly method: string;
};

export type MethodRunWorkerMessage =
  | { readonly kind: "loaded" }
  | {
    readonly kind: "done";
    readonly error?: string;
    readonly exitCode: number;
  }
  | { readonly kind: "failed"; readonly error: string };

declare const self: Worker;

const logging = initializeLogging({});

async function run(request: MethodRunWorkerRequest): Promise<void> {
  await logging;
  const type = ModelType.create(request.modelType);
  modelRegistry.invalidateType(type);
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    globalArguments: z.object({
      bytes: z.number().int().default(16),
      slow: z.boolean().default(false),
    }),
    methods: {
      peek: {
        description: "Reads nothing and writes no data",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  let error: string | undefined;
  Deno.exitCode = 0;
  try {
    await withClientEnv(
      { configDir: request.configDir },
      request.env,
      ["model", "method", "run"],
      async () => {
        const root = registerCompletionTypes(new Command())
          .globalOption("--json", "JSON output")
          .command("cmd", createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX));
        // as mod.ts does for a v3 checkout: it runs locally, serve its upstream
        setImplicitServeRouting(false);
        try {
          await root.parse([
            "cmd",
            request.model,
            request.method,
            "--json",
            "--repo-dir",
            request.repoDir,
          ]);
        } finally {
          resetImplicitServeRouting();
          await endCommand();
        }
      },
    );
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  self.postMessage(
    {
      kind: "done",
      ...(error === undefined ? {} : { error }),
      exitCode: Deno.exitCode,
    } satisfies MethodRunWorkerMessage,
  );
}

self.onmessage = (event: MessageEvent<MethodRunWorkerRequest>) => {
  run(event.data).catch((error) =>
    self.postMessage(
      {
        kind: "failed",
        error: error instanceof Error
          ? error.stack ?? error.message
          : String(error),
      } satisfies MethodRunWorkerMessage,
    )
  );
};

self.postMessage({ kind: "loaded" } satisfies MethodRunWorkerMessage);
