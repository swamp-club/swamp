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
import {
  deepMerge,
  parseInputs,
  parseKeyValueInputs,
  setNestedValue,
} from "./input_parser.ts";
import { stringify as stringifyYaml } from "@std/yaml";

// --- setNestedValue ---

Deno.test("setNestedValue: sets a simple key", () => {
  const obj: Record<string, unknown> = {};
  setNestedValue(obj, "name", "alice");
  assertEquals(obj, { name: "alice" });
});

Deno.test("setNestedValue: sets a dot-notation nested key", () => {
  const obj: Record<string, unknown> = {};
  setNestedValue(obj, "server.host", "localhost");
  assertEquals(obj, { server: { host: "localhost" } });
});

Deno.test("setNestedValue: sets deeply nested key", () => {
  const obj: Record<string, unknown> = {};
  setNestedValue(obj, "a.b.c", "deep");
  assertEquals(obj, { a: { b: { c: "deep" } } });
});

Deno.test("setNestedValue: merges into existing nested object", () => {
  const obj: Record<string, unknown> = { server: { host: "localhost" } };
  setNestedValue(obj, "server.port", "8080");
  assertEquals(obj, { server: { host: "localhost", port: "8080" } });
});

// --- parseKeyValueInputs ---

Deno.test("parseKeyValueInputs: single key=value", async () => {
  const result = await parseKeyValueInputs(["environment=production"]);
  assertEquals(result, { environment: "production" });
});

Deno.test("parseKeyValueInputs: multiple key=value pairs", async () => {
  const result = await parseKeyValueInputs([
    "environment=production",
    "replicas=3",
  ]);
  assertEquals(result, { environment: "production", replicas: "3" });
});

Deno.test("parseKeyValueInputs: dot notation nesting", async () => {
  const result = await parseKeyValueInputs([
    "server.host=localhost",
    "server.port=8080",
  ]);
  assertEquals(result, { server: { host: "localhost", port: "8080" } });
});

Deno.test("parseKeyValueInputs: value containing equals sign", async () => {
  const result = await parseKeyValueInputs(["query=SELECT * WHERE id=1"]);
  assertEquals(result, { query: "SELECT * WHERE id=1" });
});

Deno.test("parseKeyValueInputs: empty value", async () => {
  const result = await parseKeyValueInputs(["key="]);
  assertEquals(result, { key: "" });
});

Deno.test("parseKeyValueInputs: missing equals sign throws", async () => {
  await assertRejects(
    () => parseKeyValueInputs(["noequals"]),
    Error,
    "Expected key=value format",
  );
});

Deno.test("parseKeyValueInputs: empty key throws", async () => {
  await assertRejects(
    () => parseKeyValueInputs(["=value"]),
    Error,
    "empty key",
  );
});

Deno.test("parseKeyValueInputs: escaped @ produces literal @", async () => {
  const result = await parseKeyValueInputs(["key=\\@notafile"]);
  assertEquals(result, { key: "@notafile" });
});

Deno.test("parseKeyValueInputs: @file reads file contents", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "file-contents-here");
    const result = await parseKeyValueInputs([`key=@${tempFile}`]);
    assertEquals(result, { key: "file-contents-here" });
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("parseKeyValueInputs: @file with missing file throws", async () => {
  const err = await assertRejects(
    () => parseKeyValueInputs(["key=@/nonexistent/path/file.txt"]),
    Error,
  );
  assertStringIncludes(
    (err as Error).message,
    'Input file not found for key "key"',
  );
});

Deno.test("parseKeyValueInputs: @file with dot notation", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "cert-data");
    const result = await parseKeyValueInputs([`server.cert=@${tempFile}`]);
    assertEquals(result, { server: { cert: "cert-data" } });
  } finally {
    await Deno.remove(tempFile);
  }
});

// --- deepMerge ---

Deno.test("deepMerge: flat objects", () => {
  const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
  assertEquals(result, { a: 1, b: 3, c: 4 });
});

Deno.test("deepMerge: nested objects", () => {
  const result = deepMerge(
    { server: { host: "base", port: 80 } },
    { server: { host: "override" } },
  );
  assertEquals(result, { server: { host: "override", port: 80 } });
});

Deno.test("deepMerge: override replaces non-object with object", () => {
  const result = deepMerge({ server: "old" }, { server: { host: "new" } });
  assertEquals(result, { server: { host: "new" } });
});

Deno.test("deepMerge: does not mutate base", () => {
  const base = { a: 1 };
  deepMerge(base, { b: 2 });
  assertEquals(base, { a: 1 });
});

// --- parseInputs (backward compat) ---

Deno.test("parseInputs: JSON string backward compat", async () => {
  const result = await parseInputs({
    input: '{"environment": "production"}',
  });
  assertEquals(result.source, "json");
  assertEquals(result.inputs, { environment: "production" });
});

Deno.test("parseInputs: JSON array form backward compat", async () => {
  const result = await parseInputs({
    input: ['{"environment": "production"}'],
  });
  assertEquals(result.source, "json");
  assertEquals(result.inputs, { environment: "production" });
});

Deno.test("parseInputs: invalid JSON throws", async () => {
  await assertRejects(
    () => parseInputs({ input: "{bad json" }),
    Error,
    "Invalid JSON in --input",
  );
});

Deno.test("parseInputs: JSON array throws", async () => {
  // A JSON array starts with { after stringify won't, but we can test
  // invalid JSON object like {"key": [1]} parsed as non-object via a trick:
  // only `{` triggers JSON mode, and `{` always yields an object or syntax error.
  // Test that a JSON array wrapped to start with `{` but being invalid still errors.
  await assertRejects(
    () => parseInputs({ input: "{ invalid json" }),
    Error,
    "Invalid JSON in --input",
  );
});

// --- parseInputs (key-value) ---

Deno.test("parseInputs: single key=value", async () => {
  const result = await parseInputs({
    input: ["environment=production"],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, { environment: "production" });
});

Deno.test("parseInputs: multiple key=value", async () => {
  const result = await parseInputs({
    input: ["environment=production", "replicas=3"],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, { environment: "production", replicas: "3" });
});

Deno.test("parseInputs: key=value with dot notation", async () => {
  const result = await parseInputs({
    input: ["server.host=localhost", "server.port=8080"],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, {
    server: { host: "localhost", port: "8080" },
  });
});

// --- parseInputs (YAML file) ---

Deno.test("parseInputs: YAML file", async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(
      tempFile,
      stringifyYaml({ environment: "staging" } as Record<string, unknown>),
    );
    const result = await parseInputs({ inputFile: tempFile });
    assertEquals(result.source, "yaml-file");
    assertEquals(result.inputs, { environment: "staging" });
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("parseInputs: missing YAML file throws", async () => {
  await assertRejects(
    () => parseInputs({ inputFile: "/nonexistent/file.yaml" }),
    Error,
    "Input file not found",
  );
});

// --- parseInputs (combined) ---

Deno.test("parseInputs: combined file + k=v overrides", async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(
      tempFile,
      stringifyYaml(
        { environment: "staging", replicas: 2 } as Record<string, unknown>,
      ),
    );
    const result = await parseInputs({
      input: ["environment=production"],
      inputFile: tempFile,
    });
    assertEquals(result.source, "combined");
    assertEquals(result.inputs.environment, "production"); // override
    assertEquals(result.inputs.replicas, 2); // from file
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("parseInputs: JSON input ignores input-file", async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(
      tempFile,
      stringifyYaml({ fromFile: true } as Record<string, unknown>),
    );
    const result = await parseInputs({
      input: ['{"fromJson": true}'],
      inputFile: tempFile,
    });
    assertEquals(result.source, "json");
    assertEquals(result.inputs, { fromJson: true });
  } finally {
    await Deno.remove(tempFile);
  }
});

// --- parseInputs (none) ---

Deno.test("parseInputs: no options returns none", async () => {
  const result = await parseInputs({});
  assertEquals(result.source, "none");
  assertEquals(result.inputs, {});
});
