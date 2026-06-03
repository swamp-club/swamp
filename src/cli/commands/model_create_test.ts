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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { parseKeyValueInputs } from "../input_parser.ts";
import { UserError } from "../../domain/errors.ts";
import { z } from "zod";

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/echo_model_test.ts
// These tests verify the command module loads correctly

Deno.test("modelCommand module loads", async () => {
  const { modelCommand } = await import("./model_create.ts");
  assertEquals(modelCommand.getName(), "model");
});

Deno.test("modelCreateCommand is registered as subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const createCmd = commands.find((c) => c.getName() === "create");
  assertEquals(createCmd !== undefined, true);
});

Deno.test("modelValidateCommand is registered as subcommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const validateCmd = commands.find((c) => c.getName() === "validate");
  assertEquals(validateCmd !== undefined, true);
});

Deno.test("modelCreateCommand has --global-arg option", async () => {
  const { modelCreateCommand } = await import("./model_create.ts");
  const options = modelCreateCommand.getOptions();
  const globalArgOpt = options.find((o) => o.name === "global-arg");
  assertEquals(globalArgOpt !== undefined, true);
});

// Tests for --global-arg parsing (uses parseKeyValueInputs from input_parser)

Deno.test("--global-arg key=value populates globalArguments", async () => {
  const result = await parseKeyValueInputs(["message=hello"]);
  assertEquals(result, { message: "hello" });
});

Deno.test("multiple --global-arg flags accumulate correctly", async () => {
  const result = await parseKeyValueInputs([
    "region=us-east-1",
    "timeout=30",
  ]);
  assertEquals(result, { region: "us-east-1", timeout: "30" });
});

Deno.test("--global-arg splits on first = only", async () => {
  const result = await parseKeyValueInputs(["foo=bar=baz"]);
  assertEquals(result, { foo: "bar=baz" });
});

Deno.test("--global-arg supports dot notation for nested objects", async () => {
  const result = await parseKeyValueInputs([
    "config.region=us-east-1",
    "config.timeout=30",
  ]);
  assertEquals(result, { config: { region: "us-east-1", timeout: "30" } });
});

Deno.test("--global-arg missing = produces clear error", async () => {
  await assertRejects(
    () => parseKeyValueInputs(["noequals"]),
    UserError,
    'Invalid input format: "noequals"',
  );
});

Deno.test("--global-arg empty key produces clear error", async () => {
  await assertRejects(
    () => parseKeyValueInputs(["=value"]),
    UserError,
    "empty key",
  );
});

// Tests for globalArguments schema validation (mirrors model_create.ts logic)

Deno.test("global arguments validated against model type schema - pass", () => {
  const schema = z.object({
    region: z.string(),
  });
  const result = schema.safeParse({ region: "us-east-1" });
  assertEquals(result.success, true);
});

Deno.test("global arguments validated against model type schema - fail", () => {
  const schema = z.object({
    region: z.string(),
    count: z.number(),
  });
  const result = schema.safeParse({ region: "us-east-1" });
  assertEquals(result.success, false);
});
