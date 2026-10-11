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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  createDefaultVaultConfig,
  DEFAULT_VAULT_NAME,
  DEFAULT_VAULT_TYPE,
} from "./default_vault.ts";
import { isValidVaultName } from "./vault_name.ts";

Deno.test("createDefaultVaultConfig: a local_encryption vault named default with an auto-generated key", () => {
  const config = createDefaultVaultConfig();

  assertEquals(config.name, "default");
  assertEquals(config.type, "local_encryption");
  assertEquals(config.config, { auto_generate: true });
  assertEquals(config.auditReads, false);
});

Deno.test("createDefaultVaultConfig: each call gets its own id", () => {
  assertNotEquals(createDefaultVaultConfig().id, createDefaultVaultConfig().id);
});

Deno.test("DEFAULT_VAULT_NAME: is a name swamp vault create accepts", () => {
  assertEquals(isValidVaultName(DEFAULT_VAULT_NAME), true);
  assertEquals(DEFAULT_VAULT_TYPE, "local_encryption");
});
