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
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";
import { VaultAnnotation } from "./vault_annotation.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-local-vault-annotation-test-",
  });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function createVault(
  name: string,
  baseDir: string,
): LocalEncryptionVaultProvider {
  const config: LocalEncryptionConfig = {
    auto_generate: true,
    base_dir: baseDir,
  };
  return new LocalEncryptionVaultProvider(name, config);
}

Deno.test("putAnnotation + getAnnotation: round-trip encrypt/decrypt", async () => {
  await withTempDir(async (dir) => {
    const vault = createVault("round-trip-vault", dir);
    await vault.put("my-secret", "secret-value");

    const annotation = VaultAnnotation.create({
      url: "https://console.aws.amazon.com/secretsmanager",
      notes: "Production API key for payment service",
      labels: { env: "prod", team: "payments" },
    });

    await vault.putAnnotation("my-secret", annotation);
    const retrieved = await vault.getAnnotation("my-secret");

    assertEquals(retrieved !== null, true);
    assertEquals(
      retrieved!.url,
      "https://console.aws.amazon.com/secretsmanager",
    );
    assertEquals(retrieved!.notes, "Production API key for payment service");
    assertEquals(retrieved!.labels, { env: "prod", team: "payments" });
  });
});

Deno.test("getAnnotation: returns null when no annotation exists", async () => {
  await withTempDir(async (dir) => {
    const vault = createVault("no-annotation-vault", dir);
    await vault.put("my-secret", "secret-value");

    const annotation = await vault.getAnnotation("my-secret");
    assertEquals(annotation, null);
  });
});

Deno.test("deleteAnnotation: idempotent when annotation does not exist", async () => {
  await withTempDir(async (dir) => {
    const vault = createVault("delete-idempotent-vault", dir);
    await vault.put("my-secret", "secret-value");

    // Should not throw when deleting a non-existent annotation
    await vault.deleteAnnotation("my-secret");

    // Verify it is still null
    const annotation = await vault.getAnnotation("my-secret");
    assertEquals(annotation, null);
  });
});

Deno.test("listAnnotations: returns correct map of annotations", async () => {
  await withTempDir(async (dir) => {
    const vault = createVault("list-annotations-vault", dir);
    await vault.put("secret-a", "value-a");
    await vault.put("secret-b", "value-b");
    await vault.put("secret-c", "value-c");

    const annotationA = VaultAnnotation.create({
      url: "https://a.example.com",
      notes: "First secret",
    });
    const annotationB = VaultAnnotation.create({
      labels: { env: "staging" },
    });

    await vault.putAnnotation("secret-a", annotationA);
    await vault.putAnnotation("secret-b", annotationB);
    // secret-c has no annotation

    const annotations = await vault.listAnnotations();
    assertEquals(annotations.size, 2);
    assertEquals(annotations.has("secret-a"), true);
    assertEquals(annotations.has("secret-b"), true);
    assertEquals(annotations.has("secret-c"), false);

    assertEquals(annotations.get("secret-a")!.url, "https://a.example.com");
    assertEquals(annotations.get("secret-a")!.notes, "First secret");
    assertEquals(annotations.get("secret-b")!.labels, { env: "staging" });
  });
});

Deno.test("listAnnotations: returns empty map when no annotations exist", async () => {
  await withTempDir(async (dir) => {
    const vault = createVault("empty-annotations-vault", dir);
    await vault.put("my-secret", "secret-value");

    const annotations = await vault.listAnnotations();
    assertEquals(annotations.size, 0);
  });
});

Deno.test("putAnnotation: overwrites existing annotation", async () => {
  await withTempDir(async (dir) => {
    const vault = createVault("overwrite-vault", dir);
    await vault.put("my-secret", "secret-value");

    const original = VaultAnnotation.create({
      url: "https://old.example.com",
      notes: "Original note",
      labels: { env: "dev" },
    });
    await vault.putAnnotation("my-secret", original);

    // Verify original was stored
    const first = await vault.getAnnotation("my-secret");
    assertEquals(first!.url, "https://old.example.com");
    assertEquals(first!.notes, "Original note");

    const updated = VaultAnnotation.create({
      url: "https://new.example.com",
      notes: "Updated note",
      labels: { env: "prod", region: "us-east-1" },
    });
    await vault.putAnnotation("my-secret", updated);

    // Verify overwrite took effect
    const second = await vault.getAnnotation("my-secret");
    assertEquals(second!.url, "https://new.example.com");
    assertEquals(second!.notes, "Updated note");
    assertEquals(second!.labels, { env: "prod", region: "us-east-1" });
  });
});
