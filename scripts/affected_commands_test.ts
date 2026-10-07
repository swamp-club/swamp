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
import { join, toFileUrl } from "@std/path";
import {
  buildImportGraph,
  classifyOutsideGraph,
  closure,
  computeAffectedCommands,
  type DenoInfo,
  type ImportGraph,
} from "./affected_commands.ts";

/** A graph written as `{ file: [imports] }`. */
function graphOf(edges: Record<string, string[]>): ImportGraph {
  return new Map(Object.entries(edges).map(([k, v]) => [k, new Set(v)]));
}

// main.ts -> mod.ts -> the three root command files. `logger.ts` is reached by
// startup alone, `shared.ts` by startup and vault, `vault_lib.ts` by vault
// alone, and `serve.ts` reaches `serve_lib.ts` through a subcommand file.
const GRAPH = graphOf({
  "main.ts": ["src/cli/mod.ts"],
  "src/cli/mod.ts": [
    "src/cli/commands/vault.ts",
    "src/cli/commands/serve.ts",
    "src/cli/commands/version.ts",
    "src/infra/logger.ts",
    "src/domain/shared.ts",
  ],
  "src/cli/commands/vault.ts": ["src/lib/vault_lib.ts", "src/domain/shared.ts"],
  "src/cli/commands/serve.ts": ["src/cli/commands/serve_reload.ts"],
  "src/cli/commands/serve_reload.ts": ["src/lib/serve_lib.ts"],
  "src/cli/commands/version.ts": [],
  "src/infra/logger.ts": [],
  "src/domain/shared.ts": [],
  "src/lib/vault_lib.ts": [],
  "src/lib/serve_lib.ts": [],
});

const INDEX = {
  vault: "src/cli/commands/vault.ts",
  serve: "src/cli/commands/serve.ts",
  version: "src/cli/commands/version.ts",
};

function affected(changedFiles: string[]) {
  return computeAffectedCommands({
    graph: GRAPH,
    index: INDEX,
    changedFiles,
    diffBase: "base-sha",
  });
}

Deno.test("buildImportGraph: keys local modules by repo-relative path and follows code and type edges", () => {
  const root = join(Deno.cwd(), "repo");
  const url = (path: string) => toFileUrl(join(root, path)).href;
  const info: DenoInfo = {
    modules: [
      {
        specifier: url("a.ts"),
        dependencies: [
          { code: { specifier: url("src/b.ts") } },
          { type: { specifier: url("src/c.ts") } },
          { code: { specifier: "jsr:@std/path@1" } },
          { code: { specifier: "redirected:d" } },
          { code: { specifier: toFileUrl(join(Deno.cwd(), "outside.ts")).href } },
        ],
      },
      { specifier: url("src/b.ts") },
      { specifier: "https://jsr.io/@std/path/1.0.0/mod.ts" },
    ],
    redirects: { "redirected:d": url("src/d.ts") },
  };
  const graph = buildImportGraph(info, root);
  assertEquals([...graph.keys()].sort(), ["a.ts", "src/b.ts"]);
  assertEquals([...graph.get("a.ts")!].sort(), [
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
  ]);
});

Deno.test("closure: terminates on a cycle and includes the root", () => {
  const graph = graphOf({ "a.ts": ["b.ts"], "b.ts": ["a.ts", "c.ts"] });
  assertEquals([...closure(graph, "a.ts")].sort(), ["a.ts", "b.ts", "c.ts"]);
});

Deno.test("closure: does not enter a module stopAt names", () => {
  const graph = graphOf({ "a.ts": ["b.ts", "d.ts"], "b.ts": ["c.ts"] });
  assertEquals(
    [...closure(graph, "a.ts", (p) => p === "b.ts")].sort(),
    ["a.ts", "d.ts"],
  );
});

Deno.test("classifyOutsideGraph: build configuration affects every command", () => {
  for (
    const file of [
      "deno.json",
      "deno.lock",
      ".tool-versions",
      "Dockerfile",
      "scripts/compile.ts",
    ]
  ) {
    assertEquals(classifyOutsideGraph(file), {
      effect: "all",
      rule: "build-configuration",
    });
  }
});

Deno.test("classifyOutsideGraph: what the binary embeds affects every command", () => {
  for (
    const file of [
      "packages/dashboard/src/App.tsx",
      "packages/dashboard/package.json",
      "packages/dashboard/src/App_test.tsx",
    ]
  ) {
    assertEquals(classifyOutsideGraph(file), {
      effect: "all",
      rule: "bundled-asset",
    }, file);
  }
});

Deno.test("classifyOutsideGraph: a nested deno.json is not the root one", () => {
  assertEquals(classifyOutsideGraph("packages/client/deno.json").effect, "none");
});

Deno.test("classifyOutsideGraph: docs, skills, tests and tooling affect no command", () => {
  for (
    const file of [
      "README.md",
      "design/architecture.md",
      ".claude/skills/swamp/SKILL.md",
      ".github/workflows/ci.yml",
      "verification/workflow-verify-build.yaml",
      "agent-constraints/triage-conventions.md",
      "scripts/build_attestation.ts",
      "extensions/models/_lib/schemas.ts",
      "packages/testing/mod.ts",
      "integration/ddd_layer_rules_test.ts",
      "src/domain/data/composite_name_test.ts",
      "src/presentation/renderers/thing_test.tsx",
      "src/infrastructure/persistence/path_test_helpers.ts",
      "src/infrastructure/persistence/test_helpers/install_crash.ts",
      "main_test.ts",
      "src/domain/notes.md",
      "logo.png",
      "LICENSE",
      ".gitignore",
    ]
  ) {
    assertEquals(classifyOutsideGraph(file).effect, "none", file);
  }
});

Deno.test("classifyOutsideGraph: a file no rule recognises affects every command", () => {
  for (
    const file of [
      "src/cli/commands/worker_exec_dispatch_entry.ts",
      "src/domain/assets/template.yaml",
      "new-top-level/thing.ts",
      "Makefile",
    ]
  ) {
    assertEquals(classifyOutsideGraph(file), {
      effect: "all",
      rule: "unclassified",
    }, file);
  }
});

Deno.test("computeAffectedCommands: a module selects the commands whose closure contains it", () => {
  const result = affected(["src/lib/vault_lib.ts"]);
  assertEquals(result.commands, ["vault"]);
  assertEquals(result.scope, "some");
  assertEquals(result.totalCommands, 3);
  assertEquals(result.startupPath, { count: 0, files: [] });
  assertEquals(result.forcedAll, { count: 0, files: [] });
});

Deno.test("computeAffectedCommands: a root is affected through its subcommand's imports", () => {
  assertEquals(affected(["src/lib/serve_lib.ts"]).commands, ["serve"]);
  assertEquals(affected(["src/cli/commands/serve_reload.ts"]).commands, [
    "serve",
  ]);
});

Deno.test("computeAffectedCommands: a startup-only module sets the flag without widening the list", () => {
  const result = affected(["src/infra/logger.ts"]);
  assertEquals(result.commands, []);
  assertEquals(result.scope, "none");
  assertEquals(result.startupPath, {
    count: 1,
    files: ["src/infra/logger.ts"],
  });
});

Deno.test("computeAffectedCommands: a module on the startup path and in a closure reports both", () => {
  const result = affected(["src/domain/shared.ts"]);
  assertEquals(result.commands, ["vault"]);
  assertEquals(result.startupPath.files, ["src/domain/shared.ts"]);
});

Deno.test("computeAffectedCommands: a command file is not on the startup path", () => {
  const result = affected(["src/cli/commands/vault.ts"]);
  assertEquals(result.commands, ["vault"]);
  assertEquals(result.startupPath.count, 0);
});

Deno.test("computeAffectedCommands: build configuration selects every command and says why", () => {
  const result = affected(["deno.lock", "src/lib/vault_lib.ts"]);
  assertEquals(result.commands, ["serve", "vault", "version"]);
  assertEquals(result.scope, "all");
  assertEquals(result.forcedAll, {
    count: 1,
    files: [{ file: "deno.lock", rule: "build-configuration" }],
  });
});

Deno.test("computeAffectedCommands: docs and skills select nothing", () => {
  const result = affected(["README.md", ".claude/skills/swamp/SKILL.md"]);
  assertEquals(result.commands, []);
  assertEquals(result.scope, "none");
  assertEquals(result.derivation.changedFiles, 2);
});

Deno.test("computeAffectedCommands: a deleted module selects nothing by itself", () => {
  const result = computeAffectedCommands({
    graph: GRAPH,
    index: INDEX,
    changedFiles: ["src/lib/vault_lib.ts"],
    deletedFiles: ["src/lib/gone.ts", "src/ui/gone.tsx"],
    diffBase: "base-sha",
  });
  assertEquals(result.commands, ["vault"]);
  assertEquals(result.forcedAll.count, 0);
  assertEquals(result.derivation.changedFiles, 3);
});

Deno.test("computeAffectedCommands: a deleted file that is not a module is classified like a changed one", () => {
  const deleted = (deletedFiles: string[]) =>
    computeAffectedCommands({
      graph: GRAPH,
      index: INDEX,
      changedFiles: [],
      deletedFiles,
      diffBase: "base-sha",
    });
  assertEquals(deleted([".tool-versions"]).scope, "all");
  assertEquals(deleted(["src/domain/assets/template.yaml"]).forcedAll.files, [
    { file: "src/domain/assets/template.yaml", rule: "unclassified" },
  ]);
  assertEquals(deleted(["design/old.md"]).scope, "none");
});

Deno.test("computeAffectedCommands: records how the list was derived", () => {
  assertEquals(affected(["README.md", "README.md"]).derivation, {
    method: "static-imports",
    diffBase: "base-sha",
    edges: ["code", "type"],
    changedFiles: 1,
  });
});

Deno.test("computeAffectedCommands: file lists state their size and carry only the first fifty", () => {
  const files = Array.from(
    { length: 60 },
    (_, i) => `unknown/file_${String(i).padStart(2, "0")}.bin`,
  );
  const result = affected(files);
  assertEquals(result.forcedAll.count, 60);
  assertEquals(result.forcedAll.files.length, 50);
  assertEquals(result.forcedAll.files[0].file, "unknown/file_00.bin");
});
