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

// Serve code must rely on the per-path markDirty signals its repositories
// send. A no-argument markDirty() — on the sync service, or on the repository
// hook, which forwards an absent path as a bare call — sets bulkInvalidated in
// the datastore extension, so the next push rebuilds the index from every
// shard and walks the whole cache for a handful of changed files
// (swamp-club#2408). Each entry is one top-level declaration in src/serve or
// the serve command; one that makes more than one call is suffixed with the
// call count.
const PINNED_BARE_MARK_DIRTY_SITES: readonly string[] = [
  // Startup migration: migrateGrantDefinitions moves server-token definitions
  // from models/ to auto-definitions/ directly on disk, so no repository sends
  // a per-path signal and a bare call is the only way to mark them.
  "src/cli/commands/serve.ts: serveCommand",
  // Pending an audit of whether all their writes carry per-path signals
  // (swamp-club#2415).
  "src/serve/handlers/access_handlers.ts: handleAccessReload",
  "src/serve/handlers/admin_handlers.ts: handleExtensionInstall",
  "src/serve/handlers/admin_handlers.ts: handleExtensionPull",
  "src/serve/handlers/admin_handlers.ts: handleExtensionRm",
  "src/serve/handlers/admin_handlers.ts: handleExtensionUpdate",
  "src/serve/handlers/admin_handlers.ts: handleVaultMigrate",
  "src/serve/handlers/vault_handlers.ts: handleVaultAnnotate",
  "src/serve/handlers/vault_handlers.ts: handleVaultCreate",
  "src/serve/handlers/vault_handlers.ts: handleVaultDelete",
  "src/serve/handlers/vault_handlers.ts: handleVaultEdit",
];

// `.markDirty()` or `.markDirty?.()` with no arguments, on any receiver.
const BARE_MARK_DIRTY_CALL = /\.markDirty(?:\?\.)?\(\s*\)/g;
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

Deno.test("serve code must not add bare markDirty() calls (swamp-club#2408)", async () => {
  const callCounts = new Map<string, number>();

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
      const calls = line.match(BARE_MARK_DIRTY_CALL)?.length ?? 0;
      if (calls === 0) continue;
      const site = `${rel}: ${owner}`;
      callCounts.set(site, (callCounts.get(site) ?? 0) + calls);
    }
  }

  const sites = [...callCounts].map(([site, count]) =>
    count === 1 ? site : `${site} (${count} calls)`
  );
  assertPinnedSet(
    sites.sort(),
    PINNED_BARE_MARK_DIRTY_SITES,
    "Bare markDirty() calls in serve code",
    "Mutations must rely on the per-path markDirty signals their\n" +
      "repositories send; a bare call forces a full-cache push. Write through\n" +
      "a repository wired with the markDirty hook, or pass the changed path.\n" +
      "This list is frozen debt (swamp-club#2415); it may shrink, never grow.\n" +
      'A second call in a pinned function shows up as a "(2 calls)" entry\n' +
      "added and the plain entry removed. Renaming a pinned function shows up\n" +
      "as one entry added and one removed.",
  );
});
