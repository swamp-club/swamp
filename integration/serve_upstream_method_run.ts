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
import {
  createModelMethodRunCommand,
  MODEL_METHOD_RUN_SYNTAX,
} from "../src/cli/commands/model_method_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { endCommand, withClientEnv } from "./serve_upstream_fixtures.ts";
import type { ProcessHost } from "./process_host.ts";

/** a second member's `model method run`, in its own ProcessRuntime as in its own process */
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
  | {
    readonly kind: "done";
    readonly error?: string;
    readonly exitCode: number;
  }
  | { readonly kind: "failed"; readonly error: string };

// the behavior type is the test's to register: one definition serves the
// isolate, and this run uses its `peek`
async function run(
  request: MethodRunWorkerRequest,
  post: (message: MethodRunWorkerMessage) => void,
): Promise<void> {
  await initializeLogging({});
  let error: string | undefined;
  // a process global: sound only while no other command in the isolate fails
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
  post({
    kind: "done",
    ...(error === undefined ? {} : { error }),
    exitCode: Deno.exitCode,
  });
}

export const methodRunHost: ProcessHost<
  MethodRunWorkerRequest,
  MethodRunWorkerMessage
> = (post) => (request) => {
  run(request, post).catch((error) =>
    post({
      kind: "failed",
      error: error instanceof Error
        ? error.stack ?? error.message
        : String(error),
    })
  );
};
