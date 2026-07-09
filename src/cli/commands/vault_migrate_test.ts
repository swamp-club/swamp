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

// Initialize logging for tests
await initializeLogging({});

Deno.test("vaultMigrateCommand: module loads", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  assertEquals(vaultMigrateCommand.getName(), "migrate");
});

Deno.test("vaultMigrateCommand: --to-type is not required", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const toTypeOpt = options.find((o) => o.name === "to-type");
  assertEquals(toTypeOpt !== undefined, true);
  assertEquals(toTypeOpt?.required ?? false, false);
});

Deno.test("vaultMigrateCommand: has --config option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "config");
  assertEquals(opt !== undefined, true);
});

Deno.test("vaultMigrateCommand: has --force option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "force");
  assertEquals(opt !== undefined, true);
});

Deno.test("vaultMigrateCommand: has --dry-run option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "dry-run");
  assertEquals(opt !== undefined, true);
});

Deno.test("vaultMigrateCommand: has --repo-dir option", async () => {
  const { vaultMigrateCommand } = await import("./vault_migrate.ts");
  const options = vaultMigrateCommand.getOptions();
  const opt = options.find((o) => o.name === "repo-dir");
  assertEquals(opt !== undefined, true);
});
