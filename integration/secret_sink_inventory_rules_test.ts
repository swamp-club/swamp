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

// Fitness ratchet on the typed-secrets sink inventory (swamp-club#3511).
//
// integration/secret_sink_inventory.json lists every place swamp writes or
// emits a value derived from an expression, every boundary where plaintext
// is allowed, and every protected secret path. Later phase gates of
// design/enablers/typed-secrets.md are measured against that list, so it must
// not go stale. These rules keep it honest:
//
// 1. Every destination Section 7.1 names (each table row, and each
//    backticked name in its inventory paragraph) is covered by an entry.
//    The names are read from the design doc, so editing the doc forces an
//    inventory update.
// 2. Every anchor still exists, so a moved or renamed seam fails as GONE.
// 3. Every site found by the primitive scans below is an anchor or a pinned
//    NOT_A_SINK entry with a reason. Keys name the repo-relative file and
//    the top-level declaration that holds the site, never a line number.
// 4. Every workflow event kind and every remote protocol verb is an anchor.
// 5. Every gate names a section and a phase heading the design doc has.
// 6. Every boundary and protected entry names a test that exists.
//
// File-write primitives are scanned only in the layers that persist
// expression-derived values (persistence, datastore v3, serve audit, serve,
// worker). Widening that scope is a deliberate edit to WRITE_SCAN_DIRS.

import { assert, assertEquals, assertGreater } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import {
  assertPinnedSet,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
  TOP_LEVEL_DECLARATION,
  topLevelOwners,
} from "./arch_fitness_helpers.ts";

const InventorySchema = z.object({
  description: z.string(),
  entries: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      family: z.enum([
        "persisted-records",
        "datastore-v3",
        "events-and-logs",
        "remote",
        "serve",
        "telemetry-and-trace",
        "cli-audit",
        "process-and-temp",
        "boundaries",
      ]),
      kind: z.enum(["prohibited", "boundary", "protected"]),
      covers: z.array(z.string()),
      anchors: z.array(z.string().regex(/^src\/\S+\.tsx?: \S+$/)).min(1),
      observe: z.string().min(1),
      gate: z.object({ section: z.string(), phase: z.string() }),
      test: z.object({ file: z.string(), name: z.string() }).optional(),
    }).strict(),
  ),
}).strict();

const INVENTORY = InventorySchema.parse(
  JSON.parse(
    await Deno.readTextFile(
      join(ROOT, "integration", "secret_sink_inventory.json"),
    ),
  ),
);

const DESIGN_DOC = await Deno.readTextFile(
  join(ROOT, "design", "enablers", "typed-secrets.md"),
);

const ANCHORS = new Set(INVENTORY.entries.flatMap((e) => e.anchors));

const POLICY =
  "Add the site to an entry's anchors in integration/secret_sink_inventory.json " +
  "if it can write or emit a value derived from an expression, or pin it in " +
  "NOT_A_SINK in this test with the reason it cannot.";

// ---------------------------------------------------------------------------
// Rule 1: Section 7.1 destinations are covered
// ---------------------------------------------------------------------------

/** The destinations Section 7.1 names: table rows and backticked names. */
function section71Destinations(doc: string): string[] {
  const start = doc.indexOf("### 7.1 Destination contract");
  assert(start >= 0, "design doc has no Section 7.1 heading");
  const next = doc.indexOf("\n### ", start + 1);
  const end = next < 0 ? doc.length : next;
  const lines = doc.slice(start, end).split("\n");
  const names = new Set<string>();
  for (const line of lines) {
    if (line.startsWith("|")) {
      const cell = line.split("|")[1].trim();
      if (cell === "Destination" || /^-+$/.test(cell)) continue;
      names.add(cell.replaceAll("`", ""));
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) names.add(match[1]);
  }
  return [...names].sort();
}

Deno.test("secret sink inventory: every Section 7.1 destination is covered", () => {
  const destinations = section71Destinations(DESIGN_DOC);
  // Proves the extractor still finds the table and the paragraph.
  assertGreater(destinations.length, 20);
  const covered = new Set(INVENTORY.entries.flatMap((e) => e.covers));
  const missing = destinations.filter((d) => !covered.has(d));
  assertEquals(
    missing,
    [],
    "Section 7.1 names destinations no inventory entry covers. Add them to " +
      "an entry's covers in integration/secret_sink_inventory.json.",
  );
  const unknown = [...covered].filter((c) => !destinations.includes(c));
  assertEquals(
    unknown,
    [],
    "Inventory covers names Section 7.1 no longer has. Remove them.",
  );
});

Deno.test("secret sink inventory: entry ids are unique", () => {
  const ids = INVENTORY.entries.map((e) => e.id);
  assertEquals(ids.length, new Set(ids).size);
});

// ---------------------------------------------------------------------------
// Event kinds and protocol verbs (anchors for rules 2 and 4)
// ---------------------------------------------------------------------------

const EVENTS_FILE = "src/domain/workflows/execution_events.ts";
const PROTOCOL_FILE = "src/domain/remote/protocol.ts";

/**
 * The statement that begins at `start`, up to its closing `;`, with comments
 * removed. Brackets and string literals are tracked, so a `;` or `}` inside
 * a nested object type, a string or a comment never ends it early.
 */
function statementAt(code: string, start: string): string {
  const from = code.indexOf(start);
  assert(from >= 0, `missing ${start}`);
  let depth = 0;
  let out = "";
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "*") {
      i = code.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i = code.indexOf("\n", i) - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j;
      continue;
    }
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === ";" && depth === 0) return out + ch;
    out += ch;
  }
  throw new Error(`no end to the statement at ${start}`);
}

const EVENTS_CODE = await Deno.readTextFile(join(ROOT, EVENTS_FILE));
const PROTOCOL_CODE = await Deno.readTextFile(join(ROOT, PROTOCOL_FILE));

/** `<file>: <kind>` for every member of the WorkflowExecutionEvent union. */
const EVENT_KINDS = new Set(
  [
    ...statementAt(EVENTS_CODE, "export type WorkflowExecutionEvent =")
      .matchAll(/\bkind: "([a-z_]+)"/g),
  ].map((m) => `${EVENTS_FILE}: ${m[1]}`),
);

/** `<file>: <verb>` for every RemoteMethod and WorkerMethod value. */
const PROTOCOL_VERBS = new Set(
  ["export const RemoteMethod =", "export const WorkerMethod ="].flatMap((
    start,
  ) =>
    [
      ...statementAt(PROTOCOL_CODE, start).matchAll(
        /:\s*"((?:worker|capability)\.[\w.]+)"/g,
      ),
    ].map((m) => `${PROTOCOL_FILE}: ${m[1]}`)
  ),
);

// ---------------------------------------------------------------------------
// Rule 2: anchors exist
// ---------------------------------------------------------------------------

/** Whether `name` is a top-level declaration in `code`. */
function declares(code: string, name: string): boolean {
  return code.split("\n").some((line) =>
    line.match(TOP_LEVEL_DECLARATION)?.[1] === name
  );
}

Deno.test("secret sink inventory: every anchor exists", async () => {
  const gone: string[] = [];
  for (const anchor of ANCHORS) {
    // An event kind or protocol verb exists while the scan still finds it.
    if (EVENT_KINDS.has(anchor) || PROTOCOL_VERBS.has(anchor)) continue;
    const [file, name] = anchor.split(": ");
    let code: string;
    try {
      code = await Deno.readTextFile(join(ROOT, file));
    } catch {
      gone.push(anchor);
      continue;
    }
    if (!declares(code, name)) gone.push(anchor);
  }
  assertEquals(
    gone.sort(),
    [],
    "Inventory anchors no longer found. Point the entry at the seam's new " +
      "home rather than deleting the anchor.",
  );
});

// ---------------------------------------------------------------------------
// Rule 3: primitive scans
// ---------------------------------------------------------------------------

/** Production files that are test or benchmark support. */
function isTestSupport(rel: string): boolean {
  return rel.includes("/test_helpers/") ||
    rel.startsWith("src/infrastructure/testing/") ||
    rel.endsWith("_test_helpers.ts") ||
    rel.endsWith("_bench.ts");
}

const WRITE_SCAN_DIRS = [
  "src/infrastructure/persistence/",
  "src/infrastructure/datastore_v3/",
  "src/domain/serve_audit/",
  "src/serve/",
  "src/worker/",
];

interface PrimitiveScan {
  family: string;
  pattern: RegExp;
  dirs?: readonly string[];
  /** The scan must find more sites than this, proving the pattern matches. */
  floor: number;
}

const PRIMITIVE_SCANS: readonly PrimitiveScan[] = [
  { family: "sqlite", pattern: /\bnew DatabaseSync\s*\(/, floor: 5 },
  { family: "spawn", pattern: /\bnew Deno\.Command\s*\(/, floor: 20 },
  {
    family: "temp",
    pattern: /\bDeno\.makeTemp(?:Dir|File)(?:Sync)?\s*\(/,
    floor: 5,
  },
  {
    family: "span-status",
    pattern: /\.setStatus\s*\(|\brecordSpanError\s*\(/,
    floor: 3,
  },
  {
    family: "file-write",
    pattern:
      /\bDeno\.(?:writeTextFile|writeFile|create)(?:Sync)?\s*\(|\batomicWrite\w*\s*\(/,
    dirs: WRITE_SCAN_DIRS,
    floor: 20,
  },
];

const TOOLING = "Runs a fixed tool (system service manager, git, deno, " +
  "litestream, an editor or browser); its argv comes from code or " +
  "configuration, never from an expression.";
const CLI_REINVOCATION = "Re-runs swamp with operator-supplied CLI " +
  "arguments; no expression is evaluated into its argv.";
const READ_ONLY_DB = "Opens a database to read or verify it; writes nothing " +
  "derived from an expression.";
const UNEVALUATED_TEMP = "Temporary files for editing issues, building or " +
  "publishing extensions, updates or diagnostics; no expression is " +
  "evaluated into them.";
const VALUE_FREE_STATUS = "Span status is fixed text, an HTTP status, or a " +
  "datastore lock or sync failure; no expression value reaches it.";
const CONFIG_WRITE = "Writes configuration, credentials, identity, locks, " +
  "markers or replication state; no expression is evaluated into it.";
const AUTHORED_SOURCE = "Persists authored source, where secrets appear only " +
  "as references.";

/** Scanned sites that are not sinks, with the reason. */
const NOT_A_SINK: Record<string, Record<string, string>> = {
  "sqlite": {
    "src/infrastructure/datastore_v3/litestream/litestream_restorer.ts: checkDatabase":
      READ_ONLY_DB,
    "src/infrastructure/datastore_v3/litestream/v3_copy.ts: commitsIn":
      READ_ONLY_DB,
    "src/infrastructure/datastore_v3/litestream/v3_copy.ts: txnAt":
      READ_ONLY_DB,
    "src/infrastructure/datastore_v3/v3_datastore.ts: listV3Namespaces":
      READ_ONLY_DB,
    "src/infrastructure/persistence/extension_catalog_store.ts: ExtensionCatalogStore":
      "Indexes installed extension metadata; no expression is evaluated into it.",
  },
  "spawn": {
    "src/cli/commands/datastore_setup.ts: datastoreSetupCommand":
      CLI_REINVOCATION,
    "src/cli/commands/doctor_audit.ts: makeSwampSpawnFn": CLI_REINVOCATION,
    "src/cli/commands/vault_migrate.ts: vaultMigrateCommand": CLI_REINVOCATION,
    "src/cli/commands/workflow_search.ts: workflowSearchAction":
      CLI_REINVOCATION,
    "src/serve/local/workspace_hub.ts: SWAMP_CLI_ACTIONS": CLI_REINVOCATION,
    "src/serve/local/workspace_hub.ts: spawnDashboardChild": CLI_REINVOCATION,
    "src/cli/context.ts: getGitRootSync": TOOLING,
    "src/domain/extensions/extension_quality_checker.ts: checkExtensionQuality":
      TOOLING,
    "src/domain/extensions/extension_rubric_scorer.ts: createRubricScoreDeps":
      TOOLING,
    "src/domain/models/bundle.ts: bundleExtension": TOOLING,
    "src/infrastructure/daemon/has_systemctl.ts: hasSystemctl": TOOLING,
    "src/infrastructure/daemon/launchd_service_scheduler.ts: LaunchdServiceScheduler":
      TOOLING,
    "src/infrastructure/daemon/launchd_service_scheduler.ts: getUid": TOOLING,
    "src/infrastructure/daemon/launchd_worker_scheduler.ts: LaunchdWorkerScheduler":
      TOOLING,
    "src/infrastructure/daemon/launchd_worker_scheduler.ts: getUid": TOOLING,
    "src/infrastructure/daemon/systemd_service_scheduler.ts: systemctl":
      TOOLING,
    "src/infrastructure/daemon/systemd_worker_scheduler.ts: systemctl": TOOLING,
    "src/infrastructure/datastore_v3/boot_identity.ts: catBootId": TOOLING,
    "src/infrastructure/datastore_v3/boot_identity.ts: readBootIdentity":
      TOOLING,
    "src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts: clearMacOSQuarantine":
      TOOLING,
    "src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts: defaultLitestreamExtractor":
      TOOLING,
    "src/infrastructure/datastore_v3/litestream/litestream_processes.ts: hostLitestreamProcesses":
      TOOLING,
    "src/infrastructure/datastore_v3/litestream/litestream_restorer.ts: runRestore":
      TOOLING,
    "src/infrastructure/datastore_v3/litestream/replication_supervisor_entry.ts: hostSupervisorDeps":
      TOOLING,
    "src/infrastructure/editor/editor_service.ts: EditorService": TOOLING,
    "src/infrastructure/github/github_issue_service.ts: GitHubIssueService":
      TOOLING,
    "src/infrastructure/persistence/git_worktree.ts: resolveGitMainWorktreeRoot":
      TOOLING,
    "src/infrastructure/process/browser.ts: defaultDeps": TOOLING,
    "src/infrastructure/process/folder_picker.ts: createSystemFolderPicker":
      TOOLING,
    "src/infrastructure/process/gh_cli.ts: defaultGhRunner": TOOLING,
    "src/infrastructure/process/process_executor.ts: terminateWindowsTree":
      TOOLING,
    "src/infrastructure/process/process_kill.ts: findChildPids": TOOLING,
    "src/infrastructure/process/process_kill.ts: isSwampProcess": TOOLING,
    "src/infrastructure/process/process_kill.ts: processStartTimes": TOOLING,
    "src/infrastructure/process/resolve_command.ts: defaultLookupRunner":
      TOOLING,
    "src/infrastructure/process/terminal/terminal_launcher.ts: createSystemTerminalLauncher":
      TOOLING,
    "src/infrastructure/process/terminal/terminal_launcher.ts: lookupExecutable":
      TOOLING,
    "src/infrastructure/runtime/deno_info_module_graph_reader.ts: DenoInfoModuleGraphReader":
      TOOLING,
    "src/infrastructure/runtime/embedded_deno_runtime.ts: EmbeddedDenoRuntime":
      TOOLING,
    "src/infrastructure/runtime/process.ts: getOpenFileSoftLimitPosix": TOOLING,
    "src/infrastructure/runtime/process.ts: isProcessDeadWindows": TOOLING,
    "src/infrastructure/runtime/process_bundle_prober.ts: startProbeHost":
      TOOLING,
    "src/infrastructure/security/file_security_check.ts: checkWindowsAcl":
      TOOLING,
    "src/infrastructure/update/cron_scheduler.ts: readCrontab": TOOLING,
    "src/infrastructure/update/cron_scheduler.ts: readCrontabForUser": TOOLING,
    "src/infrastructure/update/cron_scheduler.ts: writeCrontab": TOOLING,
    "src/infrastructure/update/cron_scheduler.ts: writeCrontabForUser": TOOLING,
    "src/infrastructure/update/http_update_checker.ts: extractZip": TOOLING,
    "src/infrastructure/update/http_update_checker.ts: removeQuarantine":
      TOOLING,
    "src/infrastructure/update/launchd_scheduler.ts: LaunchdScheduler": TOOLING,
    "src/infrastructure/update/launchd_scheduler.ts: getUid": TOOLING,
    "src/infrastructure/update/launchd_scheduler.ts: launchctl": TOOLING,
    "src/infrastructure/update/launchd_scheduler.ts: sudoUserHome": TOOLING,
    "src/infrastructure/update/scheduler_factory.ts: hasSystemctl": TOOLING,
    "src/infrastructure/update/systemd_scheduler.ts: SystemdScheduler": TOOLING,
    "src/infrastructure/update/systemd_scheduler.ts: linuxSudoUserHome":
      TOOLING,
    "src/infrastructure/update/systemd_scheduler.ts: systemctl": TOOLING,
    "src/libswamp/extensions/fmt.ts: createExtensionFmtDeps": TOOLING,
  },
  "temp": {
    "src/cli/commands/issue_bug.ts: issueBugCommand": UNEVALUATED_TEMP,
    "src/cli/commands/issue_edit.ts: issueEditCommand": UNEVALUATED_TEMP,
    "src/cli/commands/issue_feature.ts: issueFeatureCommand": UNEVALUATED_TEMP,
    "src/cli/commands/issue_ripple.ts: issueRippleCommand": UNEVALUATED_TEMP,
    "src/cli/commands/issue_security.ts: issueSecurityCommand":
      UNEVALUATED_TEMP,
    "src/domain/audit/doctor/checks/recording_smoke.ts: recordingSmokeTestCheck":
      UNEVALUATED_TEMP,
    "src/domain/extensions/extension_rubric_scorer.ts: scoreExtensionTarball":
      UNEVALUATED_TEMP,
    "src/domain/models/bundle.ts: bundleExtension": UNEVALUATED_TEMP,
    "src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts: denoLitestreamFs":
      UNEVALUATED_TEMP,
    "src/infrastructure/source/http_source_downloader.ts: HttpSourceDownloader":
      UNEVALUATED_TEMP,
    "src/infrastructure/update/http_update_checker.ts: HttpUpdateChecker":
      UNEVALUATED_TEMP,
    "src/libswamp/extensions/pull.ts: prepareInstall": UNEVALUATED_TEMP,
    "src/libswamp/extensions/push.ts: createArchive": UNEVALUATED_TEMP,
    "src/libswamp/extensions/push.ts: indexArchiveTree": UNEVALUATED_TEMP,
  },
  "span-status": {
    "src/infrastructure/persistence/datastore_sync_coordinator.ts: flushDatastoreSyncNamed":
      VALUE_FREE_STATUS,
    "src/infrastructure/persistence/datastore_sync_coordinator.ts: registerDatastoreSyncNamed":
      VALUE_FREE_STATUS,
    "src/serve/http_request_span.ts: traceHttpRequests": VALUE_FREE_STATUS,
    "src/serve/sync_gate.ts: runGated": VALUE_FREE_STATUS,
  },
  "file-write": {
    "src/infrastructure/datastore_v3/interrupted_writer_recovery.ts: writeWriterMarker":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/litestream_binary_provider.ts: defaultLitestreamExtractor":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/litestream_replicator.ts: LitestreamReplicator":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/litestream_restorer.ts: restoreV3Copy":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/replication_files.ts: markForReplacement":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/replication_files.ts: writeCopyState":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/replication_files.ts: writeLineage":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/litestream/replication_files.ts: writePresence":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/v3_config_adoption.ts: commitConfigAdoption":
      CONFIG_WRITE,
    "src/infrastructure/datastore_v3/v3_repo_context.ts: holdV3Writer":
      CONFIG_WRITE,
    "src/infrastructure/persistence/auth_repository.ts: AuthRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/auth_verification_repository.ts: AuthVerificationRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/builtin_tool_skill_dirs_repository.ts: BuiltInToolSkillDirsRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/custom_tool_skill_dirs_repository.ts: CustomToolSkillDirsRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/custom_tools_repository.ts: writeCustomTools":
      CONFIG_WRITE,
    "src/infrastructure/persistence/datastore_format_marker_writer.ts: writeDatastoreFormatMarker":
      CONFIG_WRITE,
    "src/infrastructure/persistence/drain_wait_store.ts: DrainWaitStore":
      CONFIG_WRITE,
    "src/infrastructure/persistence/extension_install_transaction.ts: defaultInstallFsOps":
      CONFIG_WRITE,
    "src/infrastructure/persistence/extension_update_check_repository.ts: FileExtensionUpdateCheckRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/file_lock.ts: FileLock": CONFIG_WRITE,
    "src/infrastructure/persistence/filesystem_datastore_verifier.ts: FilesystemDatastoreVerifier":
      CONFIG_WRITE,
    "src/infrastructure/persistence/lockfile_repository.ts: LockfileRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/namespace_manifest.ts: writeNamespaceManifest":
      CONFIG_WRITE,
    "src/infrastructure/persistence/pending_lockfile_publish.ts: markLockfilePublishPending":
      CONFIG_WRITE,
    "src/infrastructure/persistence/repo_marker_repository.ts: RepoMarkerRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/server_credential_repository.ts: FileServerCredentialRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/shared_datastore_write_tracker.ts: SharedDatastoreWriteTracker":
      CONFIG_WRITE,
    "src/infrastructure/persistence/start_server_record.ts: writeStartServerRecord":
      CONFIG_WRITE,
    "src/infrastructure/persistence/start_session_file_repository.ts: StartSessionFileRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/swamp_sources_repository.ts: writeSwampSources":
      CONFIG_WRITE,
    "src/infrastructure/persistence/telemetry_preferences_file_repository.ts: TelemetryPreferencesFileRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/user_identity_repository.ts: UserIdentityRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/workspace_preferences_file_repository.ts: WorkspacePreferencesFileRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/workspace_registry_file_repository.ts: WorkspaceRegistryFileRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/yaml_vault_config_repository.ts: YamlVaultConfigRepository":
      CONFIG_WRITE,
    "src/infrastructure/persistence/yaml_workflow_repository.ts: YamlWorkflowRepository":
      AUTHORED_SOURCE,
    "src/serve/extension_reload.ts: reloadPulledExtensions": CONFIG_WRITE,
    "src/serve/serve_config.ts: writeServeConfigFile": CONFIG_WRITE,
    "src/worker/bundle_cache.ts: WorkerBundleCache": CONFIG_WRITE,
    "src/worker/connect.ts: loadOrCreateMachineId": CONFIG_WRITE,
  },
};

/** `<file>: <top-level owner>` for every site each scan matches. */
async function scanPrimitives(): Promise<Map<string, Set<string>>> {
  const sites = new Map<string, Set<string>>(
    PRIMITIVE_SCANS.map((s) => [s.family, new Set<string>()]),
  );
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(path);
    if (isTestSupport(rel)) continue;
    const lines = (await Deno.readTextFile(path)).split("\n");
    const owners = topLevelOwners(lines);
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const scan of PRIMITIVE_SCANS) {
        if (scan.dirs && !scan.dirs.some((d) => rel.startsWith(d))) continue;
        if (scan.pattern.test(line)) {
          sites.get(scan.family)!.add(`${rel}: ${owners[i]}`);
        }
      }
    });
  }
  return sites;
}

const SCANNED = await scanPrimitives();

for (const scan of PRIMITIVE_SCANS) {
  Deno.test(`secret sink inventory: every ${scan.family} site is inventoried or excluded`, () => {
    const sites = [...SCANNED.get(scan.family)!].sort();
    assertGreater(sites.length, scan.floor);
    assertPinnedSet(
      sites.filter((s) => !ANCHORS.has(s)),
      Object.keys(NOT_A_SINK[scan.family] ?? {}).sort(),
      `Unclassified ${scan.family} sites`,
      POLICY,
    );
  });
}

// ---------------------------------------------------------------------------
// Rule 4: event kinds and protocol verbs
// ---------------------------------------------------------------------------

Deno.test("secret sink inventory: every workflow event kind is inventoried", () => {
  // Proves the union is still parsed whole.
  assertGreater(EVENT_KINDS.size, 15);
  assertPinnedSet(
    [...EVENT_KINDS].filter((k) => !ANCHORS.has(k)).sort(),
    [],
    "Workflow event kinds not in the inventory",
    "Anchor the new kind to the entry whose fields it carries " +
      "(workflow-run-events for values, identifier-destinations for names).",
  );
});

Deno.test("secret sink inventory: every remote protocol verb is inventoried", () => {
  assertGreater(PROTOCOL_VERBS.size, 10);
  assertPinnedSet(
    [...PROTOCOL_VERBS].filter((v) => !ANCHORS.has(v)).sort(),
    [],
    "Remote protocol verbs not in the inventory",
    "Anchor the new verb to dispatch-control-frames, or to " +
      "remote-secret-traffic when it carries secret values by design.",
  );
});

// ---------------------------------------------------------------------------
// Rules 5 and 6: gates and boundary tests
// ---------------------------------------------------------------------------

Deno.test("secret sink inventory: every gate names a design section and phase", () => {
  const headings = DESIGN_DOC.split("\n").filter((l) => /^#{2,3} /.test(l));
  const missing: string[] = [];
  for (const { id, gate } of INVENTORY.entries) {
    const section = headings.some((h) =>
      h.startsWith(`## ${gate.section}. `) ||
      h.startsWith(`### ${gate.section} `)
    );
    const phase = headings.some((h) => h.startsWith(`### ${gate.phase}: `));
    if (!section || !phase) {
      missing.push(`${id}: ${gate.section} / ${gate.phase}`);
    }
  }
  assertEquals(missing, []);
});

Deno.test("secret sink inventory: every boundary and protected entry names a live test", async () => {
  const problems: string[] = [];
  for (const entry of INVENTORY.entries) {
    if (entry.kind === "prohibited") {
      // Prohibited sinks are read by the swamp-uat canary suite.
      if (entry.test) {
        problems.push(`${entry.id}: prohibited entry names a test`);
      }
      continue;
    }
    if (!entry.test) {
      problems.push(`${entry.id}: no test`);
      continue;
    }
    const code = await Deno.readTextFile(join(ROOT, entry.test.file));
    if (!code.includes(`"${entry.test.name}"`)) {
      problems.push(`${entry.id}: ${entry.test.name} not found`);
    }
  }
  assertEquals(problems, []);
});
