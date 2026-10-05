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
import {
  assertPinnedSet,
  constructorArgs,
  isCommentLine,
  TOP_LEVEL_DECLARATION,
} from "./arch_fitness_helpers.ts";

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

// Repositories that stage typed changes at each call site instead of through
// a private notifyDirty (datastore rework Phase 1 repository moves). A bulk
// change is their bare notifyDirty(): it must say why no single path covers
// the change, and every one is pinned so a new one shows up in review.
const MOVED_REPOS = [
  // swamp-club#2979, move A.
  "unified_data_repository.ts",
  "yaml_output_repository.ts",
  // swamp-club#2980, move B.
  "yaml_definition_repository.ts",
  "yaml_evaluated_definition_repository.ts",
  "yaml_evaluated_workflow_repository.ts",
  "yaml_workflow_repository.ts",
  // swamp-club#2992, move C1.
  "yaml_workflow_run_repository.ts",
  // swamp-club#2995, move C2.
  "yaml_vault_config_repository.ts",
];

// The kind property of a bulk StagedChange literal, then its reason: a quoted
// string (commas and braces inside it are fine), an expression such as
// `this.reasonFor(id)`, or the shorthand `reason`. The reason must follow the
// kind, as every StagedChange literal in src/ writes it.
const BULK_CHANGE = /\bkind:\s*"bulk"/g;
const BULK_REASON =
  /^\s*,\s*reason(?:\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|[\w.]+(?:\([^)\n]*\))?)|(?=\s*[,}\n]))/;
const EMPTY_STRING = /^(?:""|''|``)$/;

/**
 * Bulk changes staged in `code`, as "<rel>: bulk <reason>", and the ones whose
 * reason is missing or an empty string literal.
 */
function bulkChanges(
  rel: string,
  code: string,
): { changes: string[]; violations: string[] } {
  const source = code
    .split("\n")
    .map((line) => isCommentLine(line) ? "" : line)
    .join("\n");
  const changes: string[] = [];
  const violations: string[] = [];
  for (const match of source.matchAll(BULK_CHANGE)) {
    const after = source.slice(match.index + match[0].length);
    const found = after.match(BULK_REASON);
    const reason = found ? found[1] ?? "reason" : undefined;
    const line = source.slice(0, match.index).split("\n").length;
    if (reason === undefined || EMPTY_STRING.test(reason)) {
      violations.push(`${rel}:${line}: bulk change without a reason`);
    }
    changes.push(`${rel}: bulk ${reason ?? "<none>"}`);
  }
  return { changes, violations };
}

const PINNED_MOVED_BULK_CHANGES: readonly string[] = [];

Deno.test("moved repositories stage bulk changes only with a reason, and each is pinned (swamp-club#2979)", async () => {
  const changes: string[] = [];
  const violations: string[] = [];
  for (const filename of MOVED_REPOS) {
    const filepath = join(PERSISTENCE_DIR, filename);
    const rel = normalise(relative(ROOT, filepath));
    const code = await Deno.readTextFile(filepath);
    // A moved repository stages typed changes; notifyDirty must not return.
    if (/\bnotifyDirty\b/.test(code)) {
      violations.push(`${rel}: moved repository still uses notifyDirty`);
    }
    const found = bulkChanges(rel, code);
    changes.push(...found.changes);
    violations.push(...found.violations);
  }

  assertEquals(
    violations,
    [],
    "A bulk change makes the datastore extension walk the whole cache and " +
      "skip deletion detection (swamp-club#2273). Stage a write or remove " +
      "with the path instead; if no single path covers the change, give " +
      "the bulk change a non-empty reason.\n\nViolations:\n" +
      violations.join("\n"),
  );
  assertPinnedSet(
    changes.sort(),
    PINNED_MOVED_BULK_CHANGES,
    "Bulk changes staged by moved repositories",
    "A moved repository stages a bulk change. Prefer a write or remove with " +
      "the path; if bulk is deliberate, pin it here with a reason.",
  );
});

Deno.test("moved repositories: the bulk scan flags a missing or empty reason, not comments", () => {
  const code = [
    'await this.stage({ kind: "bulk", reason: "Repo.rebuildIndex" });',
    "await this.stage({",
    '  kind: "bulk",',
    '  reason: "",',
    "});",
    'await this.stage({ kind: "bulk", reason: "rebuild {all}, then prune" });',
    'await this.stage({ kind: "bulk", reason });',
    'await this.stage({ kind: "bulk" } as StagedChange);',
    '// await this.stage({ kind: "bulk", reason: "" }) in a comment',
    'await this.stage({ kind: "write", path });',
  ].join("\n");
  assertEquals(bulkChanges("probe.ts", code), {
    changes: [
      'probe.ts: bulk "Repo.rebuildIndex"',
      'probe.ts: bulk ""',
      'probe.ts: bulk "rebuild {all}, then prune"',
      "probe.ts: bulk reason",
      "probe.ts: bulk <none>",
    ],
    violations: [
      "probe.ts:3: bulk change without a reason",
      "probe.ts:8: bulk change without a reason",
    ],
  });
});

// No persistence module defines a notifyDirty: every hooked repository stages
// typed changes through signalChange at its call sites (swamp-club#2992). This
// keeps the method from coming back in a repository that is not in
// MOVED_REPOS, where the bulk rule above would not see it.
const NOTIFY_DIRTY_DEFINITION =
  /^\s*(?:(?:(?:private|protected|public|static|async|readonly|export|const|let|function)\s+)*notifyDirty\s*[(<:]|(?:(?:private|protected|public|static|readonly|export|const|let)\s+)*(?:this\.)?notifyDirty\s*=(?!=))/;

/** Lines of `code` that define a notifyDirty, as "<rel>:<line>". */
function notifyDirtyDefinitions(rel: string, code: string): string[] {
  const found: string[] = [];
  code.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (NOTIFY_DIRTY_DEFINITION.test(line)) found.push(`${rel}:${i + 1}`);
  });
  return found;
}

const PINNED_NOTIFY_DIRTY_DEFINITIONS: readonly string[] = [];

Deno.test("persistence: no module defines notifyDirty (swamp-club#2992)", async () => {
  const found: string[] = [];
  for await (
    const entry of walk(PERSISTENCE_DIR, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const rel = normalise(relative(ROOT, entry.path));
    found.push(
      ...notifyDirtyDefinitions(rel, await Deno.readTextFile(entry.path)),
    );
  }

  assertPinnedSet(
    found.sort(),
    PINNED_NOTIFY_DIRTY_DEFINITIONS,
    "notifyDirty definitions under src/infrastructure/persistence",
    "Repositories stage a typed change with signalChange(this.markDirty, " +
      "{ kind, path }) at each call site instead of a private notifyDirty.",
  );
});

Deno.test("persistence: the notifyDirty scan finds definitions, not calls or comments", () => {
  const code = [
    "  private async notifyDirty(relPath?: string): Promise<void> {",
    "  async notifyDirty(path: string) {",
    "  private readonly notifyDirty = async (path?: string) => {};",
    "function notifyDirty(path?: string): Promise<void> {",
    "    this.notifyDirty = (path?: string) => markDirty(path);",
    "    await this.notifyDirty(path);",
    "   * The StagedChange for a repository's `notifyDirty(relPath?)` call.",
    "  // private async notifyDirty(relPath?: string) in a comment",
    '    await signalChange(this.markDirty, { kind: "write", path });',
  ].join("\n");
  assertEquals(notifyDirtyDefinitions("probe.ts", code), [
    "probe.ts:1",
    "probe.ts:2",
    "probe.ts:3",
    "probe.ts:4",
    "probe.ts:5",
  ]);
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
  // The early startup pull lives in pullManagedConfigAtBoot, which also
  // re-enumerates pulled workflow dirs once config/ lands (swamp-club#2434).
  const serveFile = join(ROOT, "src", "cli", "commands", "serve.ts");
  const bootPullFile = join(ROOT, "src", "cli", "managed_config_sync.ts");
  const serveContent = await Deno.readTextFile(serveFile);
  const bootPullContent = await Deno.readTextFile(bootPullFile);

  assertStringIncludes(
    serveContent,
    "await pullManagedConfigAtBoot(",
    "serve.ts must run its early startup pull through " +
      "pullManagedConfigAtBoot (swamp-club#2275, swamp-club#2434).",
  );
  assertStringIncludes(
    bootPullContent,
    '"auto-definitions"',
    "The early startup pullChanged in pullManagedConfigAtBoot must include " +
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

// CLI commands that write the extension lockfile make the change inside a
// managed lockfile transaction: under the datastore global lock it fetches
// the shared lockfile first and publishes exactly the lockfile afterwards,
// so a stale cache never overwrites other checkouts' entries
// (swamp-club#2838). Publishing the lockfile after the command instead,
// without the fetch, is the bug; so is a bulk push, whose bare markDirty()
// makes the push walk the whole cache and skip deletion detection
// (swamp-club#2415, swamp-club#2429). A new extension writer belongs in
// this list.
const EXTENSION_WRITER_FILES: readonly string[] = [
  "src/cli/commands/doctor_extensions.ts",
  "src/cli/commands/extension_install.ts",
  "src/cli/commands/extension_pull.ts",
  "src/cli/commands/extension_rm.ts",
  "src/cli/commands/extension_search.ts",
  "src/cli/commands/extension_update.ts",
  "src/cli/commands/repo_init.ts",
];
const BULK_PUSH_HELPER_CALL =
  /\b(?:pushManagedConfigChanges(?:Deferred)?|runManagedConfigMutation)\s*\(/;
const UNFETCHED_PUSH_HELPER_CALL = /\bpushManagedConfigPaths(?:Deferred)?\s*\(/;
const TRANSACTION_CALLS = [
  /\bcreateManagedLockfileTransaction\s*\(/,
  /\bwithManagedLockfileTransaction\s*\(/,
];

Deno.test("extension writers change the lockfile inside a managed lockfile transaction (swamp-club#2429, swamp-club#2838)", async () => {
  const bulk: string[] = [];
  const unfetched: string[] = [];
  const untransacted: string[] = [];

  for (const rel of EXTENSION_WRITER_FILES) {
    const code = (await Deno.readTextFile(join(ROOT, rel)))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
    if (BULK_PUSH_HELPER_CALL.test(code)) bulk.push(rel);
    if (UNFETCHED_PUSH_HELPER_CALL.test(code)) unfetched.push(rel);
    if (!TRANSACTION_CALLS.every((call) => call.test(code))) {
      untransacted.push(rel);
    }
  }

  assertEquals(
    bulk,
    [],
    "Extension writers must not call pushManagedConfigChanges, " +
      "pushManagedConfigChangesDeferred or runManagedConfigMutation: their " +
      "bare markDirty() turns the " +
      "push into a full-cache walk that never detects deletions.",
  );
  assertEquals(
    unfetched,
    [],
    "Extension writers must not publish the lockfile with " +
      "pushManagedConfigPaths(Deferred): publishing without first fetching " +
      "the datastore's lockfile under the global lock overwrites other " +
      "checkouts' entries (swamp-club#2838). Run the change in " +
      "withManagedLockfileTransaction(createManagedLockfileTransaction(...)).",
  );
  assertEquals(
    untransacted,
    [],
    "These extension writers no longer run their lockfile change in " +
      "withManagedLockfileTransaction(createManagedLockfileTransaction(...)). " +
      "Wrap it, or remove the file from EXTENSION_WRITER_FILES if it no " +
      "longer writes the lockfile.",
  );
});

// Serve's extension handlers change the lockfile inside a managed lockfile
// transaction too, and no longer push the lockfile after answering the
// client (swamp-club#2838).
const SERVE_EXTENSION_HANDLERS: readonly string[] = [
  "handleExtensionInstall",
  "handleExtensionPull",
  "handleExtensionRm",
  "handleExtensionUpdate",
];

Deno.test("serve extension handlers change the lockfile inside a managed lockfile transaction (swamp-club#2838)", async () => {
  const content = await Deno.readTextFile(
    join(ROOT, "src", "serve", "handlers", "admin_handlers.ts"),
  );
  const violations: string[] = [];
  for (const name of SERVE_EXTENSION_HANDLERS) {
    const start = content.indexOf(`export async function ${name}(`);
    if (start === -1) {
      violations.push(`${name}: not found`);
      continue;
    }
    const next = content.indexOf("\nexport async function ", start + 1);
    const body = content.slice(start, next === -1 ? undefined : next);
    if (!body.includes("withManagedLockfileTransaction(")) {
      violations.push(`${name}: no withManagedLockfileTransaction`);
    }
    if (body.includes("pushChangedToRemote(")) {
      violations.push(`${name}: pushes after the change`);
    }
  }
  assertEquals(
    violations,
    [],
    "Serve extension handlers must run their change in " +
      "withManagedLockfileTransaction(extensionLockfileTransaction(...)), " +
      "which fetches and publishes the lockfile under the datastore global " +
      "lock.\n\nViolations:\n" + violations.join("\n"),
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
