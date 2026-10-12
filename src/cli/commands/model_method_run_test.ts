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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { ModelNameType } from "../completion_types.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

// Module-shape tests only. Running the command — locally and through
// --server, for both spellings — is covered in-process by
// integration/behavior_run_parity_test.ts, where a port-0 server is allowed.

Deno.test("modelMethodRunCommand module loads", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  assertEquals(modelMethodRunCommand.getName(), "run");
});

Deno.test("modelMethodRunCommand has correct description", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const desc = modelMethodRunCommand.getDescription();
  assertStringIncludes(
    desc,
    "Execute a method on a model. With @type prefix, auto-creates the definition if needed.",
  );
  assertStringIncludes(desc, "lock_timeout");
  assertStringIncludes(desc, "Exit codes:");
  assertStringIncludes(desc, "SWAMP_LOCK_TIMEOUT_MS");
});

Deno.test("modelMethodCommand module loads", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  assertEquals(modelMethodCommand.getName(), "method");
});

Deno.test("modelMethodCommand has correct description", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  assertEquals(
    modelMethodCommand.getDescription(),
    "Execute model methods",
  );
});

Deno.test("modelMethodCommand has run as subcommand", async () => {
  const { modelMethodCommand } = await import("./model_method_run.ts");
  const commands = modelMethodCommand.getCommands();
  const runCommand = commands.find((cmd) => cmd.getName() === "run");
  assertEquals(runCommand !== undefined, true);
});

Deno.test("modelMethodRunCommand has --timeout option (swamp-club#235)", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const names = modelMethodRunCommand.getOptions().map((o) => o.name);
  if (!names.includes("timeout")) {
    throw new Error(
      `expected --timeout option, got: ${names.join(", ")}`,
    );
  }
});

Deno.test("createModelMethodRunCommand: returns a new instance per call (swamp-club#3265)", async () => {
  const { createModelMethodRunCommand, MODEL_METHOD_RUN_SYNTAX } = await import(
    "./model_method_run.ts"
  );
  const first = createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX);
  const second = createModelMethodRunCommand(MODEL_METHOD_RUN_SYNTAX);
  assertEquals(first !== second, true);
  assertEquals(first.getName(), second.getName());
});

Deno.test("modelMethodRunCommand has --server option", async () => {
  const { modelMethodRunCommand } = await import("./model_method_run.ts");
  const options = modelMethodRunCommand.getOptions();
  const serverOpt = options.find((o) => o.name === "server");
  assertEquals(serverOpt !== undefined, true);
});

Deno.test({
  name:
    "modelMethodRunCommand: direct type execution without definition name rejects before server call",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { modelMethodRunCommand } = await import("./model_method_run.ts");
    const root = new Command()
      .globalType("model_name", new ModelNameType())
      .globalOption("--json", "JSON output")
      .command("run", modelMethodRunCommand);
    try {
      await root.parse([
        "run",
        "@swamp/echo",
        "echo",
        "--json",
        "--server",
        "ws://localhost:9999",
        "--token",
        "test.token",
      ]);
      throw new Error("expected UserError");
    } catch (err) {
      assertStringIncludes(
        (err as Error).message,
        "Direct type execution requires a definition name",
      );
    }
  },
});
