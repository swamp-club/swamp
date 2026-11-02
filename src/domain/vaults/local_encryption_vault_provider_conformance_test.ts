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
 * export suites and testTags are skipped: built-ins come from the factory
 * switch, and tags live in async-only encrypted annotations, covered by the
 * annotation suite's label roundtrip
 */

import {
  assertVaultAnnotationConformance,
  assertVaultConformance,
  assertVaultExistenceConformance,
} from "@swamp-club/swamp-testing";
import { LocalEncryptionVaultProvider } from "./local_encryption_vault_provider.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-conformance-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("LocalEncryptionVaultProvider: satisfies vault provider conformance contract", async () => {
  await withTempDir(async (dir) => {
    const provider = new LocalEncryptionVaultProvider("conformance", {
      auto_generate: true,
      base_dir: dir,
    });
    await assertVaultConformance(provider);
  });
});

Deno.test("LocalEncryptionVaultProvider: satisfies vault annotation conformance contract", async () => {
  await withTempDir(async (dir) => {
    const provider = new LocalEncryptionVaultProvider("conformance", {
      auto_generate: true,
      base_dir: dir,
    });
    await assertVaultAnnotationConformance(provider);
  });
});

Deno.test("LocalEncryptionVaultProvider: satisfies vault existence conformance contract", async () => {
  await withTempDir(async (dir) => {
    const provider = new LocalEncryptionVaultProvider("conformance", {
      auto_generate: true,
      base_dir: dir,
    });
    await assertVaultExistenceConformance(provider);
  });
});
