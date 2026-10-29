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
 * Fitness rules for the v3 datastore: the domain model (swamp-club#3233), the
 * commit store (swamp-club#3236) and chunk storage (swamp-club#3237).
 *
 * 1. **Dormancy.** The model in `src/domain/datastore_v3/` and the commit
 *    store in `src/infrastructure/datastore_v3/` are built ahead of the
 *    opt-in that will use them. Until then no production code outside those
 *    two directories may import either, so they cannot change behaviour.
 *    That covers `src/cli`, `src/serve`, `src/libswamp` and the
 *    `src/domain/datastore/mod.ts` barrel. The pinned edges are the shared
 *    typed staging route's and the repositories' builders
 *    (swamp-club#3250), which run only under a commit-log unit; the issue
 *    that wires v3 in adds its edges here.
 * 2. **Partition keys come from aggregate identity.** `partitionOf()` is the
 *    only way to build a key. No string or template literal elsewhere may
 *    start with a partition-key prefix, so nobody assembles a key by hand.
 * 3. **Chunk storage is dormant too** (swamp-club#3237). The chunk store
 *    lives in the v3 model, so rule 1 covers it. The filesystem `storage/1`
 *    implementation has no production importers, and no production code
 *    calls a provider's `storage()`. Both pinned lists are empty; the v3
 *    opt-in adds its edges here.
 * 4. **No forced checkpoints.** `commits.db` never forces a checkpoint:
 *    Litestream replicates the WAL, and a forced `TRUNCATE` checkpoint made
 *    its replica 11 times larger (`design/enablers/datastore-litestream.md`).
 *    The one pinned site turns auto-checkpoint off on a replicated copy, so
 *    only Litestream checkpoints it (swamp-club#3935). No other v3 file may
 *    mention `wal_checkpoint` or `wal_autocheckpoint`. `catalog_store.ts`
 *    checkpoints `_catalog.db` on purpose, so the rule covers the v3
 *    directories only.
 * 5. **The commit-log unit is dormant** (swamp-club#3240). The commit-log
 *    unit and its root (`commit_log_unit_of_work.ts`, `commit_log_root.ts`
 *    in `src/infrastructure/datastore_v3/`) have no importers outside the v3
 *    directories, so no command or request can open one before the opt-in.
 *    Rule 1 already implies it; this rule names the files. The binding
 *    registry it shares with v2 lives in persistence and is pinned in
 *    `datastore_write_seams_rules_test.ts`.
 * 6. **The commit store is the only writer of `commits.db`**
 *    (swamp-club#3239). The read model reads commits through the
 *    `CommitStore` port. No v3 file but `sqlite_commit_store.ts` may hold a
 *    statement that changes the commit tables, its chunk index
 *    (`chunk_refs`, swamp-club#3249) included, or import
 *    `openCommitsDatabase`.
 * 7. **The read model's state is never synced** (swamp-club#3239).
 *    `.swamp/_read_model_v3/` holds one checkout's cursor and catalog. It is
 *    no datastore subdirectory, so sync never routes it and no record key
 *    may be materialised into it.
 *
 * 8. **Chunk garbage collection is dormant** (swamp-club#3249). The
 *    collector (`chunk_collector.ts` in `src/domain/datastore_v3/`) has no
 *    importers outside the v3 directories, and no production code but the
 *    filesystem storage itself mentions `removeStaleTempFiles`, so nothing
 *    deletes a chunk or a temp file before a v3 `datastore gc` is wired in
 *    at the opt-in. Both pinned lists are empty.
 * 9. **History compaction is dormant** (swamp-club#3258). Compaction
 *    (`compaction.ts`, `compaction_policy.ts`) and the run-artifact resolver
 *    (`run_artifact_resolution.ts`) have no importers outside the v3
 *    directories, and no production code outside them mentions
 *    `compactHistory`, so no commit is folded away before the opt-in wires
 *    compaction in. Rule 6 covers the compacted base's tables: only the
 *    commit store writes them. Both pinned lists are empty.
 * 10. **The stream directories stay repo-local** (swamp-club#3278).
 *    `audit`, `telemetry`, `logs` and `files` are datastore directories, but
 *    nothing writes them through the datastore: audit and telemetry files go
 *    to the checkout's own `.swamp` or the user-global spool, and nothing
 *    writes the other two. They have no v3 home, so no record key may be
 *    materialised into them, no production code may resolve one through a
 *    datastore resolver, and every production use of their `SWAMP_SUBDIRS`
 *    names is pinned. A writer that needs one of them synced must first give
 *    it a v3 home ("v3 stream directories" in
 *    `design/enablers/datastores.md`).
 * 11. **The Litestream sidecar runs only through the v3 binding**
 *    (swamp-club#3358, swamp-club#3416, swamp-club#3534). The pinned release
 *    (`litestream_pin.ts`) and the provider that downloads, verifies and
 *    caches it live in `src/infrastructure/datastore_v3/litestream/`, with
 *    the sidecar that runs it. Only the provider, the sidecar's wiring, the
 *    supervisor's entry and the binding's platform check import them; only
 *    the provider reads `SWAMP_LITESTREAM_PATH`; and only
 *    `replica_setting.ts` reads the internal replica setting tests use. A
 *    v3 datastore on a bucket replicates to its provider's own target,
 *    which reaches Litestream only through the resolver and the binding
 *    (`v3_datastore_binding.ts`); Litestream itself runs with only what its
 *    replica needs (`litestreamChildEnv`).
 * 12. **Every v3 path takes the bucket datastore too** (swamp-club#3534).
 *    No production code pairs a v3 engine check with
 *    `!isCustomDatastoreConfig`: a v3 extension datastore is opened through
 *    its binding, never as v2. A bucket datastore's namespaced records live
 *    under `ns/` in its control plane, built only by the binding, and its
 *    format marker is confirmed before every lease taken and every copy
 *    made current.
 * 13. **Follower mode is serve's** (swamp-club#3985). A commit store or read
 *    model opened with `follower` takes gapped seqs: a copy of serve's log
 *    with the commits the caller may not read left out. Only
 *    `v3_datastore.ts` and the `serve_*.ts` files in
 *    `src/infrastructure/datastore_v3/` may pass it, so a solo checkout's
 *    own log never loses its gapless rule.
 *
 * Rule 1 covers the read model too: it lives in the two v3 directories.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../src/domain/datastore/datastore_config.ts";
import { restoreNamespace } from "../src/domain/data/namespace.ts";
import {
  MATERIALISED_SUBDIRS,
  READ_MODEL_STATE_DIR,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import {
  assertPinnedSet,
  collectImportEdges,
  importsLayer,
  isUnder,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const V3_DIR = "src/domain/datastore_v3";

/** Every directory holding v3 code, under `src/`. */
const V3_LAYERS = ["domain/datastore_v3", "infrastructure/datastore_v3"];

function isV3File(rel: string): boolean {
  return V3_LAYERS.some((layer) => isUnder(rel, `src/${layer}`));
}

/** The production imports of v3 code from outside it. */
const PINNED_V3_IMPORTERS: readonly string[] = [
  // swamp-club#3250, the shared typed staging route: type-only imports of
  // `TypedChange`, which a repository's builder returns and the commit-log
  // adapter's registered stager takes. Nothing runs v3 code through them
  // until a hook requires a unit, which only a commit-log root marks.
  "src/infrastructure/persistence/unit_of_work_binding.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/unit_of_work_scope.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  // swamp-club#3250, the data and output repositories' typed builders: the
  // pure change factory (repository_changes.ts), the types it builds, the
  // inline limit that decides bytes or a stream, and the file access a
  // content file records (swamp-club#3693). The builders run only inside
  // stageTyped, which returns before them on every v2 context.
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/file_access.ts",
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/op.ts",
  "src/infrastructure/persistence/unified_data_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
  "src/infrastructure/persistence/yaml_output_repository.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/yaml_output_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
  // swamp-club#3256, the definition, workflow and evaluated repositories'
  // typed builders. config_staging.ts holds the tier rule, the record keys
  // and the save and delete batches the definition and workflow
  // repositories share; it runs only inside stageTyped or behind
  // typedStagingActive, so never on v2.
  "src/infrastructure/persistence/config_staging.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/config_staging.ts -> src/domain/datastore_v3/partition_key.ts",
  "src/infrastructure/persistence/config_staging.ts -> src/domain/datastore_v3/record_key.ts",
  "src/infrastructure/persistence/config_staging.ts -> src/domain/datastore_v3/repository_changes.ts",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/yaml_evaluated_definition_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
  // swamp-club#3257, the workflow run repository's typed builder: the run
  // record's factory, run only inside stageTyped.
  "src/infrastructure/persistence/yaml_workflow_run_repository.ts -> src/domain/datastore_v3/repository_changes.ts",
  // swamp-club#3257, the persistence test helper's typed recording unit: a
  // type-only import of the `TypedChange` batches it records.
  "src/infrastructure/persistence/test_helpers/staged_change_helpers.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  // swamp-club#3279, the v3 opt-in: the one place outside the v3
  // directories that opens a v3 datastore for a repository context
  // (v3_repo_context.ts), and the code that reaches it: the CLI's context
  // builders and teardown, serve's compaction timer and status handler,
  // `datastore gc`, `datastore status` and `datastore lock`.
  "src/cli/commands/datastore_gc.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/cli/commands/datastore_lock.ts -> src/infrastructure/datastore_v3/v3_writer_lock.ts",
  "src/cli/commands/datastore_status.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/cli/commands/serve.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/cli/repo_context.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/serve/handlers/admin_handlers.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  // swamp-club#3279, the managed lockfile's v3 publish, CLI and serve: it
  // commits the lockfile at its transaction root's checkpoint.
  "src/cli/managed_config_sync.ts -> src/infrastructure/datastore_v3/v3_lockfile_sync.ts",
  "src/serve/handlers/admin_handlers.ts -> src/infrastructure/datastore_v3/v3_lockfile_sync.ts",
  // swamp-club#3300: `datastore config migrate` commits the repo's existing
  // config into the config tier, and a writing context adopts it when
  // managedConfig was turned on by hand (a read-only one warns).
  "src/cli/commands/datastore_config_migrate.ts -> src/infrastructure/datastore_v3/v3_config_adoption.ts",
  "src/cli/repo_context.ts -> src/infrastructure/datastore_v3/v3_config_adoption.ts",
  // swamp-club#3279: catalogDbPath returns the read model's catalog on a v3
  // datastore, and setup leaves the stream directories out of its
  // records check.
  "src/infrastructure/persistence/repository_factory.ts -> src/infrastructure/datastore_v3/record_path_guard.ts",
  "src/libswamp/datastores/setup.ts -> src/infrastructure/datastore_v3/record_path_guard.ts",
  // swamp-club#3279: `datastore setup --format 3` creates the datastore.
  "src/libswamp/datastores/setup.ts -> src/infrastructure/datastore_v3/v3_datastore.ts",
  // swamp-club#3534: and on a bucket, after checking the provider can host
  // v3 here and the target is new and empty.
  "src/libswamp/datastores/setup.ts -> src/infrastructure/datastore_v3/v3_bucket_setup.ts",
  "src/libswamp/datastores/setup.ts -> src/infrastructure/datastore_v3/v3_datastore_binding.ts",
  // swamp-club#3691: `--format 3` refuses a checkout whose materialised
  // subdirectories link out of .swamp, as the v3 open does.
  "src/libswamp/datastores/setup.ts -> src/infrastructure/datastore_v3/cache_root_containment.ts",
  // swamp-club#3534: lock status and release, and config migrate, open a
  // bucket datastore through its binding (v3DatastoreConfigOf).
  "src/cli/commands/datastore_config_migrate.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/cli/commands/datastore_lock.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  // swamp-club#3301: `datastore namespace list` reads a v3 datastore's
  // namespaces from its commits.db, read-only, for the CLI and serve.
  "src/libswamp/datastores/namespace_list.ts -> src/infrastructure/datastore_v3/v3_datastore.ts",
  // swamp-club#3491: and makes a replicated checkout's copy current first.
  "src/libswamp/datastores/namespace_list.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  // swamp-club#3617: `doctor datastores --repair -y` restores the format
  // marker a crash lost from a filesystem v3 datastore.
  "src/cli/commands/doctor_datastores.ts -> src/infrastructure/datastore_v3/v3_datastore.ts",
  // swamp-club#3617: `doctor datastores` reports a v3 checkout's
  // unreadable records, at-risk copies and torn chunks, CLI and serve:
  // checkout-local state read-only and chunk stats, never commits.db.
  "src/cli/commands/doctor_datastores.ts -> src/infrastructure/datastore_v3/v3_content_inspection.ts",
  "src/serve/handlers/admin_handlers.ts -> src/infrastructure/datastore_v3/v3_content_inspection.ts",
  // swamp-club#3473: `doctor datastores --retention` reads how far back a
  // v3 datastore's history reaches (v3RetentionHistory), read-only.
  "src/libswamp/datastores/retention_check.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  // swamp-club#3279: run-record artifacts resolve through the resolver on
  // v3, where a removed version can be written again.
  "src/libswamp/data/run_artifact_check.ts -> src/domain/datastore_v3/run_artifact_resolution.ts",
  "src/libswamp/models/output_data.ts -> src/domain/datastore_v3/run_artifact_resolution.ts",
  // swamp-club#3416, the Litestream sidecar: serve sets its closing sync's
  // budget, the CLI's teardown reports commits a sync did not confirm, and
  // the error renderer gives them the temporary-failure exit code.
  "src/cli/commands/serve.ts -> src/infrastructure/datastore_v3/litestream/v3_replication.ts",
  "src/cli/v3_teardown.ts -> src/domain/datastore_v3/litestream_replication.ts",
  "src/cli/v3_teardown.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  // swamp-club#3473: the end-of-command retention pass compacts v3 history
  // after a pass, as the writer, before teardown closes the hold.
  "src/cli/retention_teardown.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/presentation/output/error_output.ts -> src/domain/datastore_v3/litestream_replication.ts",
  // swamp-club#3564: lease contention gets the temporary-failure exit code.
  "src/presentation/output/error_output.ts -> src/domain/datastore_v3/writer_lease.ts",
  // swamp-club#3489: serve answers a write whose commits a sync did not
  // confirm, or whose lease was fenced, with the CLI's error codes.
  "src/serve/handlers/shared.ts -> src/domain/datastore_v3/litestream_replication.ts",
  "src/serve/handlers/shared.ts -> src/domain/datastore_v3/writer_lease.ts",
  // swamp-club#3690: the first v3 open of a checkout refuses one whose
  // .swamp holds records, and `doctor datastores --repair` moves them aside.
  "src/cli/commands/doctor_datastores.ts -> src/infrastructure/datastore_v3/v3_checkout_join.ts",
  "src/cli/repo_context.ts -> src/infrastructure/datastore_v3/v3_checkout_join.ts",
  // swamp-club#3893: the CLI has a checkout's recovery of an interrupted
  // writer say on stderr that it is running.
  "src/cli/repo_context.ts -> src/infrastructure/datastore_v3/interrupted_writer_recovery.ts",
  // swamp-club#3759: a commit that could not reach the storage. The runs
  // word it for steps that ran, the error renderer and serve give it its
  // code, and the CLI's failed teardown tells the close the storage is
  // unreachable (swamp-club#3802: also for a hold or a catch-up cut off from
  // it, whose codes the error renderer maps too; swamp-club#3803: and a
  // reader that waited too long for another process's catch-up gets the
  // temporary-failure exit code).
  "src/cli/commands/model_method_run.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/cli/commands/workflow_resume.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/cli/commands/workflow_run.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/cli/v3_teardown.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/cli/v3_teardown.ts -> src/domain/datastore_v3/read_model.ts",
  "src/cli/v3_teardown.ts -> src/domain/datastore_v3/writer_lease.ts",
  "src/presentation/output/error_output.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  "src/presentation/output/error_output.ts -> src/domain/datastore_v3/read_model.ts",
  "src/serve/handlers/shared.ts -> src/domain/datastore_v3/commit_log_unit_of_work.ts",
  // swamp-club#3915, team mode: serve's datastore API authorises forwarded
  // commits on their intents, ingests their chunks and commits them through
  // serve's own v3 writer; serve keeps the API's upload ledger.
  "src/cli/commands/serve.ts -> src/infrastructure/datastore_v3/upload_ledger.ts",
  // swamp-club#4096: serve's team mode. Serve leads while it holds the
  // writer lease, which it reads through the lock; the leader record, the
  // follower's refusal and its code are the serve_leader domain's.
  "src/cli/commands/serve.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/cli/commands/serve.ts -> src/infrastructure/datastore_v3/v3_writer_lock.ts",
  "src/presentation/output/error_output.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/follower_requests.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/handlers/shared.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/boot_reconciliation.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/serve_leadership.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/webhook.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/worker_gateway.ts -> src/domain/datastore_v3/serve_leader.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/blob_ref.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/chunk_store.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/commit.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/commit_authorization.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/commit_store.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/observed_base.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/op.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/partition.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/partition_key.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/read_model.ts",
  "src/serve/datastore_api.ts -> src/domain/datastore_v3/record_key.ts",
  "src/serve/datastore_api.ts -> src/infrastructure/datastore_v3/chunk_ingest.ts",
  "src/serve/datastore_api.ts -> src/infrastructure/datastore_v3/forwarded_commit.ts",
  // The log id header serve sends and the client checks (swamp-club#4049).
  "src/serve/datastore_api.ts -> src/infrastructure/datastore_v3/serve_datastore_client.ts",
  "src/serve/datastore_api.ts -> src/infrastructure/datastore_v3/upload_ledger.ts",
  "src/serve/datastore_api.ts -> src/infrastructure/datastore_v3/v3_datastore.ts",
  // swamp-club#3922: serve checks a forwarded commit's content as its
  // handlers check the same write, and runs only the evaluations it wrote,
  // which the read model's writers tell; serve gives its repository context
  // that trust on a v3 datastore.
  "src/cli/commands/serve.ts -> src/infrastructure/datastore_v3/trusted_evaluations.ts",
  "src/infrastructure/persistence/repository_factory.ts -> src/infrastructure/datastore_v3/trusted_evaluations.ts",
  "src/serve/forwarded_content_authorization.ts -> src/domain/datastore_v3/chunk_store.ts",
  "src/serve/forwarded_content_authorization.ts -> src/domain/datastore_v3/commit_authorization.ts",
  "src/serve/forwarded_content_authorization.ts -> src/domain/datastore_v3/content_bindings.ts",
  "src/serve/forwarded_content_authorization.ts -> src/domain/datastore_v3/intent_key_paths.ts",
  "src/serve/forwarded_content_authorization.ts -> src/domain/datastore_v3/op.ts",
  "src/serve/forwarded_content_authorization.ts -> src/domain/datastore_v3/partition_key.ts",
  "src/serve/forwarded_content_authorization.ts -> src/infrastructure/datastore_v3/v3_datastore.ts",
  "src/serve/forwarded_data_content.ts -> src/domain/datastore_v3/commit_authorization.ts",
  "src/serve/forwarded_data_content.ts -> src/domain/datastore_v3/op.ts",
  "src/serve/forwarded_run_content.ts -> src/domain/datastore_v3/commit_authorization.ts",
  "src/serve/forwarded_run_content.ts -> src/domain/datastore_v3/content_bindings.ts",
  "src/serve/forwarded_run_content.ts -> src/domain/datastore_v3/op.ts",
  "src/serve/forwarded_run_content.ts -> src/domain/datastore_v3/partition_key.ts",
  // swamp-club#3985: a v3 checkout with a serve address resolves serve as
  // its datastore upstream (the address, its bound token, CA certificates
  // and pass-through headers) into a pure value object.
  "src/cli/serve_upstream.ts -> src/domain/datastore_v3/serve_upstream.ts",
  // swamp-club#3985: the repo context binds a v3 datastore written through
  // serve to its follower copy, from the serve address it resolved.
  "src/cli/repo_context.ts -> src/domain/datastore_v3/serve_upstream.ts",
  "src/cli/repo_context.ts -> src/infrastructure/datastore_v3/serve_upstream_binding.ts",
  // swamp-club#3985: a serve-mode checkout's per-model and workflow-run
  // locks are serve's own, held through its lock routes, so two machines
  // never allocate the same data version.
  "src/cli/repo_context.ts -> src/infrastructure/datastore_v3/serve_lock.ts",
  // swamp-club#4063: `datastore claim` and `release` change the claim on a
  // v3 datastore through its commit log, under the writer lease, directly
  // or in serve's handlers; the owner value object normalizes the address
  // serve was started with, the address a claim names, and the one its
  // audit entry records.
  "src/cli/commands/datastore_claim.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/cli/commands/datastore_release.ts -> src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/cli/commands/serve.ts -> src/domain/datastore_v3/datastore_owner.ts",
  "src/libswamp/datastores/claim.ts -> src/domain/datastore_v3/datastore_owner.ts",
  "src/serve/connection.ts -> src/domain/datastore_v3/datastore_owner.ts",
  "src/serve/handlers/admin_handlers.ts -> src/domain/datastore_v3/datastore_owner.ts",
  // swamp-club#4097: the CLI's edit and delete commands run as a user's
  // config edit, so an edit or a delete expects the version the user
  // started from; get marks a definition loaded; the lockfile publish asks
  // the commit log for the version it replaces; the error renderer and
  // serve answer a refused stale edit as config_edit_conflict.
  "src/cli/commands/model_delete.ts -> src/infrastructure/datastore_v3/config_edit_scope.ts",
  "src/cli/commands/model_edit.ts -> src/infrastructure/datastore_v3/config_edit_scope.ts",
  "src/cli/commands/vault_edit.ts -> src/infrastructure/datastore_v3/config_edit_scope.ts",
  "src/cli/commands/vault_remove.ts -> src/infrastructure/datastore_v3/config_edit_scope.ts",
  "src/cli/commands/workflow_delete.ts -> src/infrastructure/datastore_v3/config_edit_scope.ts",
  "src/cli/commands/workflow_edit.ts -> src/infrastructure/datastore_v3/config_edit_scope.ts",
  "src/cli/editor_edit.ts -> src/domain/datastore_v3/config_edit_conflict.ts",
  "src/infrastructure/persistence/repo_unit_of_work.ts -> src/domain/datastore_v3/config_edit_conflict.ts",
  "src/infrastructure/persistence/repo_unit_of_work.ts -> src/domain/datastore_v3/op.ts",
  "src/infrastructure/persistence/repo_unit_of_work.ts -> src/domain/datastore_v3/partition_key.ts",
  "src/presentation/output/error_output.ts -> src/domain/datastore_v3/config_edit_conflict.ts",
  "src/serve/handlers/shared.ts -> src/domain/datastore_v3/config_edit_conflict.ts",
];

Deno.test("datastore v3: no production code outside v3 imports it", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      V3_LAYERS.some((layer) => importsLayer(filePath, importPath, layer)) &&
      !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_V3_IMPORTERS,
    "Production imports of the dormant v3 datastore",
    "The v3 model and commit store are dormant until the opt-in wires them\n" +
      "in. Do not import them from production code before then.",
  );
});

const COMMIT_LOG_FILES = [
  "infrastructure/datastore_v3/commit_log_unit_of_work.ts",
  "infrastructure/datastore_v3/commit_log_root.ts",
];

/** Production imports of the commit-log unit from outside v3. */
const PINNED_COMMIT_LOG_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code outside v3 imports the commit-log unit", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      COMMIT_LOG_FILES.some((file) =>
        importsLayer(filePath, importPath, file)
      ) && !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_COMMIT_LOG_IMPORTERS,
    "Production imports of the dormant commit-log unit",
    "The commit-log unit of work is dormant until the v3 opt-in opens it\n" +
      "over a v3 repository context. Do not import it from production code\n" +
      "before then.",
  );
});

/** A pragma that checkpoints the WAL or changes when it is checkpointed. */
const CHECKPOINT = /wal_(?:auto)?checkpoint/i;

/** v3 files that mention a checkpoint pragma, as `file:line`. */
const PINNED_V3_CHECKPOINTS: readonly string[] = [
  // Auto-checkpoint off on a copy Litestream replicates (swamp-club#3935).
  "src/infrastructure/datastore_v3/sqlite_commit_store.ts:2482",
];

Deno.test("datastore v3: no v3 code forces or tunes a WAL checkpoint", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (!isV3File(rel)) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (CHECKPOINT.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_V3_CHECKPOINTS,
    "WAL checkpoint pragmas in v3 code",
    "commits.db never forces a checkpoint, and only a replicated copy turns\n" +
      "auto-checkpoint off: Litestream replicates the WAL. See\n" +
      "design/enablers/datastore-litestream.md.",
  );
});

/**
 * A string or template literal that starts with a partition-key prefix. It
 * can also match unrelated text that happens to start that way (help text
 * such as `"run--dry"`). For such a false positive, pin the `file:line` in
 * PINNED_HAND_BUILT_KEYS with a comment saying it is not a key.
 */
const HAND_BUILT_KEY = /["'`](?:model|run|config|definition)--/;

/** The one file allowed to spell partition keys. */
const KEY_BUILDER = `${V3_DIR}/partition_key.ts`;

/** Hand-built partition keys outside `partition_key.ts`, as `file:line`. */
const PINNED_HAND_BUILT_KEYS: readonly string[] = [];

Deno.test("datastore v3: partition keys are built only by partitionOf()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === KEY_BUILDER) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (HAND_BUILT_KEY.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_HAND_BUILT_KEYS,
    "Hand-built partition keys",
    "Build partition keys with partitionOf() from the aggregate's identity\n" +
      `(${KEY_BUILDER}), not by hand.`,
  );
});

const FS_STORAGE = "src/infrastructure/persistence/fs_datastore_storage.ts";

/** Production imports of the filesystem storage. */
const PINNED_FS_STORAGE_IMPORTERS: readonly string[] = [
  // A bucket v3 datastore's chunks go through its provider's storage()
  // (swamp-club#3534); the binding never builds a filesystem storage.
  // swamp-club#3279: a filesystem v3 datastore stores its chunks in the
  // filesystem storage.
  "src/infrastructure/datastore_v3/v3_datastore.ts -> src/infrastructure/persistence/fs_datastore_storage.ts",
  // swamp-club#3617: `doctor datastores` stats a filesystem v3 datastore's
  // chunks for torn ones; it never reads, writes or deletes one.
  "src/infrastructure/datastore_v3/v3_content_inspection.ts -> src/infrastructure/persistence/fs_datastore_storage.ts",
  // swamp-club#3985: a checkout whose upstream is serve caches chunks in a
  // filesystem storage under its own .swamp/, with serve behind it.
  "src/infrastructure/datastore_v3/serve_datastore_storage.ts -> src/infrastructure/persistence/fs_datastore_storage.ts",
];

Deno.test("datastore v3: no production code imports the filesystem storage", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      importsLayer(
        filePath,
        importPath,
        "infrastructure/persistence/fs_datastore_storage.ts",
      ),
  );
  assertPinnedSet(
    edges,
    PINNED_FS_STORAGE_IMPORTERS,
    "Production imports of the filesystem storage",
    "Only a filesystem v3 datastore stores chunks in the filesystem\n" +
      "storage. Do not import it from anywhere else.",
  );
});

/** A call of a provider's `storage()`: `.storage(` or `.storage?.(`. */
const STORAGE_CALL = /\.storage\??\.?\(/;

/** Production calls of a provider's `storage()`, as `file:line`. */
const PINNED_STORAGE_CALLS: readonly string[] = [
  // swamp-club#3534: setup checks a bucket holds no chunk, and the binding
  // gives a bucket v3 datastore its chunk storage.
  "src/infrastructure/datastore_v3/v3_bucket_setup.ts:131",
  "src/infrastructure/datastore_v3/v3_datastore_binding.ts:361",
];

Deno.test("datastore v3: no production code calls a provider's storage()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (isUnder(rel, V3_DIR) || rel === FS_STORAGE) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (STORAGE_CALL.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_STORAGE_CALLS,
    "Production calls of DatastoreProvider.storage()",
    "A provider's chunk storage is reached only by the v3 binding and\n" +
      "setup's target check (swamp-club#3534).",
  );
});

const COMMIT_STORE = "src/infrastructure/datastore_v3/sqlite_commit_store.ts";

/** A statement that changes one of `commits.db`'s tables. */
const COMMIT_TABLE_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:commits|partition_heads|partition_snapshots|chunk_refs|chunk_ref_counts|compaction|compacted_partitions|compacted_txns|base_records|base_versions|base_catalog|base_forwards|base_files|released_chunks)\b/i;

/** v3 files other than the commit store that write its tables, as `file:line`. */
const PINNED_COMMIT_TABLE_WRITERS: readonly string[] = [];

Deno.test("datastore v3: only the commit store writes commits.db's tables", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (!isV3File(rel) || rel === COMMIT_STORE) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (COMMIT_TABLE_WRITE.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_COMMIT_TABLE_WRITERS,
    "Writes to commits.db's tables outside the commit store",
    "The commit store is the only writer of commits: append through the\n" +
      "CommitStore port. The read model only reads commits.",
  );
});

/** Production importers of `openCommitsDatabase` outside the commit store. */
const PINNED_COMMITS_DB_OPENERS: readonly string[] = [];

Deno.test("datastore v3: only the commit store opens commits.db", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === COMMIT_STORE) continue;
    if ((await Deno.readTextFile(filePath)).includes("openCommitsDatabase")) {
      found.push(rel);
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_COMMITS_DB_OPENERS,
    "Production code opening commits.db outside the commit store",
    "Open commits.db only through SqliteCommitStore.open.",
  );
});

Deno.test("datastore v3: the read model's state directory is never a datastore directory", () => {
  const datastoreDirs = new Set<string>([
    ...DEFAULT_DATASTORE_SUBDIRS,
    ...ALWAYS_LOCAL_SUBDIRS,
  ]);
  assertEquals(
    datastoreDirs.has(READ_MODEL_STATE_DIR),
    false,
    `${READ_MODEL_STATE_DIR} must stay out of DEFAULT_DATASTORE_SUBDIRS and ALWAYS_LOCAL_SUBDIRS: it holds one checkout's cursor and must never be synced`,
  );
  // No namespace may be named after the state directory, or its cache root
  // would be the state directory. Namespace validation refuses any name
  // starting with `_`, which this pins for the state directory's name.
  assertThrows(() => restoreNamespace(READ_MODEL_STATE_DIR));
  assertEquals(MATERIALISED_SUBDIRS.has(READ_MODEL_STATE_DIR), false);
  for (const dir of MATERIALISED_SUBDIRS) {
    assertEquals(
      datastoreDirs.has(dir),
      true,
      `${dir} is not a datastore directory`,
    );
  }
});

Deno.test("datastore v3: the stream directories are datastore directories no key materialises into", () => {
  const always: readonly string[] = ALWAYS_LOCAL_SUBDIRS;
  const defaults: readonly string[] = DEFAULT_DATASTORE_SUBDIRS;
  for (const dir of REPO_LOCAL_STREAM_SUBDIRS) {
    assertEquals(
      defaults.includes(dir),
      true,
      `${dir} is not a datastore directory`,
    );
    assertEquals(always.includes(dir), false, `${dir} is always-local`);
    assertEquals(
      MATERIALISED_SUBDIRS.has(dir),
      false,
      `${dir} has no v3 home, so no record key may be materialised into it`,
    );
  }
});

/**
 * A datastore-resolver call naming a stream directory, by `SWAMP_SUBDIRS`
 * member or literal.
 */
const STREAM_DIR_RESOLVE =
  /\b(?:resolvePath|dsPath)\(\s*(?:SWAMP_SUBDIRS\.(?:audit|telemetry|logs|files)\b|["'`](?:audit|telemetry|logs|files)(?:["'`/]))/;

/** Production resolver calls naming a stream directory, as `file:line`. */
const PINNED_STREAM_DIR_RESOLVES: readonly string[] = [];

Deno.test("datastore v3: no production code resolves a stream directory through the datastore", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (STREAM_DIR_RESOLVE.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_STREAM_DIR_RESOLVES,
    "Datastore-resolved stream directories",
    "audit, telemetry, logs and files have no v3 home: a write through the\n" +
      "datastore would sync on v2 and silently stop on v3. Give the directory\n" +
      "a v3 home first (design/enablers/datastores.md, v3 stream directories).",
  );
});

/** A use of a stream directory's `SWAMP_SUBDIRS` name. */
const STREAM_DIR_NAME = /\bSWAMP_SUBDIRS\.(?:audit|telemetry|logs|files)\b/;

/**
 * Production files using a stream directory's `SWAMP_SUBDIRS` name. Each
 * builds a repo-local or user-global path, never a datastore one, so a
 * resolver call through a variable cannot slip past the rule above
 * unreviewed.
 */
const PINNED_STREAM_DIR_USERS: readonly string[] = [
  // swampPath(repoDir, audit): the doctor's write probe.
  "src/cli/commands/doctor_audit.ts",
  // .gitignore entries and the user-global telemetry spool.
  "src/domain/repo/repo_service.ts",
  // swampPath(repoDir, telemetry): the default, overridden by every caller.
  "src/infrastructure/persistence/json_telemetry_repository.ts",
  // swampPath(repoDir, audit): command audit.
  "src/infrastructure/persistence/jsonl_audit_repository.ts",
  // swampPath(repoDir, audit): vault audit.
  "src/infrastructure/persistence/jsonl_vault_audit_repository.ts",
  // globalTelemetryDir: the user-global spool.
  "src/infrastructure/persistence/paths.ts",
  // swampPath(repoDir, audit): `doctor datastores --retention` lists the
  // command audit days, read-only (swamp-club#3473).
  "src/libswamp/datastores/retention_check.ts",
  // swampPath(repoDir, telemetry): drains the legacy repo-local spool.
  "src/infrastructure/persistence/telemetry_spool_migration.ts",
];

Deno.test("datastore v3: every use of a stream directory's name is reviewed", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (STREAM_DIR_NAME.test(await Deno.readTextFile(filePath))) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_STREAM_DIR_USERS,
    "Production uses of a stream directory's SWAMP_SUBDIRS name",
    "audit, telemetry, logs and files stay repo-local on v3. Build their\n" +
      "paths with swampPath (or the user-global config dir), never through a\n" +
      "datastore resolver, then pin the file here.",
  );
});

const CHUNK_COLLECTOR = "domain/datastore_v3/chunk_collector.ts";

/** Production imports of the chunk collector from outside v3. */
const PINNED_CHUNK_COLLECTOR_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code outside v3 imports the chunk collector", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      importsLayer(filePath, importPath, CHUNK_COLLECTOR) &&
      !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_CHUNK_COLLECTOR_IMPORTERS,
    "Production imports of the dormant chunk collector",
    "Chunk garbage collection is dormant until a v3 datastore gc is wired\n" +
      "in at the opt-in. Do not import it from production code before then.",
  );
});

/** Production mentions of `removeStaleTempFiles` outside the storage. */
const PINNED_TEMP_FILE_SWEEPS: readonly string[] = [];

Deno.test("datastore v3: no production code sweeps storage temp files", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === FS_STORAGE || isV3File(rel)) continue;
    // The port's declaration beside storage/1.
    if (rel === "src/domain/datastore/datastore_storage.ts") continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (line.includes("removeStaleTempFiles")) {
        found.push(`${rel}:${index + 1}`);
      }
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_TEMP_FILE_SWEEPS,
    "Production calls of removeStaleTempFiles",
    "Removing a storage's temp files is part of chunk garbage collection,\n" +
      "which is dormant until the v3 opt-in wires it in.",
  );
});

/** The compaction modules, under `src/`. */
const COMPACTION_MODULES = [
  "domain/datastore_v3/compaction.ts",
  "domain/datastore_v3/compaction_policy.ts",
  "domain/datastore_v3/run_artifact_resolution.ts",
];

/** Production imports of the compaction modules from outside v3. */
const PINNED_COMPACTION_IMPORTERS: readonly string[] = [
  // swamp-club#3279: run-record artifacts resolve through the resolver on
  // v3, where a removed version can be written again.
  "src/libswamp/data/run_artifact_check.ts -> src/domain/datastore_v3/run_artifact_resolution.ts",
  "src/libswamp/models/output_data.ts -> src/domain/datastore_v3/run_artifact_resolution.ts",
];

Deno.test("datastore v3: no production code outside v3 imports history compaction", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      COMPACTION_MODULES.some((module) =>
        importsLayer(filePath, importPath, module)
      ) && !isV3File(repoRelative(filePath)),
  );
  assertPinnedSet(
    edges,
    PINNED_COMPACTION_IMPORTERS,
    "Production imports of the dormant history compaction",
    "History compaction is dormant until the v3 opt-in wires it in. Do not\n" +
      "import it from production code before then.",
  );
});

/** Production mentions of `compactHistory` outside v3. */
const PINNED_COMPACT_HISTORY_CALLS: readonly string[] = [];

Deno.test("datastore v3: no production code outside v3 compacts history", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (isV3File(rel)) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (line.includes("compactHistory")) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_COMPACT_HISTORY_CALLS,
    "Production calls of compactHistory",
    "Compacting history deletes commits. It is dormant until the v3 opt-in\n" +
      "wires it in.",
  );
});

const LITESTREAM_DIR = "src/infrastructure/datastore_v3/litestream";
const LITESTREAM_MODULES = [
  "infrastructure/datastore_v3/litestream/litestream_binary_provider.ts",
  "infrastructure/datastore_v3/litestream/litestream_pin.ts",
];

/** Production imports of the Litestream provider or pin, in or out of v3. */
const PINNED_LITESTREAM_IMPORTERS: readonly string[] = [
  // The provider reads the pin it verifies against.
  "src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts -> src/infrastructure/datastore_v3/litestream/litestream_pin.ts",
  // swamp-club#3416: a writer resolves the binary before it starts a
  // sidecar, and the supervisor again right before it runs Litestream, so
  // the hash is checked before every start.
  "src/infrastructure/datastore_v3/litestream/replication_supervisor_entry.ts -> src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts",
  "src/infrastructure/datastore_v3/litestream/v3_replication.ts -> src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts",
  // swamp-club#3534: binding a bucket datastore checks the pinned release
  // can replicate on this platform (Windows below the pin cannot).
  "src/infrastructure/datastore_v3/v3_datastore_binding.ts -> src/infrastructure/datastore_v3/litestream/litestream_pin.ts",
];

Deno.test("datastore v3: no production code imports the Litestream binary provider", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      LITESTREAM_MODULES.some((module) =>
        importsLayer(filePath, importPath, module)
      ),
  );
  assertPinnedSet(
    edges,
    PINNED_LITESTREAM_IMPORTERS,
    "Production imports of the Litestream binary provider",
    "Downloading and running Litestream happens only through the sidecar\n" +
      "(swamp-club#3416), started for a datastore that replicates.",
  );
});

/** Production files that mention `SWAMP_LITESTREAM_PATH`. */
const PINNED_LITESTREAM_PATH_READERS: readonly string[] = [
  `${LITESTREAM_DIR}/litestream_binary_provider.ts`,
];

Deno.test("datastore v3: only the Litestream provider reads SWAMP_LITESTREAM_PATH", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if ((await Deno.readTextFile(filePath)).includes("SWAMP_LITESTREAM_PATH")) {
      found.push(rel);
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_LITESTREAM_PATH_READERS,
    "Production mentions of SWAMP_LITESTREAM_PATH",
    "The override must reach Litestream only through the provider, which\n" +
      "hashes it against the pin. Pass a path to the provider instead.",
  );
});

/** Production files that mention the internal replica setting's variable. */
const PINNED_V3_REPLICA_READERS: readonly string[] = [
  `${LITESTREAM_DIR}/replica_setting.ts`,
];

Deno.test("datastore v3: only replica_setting.ts reads the internal replica setting", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if ((await Deno.readTextFile(filePath)).includes("SWAMP_V3_REPLICA")) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_V3_REPLICA_READERS,
    "Production readers of SWAMP_V3_REPLICA",
    "Only replica_setting.ts may read the internal replica setting tests\n" +
      "use (swamp-club#3416); a bucket datastore replicates to its own\n" +
      "target (swamp-club#3534).",
  );
});

/** Production files that call a provider's `replicaTarget()`. */
const PINNED_REPLICA_TARGET_CALLERS: readonly string[] = [
  `${LITESTREAM_DIR}/replica_target_resolver.ts`,
];

Deno.test("datastore v3: only the replica target resolver calls replicaTarget()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (/\.replicaTarget\s*\(/.test(await Deno.readTextFile(filePath))) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_REPLICA_TARGET_CALLERS,
    "Production callers of replicaTarget()",
    "A provider's replica target reaches Litestream only through\n" +
      "resolveV3ReplicaSetting, which checks it (swamp-club#3507).",
  );
});

/** Production files that call a provider's `replicaPaths()`. */
const PINNED_REPLICA_PATHS_CALLERS: readonly string[] = [
  `${LITESTREAM_DIR}/replica_target_resolver.ts`,
];

Deno.test("datastore v3: only the replica target resolver calls replicaPaths()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (/\.replicaPaths\s*\(/.test(await Deno.readTextFile(filePath))) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_REPLICA_PATHS_CALLERS,
    "Production callers of replicaPaths()",
    "A provider's replica paths reach lineage collection only through\n" +
      "resolveV3ReplicaPaths (swamp-club#3531).",
  );
});

/**
 * Production files outside the resolver that use it: the v3 binding, which
 * gives a bucket datastore its replica (swamp-club#3534).
 */
const PINNED_REPLICA_TARGET_RESOLVER_USERS: readonly string[] = [
  "src/infrastructure/datastore_v3/v3_datastore_binding.ts",
];

Deno.test("datastore v3: only the v3 binding uses the replica target resolver", async () => {
  const resolver = `${LITESTREAM_DIR}/replica_target_resolver.ts`;
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if (repoRelative(filePath) === resolver) continue;
    if (
      /\b(resolveV3ReplicaSetting|resolveV3ProviderReplica|replicaSettingFromTarget|resolveV3ReplicaPaths)\b/
        .test(
          await Deno.readTextFile(filePath),
        )
    ) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_REPLICA_TARGET_RESOLVER_USERS,
    "Production users of the replica target resolver",
    "A datastore's own replica target reaches Litestream only through the\n" +
      "v3 binding (swamp-club#3534), which every v3 helper reads.",
  );
});

/**
 * Production files that name `commits.db` (swamp-club#3482): only
 * `v3CommitsDbPath` decides which one a checkout opens, the datastore's or,
 * while replicating, the checkout's own copy.
 */
const PINNED_COMMITS_DB_NAMERS: readonly string[] = [
  "src/infrastructure/datastore_v3/v3_datastore.ts",
  // swamp-club#3617: the format guard stats (never opens) a filesystem
  // datastore's root commits.db to tell a v3 datastore whose marker a
  // crash lost from a v2 one; persistence may not import v3_datastore.ts.
  "src/infrastructure/persistence/datastore_format_guard.ts",
];

Deno.test("datastore v3: only v3_datastore.ts names commits.db", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    if (source.includes("COMMITS_DB_FILE") || source.includes('"commits.db"')) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_COMMITS_DB_NAMERS,
    "Production files naming commits.db",
    "Open the commit store through v3CommitsDbPath (or a V3Datastore's\n" +
      "commitsDbPath): while replicating, each checkout has its own copy.",
  );
});

/**
 * Production callers of `v3DatastoreFor` (swamp-club#3482). While
 * replicating it opens only a copy this process made current, so each
 * caller must run after a repository context, a writer hold or serve's
 * start has done that.
 */
const PINNED_V3_DATASTORE_FOR_CALLERS: readonly string[] = [
  "src/cli/commands/datastore_gc.ts",
  "src/cli/commands/datastore_status.ts",
  "src/cli/commands/serve.ts",
  // swamp-club#3473: after requireInitializedRepo made the copy current.
  "src/cli/retention_teardown.ts",
  "src/infrastructure/datastore_v3/v3_config_adoption.ts",
  "src/infrastructure/datastore_v3/v3_repo_context.ts",
  "src/serve/handlers/admin_handlers.ts",
];

Deno.test("datastore v3: v3DatastoreFor's callers are pinned", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    if ((await Deno.readTextFile(filePath)).includes("v3DatastoreFor(")) {
      found.push(repoRelative(filePath));
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_V3_DATASTORE_FOR_CALLERS,
    "Production callers of v3DatastoreFor",
    "Make the checkout's copy current first (a repository context, a writer\n" +
      "hold, or ensureV3CopyCurrent), then pin the caller here.",
  );
});

/**
 * A v3 engine check joined by `&&` to `!isCustomDatastoreConfig`, either
 * way round, across a statement's lines: the gate that kept a v3 extension
 * datastore on the v2 path before swamp-club#3534.
 */
const V3_NOT_CUSTOM_PAIRING =
  /"v3"\s*&&\s*!isCustomDatastoreConfig\(|!isCustomDatastoreConfig\([^()]*\)\s*&&[^;{]{0,120}"v3"/;

/** Production statements still pairing them, as `file:line`. */
const PINNED_V3_NOT_CUSTOM_PAIRINGS: readonly string[] = [];

Deno.test("datastore v3: no production code keeps a v3 extension datastore off the v3 path", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("isCustomDatastoreConfig(")) return;
      // Most pairings break across two or three lines.
      const window = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
      if (V3_NOT_CUSTOM_PAIRING.test(window)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_V3_NOT_CUSTOM_PAIRINGS,
    "Production v3 checks that leave out extension datastores",
    "A v3 extension datastore opens through its binding (swamp-club#3534):\n" +
      "check the engine alone and pass v3DatastoreConfigOf(repoDir, config)\n" +
      "to the v3 helpers.",
  );
});

/** Production files that build a bucket datastore's namespaced store. */
const PINNED_BUCKET_NAMESPACED_STORE_USERS: readonly string[] = [
  // Signal waits and retention watermarks, through v3BucketNamespacedStoreAt.
  "src/infrastructure/datastore_v3/v3_repo_context.ts",
];

Deno.test("datastore v3: a bucket datastore's namespaced records live only under ns/", async () => {
  const binding = "src/infrastructure/datastore_v3/v3_datastore_binding.ts";
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === binding) continue;
    const source = await Deno.readTextFile(filePath);
    if (
      /\bv3BucketNamespacedStore\b|\bV3_BUCKET_NAMESPACED_PREFIX\b/.test(source)
    ) {
      found.push(rel);
    }
  }
  assertPinnedSet(
    found.sort(),
    PINNED_BUCKET_NAMESPACED_STORE_USERS,
    "Production users of the bucket namespaced store",
    "A bucket datastore's namespaced records go under ns/<namespace>/ of\n" +
      "its control plane, which only the v3 binding builds, so they never\n" +
      "meet the lease's writer/ or the lineages' lineage/ (swamp-club#3534).",
  );
  const source = await Deno.readTextFile(join(SRC_DIR, "..", binding));
  assert(
    /export const V3_BUCKET_NAMESPACED_PREFIX = "ns";/.test(source),
    "the bucket namespaced prefix moved off ns",
  );
});

Deno.test("datastore v3: a bucket datastore's marker is confirmed before every lease and copy", async () => {
  const lock = await Deno.readTextFile(
    join(SRC_DIR, "infrastructure", "datastore_v3", "v3_writer_lock.ts"),
  );
  const takeLease = lock.slice(
    lock.indexOf("async function takeLease("),
    lock.indexOf("/** Called whenever this process takes"),
  );
  assert(
    takeLease.indexOf("confirmMarker()") >= 0 &&
      takeLease.indexOf("confirmMarker()") < takeLease.indexOf(".acquire("),
    "takeLease must confirm a bucket datastore's marker before the lease",
  );
  // Every lease is taken through takeLease. Building the lease resolves this
  // process's identity (swamp-club#3564), so it is awaited first.
  assertEquals(
    [...lock.matchAll(/\(await writerLease\([^)]*\)\)\.acquire\(/g)].length,
    1,
    "a lease is acquired outside takeLease",
  );
  const copy = await Deno.readTextFile(
    join(SRC_DIR, "infrastructure", "datastore_v3", "litestream", "v3_copy.ts"),
  );
  const current = copy.slice(
    copy.indexOf("async function makeV3CopyCurrentNow("),
    copy.indexOf("async function dropSharedOutboxEntries("),
  );
  assert(
    current.indexOf("confirmMarker()") >= 0 &&
      current.indexOf("confirmMarker()") < current.indexOf("registry.read("),
    "makeV3CopyCurrent must confirm a bucket datastore's marker first",
  );
});

/** Litestream runs (`new Deno.Command(binary`) in the sidecar's files. */
const LITESTREAM_RUNS = /new Deno\.Command\(binary\b/;

Deno.test("datastore v3: Litestream runs only with its replica's environment", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (!isUnder(rel, LITESTREAM_DIR)) continue;
    const source = await Deno.readTextFile(filePath);
    const runs = source.split("\n").filter((line) =>
      LITESTREAM_RUNS.test(line)
    );
    const narrowed = (source.match(/litestreamChildEnv\(/g) ?? []).length;
    if (runs.length > narrowed) found.push(rel);
  }
  assertEquals(
    found,
    [],
    "Each Litestream run gets litestreamChildEnv(...) with clearEnv: only\n" +
      "what its replica needs (swamp-club#3534).",
  );
});

/**
 * A `follower` option passed (swamp-club#3985): an object property, not the
 * stores' own `#follower` field or constructor parameter.
 */
const FOLLOWER_OPTION = /(?<![#\w.])follower\s*:(?!\s*boolean\b)/;

/** Where follower mode may be turned on: serve's team-mode plumbing. */
function mayOpenFollower(rel: string): boolean {
  if (rel === "src/infrastructure/datastore_v3/v3_datastore.ts") return true;
  const dir = "src/infrastructure/datastore_v3/";
  if (!rel.startsWith(dir)) return false;
  const name = rel.slice(dir.length);
  return !name.includes("/") && name.startsWith("serve_");
}

/** Production files outside {@link mayOpenFollower} passing `follower`. */
const PINNED_FOLLOWER_OPENERS: readonly string[] = [];

Deno.test("datastore v3: only serve's team-mode plumbing opens a follower commit store or read model", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (mayOpenFollower(rel)) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    if (lines.some((line) => FOLLOWER_OPTION.test(line))) found.push(rel);
  }
  assertPinnedSet(
    found.sort(),
    PINNED_FOLLOWER_OPENERS,
    "Production files passing a follower option outside v3_datastore.ts and serve_*.ts",
    "Follower mode accepts gapped seqs, which only a copy of serve's log\n" +
      "may hold (swamp-club#3985). Open the store or read model in follower\n" +
      "mode from v3_datastore.ts or a src/infrastructure/datastore_v3/serve_*.ts\n" +
      "file, never elsewhere.",
  );
});

Deno.test("datastore v3: the follower rule sees a follower option and nothing else", () => {
  assert(FOLLOWER_OPTION.test("  follower: true,"));
  assert(FOLLOWER_OPTION.test("{ follower: isTeam }"));
  assert(!FOLLOWER_OPTION.test("  readonly #follower: boolean;"));
  assert(!FOLLOWER_OPTION.test("    follower: boolean,"));
  assert(!FOLLOWER_OPTION.test("  readonly follower?: boolean;"));
  assert(!FOLLOWER_OPTION.test("this.#follower = options.follower === true;"));
  assert(mayOpenFollower("src/infrastructure/datastore_v3/v3_datastore.ts"));
  assert(mayOpenFollower("src/infrastructure/datastore_v3/serve_feed.ts"));
  assert(!mayOpenFollower("src/infrastructure/datastore_v3/solo_feed.ts"));
  assert(!mayOpenFollower("src/serve/serve_feed.ts"));
  assert(!mayOpenFollower("src/infrastructure/datastore_v3/x/serve_feed.ts"));
});
