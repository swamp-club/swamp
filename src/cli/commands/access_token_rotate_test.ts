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

Deno.test("accessTokenRotateCommand: module loads", async () => {
  const { accessTokenRotateCommand } = await import("./access_token_rotate.ts");
  assertEquals(accessTokenRotateCommand.getName(), "rotate");
});

Deno.test("accessTokenRotateCommand: has no --vault option", async () => {
  const { accessTokenRotateCommand } = await import("./access_token_rotate.ts");
  const vaultOpt = accessTokenRotateCommand.getOptions(true).find((o) =>
    o.name === "vault"
  );
  assertEquals(vaultOpt, undefined);
});
