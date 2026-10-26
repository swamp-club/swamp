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

import { assertRejects, assertStringIncludes } from "@std/assert";

import { VaultService } from "./vault_service.ts";

Deno.test("Direct Vault Service Error Messages", async (t) => {
  await t.step(
    "should provide detailed error for missing vault configuration",
    async () => {
      const vaultService = new VaultService();

      const error = await assertRejects(
        () => vaultService.get("production", "api-key"),
        Error,
      );

      // Test the detailed error message format
      assertStringIncludes(
        error.message,
        "Vault 'production' not found. No vaults are configured.",
      );
      assertStringIncludes(
        error.message,
        "Vaults are NOT configured in .swamp.yaml",
      );
      assertStringIncludes(
        error.message,
        "swamp vault create <type> production",
      );
      assertStringIncludes(
        error.message,
        "Available vault types:",
      );
      assertStringIncludes(
        error.message,
        "swamp extension pull",
      );
    },
  );

  await t.step(
    "should provide specific vault name in error message",
    async () => {
      const vaultService = new VaultService();

      // Test with a different vault name to ensure it's dynamic
      const error = await assertRejects(
        () => vaultService.get("my-custom-vault", "secret-key"),
        Error,
      );

      assertStringIncludes(error.message, "Vault 'my-custom-vault' not found");
      assertStringIncludes(error.message, "swamp vault create");
      assertStringIncludes(error.message, "my-custom-vault");
    },
  );
});
