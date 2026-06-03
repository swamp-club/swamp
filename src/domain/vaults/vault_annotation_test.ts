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

import { assertEquals } from "@std/assert";
import {
  isVaultAnnotationProvider,
  VaultAnnotation,
} from "./vault_annotation.ts";

Deno.test("VaultAnnotation.create: sets fields and defaults", () => {
  const a = VaultAnnotation.create({
    url: "https://example.com",
    notes: "test note",
    labels: { env: "prod" },
  });
  assertEquals(a.url, "https://example.com");
  assertEquals(a.notes, "test note");
  assertEquals(a.labels, { env: "prod" });
});

Deno.test("VaultAnnotation.create: defaults labels to empty", () => {
  const a = VaultAnnotation.create({ url: "https://example.com" });
  assertEquals(a.labels, {});
  assertEquals(a.notes, undefined);
});

Deno.test("VaultAnnotation.toData: round-trips through fromData", () => {
  const original = VaultAnnotation.create({
    url: "https://example.com",
    notes: "a note",
    labels: { team: "infra", env: "staging" },
  });
  const data = original.toData();
  const restored = VaultAnnotation.fromData(data);
  assertEquals(restored.url, original.url);
  assertEquals(restored.notes, original.notes);
  assertEquals(restored.labels, original.labels);
});

Deno.test("VaultAnnotation.toData: omits undefined fields", () => {
  const a = VaultAnnotation.create({});
  const data = a.toData();
  assertEquals(data.url, undefined);
  assertEquals(data.notes, undefined);
  assertEquals(data.labels, undefined);
  assertEquals(typeof data.updatedAt, "string");
});

Deno.test("VaultAnnotation.merge: updates specified fields only", () => {
  const original = VaultAnnotation.create({
    url: "https://old.com",
    notes: "original note",
    labels: { env: "prod" },
  });
  const merged = original.merge({ url: "https://new.com" });
  assertEquals(merged.url, "https://new.com");
  assertEquals(merged.notes, "original note");
  assertEquals(merged.labels, { env: "prod" });
});

Deno.test("VaultAnnotation.merge: merges labels additively", () => {
  const original = VaultAnnotation.create({
    labels: { env: "prod", team: "infra" },
  });
  const merged = original.merge({ labels: { team: "platform", region: "us" } });
  assertEquals(merged.labels, {
    env: "prod",
    team: "platform",
    region: "us",
  });
});

Deno.test("VaultAnnotation.removeLabels: removes specified keys", () => {
  const original = VaultAnnotation.create({
    url: "https://example.com",
    labels: { env: "prod", team: "infra", region: "us" },
  });
  const result = original.removeLabels(["team", "region"]);
  assertEquals(result.url, "https://example.com");
  assertEquals(result.labels, { env: "prod" });
});

Deno.test("VaultAnnotation.removeLabels: ignores nonexistent keys", () => {
  const original = VaultAnnotation.create({
    labels: { env: "prod" },
  });
  const result = original.removeLabels(["missing"]);
  assertEquals(result.labels, { env: "prod" });
});

Deno.test("VaultAnnotation.removeLabels: removing all keys leaves empty labels", () => {
  const original = VaultAnnotation.create({
    labels: { env: "prod" },
  });
  const result = original.removeLabels(["env"]);
  assertEquals(result.labels, {});
});

Deno.test("VaultAnnotation.isEmpty: true when no fields set", () => {
  const a = VaultAnnotation.create({});
  assertEquals(a.isEmpty(), true);
});

Deno.test("VaultAnnotation.isEmpty: false when url set", () => {
  const a = VaultAnnotation.create({ url: "https://example.com" });
  assertEquals(a.isEmpty(), false);
});

Deno.test("VaultAnnotation.equals: true for same content", () => {
  const a = VaultAnnotation.create({
    url: "https://example.com",
    labels: { a: "1", b: "2" },
  });
  const b = VaultAnnotation.create({
    url: "https://example.com",
    labels: { b: "2", a: "1" },
  });
  assertEquals(a.equals(b), true);
});

Deno.test("VaultAnnotation.equals: false for different content", () => {
  const a = VaultAnnotation.create({ url: "https://a.com" });
  const b = VaultAnnotation.create({ url: "https://b.com" });
  assertEquals(a.equals(b), false);
});

Deno.test("VaultAnnotation.labels: is frozen", () => {
  const a = VaultAnnotation.create({ labels: { env: "prod" } });
  assertEquals(Object.isFrozen(a.labels), true);
});

Deno.test("isVaultAnnotationProvider: true for valid provider", () => {
  const provider = {
    getAnnotation: () => Promise.resolve(null),
    putAnnotation: () => Promise.resolve(),
    deleteAnnotation: () => Promise.resolve(),
    listAnnotations: () => Promise.resolve(new Map()),
  };
  assertEquals(isVaultAnnotationProvider(provider), true);
});

Deno.test("isVaultAnnotationProvider: false for plain VaultProvider", () => {
  const provider = {
    get: () => Promise.resolve("secret"),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    getName: () => "test",
  };
  assertEquals(isVaultAnnotationProvider(provider), false);
});

Deno.test("isVaultAnnotationProvider: false for null", () => {
  assertEquals(isVaultAnnotationProvider(null), false);
});
