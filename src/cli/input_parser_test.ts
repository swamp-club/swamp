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
import { UserError } from "../domain/errors.ts";
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

// --- Stream-0 regression net: tilde expansion semantics on POSIX ---

Deno.test({
  name: "parseKeyValueInputs: ~/file expands using HOME env var on POSIX",
  // Tilde-to-HOME expansion is POSIX-specific; Windows uses USERPROFILE.
  // Stream C will add the Windows path; this test pins POSIX.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-tilde-home-" });
    const originalHome = Deno.env.get("HOME");
    try {
      // Write a file inside the temp dir and stash the value through
      // the @-file mechanism using "~/<basename>" so the production
      // tilde-expansion code (`startsWith("~/")` in resolveFileValue)
      // is exercised.
      const fileName = "tilde-test.txt";
      await Deno.writeTextFile(
        `${tempDir}/${fileName}`,
        "expanded-via-home",
      );
      Deno.env.set("HOME", tempDir);

      const result = await parseKeyValueInputs([`token=@~/${fileName}`]);
      assertEquals(result, { token: "expanded-via-home" });
    } finally {
      if (originalHome === undefined) {
        Deno.env.delete("HOME");
      } else {
        Deno.env.set("HOME", originalHome);
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "parseKeyValueInputs: ~/file is left literal when HOME is unset on POSIX",
  // Pin the existing fallback: resolveFileValue only expands ~ when
  // Deno.env.get("HOME") returns a value. With HOME unset, the literal
  // path "~/missing.txt" is passed straight to Deno.readTextFile, which
  // surfaces a "Input file not found" UserError. Stream C must preserve
  // this exact fallback (same error message, same un-expanded path).
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const originalHome = Deno.env.get("HOME");
    try {
      Deno.env.delete("HOME");
      let caught: Error | undefined;
      try {
        await parseKeyValueInputs(["token=@~/definitely-missing.txt"]);
      } catch (err) {
        caught = err as Error;
      }
      assertEquals(
        caught !== undefined,
        true,
        "expected UserError when HOME is unset and the literal path doesn't exist",
      );
      // The error message must reference the unexpanded path so a refactor
      // that silently expands via USERPROFILE on POSIX would fail.
      assertStringIncludes(
        (caught as Error).message,
        'Input file not found for key "token"',
      );
      assertStringIncludes(
        (caught as Error).message,
        "~/definitely-missing.txt",
      );
    } finally {
      if (originalHome !== undefined) {
        Deno.env.set("HOME", originalHome);
      }
    }
  },
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

// --- parseKeyValueInputs (:json suffix) — swamp-club#235 ---

Deno.test("parseKeyValueInputs: :json suffix parses an array", async () => {
  const result = await parseInputs({
    input: ['keywords:json=["typescript","retry"]'],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, { keywords: ["typescript", "retry"] });
});

Deno.test("parseKeyValueInputs: :json suffix parses an object", async () => {
  const result = await parseInputs({
    input: ['config:json={"port":8080,"host":"localhost"}'],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, {
    config: { port: 8080, host: "localhost" },
  });
});

Deno.test("parseKeyValueInputs: :json suffix on the leaf of a nested key", async () => {
  const result = await parseInputs({
    input: ['server.config:json={"port":8080}'],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, {
    server: { config: { port: 8080 } },
  });
});

Deno.test("parseKeyValueInputs: :json takes precedence over @file shorthand", async () => {
  // A `@`-prefixed value would normally be treated as a file path; the
  // :json suffix bypasses that and parses the literal as JSON. So
  // `key:json=@notafile.json` parses `@notafile.json` as JSON (which
  // fails) — verifying the suffix takes precedence.
  await assertRejects(
    () => parseInputs({ input: ["key:json=@notafile"] }),
    UserError,
    "Invalid JSON value for input",
  );
});

Deno.test("parseKeyValueInputs: no :json suffix preserves string behavior", async () => {
  const result = await parseInputs({
    input: ['raw=["this","is","a","string"]'],
  });
  assertEquals(result.source, "key-value");
  assertEquals(result.inputs, { raw: '["this","is","a","string"]' });
});

Deno.test("parseKeyValueInputs: :json parse failure raises UserError", async () => {
  await assertRejects(
    () => parseInputs({ input: ["bad:json={not json}"] }),
    UserError,
    "Invalid JSON value for input",
  );
});

Deno.test("parseKeyValueInputs: :json from CLI overrides --input-file value", async () => {
  // Confirms precedence: the YAML file sets keywords as a string list,
  // the CLI :json override replaces it with a parsed array. Existing
  // deepMerge semantics: CLI key-value wins over file.
  const tempFile = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(
      tempFile,
      stringifyYaml({ keywords: ["from-file"] } as Record<string, unknown>),
    );
    const result = await parseInputs({
      input: ['keywords:json=["from-cli"]'],
      inputFile: tempFile,
    });
    assertEquals(result.source, "combined");
    assertEquals(result.inputs, { keywords: ["from-cli"] });
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
