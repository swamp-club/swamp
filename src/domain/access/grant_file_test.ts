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
import { join, resolve, SEPARATOR } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  collectErrors,
  parseGrantFile,
  readGrantFiles,
  resolveExternalGrantsDir,
  resolveExternalGrantsFile,
} from "./grant_file.ts";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../../infrastructure/cel/grant_condition_environment.ts";

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

Deno.test("readGrantFiles: loads symlinked YAML files", async () => {
  await withTempDir(async (dir) => {
    const realDir = join(dir, "real");
    const grantsDir = join(dir, "grants");
    await ensureDir(realDir);
    await ensureDir(grantsDir);
    await Deno.writeTextFile(
      join(realDir, "team.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.symlink(
      join(realDir, "team.yaml"),
      join(grantsDir, "team.yaml"),
      { type: "file" },
    );

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 1);
    assertEquals(results.has("team.yaml"), true);
    assertEquals(results.get("team.yaml")!.entries.length, 1);
    assertEquals(results.get("team.yaml")!.errors.length, 0);
  });
});

Deno.test("readGrantFiles: ignores symlinks to non-YAML files", async () => {
  await withTempDir(async (dir) => {
    const realDir = join(dir, "real");
    const grantsDir = join(dir, "grants");
    await ensureDir(realDir);
    await ensureDir(grantsDir);
    await Deno.writeTextFile(join(realDir, "notes.txt"), "not a grant file");
    await Deno.symlink(
      join(realDir, "notes.txt"),
      join(grantsDir, "notes.txt"),
      { type: "file" },
    );

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 0);
  });
});

Deno.test("readGrantFiles: ignores symlinked directories", async () => {
  await withTempDir(async (dir) => {
    const realDir = join(dir, "real");
    const grantsDir = join(dir, "grants");
    await ensureDir(realDir);
    await ensureDir(grantsDir);
    await Deno.writeTextFile(
      join(grantsDir, "team.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.symlink(realDir, join(grantsDir, "subdir"), { type: "dir" });

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 1);
    assertEquals(results.has("team.yaml"), true);
  });
});

Deno.test("readGrantFiles: handles broken symlinks gracefully", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    await Deno.writeTextFile(
      join(grantsDir, "good.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.symlink(
      join(dir, "nonexistent.yaml"),
      join(grantsDir, "broken.yaml"),
      { type: "file" },
    );

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 2);
    assertEquals(results.get("good.yaml")!.entries.length, 1);
    assertEquals(results.get("good.yaml")!.errors.length, 0);
    assertEquals(results.get("broken.yaml")!.entries.length, 0);
    assertEquals(results.get("broken.yaml")!.errors.length, 1);
    assertStringIncludes(
      results.get("broken.yaml")!.errors[0].message,
      "Failed to read",
    );
  });
});

Deno.test("readGrantFiles: ignores dot-prefixed symlinks (K8s ConfigMap internals)", async () => {
  await withTempDir(async (dir) => {
    const realDir = join(dir, "..2024_01_01_120000");
    const grantsDir = join(dir, "grants");
    await ensureDir(realDir);
    await ensureDir(grantsDir);
    await Deno.writeTextFile(
      join(realDir, "team.yaml"),
      `grants:\n  - subject: "user:adam"\n    effect: allow\n    actions: [run]\n    resource: "workflow:*"`,
    );
    await Deno.symlink(realDir, join(grantsDir, "..data"), { type: "dir" });
    await Deno.symlink(
      join(realDir, "team.yaml"),
      join(grantsDir, "team.yaml"),
      { type: "file" },
    );

    const results = await readGrantFiles(grantsDir);
    assertEquals(results.size, 1);
    assertEquals(results.has("team.yaml"), true);
    assertEquals(results.has("..data"), false);
  });
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
        warnings: [],
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
        warnings: [],
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
        warnings: [],
      },
    ],
  ]);
  const errors = collectErrors(results);
  assertEquals(errors.length, 3);
});

Deno.test("parseGrantFile: parses grant with methods field", () => {
  const content = `
grants:
  - subject: "user:monitor"
    effect: allow
    actions: [run]
    resource: "model:@acme/my-model"
    methods: [read, list]
`;
  const result = parseGrantFile("monitor.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].methods, ["read", "list"]);
});

Deno.test("parseGrantFile: methods field is optional", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
`;
  const result = parseGrantFile("basic.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries[0].methods, undefined);
});

Deno.test("parseGrantFile: resources array expands to multiple entries", () => {
  const content = `
grants:
  - subject: "idp-group:my-team"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/create-thing"
      - "workflow:@acme/connect-thing"
`;
  const result = parseGrantFile("team.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 2);
  assertEquals(result.entries[0].resource, {
    kind: "workflow",
    pattern: "@acme/create-thing",
  });
  assertEquals(result.entries[1].resource, {
    kind: "workflow",
    pattern: "@acme/connect-thing",
  });
  assertEquals(result.entries[0].subject, result.entries[1].subject);
  assertEquals(result.entries[0].effect, result.entries[1].effect);
  assertEquals(result.entries[0].actions, result.entries[1].actions);
});

Deno.test("parseGrantFile: resources array with mixed resource kinds", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run, read]
    resources:
      - "workflow:@acme/deploy"
      - "model:@acme/build"
`;
  const result = parseGrantFile("mixed.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 2);
  assertEquals(result.entries[0].resource.kind, "workflow");
  assertEquals(result.entries[1].resource.kind, "model");
});

Deno.test("parseGrantFile: resources array preserves methods and condition", () => {
  const content = `
grants:
  - subject: "user:monitor"
    effect: allow
    actions: [run]
    resources:
      - "model:@acme/model-a"
      - "model:@acme/model-b"
    methods: [read, list]
`;
  const result = parseGrantFile("monitor.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 2);
  assertEquals(result.entries[0].methods, ["read", "list"]);
  assertEquals(result.entries[1].methods, ["read", "list"]);
});

Deno.test("parseGrantFile: rejects both resource and resources specified", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:@acme/*"
    resources:
      - "workflow:@acme/deploy"
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
  assertStringIncludes(result.errors[0].message, "resource");
});

Deno.test("parseGrantFile: rejects neither resource nor resources specified", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
  assertStringIncludes(result.errors[0].message, "resource");
});

Deno.test("parseGrantFile: rejects empty resources array", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resources: []
`;
  const result = parseGrantFile("bad.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length >= 1, true);
});

Deno.test("parseGrantFile: rejects duplicate resource strings within resources array", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/deploy"
      - "workflow:@acme/deploy"
`;
  const result = parseGrantFile("dups.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "Duplicate resource");
  assertEquals(result.errors[0].entryIndex, 0);
});

Deno.test("parseGrantFile: resources array with one invalid resource continues others", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/deploy"
      - "badkind:@acme/other"
`;
  const result = parseGrantFile("partial.yaml", content);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].resource, {
    kind: "workflow",
    pattern: "@acme/deploy",
  });
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "resource kind");
});

Deno.test("parseGrantFile: resources array detects cross-entry duplicates", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resource: "workflow:@acme/deploy"
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/deploy"
      - "workflow:@acme/build"
`;
  const result = parseGrantFile("cross-dup.yaml", content);
  assertEquals(result.entries.length, 2);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "Duplicate grant entry");
  assertEquals(result.entries[0].resource.pattern, "@acme/deploy");
  assertEquals(result.entries[1].resource.pattern, "@acme/build");
});

Deno.test("parseGrantFile: resources array with condition validated per resource kind", () => {
  const validForWorkflow = (
    _condition: string,
    kind: string,
  ): { valid: boolean; error?: string } => {
    if (kind === "workflow") return { valid: true };
    return { valid: false, error: `condition not valid for ${kind}` };
  };

  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/deploy"
      - "model:@acme/build"
    condition: 'tags.env == "prod"'
`;
  const result = parseGrantFile("cond.yaml", content, validForWorkflow);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].resource.kind, "workflow");
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "CEL condition invalid");
  assertStringIncludes(result.errors[0].message, "model:@acme/build");
});

Deno.test("parseGrantFile: single-element resources array works", () => {
  const content = `
grants:
  - subject: "user:adam"
    effect: allow
    actions: [run]
    resources:
      - "workflow:@acme/deploy"
`;
  const result = parseGrantFile("single.yaml", content);
  assertEquals(result.errors.length, 0);
  assertEquals(result.entries.length, 1);
  assertEquals(result.entries[0].resource, {
    kind: "workflow",
    pattern: "@acme/deploy",
  });
});

Deno.test("resolveExternalGrantsDir: returns undefined when no grants-dir is configured", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await resolveExternalGrantsDir(dir, undefined), undefined);
  });
});

Deno.test("resolveExternalGrantsDir: drops a grants-dir that is the repository grants directory", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);

    assertEquals(await resolveExternalGrantsDir(dir, grantsDir), undefined);
    assertEquals(
      await resolveExternalGrantsDir(dir, grantsDir + SEPARATOR),
      undefined,
    );
    assertEquals(
      await resolveExternalGrantsDir(dir, join(dir, "sub", "..", "grants")),
      undefined,
    );
    assertEquals(await resolveExternalGrantsDir(dir, "grants"), undefined);
  });
});

Deno.test("resolveExternalGrantsDir: drops a symlink to the repository grants directory", async () => {
  await withTempDir(async (dir) => {
    const grantsDir = join(dir, "grants");
    await ensureDir(grantsDir);
    const link = join(dir, "grants-link");
    await Deno.symlink(grantsDir, link, { type: "dir" });

    assertEquals(await resolveExternalGrantsDir(dir, link), undefined);
  });
});

Deno.test("resolveExternalGrantsDir: keeps a different directory, resolved to an absolute path", async () => {
  await withTempDir(async (dir) => {
    const otherDir = join(dir, "other");
    await ensureDir(join(dir, "grants"));
    await ensureDir(otherDir);

    assertEquals(await resolveExternalGrantsDir(dir, otherDir), otherDir);
  });
});

Deno.test("resolveExternalGrantsDir: resolves a relative grants-dir against the repository, not the working directory", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(join(repoDir, "extra-grants"));

    assertEquals(
      await resolveExternalGrantsDir(repoDir, "extra-grants"),
      join(repoDir, "extra-grants"),
    );
    assertEquals(
      await resolveExternalGrantsDir(repoDir, join("..", "shared")),
      join(dir, "shared"),
    );
  });
});

Deno.test("resolveExternalGrantsDir: keeps grants-dir when the repository has no grants directory", async () => {
  await withTempDir(async (dir) => {
    const otherDir = join(dir, "other");
    await ensureDir(otherDir);

    assertEquals(await resolveExternalGrantsDir(dir, otherDir), otherDir);
  });
});

// An absolute base that is never the working directory.
const REPO_DIR = resolve(SEPARATOR, "srv", "repo");

Deno.test("resolveExternalGrantsFile: returns undefined when no grants-file is configured", () => {
  assertEquals(resolveExternalGrantsFile(REPO_DIR, undefined), undefined);
  assertEquals(resolveExternalGrantsFile(REPO_DIR, ""), undefined);
});

Deno.test("resolveExternalGrantsFile: resolves a relative grants-file against the repository, not the working directory", () => {
  assertEquals(
    resolveExternalGrantsFile(REPO_DIR, "team.yaml"),
    join(REPO_DIR, "team.yaml"),
  );
  assertEquals(
    resolveExternalGrantsFile(REPO_DIR, join("..", "team.yaml")),
    resolve(SEPARATOR, "srv", "team.yaml"),
  );
});

Deno.test("resolveExternalGrantsFile: keeps an absolute grants-file unchanged", () => {
  const file = resolve(SEPARATOR, "etc", "swamp", "team.yaml");

  assertEquals(resolveExternalGrantsFile(REPO_DIR, file), file);
});

Deno.test("parseGrantFile: subjects array expands to one entry per subject", () => {
  const content = `
grants:
  - subjects:
      - "user:alice"
      - "user:bob"
      - "group:ops"
    effect: allow
    actions: [read, write, run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("team.yaml", content);
  assertEquals(result.errors, []);
  assertEquals(result.entries.map((e) => e.subject), [
    { kind: "user", name: "alice" },
    { kind: "user", name: "bob" },
    { kind: "group", name: "ops" },
  ]);
  for (const entry of result.entries) {
    assertEquals(entry.effect, "allow");
    assertEquals(entry.actions, ["read", "write", "run"]);
    assertEquals(entry.resource, { kind: "workflow", pattern: "*" });
  }
});

Deno.test("parseGrantFile: subjects and resources expand to every pair", () => {
  const content = `
grants:
  - subjects: ["user:alice", "user:bob"]
    effect: allow
    actions: [run]
    resources: ["workflow:*", "model:*"]
    condition: 'resource.tags.env == "staging"'
    methods: [read]
`;
  const result = parseGrantFile("pairs.yaml", content);
  assertEquals(result.errors, []);
  assertEquals(
    result.entries.map((e) =>
      `${e.subject.name} ${e.resource.kind}:${e.resource.pattern}`
    ),
    [
      "alice workflow:*",
      "bob workflow:*",
      "alice model:*",
      "bob model:*",
    ],
  );
  for (const entry of result.entries) {
    assertEquals(entry.condition, 'resource.tags.env == "staging"');
    assertEquals(entry.methods, ["read"]);
  }
});

Deno.test("parseGrantFile: single-element subjects array equals the subject form", () => {
  const withSubject = parseGrantFile(
    "a.yaml",
    `
grants:
  - subject: "user:alice"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`,
  );
  const withSubjects = parseGrantFile(
    "a.yaml",
    `
grants:
  - subjects: ["user:alice"]
    effect: allow
    actions: [run]
    resource: "workflow:*"
`,
  );
  assertEquals(withSubjects, withSubject);
});

Deno.test("parseGrantFile: rejects both subject and subjects specified", () => {
  const content = `
grants:
  - subject: "user:alice"
    subjects: ["user:bob"]
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("both.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(
    result.errors[0].message,
    "Cannot specify both 'subject' and 'subjects'",
  );
});

Deno.test("parseGrantFile: rejects neither subject nor subjects specified", () => {
  const content = `
grants:
  - effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("neither.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(
    result.errors[0].message,
    "Must specify either 'subject' (single) or 'subjects' (array)",
  );
});

Deno.test("parseGrantFile: reports a missing subject and a missing resource together", () => {
  const content = `
grants:
  - effect: allow
    actions: [run]
`;
  const result = parseGrantFile("bare.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 2);
  assertStringIncludes(result.errors[0].message, "'subject' (single)");
  assertStringIncludes(result.errors[1].message, "'resource' (single)");
});

Deno.test("parseGrantFile: rejects empty subjects array", () => {
  const content = `
grants:
  - subjects: []
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("empty.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "grants.0.subjects");
});

Deno.test("parseGrantFile: accepts 100 subjects and rejects 101", () => {
  const fileWith = (count: number) => {
    const subjects = Array.from(
      { length: count },
      (_, n) => `      - "user:u${n}"`,
    ).join("\n");
    return `
grants:
  - subjects:
${subjects}
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  };

  const atCap = parseGrantFile("cap.yaml", fileWith(100));
  assertEquals(atCap.errors, []);
  assertEquals(atCap.entries.length, 100);

  const overCap = parseGrantFile("cap.yaml", fileWith(101));
  assertEquals(overCap.entries.length, 0);
  assertEquals(overCap.errors.length, 1);
  assertStringIncludes(overCap.errors[0].message, "grants.0.subjects");
});

Deno.test("parseGrantFile: rejects duplicate subject strings within subjects array", () => {
  const content = `
grants:
  - subjects: ["user:alice", "user:bob", "user:alice"]
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("dup.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors, [{
    filename: "dup.yaml",
    entryIndex: 0,
    message: 'Duplicate subject in subjects array: "user:alice"',
  }]);
});

Deno.test("parseGrantFile: subjects array with invalid subjects continues others", () => {
  const content = `
grants:
  - subjects:
      - "user:alice"
      - "badkind:bob"
      - "nocolon"
      - "service:not-a-real-service"
      - "group:ops"
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("partial.yaml", content);
  assertEquals(result.entries.map((e) => e.subject), [
    { kind: "user", name: "alice" },
    { kind: "group", name: "ops" },
  ]);
  assertEquals(result.errors.length, 3);
  assertStringIncludes(result.errors[0].message, '"badkind"');
  assertStringIncludes(result.errors[1].message, '"nocolon"');
  assertStringIncludes(
    result.errors[2].message,
    '"service:not-a-real-service"',
  );
  for (const error of result.errors) assertEquals(error.entryIndex, 0);
});

Deno.test("parseGrantFile: invalid singular subject skips the entry's resource errors", () => {
  const content = `
grants:
  - subject: "badkind:alice"
    effect: allow
    actions: [run]
    resources: ["badkind:x", "workflow:*"]
`;
  const result = parseGrantFile("skip.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, '"badkind"');
});

Deno.test("parseGrantFile: subjects array with no valid subject skips the entry's resource errors", () => {
  const content = `
grants:
  - subjects: ["badkind:alice", "nocolon"]
    effect: allow
    actions: [run]
    resources: ["badkind:x", "workflow:*"]
`;
  const result = parseGrantFile("skip.yaml", content);
  assertEquals(result.entries.length, 0);
  assertEquals(result.errors.length, 2);
  assertStringIncludes(result.errors[0].message, '"badkind"');
  assertStringIncludes(result.errors[1].message, '"nocolon"');
});

Deno.test("parseGrantFile: subject errors come first and a bad resource is reported once", () => {
  const content = `
grants:
  - subjects: ["user:alice", "badkind:bob", "user:carol"]
    effect: allow
    actions: [run]
    resources: ["workflow:*", "badkind:x"]
`;
  const result = parseGrantFile("order.yaml", content);
  assertEquals(result.entries.map((e) => e.subject.name), ["alice", "carol"]);
  assertEquals(result.errors.length, 2);
  assertStringIncludes(result.errors[0].message, '"badkind"');
  assertStringIncludes(result.errors[0].message, "subject kind");
  assertStringIncludes(result.errors[1].message, "resource kind");
});

Deno.test("parseGrantFile: invalid condition is reported once per resource, not per subject", () => {
  const validForWorkflow = (
    _condition: string,
    kind: string,
  ): { valid: boolean; error?: string } => {
    if (kind === "workflow") return { valid: true };
    return { valid: false, error: `condition not valid for ${kind}` };
  };

  const content = `
grants:
  - subjects: ["user:alice", "user:bob", "user:carol"]
    effect: allow
    actions: [run]
    resources: ["workflow:@acme/deploy", "model:@acme/build"]
    condition: 'tags.env == "prod"'
`;
  const result = parseGrantFile("cond.yaml", content, validForWorkflow);
  assertEquals(result.entries.length, 3);
  for (const entry of result.entries) {
    assertEquals(entry.resource.kind, "workflow");
  }
  assertEquals(result.errors.length, 1);
  assertStringIncludes(result.errors[0].message, "model:@acme/build");
});

Deno.test("parseGrantFile: subjects array detects cross-entry duplicates", () => {
  const content = `
grants:
  - subject: "user:alice"
    effect: allow
    actions: [run]
    resource: "workflow:*"
  - subjects: ["user:alice", "user:bob"]
    effect: allow
    actions: [run]
    resource: "workflow:*"
`;
  const result = parseGrantFile("cross-dup.yaml", content);
  assertEquals(result.entries.map((e) => e.subject.name), ["alice", "bob"]);
  assertEquals(result.errors, [{
    filename: "cross-dup.yaml",
    entryIndex: 1,
    message: "Duplicate grant entry (same as entry 1)",
  }]);
});

Deno.test("parseGrantFile: accepts a grant for signal alone", () => {
  const content = `
grants:
  - subject: "user:release-callback"
    effect: allow
    actions: [signal]
    resource: "workflow:release"
`;
  const result = parseGrantFile("callbacks.yaml", content);
  assertEquals(result.errors, []);
  assertEquals(result.entries[0].actions, ["signal"]);
});

Deno.test("parseGrantFile: a non-canonical type spelling is a warning, never an error (swamp-club#3130)", () => {
  const content = `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resource: "model:AWS::EC2::*"
  - subject: user:adam
    effect: allow
    actions: [run]
    resource: "model:*"
    condition: 'modelType == "Acme.Tools.Probe"'
  - subject: user:adam
    effect: allow
    actions: [run]
    resource: "model:@acme/*"
`;
  const result = parseGrantFile(
    "spelling.yaml",
    content,
    validateGrantCondition,
    readConditionTypeLiterals,
  );
  assertEquals(result.errors, []);
  assertEquals(result.entries.length, 3);
  assertEquals(result.warnings.map((w) => w.entryIndex), [0, 1]);
  assertEquals(result.warnings[0].message.includes("model:aws/ec2/*"), true);
  assertEquals(result.warnings[1].message.includes("acme/tools/probe"), true);
});

Deno.test("parseGrantFile: without a literal reader only selectors are checked", () => {
  const content = `
grants:
  - subject: user:adam
    effect: allow
    actions: [run]
    resource: "model:*"
    condition: 'modelType == "Acme.Tools.Probe"'
`;
  assertEquals(parseGrantFile("c.yaml", content).warnings, []);
});
