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

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertVaultAnnotationConformance,
  assertVaultAnnotationExportConformance,
  assertVaultConformance,
  assertVaultExportConformance,
} from "./vault_conformance.ts";
import { createVaultTestContext } from "./vault_test_context.ts";
import { VaultAnnotation } from "./vault_types.ts";

// --- assertVaultExportConformance ---

Deno.test("assertVaultExportConformance: passes for valid export", () => {
  const { vault } = createVaultTestContext();
  const validExport = {
    type: "@test/my-vault",
    name: "Test Vault",
    description: "A test vault provider",
    configSchema: {
      safeParse: (v: unknown) => {
        const obj = v as Record<string, unknown>;
        return {
          success: typeof obj?.region === "string" && obj.region !== "",
        };
      },
    },
    createProvider: (_name: string, _config: Record<string, unknown>) => vault,
  };

  assertVaultExportConformance(validExport, {
    validConfigs: [{ region: "us-east-1" }],
    invalidConfigs: [{}, { region: "" }],
  });
});

Deno.test("assertVaultExportConformance: fails for bad type pattern", () => {
  const { vault } = createVaultTestContext();
  const badExport = {
    type: "INVALID",
    name: "Test",
    description: "Test",
    configSchema: { safeParse: () => ({ success: true }) },
    createProvider: () => vault,
  };

  assertThrows(
    () =>
      assertVaultExportConformance(
        badExport as Parameters<typeof assertVaultExportConformance>[0],
        { validConfigs: [{}] },
      ),
    Error,
    "must match pattern",
  );
});

Deno.test("assertVaultExportConformance: fails when valid config is rejected", () => {
  const { vault } = createVaultTestContext();
  const badExport = {
    type: "@test/vault",
    name: "Test",
    description: "Test",
    configSchema: { safeParse: () => ({ success: false }) },
    createProvider: () => vault,
  };

  assertThrows(
    () =>
      assertVaultExportConformance(
        badExport as Parameters<typeof assertVaultExportConformance>[0],
        { validConfigs: [{ region: "us-east-1" }] },
      ),
    Error,
    "should accept",
  );
});

Deno.test("assertVaultExportConformance: fails when invalid config is accepted", () => {
  const { vault } = createVaultTestContext();
  const badExport = {
    type: "@test/vault",
    name: "Test",
    description: "Test",
    configSchema: { safeParse: () => ({ success: true }) },
    createProvider: () => vault,
  };

  assertThrows(
    () =>
      assertVaultExportConformance(
        badExport as Parameters<typeof assertVaultExportConformance>[0],
        { validConfigs: [{}], invalidConfigs: [{ bad: true }] },
      ),
    Error,
    "should reject",
  );
});

// --- assertVaultConformance ---

Deno.test("assertVaultConformance: passes for conforming in-memory vault", async () => {
  const { vault } = createVaultTestContext();
  await assertVaultConformance(vault, { cleanup: false });
});

Deno.test("assertVaultConformance: passes with pre-seeded vault", async () => {
  const { vault } = createVaultTestContext({
    secrets: { "existing-key": "existing-value" },
  });
  await assertVaultConformance(vault, { cleanup: false });
});

Deno.test("assertVaultConformance: detects broken get (returns wrong value)", async () => {
  // A vault that always returns the same value regardless of key
  const brokenVault = {
    get: () => Promise.resolve("always-this"),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    getName: () => "broken",
  };

  try {
    await assertVaultConformance(brokenVault, { cleanup: false });
    throw new Error("Should have thrown");
  } catch (e) {
    // Expected — the put/get roundtrip check will fail because
    // list() doesn't include the stored keys
    if (e instanceof Error && e.message === "Should have thrown") {
      throw e;
    }
  }
});

// --- assertVaultAnnotationExportConformance ---

Deno.test("assertVaultAnnotationExportConformance: passes for valid export", () => {
  const { vault, annotationProvider } = createVaultTestContext({
    withAnnotations: true,
  });
  const combined = { ...vault, ...annotationProvider! };
  const validExport = {
    type: "@test/my-vault",
    name: "Test Vault",
    description: "A test vault provider with annotations",
    configSchema: {
      safeParse: (v: unknown) => {
        const obj = v as Record<string, unknown>;
        return {
          success: typeof obj?.region === "string" && obj.region !== "",
        };
      },
    },
    createProvider: (
      _name: string,
      _config: Record<string, unknown>,
    ) => combined,
  };

  assertVaultAnnotationExportConformance(validExport, {
    validConfigs: [{ region: "us-east-1" }],
  });
});

Deno.test("assertVaultAnnotationExportConformance: fails when annotation methods missing", () => {
  const { vault } = createVaultTestContext();
  const noAnnotations = {
    type: "@test/vault",
    name: "Test",
    description: "Test",
    configSchema: { safeParse: () => ({ success: true }) },
    createProvider: () => vault as ReturnType<typeof Object>,
  };

  assertThrows(
    () =>
      assertVaultAnnotationExportConformance(
        noAnnotations as Parameters<
          typeof assertVaultAnnotationExportConformance
        >[0],
        { validConfigs: [{}] },
      ),
    Error,
    "getAnnotation",
  );
});

// --- assertVaultAnnotationConformance ---

Deno.test("assertVaultAnnotationConformance: passes for conforming in-memory provider", async () => {
  const { annotationProvider } = createVaultTestContext({
    withAnnotations: true,
  });
  await assertVaultAnnotationConformance(annotationProvider!, {
    cleanup: false,
  });
});

Deno.test("assertVaultAnnotationConformance: detects broken getAnnotation (never returns null)", async () => {
  const fallbackAnnotation = VaultAnnotation.create({ notes: "fallback" });
  const brokenProvider = {
    getAnnotation: () => Promise.resolve(fallbackAnnotation),
    putAnnotation: () => Promise.resolve(),
    deleteAnnotation: () => Promise.resolve(),
    listAnnotations: () => Promise.resolve(new Map()),
  };

  try {
    await assertVaultAnnotationConformance(brokenProvider, { cleanup: false });
    throw new Error("Should have thrown");
  } catch (e) {
    if (e instanceof Error && e.message === "Should have thrown") {
      throw e;
    }
    // Expected — getAnnotation should return null for unannotated key
    // but this broken provider always returns a non-null value, which
    // will fail the "must return null" assertion
  }
});

Deno.test("assertVaultAnnotationConformance: detects broken deleteAnnotation (no-op)", async () => {
  const annotations = new Map<string, VaultAnnotation>();
  const brokenProvider = {
    getAnnotation: (key: string) =>
      Promise.resolve(annotations.get(key) ?? null),
    putAnnotation: (key: string, ann: VaultAnnotation) => {
      annotations.set(key, ann);
      return Promise.resolve();
    },
    // deleteAnnotation is a no-op — doesn't actually delete
    deleteAnnotation: () => Promise.resolve(),
    listAnnotations: () => Promise.resolve(new Map(annotations)),
  };

  try {
    await assertVaultAnnotationConformance(brokenProvider, { cleanup: false });
    throw new Error("Should have thrown");
  } catch (e) {
    if (e instanceof Error && e.message === "Should have thrown") {
      throw e;
    }
  }
});

Deno.test("assertVaultAnnotationConformance: VaultAnnotation value object behavior", () => {
  // Verify the VaultAnnotation class works correctly in isolation
  const ann = VaultAnnotation.create({
    url: "https://example.com",
    notes: "test",
    labels: { env: "dev" },
  });

  assertEquals(ann.url, "https://example.com");
  assertEquals(ann.notes, "test");
  assertEquals(ann.labels["env"], "dev");
  assertEquals(ann.isEmpty(), false);

  // toData/fromData roundtrip
  const data = ann.toData();
  const restored = VaultAnnotation.fromData(data);
  assertEquals(restored.url, ann.url);
  assertEquals(restored.notes, ann.notes);
  assertEquals(restored.labels["env"], ann.labels["env"]);

  // merge preserves existing, adds new
  const merged = ann.merge({ labels: { region: "us-east-1" } });
  assertEquals(merged.labels["env"], "dev");
  assertEquals(merged.labels["region"], "us-east-1");

  // empty annotation
  const empty = VaultAnnotation.create({});
  assertEquals(empty.isEmpty(), true);
});
