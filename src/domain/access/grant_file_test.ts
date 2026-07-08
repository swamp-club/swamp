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
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { collectErrors, parseGrantFile, readGrantFiles } from "./grant_file.ts";

Deno.test("parseGrantFile: parses valid grant file", () => {
  const content = `
grants:
  - subject: "idp-group:platform-eng"
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
`;
  const result = parseGrantFile("platform-team.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].subject, {
    kind: "idp-group",
    name: "platform-eng",
  });
  assertEquals(result.entries[0].effect, "allow");
  assertEquals(result.entries[0].actions, ["run"]);
  assertEquals(result.entries[0].resource, {
    kind: "workflow",
    pattern: "@acme/*",
  });
});

Deno.test("parseGrantFile: parses multiple entries", () => {
  const content = `
grants:
  - subject: "idp-group:developers"
    effect: allow
    actions: [read]
    resource: "data:*"
  - subject: "idp-group:developers"
    effect: deny
    actions: [read]
    resource: "data:@acme/secrets-*"
`;
  const result = parseGrantFile("compliance.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 2);
  assertEquals(result.entries[0].effect, "allow");
  assertEquals(result.entries[1].effect, "deny");
});

Deno.test("parseGrantFile: parses entry with condition", () => {
  const content = `
grants:
  - subject: "idp-group:platform-eng"
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
    condition: 'tags.env == "staging"'
`;
  const result = parseGrantFile("staging.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].condition, 'tags.env == "staging"');
});

Deno.test("parseGrantFile: rejects invalid YAML syntax", () => {
  const content = `grants:\n  - subject: [invalid yaml`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "Invalid YAML syntax");
});

Deno.test("parseGrantFile: rejects missing grants key", () => {
  const content = `rules:\n  - subject: "user:adam"`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
});

Deno.test("parseGrantFile: rejects empty grants array", () => {
  const content = `grants: []`;
  const result = parseGrantFile("empty.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
});

Deno.test("parseGrantFile: rejects invalid subject format", () => {
  const content = `
grants:
  - subject: "badformat"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "subject");
  assertEquals(result.errors[0].entryIndex, 0);
});

Deno.test("parseGrantFile: rejects invalid resource selector", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "badkind:*"
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "resource kind");
  assertEquals(result.errors[0].entryIndex, 0);
});

Deno.test("parseGrantFile: rejects invalid effect", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: maybe
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
});

Deno.test("parseGrantFile: rejects invalid action", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [destroy]
    resource: "workflow:*"
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
});

Deno.test("parseGrantFile: detects duplicate identity tuples", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("dups.yaml", content);
  assertEquals(result.entries.length, 1);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "Duplicate");
  assertEquals(result.errors[0].entryIndex, 1);
});

Deno.test("parseGrantFile: duplicate detection normalizes action order", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [read, run]
    resource: "workflow:*"
  - subject: "user:adam"
    effect: allow
    actions: [run, read]
    resource: "workflow:*"
`;
  const result = parseGrantFile("dups.yaml", content);
  assertEquals(result.entries.length, 1);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "Duplicate");
});

Deno.test("parseGrantFile: duplicate detection trims condition whitespace", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
    condition: 'tags.env == "prod"'
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
    condition: '  tags.env == "prod"  '
`;
  const result = parseGrantFile("dups.yaml", content);
  assertEquals(result.entries.length, 1);
  assertEquals(result.errors.length, 1);
});

Deno.test("parseGrantFile: different effects are not duplicates", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
  - subject: "user:adam"
    effect: deny
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("not-dups.yaml", content);
  assertEquals(result.entries.length, 2);
  assertEquals(result.errors.length, 0);
});

Deno.test("parseGrantFile: valid and invalid entries in same file", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:*"
  - subject: "badformat"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("mixed.yaml", content);
  assertEquals(result.entries.length, 1);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].entryIndex, 1);
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("readGrantFiles: reads .yaml and .yml files", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(
      join(grantsDir, "team.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.writeTextFile(
      join(grantsDir, "other.yml"),
      `grants:\n  - subject: "user:sarah"\n    effect: allow\n    actions: [read]\n    resource: "data:*"`,
    );

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 2);
    assertEquals(results.has("team.yaml"), true);
    assertEquals(results.has("other.yml"), true);
  });
});

Deno.test("readGrantFiles: ignores non-YAML files", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(
      join(grantsDir, "team.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.writeTextFile(join(grantsDir, "README.md"), "# Grants");
    await Deno.writeTextFile(join(grantsDir, ".gitkeep"), "");

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 1);
    assertEquals(results.has("team.yaml"), true);
  });
});

Deno.test("readGrantFiles: ignores subdirectories", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(join(grantsDir, "subdir"));
    await Deno.writeTextFile(
      join(grantsDir, "team.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.writeTextFile(
      join(grantsDir, "subdir", "nested.yaml"),
      `grants:\n  - subject: "user:sarah"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 1);
    assertEquals(results.has("team.yaml"), true);
  });
});

Deno.test("readGrantFiles: returns empty map when directory does not exist", async () => {
  const results = await readGrantFiles("/nonexistent/grants");
  assertEquals(results.size, 0);
});

Deno.test("readGrantFiles: returns empty map for empty directory", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 0);
  });
});

Deno.test("collectErrors: aggregates errors from all files", () => {
  const results = new Map([
    [
      "a.yaml",
      {
        entries: [],
        errors: [{ filename: "a.yaml", message: "err1" }],
      },
    ],
    [
      "b.yaml",
      {
        entries: [
          {
            subject: { kind: "user" as const, name: "x" },
            effect: "allow" as const,
            actions: ["run" as const],
            resource: { kind: "workflow" as const, pattern: "*" },
          },
        ],
        errors: [],
      },
    ],
    [
      "c.yaml",
      {
        entries: [],
        errors: [
          { filename: "c.yaml", entryIndex: 0, message: "err2" },
          { filename: "c.yaml", entryIndex: 1, message: "err3" },
        ],
      },
    ],
  ]);
  const errors = collectErrors(results);
  assertEquals(errors.length, 3);
});
