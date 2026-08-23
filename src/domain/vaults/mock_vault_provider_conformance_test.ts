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

/**
 * Runs the @swamp-club/swamp-testing vault conformance suite against
 * MockVaultProvider. Other tests rely on the mock standing in for a
 * real provider, so it must satisfy the same behavioral contract
 * extension vault authors are held to.
 */

import { assertVaultConformance } from "@swamp-club/swamp-testing";
import { MockVaultProvider } from "./mock_vault_provider.ts";

Deno.test("MockVaultProvider: satisfies vault provider conformance contract", async () => {
  const provider = new MockVaultProvider("conformance-mock");
  await assertVaultConformance(provider);
});
