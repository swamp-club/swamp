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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { VaultService } from "./vault_service.ts";
import { VaultAnnotation } from "./vault_annotation.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-vault-service-annotation-test-",
  });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function createServiceWithLocalVault(
  vaultName: string,
  baseDir: string,
): VaultService {
  const service = new VaultService();
  service.registerVault({
    name: vaultName,
    type: "local_encryption",
    config: { auto_generate: true, base_dir: baseDir },
  });
  return service;
}

Deno.test("getAnnotation: delegates to provider", async () => {
  await withTempDir(async (dir) => {
    const service = createServiceWithLocalVault("test-vault", dir);
    await service.put("test-vault", "my-key", "my-value");

    const annotation = VaultAnnotation.create({
      url: "https://example.com",
      notes: "test note",
    });
    await service.putAnnotation("test-vault", "my-key", annotation);

    const retrieved = await service.getAnnotation("test-vault", "my-key");
    assertEquals(retrieved !== null, true);
    assertEquals(retrieved!.url, "https://example.com");
    assertEquals(retrieved!.notes, "test note");
  });
});

Deno.test("putAnnotation: delegates to provider", async () => {
  await withTempDir(async (dir) => {
    const service = createServiceWithLocalVault("test-vault", dir);
    await service.put("test-vault", "my-key", "my-value");

    const annotation = VaultAnnotation.create({
      labels: { env: "prod" },
    });
    await service.putAnnotation("test-vault", "my-key", annotation);

    // Verify the annotation was stored by reading it back
    const retrieved = await service.getAnnotation("test-vault", "my-key");
    assertEquals(retrieved !== null, true);
    assertEquals(retrieved!.labels, { env: "prod" });
  });
});

Deno.test("deleteAnnotation: delegates to provider", async () => {
  await withTempDir(async (dir) => {
    const service = createServiceWithLocalVault("test-vault", dir);
    await service.put("test-vault", "my-key", "my-value");

    const annotation = VaultAnnotation.create({ notes: "to be deleted" });
    await service.putAnnotation("test-vault", "my-key", annotation);

    // Delete the annotation
    await service.deleteAnnotation("test-vault", "my-key");

    // Verify it is gone
    const retrieved = await service.getAnnotation("test-vault", "my-key");
    assertEquals(retrieved, null);
  });
});

Deno.test("supportsAnnotations: returns true for annotation-capable provider", () => {
  const service = new VaultService();
  service.registerVault({
    name: "local-vault",
    type: "local_encryption",
    config: { auto_generate: true },
  });

  assertEquals(service.supportsAnnotations("local-vault"), true);
});

Deno.test("supportsAnnotations: returns false for plain VaultProvider", () => {
  const service = new VaultService();
  service.registerVault({
    name: "mock-vault",
    type: "mock",
    config: {},
  });

  assertEquals(service.supportsAnnotations("mock-vault"), false);
});

Deno.test("supportsAnnotations: returns false for non-existent vault", () => {
  const service = new VaultService();

  assertEquals(service.supportsAnnotations("non-existent"), false);
});

Deno.test("requireAnnotationProvider: throws when vault not found with no vaults configured", async () => {
  const service = new VaultService();

  const error = await assertRejects(
    () => service.getAnnotation("missing-vault", "some-key"),
    Error,
  );

  assertStringIncludes(
    error.message,
    "Vault 'missing-vault' not found. No vaults are configured.",
  );
});

Deno.test("requireAnnotationProvider: throws when vault not found with other vaults available", async () => {
  const service = new VaultService();
  service.registerVault({
    name: "existing-vault",
    type: "mock",
    config: {},
  });

  const error = await assertRejects(
    () => service.getAnnotation("missing-vault", "some-key"),
    Error,
  );

  assertStringIncludes(
    error.message,
    "Vault 'missing-vault' not found. Available vaults: existing-vault",
  );
});

Deno.test("requireAnnotationProvider: throws when provider does not support annotations", async () => {
  const service = new VaultService();
  service.registerVault({
    name: "mock-vault",
    type: "mock",
    config: {},
  });

  const error = await assertRejects(
    () => service.getAnnotation("mock-vault", "some-key"),
    Error,
  );

  assertStringIncludes(
    error.message,
    "does not support annotations",
  );
});
