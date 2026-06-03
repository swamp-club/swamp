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

import { assertEquals, assertThrows } from "@std/assert";
import {
  createNamespace,
  formatNamespacedModelName,
  isEmptyNamespace,
  parseNamespacedModelName,
  SOLO_NAMESPACE,
} from "./namespace.ts";

// --- createNamespace validation ---

Deno.test("createNamespace: accepts valid lowercase slug", () => {
  assertEquals(createNamespace("infra") as string, "infra");
});

Deno.test("createNamespace: accepts slug with digits", () => {
  assertEquals(createNamespace("team42") as string, "team42");
});

Deno.test("createNamespace: accepts slug with hyphens", () => {
  assertEquals(createNamespace("security-prod") as string, "security-prod");
});

Deno.test("createNamespace: accepts slug starting with digit", () => {
  assertEquals(createNamespace("1team") as string, "1team");
});

Deno.test("createNamespace: accepts single character", () => {
  assertEquals(createNamespace("a") as string, "a");
});

Deno.test("createNamespace: accepts maximum length (64 chars)", () => {
  const slug = "a".repeat(64);
  assertEquals(createNamespace(slug) as string, slug);
});

Deno.test("createNamespace: throws on empty string", () => {
  assertThrows(
    () => createNamespace(""),
    Error,
    "Namespace cannot be empty",
  );
});

Deno.test("createNamespace: throws on exceeding max length", () => {
  assertThrows(
    () => createNamespace("a".repeat(65)),
    Error,
    "Namespace must be at most 64 characters",
  );
});

Deno.test("createNamespace: throws on uppercase letters", () => {
  assertThrows(
    () => createNamespace("Infra"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on underscores", () => {
  assertThrows(
    () => createNamespace("my_ns"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on dots", () => {
  assertThrows(
    () => createNamespace("my.ns"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on spaces", () => {
  assertThrows(
    () => createNamespace("my ns"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on leading hyphen", () => {
  assertThrows(
    () => createNamespace("-infra"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on trailing hyphen", () => {
  assertThrows(
    () => createNamespace("infra-"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on consecutive hyphens at end", () => {
  assertThrows(
    () => createNamespace("team--"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on slash", () => {
  assertThrows(
    () => createNamespace("a/b"),
    Error,
    "Namespace must match",
  );
});

Deno.test("createNamespace: throws on colon", () => {
  assertThrows(
    () => createNamespace("a:b"),
    Error,
    "Namespace must match",
  );
});

// --- SOLO_NAMESPACE ---

Deno.test("SOLO_NAMESPACE: is empty string", () => {
  assertEquals(SOLO_NAMESPACE as string, "");
});

Deno.test("SOLO_NAMESPACE: isEmptyNamespace returns true", () => {
  assertEquals(isEmptyNamespace(SOLO_NAMESPACE), true);
});

// --- isEmptyNamespace ---

Deno.test("isEmptyNamespace: returns false for non-empty namespace", () => {
  assertEquals(isEmptyNamespace(createNamespace("infra")), false);
});

// --- Equality ---

Deno.test("createNamespace: equal slugs produce identical values", () => {
  const a = createNamespace("infra");
  const b = createNamespace("infra");
  assertEquals(a === b, true);
});

Deno.test("createNamespace: different slugs are not equal", () => {
  const a = createNamespace("infra");
  const b = createNamespace("security");
  assertEquals(a === b, false);
});

// --- parseNamespacedModelName ---

Deno.test("parseNamespacedModelName: returns undefined namespace when no colon", () => {
  const result = parseNamespacedModelName("scanner");
  assertEquals(result, { namespace: undefined, modelName: "scanner" });
});

Deno.test("parseNamespacedModelName: splits on first colon", () => {
  const result = parseNamespacedModelName("security:scanner");
  assertEquals(result, { namespace: "security", modelName: "scanner" });
});

Deno.test("parseNamespacedModelName: handles wildcard namespace", () => {
  const result = parseNamespacedModelName("*:scanner");
  assertEquals(result, { namespace: "*", modelName: "scanner" });
});

Deno.test("parseNamespacedModelName: multiple colons — first colon wins", () => {
  const result = parseNamespacedModelName("a:b:c");
  assertEquals(result, { namespace: "a", modelName: "b:c" });
});

Deno.test("parseNamespacedModelName: empty prefix treated as no namespace", () => {
  const result = parseNamespacedModelName(":model");
  assertEquals(result, { namespace: undefined, modelName: "model" });
});

Deno.test("parseNamespacedModelName: throws on empty model name", () => {
  assertThrows(
    () => parseNamespacedModelName("ns:"),
    Error,
    "model name is empty",
  );
});

Deno.test("parseNamespacedModelName: throws on empty input", () => {
  assertThrows(
    () => parseNamespacedModelName(""),
    Error,
    "input is empty",
  );
});

Deno.test("parseNamespacedModelName: handles model name with slashes", () => {
  const result = parseNamespacedModelName("infra:@swamp/echo");
  assertEquals(result, { namespace: "infra", modelName: "@swamp/echo" });
});

Deno.test("parseNamespacedModelName: plain model name with no special chars", () => {
  const result = parseNamespacedModelName("my-model");
  assertEquals(result, { namespace: undefined, modelName: "my-model" });
});

// --- formatNamespacedModelName ---

Deno.test("formatNamespacedModelName: returns bare name when namespace undefined", () => {
  assertEquals(formatNamespacedModelName(undefined, "scanner"), "scanner");
});

Deno.test("formatNamespacedModelName: returns bare name when namespace empty", () => {
  assertEquals(formatNamespacedModelName("", "scanner"), "scanner");
});

Deno.test("formatNamespacedModelName: prefixes namespace with colon", () => {
  assertEquals(
    formatNamespacedModelName("security", "scanner"),
    "security:scanner",
  );
});

Deno.test("formatNamespacedModelName: round-trips with parseNamespacedModelName", () => {
  const formatted = formatNamespacedModelName("infra", "@swamp/echo");
  const parsed = parseNamespacedModelName(formatted);
  assertEquals(parsed, { namespace: "infra", modelName: "@swamp/echo" });
});
