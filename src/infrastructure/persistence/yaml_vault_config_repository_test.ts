// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertRejects } from "@std/assert";
import { YamlVaultConfigRepository } from "./yaml_vault_config_repository.ts";

Deno.test("YamlVaultConfigRepository - normal vault types resolve correctly", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    // These should not throw - normal vault types
    const resultAws = await repo.findAllByType("aws");
    const resultLocal = await repo.findAllByType("local_encryption");
    // Both return empty arrays since the vault dir doesn't exist yet
    if (
      !Array.isArray(resultAws) || !Array.isArray(resultLocal)
    ) {
      throw new Error("Expected arrays");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - path traversal via ../../.ssh throws", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    await assertRejects(
      () => repo.findAllByType("../../.ssh"),
      Error,
      "Path traversal detected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("YamlVaultConfigRepository - path traversal via ../foo throws", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = new YamlVaultConfigRepository(dir);
    await assertRejects(
      () => repo.findAllByType("../foo"),
      Error,
      "Path traversal detected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
