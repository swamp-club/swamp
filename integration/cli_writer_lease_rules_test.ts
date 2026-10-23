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
 * Pins every CLI command that opens the repository through
 * `requireInitializedRepoUnlocked` (swamp-club#3801). That entry point takes
 * the v3 writer lease, and on a bucket datastore the lease restores the
 * checkout as a writer and starts a replication lineage: a command that only
 * reads must not take it. `workflow approvals`, `run history`, `vault
 * audit-trail` and `vault read-secret` took it while only reading, so a
 * read-only `workflow approvals` on a fresh clone began its own lineage.
 *
 * Pinned by file and top-level declaration, so a read-only subcommand added
 * beside a writing one in the same file is caught too.
 */

import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

/**
 * `<file> :: <top-level owner>`, counted. Every one writes to the datastore
 * on some path; the comments name the ones that look read-only.
 */
const PINNED = [
  "src/cli/commands/access_grant.ts :: accessGrantCreateCommand",
  "src/cli/commands/access_grant.ts :: accessGrantRevokeCommand",
  "src/cli/commands/access_group.ts :: runGroupMethod",
  "src/cli/commands/access_token_mint.ts :: accessTokenMintCommand",
  // Generates and stores the token encryption key on first use.
  "src/cli/commands/access_token_reveal.ts :: accessTokenRevealCommand",
  "src/cli/commands/access_token_revoke.ts :: accessTokenRevokeCommand",
  "src/cli/commands/access_token_rotate.ts :: accessTokenRotateCommand",
  "src/cli/commands/data_delete.ts :: dataDeleteCommand",
  "src/cli/commands/data_rename.ts :: dataRenameCommand",
  "src/cli/commands/datastore_config_migrate.ts :: datastoreConfigMigrateCommand",
  "src/cli/commands/model_cancel.ts :: createModelCancelCommand",
  "src/cli/commands/model_create.ts :: createModelCreateCommand",
  "src/cli/commands/model_delete.ts :: createModelDeleteCommand",
  "src/cli/commands/model_edit.ts :: createModelEditCommand",
  // Saves the evaluated definition.
  "src/cli/commands/model_evaluate.ts :: createModelEvaluateCommand",
  "src/cli/commands/model_method_run.ts :: createModelMethodRunCommand",
  // Reaps rows and settles orphaned runs with --fix, and verifies indexes.
  "src/cli/commands/run.ts :: runDoctorCommand",
  "src/cli/commands/serve.ts :: serveCommand",
  "src/cli/commands/vault_annotate.ts :: vaultAnnotateCommand",
  "src/cli/commands/vault_create.ts :: vaultCreateCommand",
  "src/cli/commands/vault_delete.ts :: vaultDeleteCommand",
  "src/cli/commands/vault_edit.ts :: vaultEditCommand",
  "src/cli/commands/vault_migrate.ts :: vaultMigrateCommand",
  "src/cli/commands/vault_put.ts :: vaultPutCommand",
  "src/cli/commands/vault_remove.ts :: vaultRemoveCommand",
  "src/cli/commands/worker_prune.ts :: workerPruneCommand",
  "src/cli/commands/worker_token_create.ts :: workerTokenCreateCommand",
  "src/cli/commands/worker_token_revoke.ts :: workerTokenRevokeCommand",
  "src/cli/commands/workflow_approve.ts :: workflowApproveCommand",
  "src/cli/commands/workflow_cancel.ts :: workflowCancelCommand",
  "src/cli/commands/workflow_create.ts :: workflowCreateCommand",
  "src/cli/commands/workflow_edit.ts :: workflowEditCommand",
  // Saves the evaluated workflow.
  "src/cli/commands/workflow_evaluate.ts :: workflowEvaluateCommand",
  "src/cli/commands/workflow_recover.ts :: workflowRecoverCommand",
  "src/cli/commands/workflow_reject.ts :: workflowRejectCommand",
  "src/cli/commands/workflow_resume.ts :: workflowResumeCommand",
  "src/cli/commands/workflow_run.ts :: workflowRunCommand",
  "src/cli/commands/workflow_signal.ts :: workflowSignalCommand",
  // Settles expired and abandoned waits, and registers missing ones.
  "src/cli/commands/workflow_waits.ts :: workflowWaitsCommand",
];

Deno.test("CLI commands: only a command that writes takes the v3 writer lease (swamp-club#3801)", async () => {
  const keys: string[] = [];
  for await (
    const file of productionSourceFiles(join(SRC_DIR, "cli", "commands"))
  ) {
    const lines = (await Deno.readTextFile(file)).split("\n");
    const owners = topLevelOwners(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (/\brequireInitializedRepoUnlocked\(/.test(line)) {
        keys.push(`${repoRelative(file)} :: ${owners[i]}`);
      }
    });
  }
  assertPinnedSet(
    countedKeys(keys.sort()),
    PINNED,
    "CLI commands that take the v3 writer lease",
    "A command that only reads uses requireInitializedRepoReadOnly; taking " +
      "the lease starts a replication lineage on a bucket. Pin a command " +
      "here only when it writes to the datastore on some path.",
  );
});
