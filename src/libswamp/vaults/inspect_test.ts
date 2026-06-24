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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { VaultAnnotationData } from "../../domain/vaults/vault_annotation.ts";
import {
  vaultInspect,
  type VaultInspectDeps,
  type VaultInspectEvent,
} from "./inspect.ts";

function makeDeps(
  overrides: Partial<VaultInspectDeps> = {},
): VaultInspectDeps {
  return {
    findVault: () =>
      Promise.resolve({ id: "v1", name: "my-vault", type: "env" }),
    listVaultNames: () => Promise.resolve(["my-vault"]),
    secretExists: () => Promise.resolve(true),
    measureSecretSize: () => Promise.resolve({ bytes: 11, chars: 11 }),
    supportsAnnotations: () => Promise.resolve(true),
    getAnnotation: () => Promise.resolve(null),
    supportsRefreshHooks: () => Promise.resolve(false),
    getRefreshHook: () => Promise.resolve(null),
    ...overrides,
  };
}

Deno.test("vaultInspect: yields not_found when vault does not exist", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve(["other-vault"]),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "missing", "SECRET"),
  );

  const last = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
  assertStringIncludes(last.error.message, "other-vault");
});

Deno.test("vaultInspect: yields validation_failed when secret does not exist", async () => {
  const deps = makeDeps({
    secretExists: () => Promise.resolve(false),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "MISSING_KEY"),
  );

  const last = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "MISSING_KEY");
  assertStringIncludes(last.error.message, "does not exist");
});

Deno.test("vaultInspect: degrades gracefully when annotations not supported", async () => {
  const deps = makeDeps({
    supportsAnnotations: () => Promise.resolve(false),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "API_KEY"),
  );

  const completed = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.supportsAnnotations, false);
  assertEquals(completed.data.hasAnnotation, false);
  assertEquals(completed.data.annotation, null);
  assertEquals(completed.data.sizeBytes, 11);
  assertEquals(completed.data.sizeChars, 11);
  assertEquals(completed.data.valueType, "string");
});

Deno.test("vaultInspect: degrades gracefully when neither annotations nor refresh hooks supported", async () => {
  const deps = makeDeps({
    supportsAnnotations: () => Promise.resolve(false),
    supportsRefreshHooks: () => Promise.resolve(false),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "API_KEY"),
  );

  const completed = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.supportsAnnotations, false);
  assertEquals(completed.data.annotation, null);
  assertEquals(completed.data.supportsRefreshHooks, false);
  assertEquals(completed.data.refreshHook, null);
  assertEquals(completed.data.sizeBytes, 11);
  assertEquals(completed.data.sizeChars, 11);
});

Deno.test("vaultInspect: yields completed with annotation data", async () => {
  const annotationData: VaultAnnotationData = {
    url: "https://console.aws.amazon.com",
    notes: "Production API key",
    labels: { env: "prod", region: "us-east-1" },
    updatedAt: "2026-01-15T10:30:00.000Z",
  };

  const deps = makeDeps({
    getAnnotation: () => Promise.resolve(annotationData),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "API_KEY"),
  );

  assertEquals(events[0].kind, "resolving");
  const completed = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.vaultType, "env");
  assertEquals(completed.data.supportsAnnotations, true);
  assertEquals(completed.data.hasAnnotation, true);
  assertEquals(completed.data.annotation, annotationData);
  assertEquals(completed.data.sizeBytes, 11);
  assertEquals(completed.data.sizeChars, 11);
  assertEquals(completed.data.valueType, "string");
});

Deno.test("vaultInspect: yields completed with no annotation", async () => {
  const deps = makeDeps({
    getAnnotation: () => Promise.resolve(null),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "API_KEY"),
  );

  assertEquals(events[0].kind, "resolving");
  const completed = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.vaultType, "env");
  assertEquals(completed.data.supportsAnnotations, true);
  assertEquals(completed.data.hasAnnotation, false);
  assertEquals(completed.data.annotation, null);
});

Deno.test("vaultInspect: measures secret size correctly", async () => {
  const deps = makeDeps({
    measureSecretSize: () => Promise.resolve({ bytes: 42, chars: 38 }),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "API_KEY"),
  );

  const completed = events[events.length - 1] as Extract<
    VaultInspectEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.sizeBytes, 42);
  assertEquals(completed.data.sizeChars, 38);
  assertEquals(completed.data.valueType, "string");
});

Deno.test("vaultInspect: output never contains the secret value", async () => {
  const secretValue = "super-secret-api-key-12345";
  const deps = makeDeps({
    measureSecretSize: () =>
      Promise.resolve({
        bytes: new TextEncoder().encode(secretValue).byteLength,
        chars: secretValue.length,
      }),
  });

  const events = await collect<VaultInspectEvent>(
    vaultInspect(createLibSwampContext(), deps, "my-vault", "API_KEY"),
  );

  const serialized = JSON.stringify(events);
  assertEquals(serialized.includes(secretValue), false);
});
