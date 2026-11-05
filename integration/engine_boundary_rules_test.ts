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

/** Keep the Go gateway a delivery adapter with one negotiated TS engine. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { MAX_TIMER_DELAY_MS } from "../src/domain/runtime/timer_duration.ts";
import { ENGINE_PROTOCOL } from "../src/engine/protocol.ts";
import { findModuleReferences } from "../scripts/unbarrel.ts";
import {
  assertPinnedSet,
  collectImportEdges,
  importsLayer,
  isUnder,
  resolveImport,
  ROOT,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

Deno.test("engine boundary: the shared shutdown limit fits the runtime timer range", () => {
  assertEquals(
    ENGINE_PROTOCOL.limits.maxShutdownDeadlineMs,
    MAX_TIMER_DELAY_MS,
  );
});

Deno.test("engine boundary: engine imports no CLI modules", async () => {
  const violations = await collectImportEdges(
    join(SRC_DIR, "engine"),
    (file, specifier) => importsLayer(file, specifier, "cli"),
  );
  assertPinnedSet(
    violations,
    [],
    "engine -> cli",
    "The engine and CLI are sibling delivery adapters; share construction below the CLI.",
  );
});

Deno.test("engine boundary: shared locks, operator admission and datastore normalization have no transitive CLI dependency", async () => {
  const pending = [
    "src/infrastructure/persistence/repo_execution_locks.ts",
    "src/engine/operator_auth.ts",
    "src/libswamp/datastores/resolve_filesystem.ts",
    "src/infrastructure/process/command_guardian_policy.ts",
    "src/infrastructure/process/process_executor.ts",
  ];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);
    const path = join(ROOT, module);
    const source = await Deno.readTextFile(path);
    for (const reference of findModuleReferences(path, source)) {
      const target = resolveImport(path, reference.specifier);
      if (target === undefined || !/\.tsx?$/.test(target)) continue;
      if (isUnder(target, "src/cli")) {
        violations.push(`${module} -> ${target}`);
      } else {
        pending.push(target);
      }
    }
  }
  assert(
    visited.size > 1,
    "Inspect the shared implementation and its dependencies",
  );
  assertPinnedSet(
    violations.sort(),
    [],
    "shared execution locks -> cli",
    "Move shared construction below both delivery adapters; a reexport of CLI helpers does not remove their dependency.",
  );
});

Deno.test("engine boundary: the read-only engine opener never loads the command tree", async () => {
  const pending = ["src/cli/read_only_engine_repo.ts"];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);
    const path = join(ROOT, module);
    for (
      const reference of findModuleReferences(
        path,
        await Deno.readTextFile(path),
      )
    ) {
      const target = resolveImport(path, reference.specifier);
      if (target === undefined || !/\.tsx?$/.test(target)) continue;
      const commandModule = isUnder(target, "src/cli/commands") &&
        target !== "src/cli/commands/version.ts";
      if (target === "src/cli/mod.ts" || commandModule) {
        violations.push(`${module} -> ${target}`);
      } else {
        pending.push(target);
      }
    }
  }
  assert(visited.size > 1, "Inspect the opener and its dependencies");
  assertPinnedSet(
    violations.sort(),
    [],
    "read-only engine opener -> CLI command tree",
    "A read-only engine loads the repo bootstrap and extension loaders only; keep shared setup out of src/cli/mod.ts and the command modules.",
  );
});

Deno.test("engine boundary: Go source has licenses and no domain persistence dependencies", async () => {
  const missing: string[] = [];
  const persistence: string[] = [];
  let files = 0;
  for await (
    const entry of walk(join(ROOT, "packages", "serve-go"), {
      exts: [".go"],
      includeDirs: false,
    })
  ) {
    files++;
    const source = await Deno.readTextFile(entry.path);
    if (!source.includes("GNU Affero General Public License version 3")) {
      missing.push(entry.path);
    }
    if (/"(?:database\/sql|[^"\n]*(?:sqlite|yaml)[^"\n]*)"/.test(source)) {
      persistence.push(entry.path);
    }
  }
  assert(files > 0, "Go source scan must inspect the server");
  assertPinnedSet(
    missing.sort(),
    [],
    "unlicensed Go source",
    "Add FILE-LICENSE-TEMPLATE.md as Go comments.",
  );
  assertPinnedSet(
    persistence.sort(),
    [],
    "Go domain persistence",
    "Repository data and authorization belong to the TypeScript engine.",
  );
});

Deno.test("engine boundary: Go toolchain and release setup share the repository pin", async () => {
  const pins = await Deno.readTextFile(join(ROOT, ".tool-versions"));
  const pin = /^golang\s+(\S+)\s*$/m.exec(pins)?.[1];
  assert(pin, ".tool-versions must pin Go");
  const module = await Deno.readTextFile(
    join(ROOT, "packages", "serve-go", "go.mod"),
  );
  assertEquals(/^go\s+(\S+)\s*$/m.exec(module)?.[1], pin);
  const workflow = parseYaml(
    await Deno.readTextFile(join(ROOT, ".github", "workflows", "release.yml")),
  ) as {
    jobs: Record<
      string,
      { steps?: { uses?: string; with?: Record<string, unknown> }[] }
    >;
  };
  const setups = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/setup-go@"));
  assertEquals(
    setups.length,
    2,
    "release build and native matrix must both install pinned Go",
  );
  for (const setup of setups) {
    assertEquals(setup.with?.["go-version-file"], ".tool-versions");
    assertEquals(setup.with?.["go-version"], undefined);
  }
});

Deno.test("engine boundary: Go builds and both engine adapters receive required verification", async () => {
  const build = await Deno.readTextFile(
    join(ROOT, "verification", "workflow-verify-build.yaml"),
  );
  assertStringIncludes(build, "scripts/serve_go.ts check");
  const reviews = await Deno.readTextFile(
    join(ROOT, "verification", "workflow-verify-reviews.yaml"),
  );
  assertStringIncludes(reviews, "f.startsWith('src/engine/')");
  assertStringIncludes(reviews, "f.startsWith('packages/serve-go/')");
  const ci = await Deno.readTextFile(
    join(ROOT, ".github", "workflows", "ci.yml"),
  );
  assertStringIncludes(ci, "'src/engine/**'");
  assertStringIncludes(ci, "'packages/serve-go/**'");
});

Deno.test("engine boundary: Go pairs require explicit experimental release selection", async () => {
  const workflow = parseYaml(
    await Deno.readTextFile(join(ROOT, ".github", "workflows", "release.yml")),
  ) as {
    on: {
      workflow_dispatch: { inputs: { experimental_go: { default: boolean } } };
    };
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string[];
        steps?: { uses?: string; with?: Record<string, unknown> }[];
      }
    >;
  };
  assertEquals(
    workflow.on.workflow_dispatch.inputs.experimental_go.default,
    false,
  );
  assertStringIncludes(
    workflow.jobs["go-compat"].if ?? "",
    "inputs.experimental_go",
  );
  assertStringIncludes(
    workflow.jobs["experimental-go-artifacts"].if ?? "",
    "inputs.experimental_go",
  );
  assertEquals(workflow.jobs["experimental-go-artifacts"].needs, [
    "release",
    "go-compat",
  ]);
  const publish = workflow.jobs["github-release"].steps?.find((step) =>
    step.uses?.startsWith("softprops/action-gh-release@")
  );
  assertEquals(String(publish?.with?.files).includes("swamp-serve"), false);
});

Deno.test("engine boundary: operator admission precedes repository and extension composition", async () => {
  const source = await Deno.readTextFile(join(SRC_DIR, "engine", "entry.ts"));
  const admission = source.indexOf(
    "await admitEngineOperator(identity.version)",
  );
  const composition = source.indexOf(
    "await createLocalEngineContext(launch.repo)",
  );
  assert(admission > 0 && composition > admission);
  assertStringIncludes(source, "error instanceof EngineOperatorAuthError");
  assertEquals(source.includes("error instanceof UserError"), false);
});

Deno.test("engine boundary: command containment remains installed through process teardown", async () => {
  const entry = await Deno.readTextFile(join(SRC_DIR, "engine", "entry.ts"));
  // Exactly one production installation permits no teardown reset to ordinary
  // execution while cancellation-ignoring tasks can still be scheduled.
  const installations = [...entry.matchAll(/\bsetCommandGuardian\s*\(/g)];
  assertEquals(installations.length, 1);
  const installation = installations[0].index!;
  assert(installation > entry.indexOf("output = openEngineOutput("));
  assert(installation < entry.indexOf("await frames.next()"));
  const main = await Deno.readTextFile(join(ROOT, "main.ts"));
  assert(/Deno\.exit\(\s*await runEngineMain\(/.test(main));
});

Deno.test("engine boundary: raw spawns the engine can reach are pinned, and only delegated dashboard actions bypass the command guardian on purpose", async () => {
  const pending = ["src/engine/entry.ts"];
  const visited = new Set<string>();
  const sites: string[] = [];
  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);
    const path = join(ROOT, module);
    const source = await Deno.readTextFile(path);
    if (/\bnew Deno\.Command\s*\(/.test(source)) sites.push(module);
    for (const reference of findModuleReferences(path, source)) {
      const target = resolveImport(path, reference.specifier);
      if (target !== undefined && /\.tsx?$/.test(target)) pending.push(target);
    }
  }
  assert(visited.size > 100, "Inspect the engine's import graph");
  assertPinnedSet(
    sites.sort(),
    [
      "src/cli/context.ts",
      "src/domain/extensions/dependency_resolution/deno_info.ts",
      "src/domain/extensions/extension_quality_checker.ts",
      "src/domain/models/bundle.ts",
      "src/infrastructure/datastore_v3/boot_identity.ts",
      "src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts",
      "src/infrastructure/datastore_v3/litestream/litestream_processes.ts",
      "src/infrastructure/datastore_v3/litestream/litestream_restorer.ts",
      "src/infrastructure/editor/editor_service.ts",
      "src/infrastructure/persistence/git_worktree.ts",
      "src/infrastructure/process/process_executor.ts",
      "src/infrastructure/process/process_kill.ts",
      "src/infrastructure/process/resolve_command.ts",
      "src/infrastructure/runtime/embedded_deno_runtime.ts",
      "src/infrastructure/runtime/process.ts",
      "src/infrastructure/runtime/process_bundle_prober.ts",
      "src/infrastructure/security/file_security_check.ts",
      "src/serve/local/delegated_actions.ts",
    ],
    "engine-reachable raw spawns",
    "Run repository commands through process_executor so the generation's command guardian contains them. Only a dashboard's delegated workflow action may outlive the engine.",
  );
});
