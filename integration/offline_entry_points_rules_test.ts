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

/**
 * Every command that opens a checkout to write is judged by the offline
 * rules (swamp-club#4195) at one of three places, pinned here so a new
 * writing command is classified on purpose:
 *
 * - `entry`: a method run or a workflow step, judged before it starts by
 *   `assertOfflineRunAllowed` (directly, or through `workflowStepLockHook`);
 *   one that changes things needs its behavior's lease.
 * - `config-edit`: a user's edit or removal of a definition, refused
 *   offline by `runAsUserConfigEdit`.
 * - `sink`: everything else. Offline, its commits queue only where the
 *   serve sink's backstop (`checkOfflineCommit`) allows: a run's record or
 *   an auto-definition, a behavior under a live lease or registered by an
 *   entry; a definition, the lockfile or any other behavior is refused.
 *   `serve.ts` is serve itself, which never has serve as its upstream.
 */

import { assert } from "@std/assert";
import { basename, join } from "@std/path";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";

const COMMANDS = join(import.meta.dirname!, "..", "src", "cli", "commands");

const WRITER_ENTRY = /requireInitializedRepo(Unlocked)?\(/;

const ENTRY: readonly string[] = [
  "model_method_run.ts",
  "workflow_resume.ts",
  "workflow_run.ts",
];

const CONFIG_EDIT: readonly string[] = [
  "model_delete.ts",
  "model_edit.ts",
  "vault_edit.ts",
  "vault_remove.ts",
  "workflow_delete.ts",
  "workflow_edit.ts",
];

const SINK: readonly string[] = [
  "access_grant.ts",
  "access_group.ts",
  "access_token_mint.ts",
  "access_token_reveal.ts",
  "access_token_revoke.ts",
  "access_token_rotate.ts",
  "data_delete.ts",
  "data_gc.ts",
  "data_prune.ts",
  "data_rename.ts",
  "datastore_claim.ts",
  "datastore_compact.ts",
  "datastore_config_migrate.ts",
  "datastore_gc.ts",
  "datastore_migrate_index.ts",
  "datastore_release.ts",
  "datastore_sync.ts",
  "doctor_datastores.ts",
  "model_cancel.ts",
  "model_create.ts",
  "model_evaluate.ts",
  "model_validate.ts",
  "run.ts",
  "run_gc.ts",
  "serve.ts",
  "vault_annotate.ts",
  "vault_create.ts",
  "vault_delete.ts",
  "vault_migrate.ts",
  "vault_put.ts",
  "worker_prune.ts",
  "worker_token_create.ts",
  "worker_token_revoke.ts",
  "workflow_approve.ts",
  "workflow_cancel.ts",
  "workflow_create.ts",
  "workflow_evaluate.ts",
  "workflow_recover.ts",
  "workflow_reject.ts",
  "workflow_signal.ts",
  "workflow_waits.ts",
];

async function writerCommands(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for await (const entry of Deno.readDir(COMMANDS)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith("_test.ts")) continue;
    const source = await Deno.readTextFile(join(COMMANDS, entry.name));
    if (WRITER_ENTRY.test(source)) found.set(basename(entry.name), source);
  }
  return found;
}

Deno.test("offline entry points: every writing command is classified by where the offline rules judge it (swamp-club#4195)", async () => {
  const commands = await writerCommands();
  assertPinnedSet(
    [...commands.keys()],
    [...ENTRY, ...CONFIG_EDIT, ...SINK],
    "Writing commands",
    "Classify each new writing command in this test: judge a method run or " +
      "workflow step with assertOfflineRunAllowed (entry), open a definition " +
      "edit with runAsUserConfigEdit (config-edit), or rely on the serve " +
      "sink's offline backstop (sink).",
  );
  for (const name of ENTRY) {
    const source = commands.get(name)!;
    assert(
      source.includes("assertOfflineRunAllowed(") ||
        source.includes("workflowStepLockHook("),
      `${name} must judge each run with assertOfflineRunAllowed`,
    );
  }
  for (const name of CONFIG_EDIT) {
    assert(
      commands.get(name)!.includes("runAsUserConfigEdit("),
      `${name} must open its edit with runAsUserConfigEdit`,
    );
  }
});
