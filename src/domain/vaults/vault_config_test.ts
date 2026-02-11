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

import { assertEquals } from "@std/assert";
import {
  createVaultConfigId,
  VaultConfig,
  type VaultConfigData,
} from "./vault_config.ts";

Deno.test("createVaultConfigId creates a vault config ID from string", () => {
  const id = createVaultConfigId("test-id");
  assertEquals(id, "test-id");
});

Deno.test("VaultConfig.create creates a new config with current timestamp", () => {
  const beforeCreate = new Date();
  const config = VaultConfig.create(
    "test-id",
    "my-vault",
    "aws",
    { region: "us-east-1" },
  );
  const afterCreate = new Date();

  assertEquals(config.id, "test-id");
  assertEquals(config.name, "my-vault");
  assertEquals(config.type, "aws");
  assertEquals(config.config, { region: "us-east-1" });

  // Verify createdAt is set to current time
  assertEquals(config.createdAt >= beforeCreate, true);
  assertEquals(config.createdAt <= afterCreate, true);
});

Deno.test("VaultConfig.fromData reconstructs config from persisted data", () => {
  const data: VaultConfigData = {
    id: "persisted-id",
    name: "persisted-vault",
    type: "local_encryption",
    config: { auto_generate: true },
    createdAt: "2024-06-15T10:30:00.000Z",
  };

  const config = VaultConfig.fromData(data);

  assertEquals(config.id, "persisted-id");
  assertEquals(config.name, "persisted-vault");
  assertEquals(config.type, "local_encryption");
  assertEquals(config.config, { auto_generate: true });
  assertEquals(config.createdAt.toISOString(), "2024-06-15T10:30:00.000Z");
});

Deno.test("VaultConfig.toData converts config to persistable format", () => {
  const config = VaultConfig.create(
    "export-id",
    "export-vault",
    "aws",
    { region: "eu-west-1", profile: "production" },
  );

  const data = config.toData();

  assertEquals(data.id, "export-id");
  assertEquals(data.name, "export-vault");
  assertEquals(data.type, "aws");
  assertEquals(data.config, { region: "eu-west-1", profile: "production" });
  assertEquals(typeof data.createdAt, "string");
  // Verify createdAt is valid ISO string
  assertEquals(new Date(data.createdAt).toISOString(), data.createdAt);
});

Deno.test("VaultConfig round-trip: create -> toData -> fromData preserves data", () => {
  const original = VaultConfig.create(
    "round-trip-id",
    "round-trip-vault",
    "aws",
    { region: "us-west-2" },
  );

  const data = original.toData();
  const restored = VaultConfig.fromData(data);

  assertEquals(restored.id, original.id);
  assertEquals(restored.name, original.name);
  assertEquals(restored.type, original.type);
  assertEquals(restored.config, original.config);
  assertEquals(
    restored.createdAt.toISOString(),
    original.createdAt.toISOString(),
  );
});

Deno.test("VaultConfig handles empty config object", () => {
  const config = VaultConfig.create(
    "empty-config-id",
    "empty-config-vault",
    "mock",
    {},
  );

  assertEquals(config.config, {});

  const data = config.toData();
  assertEquals(data.config, {});

  const restored = VaultConfig.fromData(data);
  assertEquals(restored.config, {});
});

Deno.test("VaultConfig handles complex nested config", () => {
  const complexConfig = {
    region: "us-east-1",
    endpoints: {
      primary: "https://primary.example.com",
      fallback: "https://fallback.example.com",
    },
    options: {
      timeout: 30000,
      retries: 3,
      cache: true,
    },
  };

  const config = VaultConfig.create(
    "complex-id",
    "complex-vault",
    "aws",
    complexConfig,
  );

  assertEquals(config.config, complexConfig);

  const data = config.toData();
  assertEquals(data.config, complexConfig);

  const restored = VaultConfig.fromData(data);
  assertEquals(restored.config, complexConfig);
});
