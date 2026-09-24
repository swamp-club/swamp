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
import { join, relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs/walk";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";

const ROOT = join(import.meta.dirname!, "..");
const PERSISTENCE_DIR = join(
  ROOT,
  "src",
  "infrastructure",
  "persistence",
);

function normalise(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

// Per-path-wired repositories must not call bare notifyDirty() (no path
// argument). A bare call sets bulkInvalidated in the datastore extension,
// forcing a full walk that skips deletion detection — silently dropping
// remote object deletions (swamp-club#2273). See the "Serve handler
// obligation" paragraph in design/enablers/datastores.md.
const PER_PATH_WIRED_REPOS = [
  "yaml_workflow_run_repository.ts",
  "unified_data_repository.ts",
  "yaml_evaluated_definition_repository.ts",
  "yaml_evaluated_workflow_repository.ts",
  "yaml_definition_repository.ts",
  "yaml_workflow_repository.ts",
  "yaml_output_repository.ts",
];

// Matches `this.notifyDirty()` or `await this.notifyDirty()` with no
// arguments — the bare/bulk form. Anchored to avoid matching the method
// definition (`private async notifyDirty(...)`) or calls with arguments
// (`this.notifyDirty(path)`).
const BARE_NOTIFY_DIRTY = /(?:await\s+)?this\.notifyDirty\(\s*\)/;

Deno.test("per-path-wired repos must not call bare notifyDirty()", async () => {
  const violations: string[] = [];

  for (const filename of PER_PATH_WIRED_REPOS) {
    const filepath = join(PERSISTENCE_DIR, filename);
    let content: string;
    try {
      content = await Deno.readTextFile(filepath);
    } catch {
      continue;
    }
    const rel = normalise(relative(ROOT, filepath));
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip the notifyDirty method definition itself
      if (
        line.includes("private") && line.includes("notifyDirty") &&
        line.includes("relPath")
      ) {
        continue;
      }
      // Skip comments
      if (line.trimStart().startsWith("//")) continue;
      if (BARE_NOTIFY_DIRTY.test(line)) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Per-path-wired repositories must call notifyDirty with a path " +
      "argument, not bare notifyDirty(). A bare call sets " +
      "bulkInvalidated in the datastore extension, forcing a full walk " +
      "that skips deletion detection — silently dropping remote object " +
      "deletions (swamp-club#2273). Use the directory path being " +
      "removed as the argument.\n\nViolations:\n" +
      violations.join("\n"),
  );
});

// Auto-definition repos that save to autoDefinitionsDir must pass markDirty
// so the sync service knows about the new file. Without it, pushChanged's
// fast-path skips the file and it is never pushed to the remote datastore —
// causing definition loss on restart (swamp-club#2275).
const AUTO_DEF_REPO_PATTERN =
  /new YamlDefinitionRepository\(\s*\n?\s*[\w.]+,\s*\n?\s*[\w.]+,\s*\n?\s*[\w.]+,\s*\n?\s*false,?\s*\n?\s*\)/;

const SRC_DIR = join(ROOT, "src");

Deno.test("auto-definition repos must pass markDirtyHook (swamp-club#2275)", async () => {
  const violations: string[] = [];

  for await (
    const entry of walk(SRC_DIR, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    if (!content.includes("autoDefRepo")) continue;
    if (!content.includes("new YamlDefinitionRepository(")) continue;
    const rel = normalise(relative(ROOT, entry.path));

    // Extract each auto-def repo construction and check for the 5th
    // parameter (markDirtyHook). The pattern matches constructions with
    // exactly 4 args (missing the hook).
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("autoDefRepo")) continue;
      // Grab a window of lines around the construction
      const window = lines.slice(i, i + 8).join("\n");
      if (
        window.includes("new YamlDefinitionRepository(") &&
        AUTO_DEF_REPO_PATTERN.test(window)
      ) {
        violations.push(`${rel}:${i + 1}`);
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Auto-definition YamlDefinitionRepository constructions must pass " +
      "markDirtyHook as the 5th parameter. Without it, pushChanged's " +
      "fast-path skips the saved file and it is never synced to the " +
      "remote datastore (swamp-club#2275).\n\nViolations:\n" +
      violations.join("\n"),
  );
});

Deno.test("serve startup pullChanged must include auto-definitions subdir", async () => {
  const serveFile = join(ROOT, "src", "cli", "commands", "serve.ts");
  const content = await Deno.readTextFile(serveFile);

  assertStringIncludes(
    content,
    '"auto-definitions"',
    "The early startup pullChanged in serve.ts must include " +
      '"auto-definitions" in its subdirs list so auto-definitions are ' +
      "available before the serve accepts connections (swamp-club#2275).",
  );
});

// Serve code must never send a bare markDirty(). A no-argument call — on the
// sync service, or on the repository hook, which forwards an absent path as a
// bare call — sets bulkInvalidated in the datastore extension, so the next
// push rebuilds the index from every shard and walks the whole cache for a
// handful of changed files, and skips deletion detection (swamp-club#2408,
// swamp-club#2415). Mutations rely on the per-path signals their
// repositories send, and mark by path whatever they write outside a hooked
// repository.

// `.markDirty()` or `.markDirty?.()` with no arguments, on any receiver.
const BARE_MARK_DIRTY_CALL = /\.markDirty(?:\?\.)?\(\s*\)/;
// A declaration at column 0: a function (generators included), or a
// const, let or class. Serve's command handlers live inside
// `export const serveCommand = new Command()...`.
const TOP_LEVEL_DECLARATION =
  /^(?:export )?(?:async )?(?:function\s*\*?\s*|const |let |class )(\w+)/;

async function* bareMarkDirtyScanFiles(): AsyncGenerator<string> {
  for await (
    const entry of walk(join(ROOT, "src", "serve"), {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    yield entry.path;
  }
  yield join(ROOT, "src", "cli", "commands", "serve.ts");
}

Deno.test("serve code must not make bare markDirty() calls (swamp-club#2408, swamp-club#2415)", async () => {
  const sites: string[] = [];

  for await (const path of bareMarkDirtyScanFiles()) {
    const rel = normalise(relative(ROOT, path));
    const content = await Deno.readTextFile(path);
    // Attribute each call to the top-level declaration whose body contains it.
    let owner = "<module>";
    for (const line of content.split("\n")) {
      const declaration = line.match(TOP_LEVEL_DECLARATION);
      if (declaration) owner = declaration[1];
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (BARE_MARK_DIRTY_CALL.test(line)) sites.push(`${rel}: ${owner}`);
    }
  }

  assertEquals(
    sites,
    [],
    "Bare markDirty() calls in serve code force a full-cache push that " +
      "also skips deletion detection. Write through a repository wired " +
      "with the markDirty hook, or mark each changed path after the write " +
      "(ctx.repoContext.markDirty(path)) before pushChanged. Mark files, " +
      "not shared directories: a directory mark deletes remotely whatever " +
      "is missing locally, including another instance's unpolled files " +
      "(swamp-club#2415).\n\nViolations:\n" + sites.join("\n"),
  );
});

// A command that takes model locks installs the datastore sync coordinator's
// SIGINT handler, which exits the process with 130 once it has released the
// locks. A command that also cancels its work on Ctrl-C must suppress that
// exit, or the process dies before it records a terminal status: an
// interrupted `workflow resume` left its run stuck at running
// (swamp-club#2430). The pinned list keeps the scan honest and puts each new
// command that matches in front of a reviewer.
const PINNED_LOCKING_CANCELLABLE_COMMANDS: readonly string[] = [
  "src/cli/commands/model_method_run.ts",
  "src/cli/commands/workflow_resume.ts",
  "src/cli/commands/workflow_run.ts",
];

Deno.test("commands that take model locks and cancel on Ctrl-C must suppress the sync exit (swamp-club#2430)", async () => {
  const commands: string[] = [];
  const missing: string[] = [];

  for await (
    const entry of walk(join(ROOT, "src", "cli", "commands"), {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const code = (await Deno.readTextFile(entry.path))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    if (!code.includes("acquireModelLocks(")) continue;
    if (!code.includes("registerShutdownHandler(")) continue;
    const rel = normalise(relative(ROOT, entry.path));
    commands.push(rel);
    if (!code.includes("suppressSyncExitOnSignal()")) missing.push(rel);
  }

  assertEquals(
    missing,
    [],
    "These commands take model locks and register a shutdown handler but " +
      "never call suppressSyncExitOnSignal(). On Ctrl-C the datastore sync " +
      "coordinator exits the process with 130 before the command can save a " +
      "terminal run status (swamp-club#2430). Take the suppression directly " +
      "before the try whose finally disposes it, as workflow_run.ts does.",
  );
  assertPinnedSet(
    commands.sort(),
    PINNED_LOCKING_CANCELLABLE_COMMANDS,
    "Commands that take model locks and cancel on Ctrl-C",
    "A new command takes model locks and registers a shutdown handler.\n" +
      "Confirm it calls suppressSyncExitOnSignal() and saves a terminal\n" +
      "status for its run after an abort, then pin it here.",
  );
});

/**
 * Top-level argument lists of every `new <className>(...)` in `code`, with
 * `//` and block-comment lines removed first.
 */
function constructorArgs(code: string, className: string): string[][] {
  const source = code
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
  const marker = `new ${className}(`;
  const calls: string[][] = [];
  let from = source.indexOf(marker);
  while (from !== -1) {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (let i = from + marker.length; i < source.length; i++) {
      const ch = source[i];
      if (depth === 0 && ch === ")") break;
      if (depth === 0 && ch === ",") {
        args.push(current.trim());
        current = "";
        continue;
      }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      current += ch;
    }
    if (current.trim() !== "") args.push(current.trim());
    calls.push(args);
    from = source.indexOf(marker, from + marker.length);
  }
  return calls;
}

// Outputs, evaluated definitions and evaluated workflows are datastore-tier.
// A repository built with only repoDir (or an undefined base dir) writes to
// the repo-local .swamp/ instead, where readers built by the repository
// factory never look and sync never pushes (swamp-club#2381). Resolve the
// base dir through the DatastorePathResolver, as repository_factory.ts does.
const DATASTORE_TIER_REPOS = [
  "YamlOutputRepository",
  "YamlEvaluatedDefinitionRepository",
  "YamlEvaluatedWorkflowRepository",
];

Deno.test("datastore-tier repos must be built with a resolved base dir (swamp-club#2381)", async () => {
  const violations: string[] = [];
  for await (
    const entry of walk(SRC_DIR, { exts: [".ts"], skip: [/_test\.ts$/] })
  ) {
    const code = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));
    for (const className of DATASTORE_TIER_REPOS) {
      for (const args of constructorArgs(code, className)) {
        if (args.length < 2 || args[1] === "undefined") {
          violations.push(`${rel}: new ${className}(${args.join(", ")})`);
        }
      }
    }
  }

  assertEquals(
    violations,
    [],
    "These constructions default a datastore-tier repository to the " +
      "repo-local .swamp/. Pass the base dir from " +
      "datastoreResolver.resolvePath(SWAMP_SUBDIRS.<subdir>) " +
      "(swamp-club#2381).\n\nViolations:\n" + violations.join("\n"),
  );
});

// A YamlDefinitionRepository built with only a repo dir reads
// auto-definitions from the repo-local .swamp/, but auto-definitions are
// datastore-tier. Workflow execution was fixed in swamp-club#2381; the files
// below are the remaining sites (swamp-club#2382). The list may only shrink.
const PINNED_REPO_LOCAL_AUTO_DEFINITION_READERS: readonly string[] = [
  "src/cli/completion_types.ts",
  "src/libswamp/data/rename.ts",
  "src/libswamp/data/versions.ts",
  "src/libswamp/models/doctor_secrets.ts",
  "src/libswamp/models/doctor_vaults.ts",
  "src/libswamp/models/edit.ts",
  "src/libswamp/models/evaluate.ts",
  "src/libswamp/models/get.ts",
  "src/libswamp/models/method_describe.ts",
  "src/libswamp/models/method_history_logs.ts",
  "src/libswamp/models/output_data.ts",
  "src/libswamp/models/output_get.ts",
  "src/libswamp/models/validate.ts",
  "src/libswamp/reports/search.ts",
  "src/libswamp/workflows/evaluate.ts",
];

Deno.test("repo-local auto-definition readers are pinned (swamp-club#2381, swamp-club#2382)", async () => {
  const files = new Set<string>();
  for await (
    const entry of walk(SRC_DIR, { exts: [".ts"], skip: [/_test\.ts$/] })
  ) {
    const code = await Deno.readTextFile(entry.path);
    const calls = constructorArgs(code, "YamlDefinitionRepository");
    if (calls.some((args) => args.length === 1)) {
      files.add(normalise(relative(ROOT, entry.path)));
    }
  }

  assertPinnedSet(
    [...files].sort(),
    PINNED_REPO_LOCAL_AUTO_DEFINITION_READERS,
    "Files building a YamlDefinitionRepository from the repo dir alone",
    "A new YamlDefinitionRepository reads auto-definitions from the\n" +
      "repo-local .swamp/. Pass datastoreResolver.resolvePath(\n" +
      "SWAMP_SUBDIRS.autoDefinitions) as the fourth argument, as\n" +
      "repository_factory.ts does, or inject the repository context's repo.",
  );
});
