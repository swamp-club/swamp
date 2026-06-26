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

import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("dataDeleteCommand module loads", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  assertEquals(dataDeleteCommand.getName(), "delete");
});

Deno.test("dataDeleteCommand has correct description", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  assertEquals(
    dataDeleteCommand.getDescription(),
    "Delete data artifacts: one by name, many by prefix, or all for a model",
  );
});

Deno.test("dataDeleteCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const deleteCmd = commands.find((c) => c.getName() === "delete");
  assertEquals(deleteCmd !== undefined, true);
});

Deno.test("dataDeleteCommand has --repo-dir option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --version option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const versionOpt = options.find((o) => o.name === "version");
  assertEquals(versionOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --force option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const forceOpt = options.find((o) => o.name === "force");
  assertEquals(forceOpt !== undefined, true);
});

Deno.test("dataDeleteCommand accepts two arguments", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const args = dataDeleteCommand.getArguments();
  assertEquals(args.length, 2);
});

Deno.test("dataDeleteCommand has --model option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const modelOpt = options.find((o) => o.name === "model");
  assertEquals(modelOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --name option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const nameOpt = options.find((o) => o.name === "name");
  assertEquals(nameOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --prefix option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const prefixOpt = options.find((o) => o.name === "prefix");
  assertEquals(prefixOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --all option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const allOpt = options.find((o) => o.name === "all");
  assertEquals(allOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has --dry-run option", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const options = dataDeleteCommand.getOptions();
  const dryRunOpt = options.find((o) => o.name === "dry-run");
  assertEquals(dryRunOpt !== undefined, true);
});

Deno.test("dataDeleteCommand has updated description for batch support", async () => {
  const { dataDeleteCommand } = await import("./data_delete.ts");
  const desc = dataDeleteCommand.getDescription();
  assertEquals(desc.includes("prefix"), true);
});
