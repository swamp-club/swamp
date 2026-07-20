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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { parseTimeout } from "../duration_parser.ts";
import { buildServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { handleConnection } from "../../serve/connection.ts";
import {
  closeConnectionsForPrincipal,
  removeConnection,
  setConnectionCollectives,
  updateCollectivesForPrincipal,
} from "../../serve/handlers/shared.ts";
import {
  createDeviceAuthDeps,
  handleDeviceAuth,
} from "../../serve/device_auth_handler.ts";
import { resolveOAuthClientCredentials } from "../../serve/oauth_registration.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  serverTokenModel,
  ServerTokenSchema,
} from "../../domain/models/access/server_token_model.ts";
import {
  authenticateServerToken,
  extractWebSocketToken,
} from "../../serve/token_auth.ts";
import { parsePrincipal } from "../../domain/access/principal.ts";
import { executeWorkflowWithLocks } from "../../serve/deps.ts";
import { CapabilityService } from "../../serve/capability_service.ts";
import { WorkerGateway } from "../../serve/worker_gateway.ts";
import { dispatchFleetProbe } from "../../serve/fleet_probe_dispatch.ts";
import { DispatchService } from "../../serve/dispatch_service.ts";
import { DispatchRegistry } from "../../serve/dispatch_registry.ts";
import { BundleRegistry } from "../../serve/bundle_registry.ts";
import { DataPlane } from "../../serve/data_plane.ts";
import { setRemoteStepDispatcher } from "../../domain/remote/remote_dispatch.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  createServiceScheduler,
  resolveServiceMode,
} from "../../infrastructure/daemon/service_scheduler_factory.ts";
import {
  renderDaemonDisabled,
  renderDaemonEnabled,
  renderDaemonStatus,
  toServiceMode,
} from "../../presentation/output/serve_daemon_output.ts";
import { groupCommandAction } from "../group_action.ts";
import { ScheduledExecutionService } from "../../libswamp/mod.ts";
import { parseWebhookFlag, WebhookService } from "../../serve/webhook.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { RunCancelRegistry } from "../../serve/run_cancel_registry.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import {
  incrementReloadGeneration,
  LockfileRepository,
} from "../../libswamp/mod.ts";
import { removeAttachedExtensionsForType } from "../../domain/extensions/model_kind_adapter.ts";
import {
  extensionKindToKindDir,
} from "../../domain/extensions/source_failure_recorder.ts";
import { computeSourceFingerprint } from "../../domain/extensions/bundle_freshness.ts";
import { bundleExtension } from "../../domain/models/bundle.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type PolicyReloadMode,
  PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import {
  createAdminGrantStore,
  materializeAdmins,
  migrateGrantDefinitions,
} from "../../domain/access/admin_materializer.ts";
import {
  collectErrors,
  readGrantFiles,
} from "../../domain/access/grant_file.ts";
import { validateGrantCondition } from "../../infrastructure/cel/grant_condition_environment.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../../domain/access/grant_file_reconciler.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { GRANT_MODEL_TYPE } from "../../domain/models/access/grant_model.ts";
import { cleanupEmptyParentDirs } from "../../infrastructure/persistence/directory_cleanup.ts";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  DEFAULT_STALE_TTL_MS,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { sweepStaleRecords } from "../../serve/boot_reconciliation.ts";
import { installUnhandledRejectionGuard } from "../../serve/unhandled_rejection_guard.ts";
import {
  checkOpenFileLimit,
  isProcessDead,
} from "../../infrastructure/runtime/process.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const authAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function sweepExpiredEntries(): void {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (now > entry.resetAt) authAttempts.delete(ip);
  }
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (authAttempts.size >= MAX_RATE_LIMIT_ENTRIES) sweepExpiredEntries();
    if (authAttempts.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldest = authAttempts.keys().next().value!;
      authAttempts.delete(oldest);
    }
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_AUTH_ATTEMPTS;
}

function clearRateLimit(ip: string): void {
  const entry = authAttempts.get(ip);
  if (entry) {
    entry.count = 0;
  }
}

export function assertOffLoopbackSecurity(
  host: string,
  tlsEnabled: boolean,
  authMode: string,
): void {
  if (LOOPBACK_HOSTS.has(host)) return;

  if (!tlsEnabled) {
    throw new UserError(
      "Off-loopback binding requires TLS — provide --cert-file and --key-file, or bind to 127.0.0.1",
    );
  }
  if (authMode === "none") {
    throw new UserError(
      "Off-loopback binding requires authentication — set --auth-mode token or --auth-mode oauth, or bind to 127.0.0.1",
    );
  }
}

export function validateWebSocketOrigin(
  origin: string | null,
  hostHeader: string | null,
  bindHost: string,
  tlsEnabled: boolean,
  trustedHosts?: readonly string[],
): { allowed: boolean; reason?: string } {
  if (origin) {
    const TRUSTED_ORIGINS = new Set([
      "http://127.0.0.1",
      "http://localhost",
      "https://127.0.0.1",
      "https://localhost",
      "http://[::1]",
      "https://[::1]",
    ]);
    if (tlsEnabled) {
      TRUSTED_ORIGINS.add(`https://${bindHost.toLowerCase()}`);
    }

    let originBase: string;
    try {
      const originUrl = new URL(origin);
      originBase = `${originUrl.protocol}//${originUrl.hostname}`;
    } catch {
      return { allowed: false, reason: `malformed origin: ${origin}` };
    }

    if (!TRUSTED_ORIGINS.has(originBase)) {
      return { allowed: false, reason: `untrusted origin: ${origin}` };
    }
  }

  // Only validate Host header when binding off-loopback (direct exposure).
  // When bound to loopback, a reverse proxy on the same machine handles
  // external connections and forwards the public domain as the Host header —
  // this is the documented production deployment model (Caddy, nginx).
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
  if (hostHeader && !LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
    let hostName: string;
    try {
      const parsed = new URL(`http://${hostHeader}`);
      hostName = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      return { allowed: false, reason: `malformed host: ${hostHeader}` };
    }
    const TRUSTED_HOSTS = new Set([
      "127.0.0.1",
      "localhost",
      "::1",
      bindHost.toLowerCase(),
    ]);
    if (trustedHosts) {
      for (const h of trustedHosts) {
        TRUSTED_HOSTS.add(h.toLowerCase());
      }
    }
    if (!TRUSTED_HOSTS.has(hostName)) {
      return { allowed: false, reason: `untrusted host: ${hostHeader}` };
    }
  }

  return { allowed: true };
}

export function collectServeExtraArgs(options: AnyOptions): string[] {
  const args: string[] = [];
  if (options.schedule === false) {
    args.push("--no-schedule");
  }
  if (options.grantReload && options.grantReload !== "manual") {
    args.push("--grant-reload", options.grantReload as string);
  }
  const webhooks = options.webhook as string[] | undefined;
  if (webhooks) {
    for (const spec of webhooks) {
      args.push("--webhook", spec);
    }
  }
  if (options.authMode && options.authMode !== "none") {
    args.push("--auth-mode", options.authMode as string);
  }
  if (options.admins) {
    args.push("--admins", options.admins as string);
  }
  if (options.allowedCollectives) {
    args.push("--allowed-collectives", options.allowedCollectives as string);
  }
  if (options.allowedUsers) {
    args.push("--allowed-users", options.allowedUsers as string);
  }
  if (options.oauthProvider) {
    args.push("--oauth-provider", options.oauthProvider as string);
  }
  if (options.oauthClientId) {
    args.push("--oauth-client-id", options.oauthClientId as string);
  }
  if (options.groupsField) {
    args.push("--groups-field", options.groupsField as string);
  }
  if (options.groupRefreshInterval) {
    args.push(
      "--group-refresh-interval",
      options.groupRefreshInterval as string,
    );
  }
  if (options.trustProxy) {
    args.push("--trust-proxy");
  }
  if (options.wsIdleTimeout) {
    args.push("--ws-idle-timeout", options.wsIdleTimeout as string);
  }
  if (options.queueTimeout) {
    args.push("--queue-timeout", options.queueTimeout as string);
  }
  if (options.verifyOnEnroll) {
    args.push("--verify-on-enroll");
  }
  if (options.trustedHosts) {
    args.push("--trusted-hosts", options.trustedHosts as string);
  }
  return args;
}

export interface ReapResult {
  readonly reaped: number;
  readonly skipped: number;
}

export async function reapOrphanedWorkflowRuns(
  runs: { run: WorkflowRun; workflowId: WorkflowId }[],
  save: (workflowId: WorkflowId, run: WorkflowRun) => Promise<void>,
  trackerLookup: (runId: string) => { status: string } | null,
  isDeadFn: (pid: number) => boolean = isProcessDead,
): Promise<ReapResult> {
  let reaped = 0;
  let skipped = 0;

  for (const { run, workflowId } of runs) {
    if (run.status !== "running") continue;

    const tracked = trackerLookup(run.id);
    if (tracked) {
      if (tracked.status === "running") {
        logger.info(
          "Skipping workflow run {runId} (workflow: {workflowName}) — tracker reports still running",
          { runId: run.id, workflowName: run.workflowName },
        );
        skipped++;
        continue;
      }
      // Tracker already reaped this run (heartbeat stale + PID dead)
      logger.warn(
        "Reaping orphaned workflow run {runId} (workflow: {workflowName}, reason: {reason})",
        {
          runId: run.id,
          workflowName: run.workflowName,
          reason: "tracker confirmed stale",
        },
      );
      run.cancel("daemon restarted (tracker confirmed stale)");
      await save(workflowId, run);
      reaped++;
      continue;
    }

    // Not in tracker (legacy run) — fall back to PID check
    const pid = run.pid;
    if (pid !== undefined && !isDeadFn(pid)) {
      logger.info(
        "Skipping workflow run {runId} (workflow: {workflowName}) — owning process {pid} is still alive (no tracker record)",
        { runId: run.id, workflowName: run.workflowName, pid },
      );
      skipped++;
      continue;
    }

    const reason = pid === undefined
      ? "daemon restarted (no PID recorded, no tracker record)"
      : "daemon restarted (owning process dead, no tracker record)";
    logger.warn(
      "Reaping orphaned workflow run {runId} (workflow: {workflowName}, reason: {reason})",
      { runId: run.id, workflowName: run.workflowName, reason },
    );
    run.cancel(reason);
    await save(workflowId, run);
    reaped++;
  }

  return { reaped, skipped };
}

const daemonEnableCommand = new Command()
  .name("enable")
  .description("Enable swamp serve as a system daemon (launchd/systemd)")
  .option(
    "--user",
    "Install as a per-user service (systemd --user / launchd agent)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--port <port:number>", "Port for the daemon to listen on", {
    default: 9090,
  })
  .option("--host <host:string>", "Host for the daemon to bind to", {
    default: "127.0.0.1",
  })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "Secret may use @env=VAR to read from an environment variable or " +
      "@file=/path to read from a file (avoids secrets in argv)",
    { collect: true },
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode: none (default, deprecated), token, or oauth",
    { default: "none" },
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated principal IDs for admin access",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs for OAuth admission policy",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated swamp-club usernames or user:<sub> subjects for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID — auto-registered on first start if omitted",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field name for group/collective memberships (default: collectives)",
  )
  .option(
    "--group-refresh-interval <duration:string>",
    "How often to re-fetch IdP group memberships for active server tokens. " +
      "Accepts seconds (14400), explicit units (4h, 30m), or 0 to disable. Default: 4h. " +
      "Requires --auth-mode oauth (env: SWAMP_GROUP_REFRESH_INTERVAL).",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For header for client IP in token auth rate limiting",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable",
  )
  .option(
    "--trusted-hosts <hosts:string>",
    "Comma-separated hostnames to trust for Host header validation (env: SWAMP_TRUSTED_HOSTS)",
  )
  .example("Enable daemon", "swamp serve daemon enable")
  .example(
    "Enable with custom port",
    "swamp serve daemon enable --port 8080",
  )
  .example(
    "Enable with TLS and auth",
    "swamp serve daemon enable --cert-file cert.pem --key-file key.pem --auth-mode token",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "enable",
    ]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });
    const extraArgs = collectServeExtraArgs(options);

    await scheduler.enable({
      binaryPath: Deno.execPath(),
      repoDir,
      port: options.port as number,
      host: options.host as string,
      certFile: options.certFile as string | undefined,
      keyFile: options.keyFile as string | undefined,
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    });

    renderDaemonEnabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonDisableCommand = new Command()
  .name("disable")
  .description("Disable and remove the swamp serve daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Disable daemon", "swamp serve daemon disable")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "disable",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });

    await scheduler.disable();

    renderDaemonDisabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonStatusCommand = new Command()
  .name("status")
  .description("Show the status of the swamp serve daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Check daemon status", "swamp serve daemon status")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "status",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });

    const status = await scheduler.status();

    renderDaemonStatus(status, ctx.outputMode, toServiceMode(mode));
  });

async function reloadPulledExtensions(
  repoDir: string,
  lockfilePath: string,
): Promise<number> {
  incrementReloadGeneration();

  const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");

  const catalog = new ExtensionCatalogStore(catalogDbPath);
  try {
    const lockfile = await LockfileRepository.create(lockfilePath);
    const entries = lockfile.getAllEntries();

    // Re-bundle only sources whose fingerprint changed since the catalog
    // was last written. Unchanged sources keep their existing bundle and
    // skip the expensive deno-bundle subprocess.
    // Query by source_path prefix instead of extension_name — the
    // source_path PK always reflects the pulled-extensions directory
    // layout, even when extension_name is empty (swamp-club#1149).
    const pulledRoot = join(repoDir, ".swamp", "pulled-extensions");
    const rebundled = new Set<string>();
    let denoRuntime: EmbeddedDenoRuntime | undefined;
    let denoPath: string | undefined;
    for (const [extName] of Object.entries(entries)) {
      const sourcePrefix = canonicalizePath(
        join(pulledRoot, extName) + "/",
      );
      const allRows = catalog.findBySourcePathPrefix(sourcePrefix);
      for (const row of allRows) {
        if (
          !row.source_path || !row.bundle_path ||
          rebundled.has(row.source_path)
        ) continue;
        try {
          const kindDir = extensionKindToKindDir(
            row.kind as Parameters<typeof extensionKindToKindDir>[0],
          );
          const baseDir = join(pulledRoot, extName, kindDir);
          const currentFp = await computeSourceFingerprint(
            row.source_path,
            baseDir,
          );
          if (currentFp === row.source_fingerprint) continue;
          if (!denoRuntime) {
            denoRuntime = new EmbeddedDenoRuntime();
          }
          if (!denoPath) {
            denoPath = await denoRuntime.ensureDeno();
          }
          const js = await bundleExtension(row.source_path, denoPath, {
            env: denoRuntime.getDenoEnv(),
          });
          await Deno.mkdir(dirname(row.bundle_path), { recursive: true });
          await Deno.writeTextFile(row.bundle_path, js);
          catalog.updateSourceFingerprint(row.source_path, currentFp);
          rebundled.add(row.source_path);
        } catch (err) {
          logger.warn(
            "Hot-reload: failed to re-bundle {path}, keeping old bundle: {error}",
            {
              path: row.source_path,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    let reloadedCount = 0;
    for (const [name] of Object.entries(entries)) {
      const sourcePrefix = canonicalizePath(
        join(pulledRoot, name) + "/",
      );
      const rows = catalog.findBySourcePathPrefix(sourcePrefix);
      if (rows.length === 0) continue;

      for (const row of rows) {
        if (!row.type_normalized) continue;
        try {
          const kind = row.kind;

          if (kind === "model") {
            modelRegistry.invalidateType(row.type_normalized);
            removeAttachedExtensionsForType(row.type_normalized);
            modelRegistry.registerLazy({
              type: ModelType.create(row.type_normalized),
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
              sourceFingerprint: row.source_fingerprint,
            });
            await modelRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "vault") {
            vaultTypeRegistry.invalidateType(row.type_normalized);
            vaultTypeRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await vaultTypeRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "datastore") {
            datastoreTypeRegistry.invalidateType(row.type_normalized);
            datastoreTypeRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await datastoreTypeRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "report") {
            reportRegistry.invalidateType(row.type_normalized);
            reportRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await reportRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          }
        } catch (err) {
          logger.warn(
            "Failed to reload type {type} from {extension}: {error}",
            {
              type: row.type_normalized,
              extension: name,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }
    return reloadedCount;
  } finally {
    catalog.close();
  }
}

const reloadCommand = new Command()
  .name("reload")
  .description(
    "Reload pulled extension bundles on a running serve process.\n\n" +
      "Reads .swamp/serve.pid and sends SIGHUP to trigger hot-reload. " +
      "Requires the serve process to be running with --hot-reload.",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async (options: AnyOptions) => {
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const pidPath = swampPath(repoDir, "serve.pid");

    let pidStr: string;
    try {
      pidStr = await Deno.readTextFile(pidPath);
    } catch {
      throw new UserError(
        "No PID file found at " + pidPath + ". " +
          "Is swamp serve running with --hot-reload?",
      );
    }

    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) {
      throw new UserError("Invalid PID in " + pidPath + ": " + pidStr.trim());
    }

    try {
      Deno.kill(pid, "SIGHUP");
    } catch {
      throw new UserError(
        "Process " + pid + " not found — stale PID file. " +
          "Remove " + pidPath + " and restart serve with --hot-reload.",
      );
    }

    logger.info`Sent SIGHUP to serve process ${pid}`;
  });

const daemonCommand = new Command()
  .name("daemon")
  .description("Manage swamp serve as a system daemon (EXPERIMENTAL)")
  .action(groupCommandAction)
  .command("enable", daemonEnableCommand)
  .command("disable", daemonDisableCommand)
  .command("status", daemonStatusCommand);

export const serveCommand = new Command()
  .name("serve")
  .description(
    "Start a WebSocket API server for workflow and model execution.\n\n" +
      "Service deployments: swamp loads all extensions — including " +
      "already-pulled repo extensions — through an embedded runtime under the " +
      "user's home directory (~/.swamp). When running under a service manager " +
      "such as systemd, ensure HOME (or USERPROFILE on Windows) is set in the " +
      "unit environment, e.g. `Environment=HOME=/root`. Without it, scheduled " +
      'workflow runs fail with "Unknown model type" for pulled extension ' +
      "types.",
  )
  .example("Start server", "swamp serve")
  .example("Custom port", "swamp serve --port 8080")
  .example(
    "Bind to all interfaces (TLS + auth required)",
    "swamp serve --host 0.0.0.0 --port 3000 --cert-file server.crt --key-file server.key --auth-mode token",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--port <port:number>", "Port to listen on", { default: 9090 })
  .option("--host <host:string>", "Host to bind to", { default: "127.0.0.1" })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate (env: SWAMP_SERVE_CERT_FILE)",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key (env: SWAMP_SERVE_KEY_FILE)",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "scheme is one of github (default), linear, stripe, slack, generic; " +
      "generic requires a header name and accepts an optional value prefix. " +
      "Secret may use @env=VAR to read from an environment variable or " +
      "@file=/path to read from a file (avoids secrets in argv)",
    { collect: true },
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode: none (default, deprecated), token, or oauth",
    { default: "none" },
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated principal IDs for admin access (e.g. user:oauth|user-123)",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs for OAuth admission policy",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated swamp-club usernames or user:<sub> subjects for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID — auto-registered on first start if omitted",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field name for group/collective memberships (default: collectives)",
  )
  .option(
    "--group-refresh-interval <duration:string>",
    "How often to re-fetch IdP group memberships for active server tokens (env: SWAMP_GROUP_REFRESH_INTERVAL). " +
      "Accepts seconds (14400), explicit units (4h, 30m), or 0 to disable. Default: 4h. Requires --auth-mode oauth.",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For header for client IP in token auth rate limiting (enable when behind a reverse proxy)",
  )
  .option(
    "--ws-idle-timeout <duration:string>",
    "WebSocket idle timeout — how long the server waits for a pong before closing the connection (env: SWAMP_WS_IDLE_TIMEOUT). " +
      "Accepts seconds (30), explicit units (2m, 5m), or 0 to disable. Default: 30s",
  )
  .option(
    "--queue-timeout <duration:string>",
    "How long a placed step queues for a matching worker before timing out (env: SWAMP_QUEUE_TIMEOUT). " +
      "Accepts seconds (60), explicit units (2m, 10m), or 0 to disable. Default: 10m",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable — workers that fail are marked unverified (env: SWAMP_VERIFY_ON_ENROLL)",
  )
  .option(
    "--trusted-hosts <hosts:string>",
    "Comma-separated hostnames to trust for Host header validation when binding off-loopback " +
      "(e.g. host.docker.internal,host.minikube.internal). " +
      "Preserves the DNS rebinding defense while allowing Docker/Kubernetes worker connections " +
      "(env: SWAMP_TRUSTED_HOSTS)",
  )
  .option(
    "--hot-reload",
    "Enable SIGHUP-based hot-reload for pulled extension bundles. " +
      "Writes a PID file to .swamp/serve.pid; use 'swamp serve reload' to trigger a reload",
  )
  .example(
    "Enable TLS",
    "swamp serve --cert-file server.crt --key-file server.key",
  )
  .example(
    "Token auth",
    "swamp serve --auth-mode token --admins 'user:oauth|user-123'",
  )
  .example(
    "Webhook (secret from env var)",
    "swamp serve --webhook '/hooks/github:my-workflow:@env=WEBHOOK_SECRET'",
  )
  .example(
    "Webhook (secret from file)",
    "swamp serve --webhook '/hooks/github:my-workflow:@file=/run/secrets/webhook'",
  )
  .example(
    "Webhook with a provider scheme",
    "swamp serve --webhook '/hooks/linear:my-workflow:@env=LINEAR_SECRET:linear' " +
      "--webhook '/hooks/custom:my-workflow:@env=CUSTOM_SECRET:generic:X-Signature:sha256='",
  )
  .example(
    "Docker workers",
    "swamp serve --host 0.0.0.0 --trusted-hosts host.docker.internal " +
      "--cert-file server.crt --key-file server.key --auth-mode token",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve"]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const port = options.port as number;
    const host = options.host as string;
    const isJson = ctx.outputMode === "json";

    const certFile = (options.certFile as string | undefined) ??
      Deno.env.get("SWAMP_SERVE_CERT_FILE") ?? undefined;
    const keyFile = (options.keyFile as string | undefined) ??
      Deno.env.get("SWAMP_SERVE_KEY_FILE") ?? undefined;

    if ((certFile && !keyFile) || (!certFile && keyFile)) {
      throw new Error(
        "Both --cert-file and --key-file must be provided together for TLS",
      );
    }

    let cert: string | undefined;
    let key: string | undefined;
    if (certFile && keyFile) {
      cert = await Deno.readTextFile(certFile);
      key = await Deno.readTextFile(keyFile);
    }
    const tlsEnabled = cert !== undefined;
    const trustProxy = options.trustProxy === true;

    const wsIdleTimeoutRaw = (options.wsIdleTimeout as string | undefined) ??
      Deno.env.get("SWAMP_WS_IDLE_TIMEOUT") ?? undefined;
    let wsIdleTimeoutSeconds: number | undefined;
    if (wsIdleTimeoutRaw !== undefined) {
      if (wsIdleTimeoutRaw === "0") {
        wsIdleTimeoutSeconds = 0;
      } else {
        wsIdleTimeoutSeconds = Math.round(
          parseTimeout(wsIdleTimeoutRaw) / 1000,
        );
      }
    }

    const queueTimeoutRaw = (options.queueTimeout as string | undefined) ??
      Deno.env.get("SWAMP_QUEUE_TIMEOUT") ?? undefined;
    let queueTimeoutMs: number | undefined;
    if (queueTimeoutRaw !== undefined) {
      const normalized = queueTimeoutRaw.trim().replace(/^0[smhdw].*$/i, "0");
      queueTimeoutMs = normalized === "0"
        ? 0
        : parseTimeout(queueTimeoutRaw, "--queue-timeout");
    }

    const authConfig = buildServeAuthConfig({
      authMode: options.authMode as string | undefined,
      admins: options.admins as string | undefined,
      allowedCollectives: options.allowedCollectives as string | undefined,
      allowedUsers: options.allowedUsers as string | undefined,
      oauthProvider: options.oauthProvider as string | undefined,
      oauthClientId: options.oauthClientId as string | undefined,
      groupsField: options.groupsField as string | undefined,
    });

    if (authConfig.mode === "none" && authConfig.admins.length > 0) {
      logger.warn(
        "--admins is set but --auth-mode is {mode} — admins will have no effect",
        { mode: authConfig.mode },
      );
    }

    if (authConfig.mode === "none") {
      logger.warn(
        "auth-mode is 'none' — this mode is deprecated and will be removed in a future release. " +
          "Use --auth-mode token for authenticated access. " +
          "See https://swamp-club.com/manual/how-to/swamp-serve/set-up-token-auth",
      );
    }

    assertOffLoopbackSecurity(host, tlsEnabled, authConfig.mode);

    const trustedHostsRaw = (options.trustedHosts as string | undefined) ??
      Deno.env.get("SWAMP_TRUSTED_HOSTS") ?? undefined;
    const trustedHosts = trustedHostsRaw
      ? trustedHostsRaw.split(",").map((h) => h.trim()).filter((h) =>
        h.length > 0
      )
      : undefined;

    const rejectionGuard = installUnhandledRejectionGuard();

    const fileLimitWarning = checkOpenFileLimit();
    if (fileLimitWarning) {
      logger.warn(fileLimitWarning.message);
    }

    ctx.logger.info`Initializing repository at ${repoDir}`;

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: ctx.outputMode,
    });

    let repoMarker = null;
    try {
      const markerRepo = new RepoMarkerRepository();
      repoMarker = await markerRepo.read(RepoPath.create(resolvedRepoDir));
    } catch {
      // Not in a swamp repo or marker unreadable — resolveModelsDir(null) returns the default
    }
    const resolvedModelsDir = resolveModelsDir(repoMarker);
    const extensionLockfilePath = join(
      isAbsolute(resolvedModelsDir)
        ? resolvedModelsDir
        : resolve(resolvedRepoDir, resolvedModelsDir),
      "upstream_extensions.json",
    );

    // Remote-execution control plane: capability verbs, worker enrollment,
    // and the dispatch/lease registries shared with the HTTP data plane.
    // See design/remote-execution.md.
    const dispatchRegistry = new DispatchRegistry();
    const capabilityService = new CapabilityService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
    });
    const bundleRegistry = new BundleRegistry();
    const dispatchService = new DispatchService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
      queueTimeoutMs,
    });
    const verifyOnEnroll = options.verifyOnEnroll === true ||
      Deno.env.get("SWAMP_VERIFY_ON_ENROLL") === "true";
    const workerGateway = new WorkerGateway({
      repoDir: resolvedRepoDir,
      repoContext,
      capabilityService,
      onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
      onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
      onWorkerEnrolled: (worker) =>
        dispatchService.notifyWorkerEnrolled(worker),
      onWorkerDraining: (worker) =>
        dispatchService.notifyWorkerDraining(worker),
      verifyOnEnroll,
      verifyWorker: verifyOnEnroll
        ? async (workerName) => {
          const probe = await dispatchFleetProbe(
            dispatchService,
            repoContext.unifiedDataRepo,
            workerName,
            "verify-on-enroll",
            AbortSignal.timeout(60_000),
          );
          if (probe.status === "pass") {
            return { ok: true };
          }
          return {
            ok: false,
            failureReason: probe.status === "error"
              ? probe.error ?? "probe error"
              : (probe.failures ?? []).join("; ") || "probe failed",
          };
        }
        : undefined,
    });
    dispatchService.bindGateway(workerGateway);
    setRemoteStepDispatcher(dispatchService);
    const dataPlane = new DataPlane({
      repoDir: resolvedRepoDir,
      repoContext,
      sessions: workerGateway.sessions,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
      onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
    });
    dispatchService.setOnDispatchEnd((dispatchId) =>
      dataPlane.releaseDispatch(dispatchId)
    );

    // Eagerly load extension registries so failures surface at startup
    // rather than silently on first scheduled/webhook execution.
    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      datastoreTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
    ]);

    const grantReloadMode = options.grantReload as string;
    if (grantReloadMode !== "manual" && grantReloadMode !== "auto") {
      throw new UserError(
        `Invalid --grant-reload value "${grantReloadMode}": must be "manual" or "auto"`,
      );
    }

    const modelsDir = join(resolvedRepoDir, "models");
    const autoDefDir = repoContext.autoDefinitionsDir;
    const grantTypeDir = GRANT_MODEL_TYPE.toDirectoryPath();
    const grantSourceDir = join(modelsDir, grantTypeDir);
    const migrationResult = await migrateGrantDefinitions(
      grantSourceDir,
      join(autoDefDir, grantTypeDir),
    );
    if (migrationResult.moved > 0) {
      logger
        .info`Migrated ${migrationResult.moved} grant definition(s) from models/ to .swamp/auto-definitions/`;
      await cleanupEmptyParentDirs(
        join(grantSourceDir, "_placeholder"),
        modelsDir,
      );
    }

    let oauthClientSecret = "";
    if (authConfig.mode === "oauth") {
      const vaultService = await VaultService.fromRepository(resolvedRepoDir);
      const vaultNames = vaultService.getVaultNames();
      if (vaultNames.length === 0) {
        throw new UserError(
          "oauth mode requires a vault — run 'swamp vault create local default' first",
        );
      }
      const vaultName = vaultNames[0];
      const credentials = await resolveOAuthClientCredentials(
        {
          getVaultSecret: async (v, k) => {
            try {
              return await vaultService.get(v, k, "serve:oauth-resolve");
            } catch {
              return null;
            }
          },
          putVaultSecret: (v, k, val) => vaultService.put(v, k, val),
          registerClient: async (providerUrl, signal) => {
            const { startDeviceGrant, pollForToken } = await import(
              "../../serve/oauth_client.ts"
            );
            const { BOOTSTRAP_CLIENT_ID } = await import(
              "../../serve/oauth_registration.ts"
            );
            const { DeviceGrantPollError } = await import(
              "../../serve/oauth_client.ts"
            );

            const grant = await startDeviceGrant(
              providerUrl,
              BOOTSTRAP_CLIENT_ID,
              signal,
            );

            const verifyUrl = grant.verificationUriComplete ||
              grant.verificationUri;
            logger.info(
              "First-time OAuth setup — visit {uri} and verify code: {code}",
              { uri: verifyUrl, code: grant.userCode },
            );

            let currentIntervalMs = (grant.interval || 5) * 1000;
            const deadline = Date.now() + grant.expiresIn * 1000;
            let tokenResponse;
            while (Date.now() < deadline) {
              try {
                tokenResponse = await pollForToken(
                  providerUrl,
                  BOOTSTRAP_CLIENT_ID,
                  "",
                  grant.deviceCode,
                  signal,
                );
                break;
              } catch (err) {
                if (err instanceof DeviceGrantPollError) {
                  if (err.code === "slow_down") {
                    currentIntervalMs += 5000;
                  }
                  if (
                    err.code === "authorization_pending" ||
                    err.code === "slow_down"
                  ) {
                    await new Promise((resolve) =>
                      setTimeout(resolve, currentIntervalMs)
                    );
                    continue;
                  }
                }
                throw err;
              }
            }
            if (!tokenResponse) {
              throw new Error("Bootstrap device grant timed out");
            }

            const resp = await fetch(
              `${providerUrl}/api/auth/oauth2/register`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "authorization": `Bearer ${tokenResponse.accessToken}`,
                },
                body: JSON.stringify({
                  client_name: `swamp-serve-${crypto.randomUUID().slice(0, 8)}`,
                  redirect_uris: ["http://localhost"],
                  grant_types: ["authorization_code"],
                  scope: "openid profile email collectives",
                }),
                signal,
              },
            );
            if (!resp.ok) {
              const body = await resp.text().catch(() => "");
              throw new Error(
                `OAuth client registration failed: ${resp.status} ${resp.statusText}${
                  body ? ` — ${body}` : ""
                }`,
              );
            }
            const data = await resp.json();
            return {
              clientId: data.client_id as string,
              clientSecret: data.client_secret as string,
              accessToken: tokenResponse.accessToken,
            };
          },
        },
        authConfig.oauthProvider,
        vaultName,
        authConfig.oauthClientId,
        AbortSignal.timeout(300_000),
      );
      authConfig.oauthClientId = credentials.clientId;
      oauthClientSecret = credentials.clientSecret;
      logger.info(
        "OAuth client credentials resolved (clientId: {clientId})",
        { clientId: credentials.clientId },
      );

      if (credentials.accessToken) {
        const { resolveUsername } = await import(
          "../../serve/oauth_client.ts"
        );
        const { storeResolvedAdmins } = await import(
          "../../serve/oauth_registration.ts"
        );
        const resolvedMap: Record<string, string> = {};
        for (let i = 0; i < authConfig.admins.length; i++) {
          const admin = authConfig.admins[i];
          const username = admin.startsWith("user:") ? admin.slice(5) : admin;
          try {
            const sub = await resolveUsername(
              authConfig.oauthProvider,
              username,
              credentials.accessToken,
              AbortSignal.timeout(10_000),
            );
            authConfig.admins[i] = `user:${sub}`;
            resolvedMap[username] = sub;
            logger.info("Resolved admin {username} to user:{sub}", {
              username,
              sub,
            });
          } catch (err) {
            throw new UserError(
              `Failed to resolve admin '${admin}': ${
                err instanceof Error ? err.message : String(err)
              }. Ensure the username exists on ${authConfig.oauthProvider}.`,
            );
          }
        }
        for (let i = 0; i < authConfig.allowedUsers.length; i++) {
          const entry = authConfig.allowedUsers[i];
          const username = entry.startsWith("user:") ? entry.slice(5) : entry;
          try {
            const sub = await resolveUsername(
              authConfig.oauthProvider,
              username,
              credentials.accessToken,
              AbortSignal.timeout(10_000),
            );
            authConfig.allowedUsers[i] = sub;
            resolvedMap[`allowed:${username}`] = sub;
            logger.info("Resolved allowed-user {username} to {sub}", {
              username,
              sub,
            });
          } catch (err) {
            throw new UserError(
              `Failed to resolve allowed-user '${entry}': ${
                err instanceof Error ? err.message : String(err)
              }. Ensure the username exists on ${authConfig.oauthProvider}.`,
            );
          }
        }
        await storeResolvedAdmins(
          { putVaultSecret: (v, k, val) => vaultService.put(v, k, val) },
          vaultName,
          resolvedMap,
        );
      } else if (credentials.resolvedAdmins) {
        for (let i = 0; i < authConfig.admins.length; i++) {
          const admin = authConfig.admins[i];
          const username = admin.startsWith("user:") ? admin.slice(5) : admin;
          const cachedSub = credentials.resolvedAdmins[username];
          if (cachedSub) {
            authConfig.admins[i] = `user:${cachedSub}`;
            logger.info(
              "Using cached admin resolution: {username} → user:{sub}",
              { username, sub: cachedSub },
            );
          } else {
            throw new UserError(
              `Admin '${admin}' not found in cached resolutions. ` +
                "Clear stored credentials to re-register: " +
                `swamp vault delete ${vaultName} oauth-client-id`,
            );
          }
        }
        for (let i = 0; i < authConfig.allowedUsers.length; i++) {
          const entry = authConfig.allowedUsers[i];
          const username = entry.startsWith("user:") ? entry.slice(5) : entry;
          const cachedSub = credentials.resolvedAdmins[`allowed:${username}`];
          if (cachedSub) {
            authConfig.allowedUsers[i] = cachedSub;
            logger.info(
              "Using cached allowed-user resolution: {username} → {sub}",
              { username, sub: cachedSub },
            );
          } else {
            throw new UserError(
              `Allowed-user '${entry}' not found in cached resolutions. ` +
                "Clear stored credentials to re-register: " +
                `swamp vault delete ${vaultName} oauth-client-id`,
            );
          }
        }
      } else {
        throw new UserError(
          "Cannot resolve usernames — no access token and no cached resolutions. " +
            "Clear stored credentials to re-register: " +
            `swamp vault delete ${vaultName} oauth-client-id`,
        );
      }
    }

    const autoDefRepo = new YamlDefinitionRepository(
      resolvedRepoDir,
      undefined,
      autoDefDir,
      false,
    );
    const adminGrantStore = createAdminGrantStore(
      repoContext.definitionRepo,
      autoDefRepo,
      repoContext.unifiedDataRepo,
    );
    const materializeResult = await materializeAdmins(
      authConfig.mode,
      authConfig.admins,
      adminGrantStore,
    );
    if (
      materializeResult.created > 0 || materializeResult.revoked > 0 ||
      materializeResult.reactivated > 0
    ) {
      logger
        .info`Admin grants materialized: ${materializeResult.created} created, ${materializeResult.revoked} revoked, ${materializeResult.reactivated} reactivated, ${materializeResult.unchanged} unchanged`;
    }

    const grantsDir = join(resolvedRepoDir, "grants");
    const grantFileResults = await readGrantFiles(
      grantsDir,
      validateGrantCondition,
    );
    const grantFileErrors = collectErrors(grantFileResults);

    if (grantFileErrors.length > 0) {
      const errorMessages = grantFileErrors.map((e) => {
        const loc = e.entryIndex !== undefined
          ? `${e.filename} entry ${e.entryIndex + 1}`
          : e.filename;
        return `  ${loc}: ${e.message}`;
      });
      throw new UserError(
        `Grant file validation failed — refusing to start:\n${
          errorMessages.join("\n")
        }`,
      );
    }

    const validEntries = new Map<
      string,
      import("../../domain/access/grant_file.ts").GrantFileEntry[]
    >();
    for (const [filename, result] of grantFileResults) {
      validEntries.set(filename, result.entries);
    }

    const fileGrantStore = createFileGrantStore(
      repoContext.definitionRepo,
      autoDefRepo,
      repoContext.unifiedDataRepo,
    );

    const fileReconcileResult = await reconcileAllFileGrants(
      validEntries,
      fileGrantStore,
    );

    if (
      fileReconcileResult.totalCreated > 0 ||
      fileReconcileResult.totalRevoked > 0 ||
      fileReconcileResult.totalReactivated > 0
    ) {
      logger
        .info`File grants reconciled (${fileReconcileResult.filesProcessed} file(s)): ${fileReconcileResult.totalCreated} created, ${fileReconcileResult.totalRevoked} revoked, ${fileReconcileResult.totalReactivated} reactivated, ${fileReconcileResult.totalUnchanged} unchanged`;
    }

    const policySnapshotLoader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      repoContext.eventBus,
      grantReloadMode as PolicyReloadMode,
    );
    await policySnapshotLoader.load();
    logger.info("Policy snapshot loaded (reload mode: {mode})", {
      mode: grantReloadMode,
    });

    const cancelRegistry = new RunCancelRegistry();

    // Reap stale runs via the SQLite tracker (heartbeat + PID liveness).
    // This handles both model-method and workflow runs registered with the tracker.
    const runTracker = RunTrackerStore.fromSwampDir(
      swampPath(resolvedRepoDir),
    );
    const reapedRuns = runTracker.reapStaleRuns(DEFAULT_STALE_TTL_MS);
    for (const run of reapedRuns) {
      logger.warn`Reaped stale ${run.runKind} run ${run.id} (${
        run.methodName ?? run.workflowName ?? "unknown"
      })`;
    }

    // Reconcile YAML-persisted workflow run state with tracker verdicts.
    // The tracker is the liveness authority; the YAML entity is the run record.
    // Legacy runs (pre-tracker) fall back to PID liveness checking.
    const reapCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentRuns = await repoContext.workflowRunRepo.findAllGlobalSince(
      reapCutoff,
    );
    await reapOrphanedWorkflowRuns(
      recentRuns,
      (wid, r) => repoContext.workflowRunRepo.save(wid, r),
      (runId) => {
        const tracked = runTracker.findById(runId);
        return tracked ? { status: tracked.status } : null;
      },
    );

    const swept = await sweepStaleRecords({
      repoDir: resolvedRepoDir,
      repoContext,
    });
    if (swept.leases + swept.pendingDispatches + swept.workers > 0) {
      logger.info(
        "Boot reconciliation: swept {leases} lease(s), {pendingDispatches} pending dispatch(es), {workers} worker(s)",
        {
          leases: swept.leases,
          pendingDispatches: swept.pendingDispatches,
          workers: swept.workers,
        },
      );
    }

    const datastoreResolver = new DefaultDatastorePathResolver(
      resolvedRepoDir,
      datastoreConfig,
    );
    const connectionCtx: import("../../serve/connection.ts").ConnectionContext =
      {
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
        workerGateway,
        policySnapshotLoader,
        authConfig,
        cancelRegistry,
        runTracker,
        dispatchService,
      };

    const ac = new AbortController();
    const enableSchedule = options.schedule !== false;
    const webhookFlags: string[] = options.webhook ?? [];

    // Start scheduled execution service if enabled
    let scheduledExecution: ScheduledExecutionService | null = null;
    if (enableSchedule) {
      scheduledExecution = new ScheduledExecutionService({
        workflowRepo: repoContext.workflowRepo,
        repoDir: resolvedRepoDir,
        executeWorkflow: (input, signal, onEvent) =>
          executeWorkflowWithLocks(
            resolvedRepoDir,
            repoContext,
            datastoreConfig,
            input,
            signal,
            onEvent,
            syncService,
            runTracker,
          ),
      });

      await scheduledExecution.start((event) => {
        if (isJson) {
          console.log(JSON.stringify(event));
        } else {
          switch (event.kind) {
            case "schedule_registered":
              logger.info(
                "Scheduled workflow {name} ({cron})",
                { name: event.workflowName, cron: event.cronExpression },
              );
              break;
            case "schedule_unregistered":
              logger.info(
                "Unregistered scheduled workflow {name}",
                { name: event.workflowName },
              );
              break;
            case "schedule_fired":
              logger.info(
                "Running scheduled workflow {name}",
                { name: event.workflowName },
              );
              break;
            case "schedule_skipped":
              logger.warn(
                "Skipped scheduled workflow {name}: {reason}",
                { name: event.workflowName, reason: event.reason },
              );
              break;
            case "schedule_completed":
              logger.info(
                "Scheduled workflow {name} completed (run: {runId})",
                { name: event.workflowName, runId: event.runId },
              );
              break;
            case "schedule_failed":
              logger.error(
                "Scheduled workflow {name} failed: {error}",
                { name: event.workflowName, error: event.error },
              );
              break;
          }
        }
      });
    }

    // Parse group refresh interval and construct service
    let collectiveRefreshService:
      | import("../../serve/collective_refresh_service.ts").CollectiveRefreshService
      | null = null;
    const groupRefreshRaw =
      (options.groupRefreshInterval as string | undefined) ??
        Deno.env.get("SWAMP_GROUP_REFRESH_INTERVAL") ?? undefined;

    const DEFAULT_GROUP_REFRESH_MS = 4 * 60 * 60 * 1000;
    let groupRefreshMs = DEFAULT_GROUP_REFRESH_MS;
    if (groupRefreshRaw !== undefined) {
      const normalized = groupRefreshRaw.trim().replace(/^0[smhdw].*$/i, "0");
      groupRefreshMs = normalized === "0"
        ? 0
        : parseTimeout(groupRefreshRaw, "--group-refresh-interval");
    }

    if (
      groupRefreshMs > 0 && (authConfig.mode !== "oauth" || !oauthClientSecret)
    ) {
      logger.warn(
        "--group-refresh-interval is set but --auth-mode oauth is not configured; group refresh is disabled",
      );
    }

    if (
      groupRefreshMs > 0 && authConfig.mode === "oauth" &&
      oauthClientSecret
    ) {
      const vaultService = await VaultService.fromRepository(resolvedRepoDir);
      const vaultNames = vaultService.getVaultNames();
      const vaultName = vaultNames[0];

      const {
        CollectiveRefreshService,
      } = await import("../../serve/collective_refresh_service.ts");
      const {
        getUserInfo,
      } = await import("../../serve/oauth_client.ts");
      const { oauthAccessTokenKey } = await import(
        "../../serve/device_auth_handler.ts"
      );

      collectiveRefreshService = new CollectiveRefreshService({
        intervalMs: groupRefreshMs,
        oauthProvider: authConfig.oauthProvider,
        groupsField: authConfig.groupsField,
        getUserInfo,
        listActiveTokens: async () => {
          const records = await repoContext.dataQueryService.query(
            `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main"`,
            { loadAttributes: true },
          ) as import("../../domain/data/data_record.ts").DataRecord[];
          const tokens:
            import("../../serve/collective_refresh_service.ts").ActiveTokenInfo[] =
              [];
          for (const record of records) {
            const parsed = ServerTokenSchema.safeParse(record.attributes);
            if (!parsed.success || parsed.data.state !== "active") continue;
            if (Date.parse(parsed.data.expiresAt) <= Date.now()) continue;
            tokens.push({
              name: parsed.data.name,
              principalId: parsed.data.principalId,
              collectives: parsed.data.collectives,
              groups: parsed.data.groups,
            });
          }
          return tokens;
        },
        getAccessToken: async (tokenName) => {
          try {
            return await vaultService.get(
              vaultName,
              oauthAccessTokenKey(tokenName),
              "serve:group-refresh",
            );
          } catch {
            return null;
          }
        },
        updateTokenCollectives: async (tokenName, collectives, groups) => {
          const { createResourceWriter } = await import(
            "../../domain/models/data_writer.ts"
          );
          const def = await repoContext.definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (!def) return;
          const { writeResource } = createResourceWriter(
            repoContext.unifiedDataRepo,
            SERVER_TOKEN_MODEL_TYPE,
            def.id,
            serverTokenModel.resources!,
            undefined,
            undefined,
            undefined,
            undefined,
            tokenName,
          );
          const record = await repoContext.dataQueryService.query(
            `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main" && modelName == "${tokenName}"`,
            { loadAttributes: true },
          ) as import("../../domain/data/data_record.ts").DataRecord[];
          if (record.length === 0) return;
          const parsed = ServerTokenSchema.safeParse(record[0].attributes);
          if (!parsed.success) return;
          const updated = { ...parsed.data, collectives, groups };
          await writeResource(
            "token",
            "token-main",
            updated as unknown as Record<string, unknown>,
          );
        },
        revokeToken: async (tokenName) => {
          const { createResourceWriter } = await import(
            "../../domain/models/data_writer.ts"
          );
          const def = await repoContext.definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (!def) return;
          const { writeResource } = createResourceWriter(
            repoContext.unifiedDataRepo,
            SERVER_TOKEN_MODEL_TYPE,
            def.id,
            serverTokenModel.resources!,
            undefined,
            undefined,
            undefined,
            undefined,
            tokenName,
          );
          const record = await repoContext.dataQueryService.query(
            `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main" && modelName == "${tokenName}"`,
            { loadAttributes: true },
          ) as import("../../domain/data/data_record.ts").DataRecord[];
          if (record.length === 0) return;
          const parsed = ServerTokenSchema.safeParse(record[0].attributes);
          if (!parsed.success) return;
          const revoked = {
            ...parsed.data,
            state: "revoked" as const,
            revokedAt: new Date().toISOString(),
          };
          await writeResource(
            "token",
            "token-main",
            revoked as unknown as Record<string, unknown>,
          );
        },
        updateConnectionCollectives: updateCollectivesForPrincipal,
        closeConnectionsForPrincipal,
      });
      collectiveRefreshService.start();
    }

    // Parse and initialize webhook endpoints
    let webhookService: WebhookService | null = null;
    if (webhookFlags.length > 0) {
      const endpoints = webhookFlags.map(parseWebhookFlag);
      webhookService = new WebhookService({
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        endpoints,
        syncService,
      });

      webhookService.setEventHandler((event) => {
        if (isJson) {
          console.log(JSON.stringify(event));
        } else {
          switch (event.kind) {
            case "webhook_received":
              logger.info(
                "Webhook received on {route} for workflow {workflow}",
                { route: event.route, workflow: event.workflowName },
              );
              break;
            case "webhook_rejected":
              logger.warn(
                "Webhook rejected on {route}: {reason}",
                { route: event.route, reason: event.reason },
              );
              break;
            case "webhook_queued":
              logger.info(
                "Webhook queued workflow {workflow}",
                { workflow: event.workflowName },
              );
              break;
            case "webhook_completed":
              logger.info(
                "Webhook workflow {workflow} completed (run: {runId})",
                { workflow: event.workflowName, runId: event.runId },
              );
              break;
            case "webhook_failed":
              logger.error(
                "Webhook workflow {workflow} failed: {error}",
                { workflow: event.workflowName, error: event.error },
              );
              break;
          }
        }
      });

      for (const ep of endpoints) {
        if (isJson) {
          console.log(JSON.stringify({
            kind: "webhook_registered",
            route: ep.route,
            workflow: ep.workflowIdOrName,
            scheme: ep.verifier.scheme,
          }));
        } else {
          logger.info(
            "Webhook registered: {route} → {workflow} (scheme: {scheme})",
            {
              route: ep.route,
              workflow: ep.workflowIdOrName,
              scheme: ep.verifier.scheme,
            },
          );
        }
      }
    }

    const wsUpgradeOpts: Deno.UpgradeWebSocketOptions = {};
    if (wsIdleTimeoutSeconds !== undefined) {
      wsUpgradeOpts.idleTimeout = wsIdleTimeoutSeconds;
    }

    const wsScheme = tlsEnabled ? "wss" : "ws";
    const server = Deno.serve(
      {
        port,
        hostname: host,
        signal: ac.signal,
        cert,
        key,
        onListen({ hostname, port: listenPort }) {
          if (isJson) {
            console.log(JSON.stringify({
              status: "listening",
              host: hostname,
              port: listenPort,
              url: `${wsScheme}://${hostname}:${listenPort}`,
              schedulingEnabled: enableSchedule,
            }));
          } else {
            logger.info("WebSocket API server listening on {url}", {
              url: `${wsScheme}://${hostname}:${listenPort}`,
            });
          }
        },
      },
      async (req, info) => {
        // WebSocket upgrade (check first — upgrade requests are also GETs)
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const remoteAddr = trustProxy
            ? (req.headers.get("x-forwarded-for")
              ?.split(",")[0]?.trim() ??
              info.remoteAddr.hostname)
            : info.remoteAddr.hostname;

          const originCheck = validateWebSocketOrigin(
            req.headers.get("origin"),
            req.headers.get("host"),
            host,
            tlsEnabled,
            trustedHosts,
          );
          if (!originCheck.allowed) {
            logger.warn(
              "WebSocket upgrade rejected: {reason} from {ip}",
              { reason: originCheck.reason, ip: remoteAddr },
            );
            return new Response(
              `Forbidden: ${originCheck.reason}`,
              { status: 403 },
            );
          }

          if (authConfig.mode !== "none") {
            if (!checkRateLimit(remoteAddr)) {
              logger.warn("WebSocket auth rate-limited from {ip}", {
                ip: remoteAddr,
              });
              return new Response("Too Many Requests", { status: 429 });
            }

            const extracted = extractWebSocketToken(req);
            if (!extracted) {
              logger.warn(
                "WebSocket auth rejected: no token provided from {ip}",
                { ip: remoteAddr },
              );
              return new Response("Unauthorized: token required", {
                status: 401,
              });
            }
            logger.debug(
              "WebSocket token received via {transport} from {ip}",
              { transport: extracted.transport, ip: remoteAddr },
            );
            const result = await authenticateServerToken(
              extracted.token,
              resolvedRepoDir,
              repoContext,
            );
            if (!result.ok) {
              logger.warn(
                "WebSocket auth rejected from {ip}: {error}",
                { ip: remoteAddr, error: result.error },
              );
              return new Response("Unauthorized", { status: 401 });
            }
            clearRateLimit(remoteAddr);
            const principal = parsePrincipal(result.principalId);
            const upgradeOpts = extracted.transport === "subprotocol"
              ? {
                ...wsUpgradeOpts,
                protocol: `bearer.${extracted.token}`,
              }
              : wsUpgradeOpts;
            const { socket, response } = Deno.upgradeWebSocket(
              req,
              upgradeOpts,
            );
            setConnectionCollectives(
              socket,
              result.collectives,
              result.groups,
              result.principalId,
            );
            socket.addEventListener("close", () => removeConnection(socket));
            handleConnection(socket, connectionCtx, principal);
            return response;
          }
          const { socket, response } = Deno.upgradeWebSocket(
            req,
            wsUpgradeOpts,
          );
          handleConnection(socket, connectionCtx, null);
          return response;
        }

        // Remote-execution data plane (bearer-authenticated worker routes)
        const dataPlaneResponse = await dataPlane.handle(req);
        if (dataPlaneResponse) return dataPlaneResponse;

        // Webhook endpoints (POST only, checked before health)
        if (webhookService && req.method === "POST") {
          const webhookResponse = await webhookService.handleRequest(req);
          if (webhookResponse) return webhookResponse;
        }

        // Cancel endpoint (authenticated — same auth as WebSocket)
        if (req.method === "POST") {
          const url = new URL(req.url);
          const cancelMatch = url.pathname.match(
            /^\/api\/v1\/cancel\/(workflow-run|method-run)\/([^/]+)$/,
          );
          const isBulkCancel = url.pathname === "/api/v1/cancel";
          if (cancelMatch || isBulkCancel) {
            if (authConfig.mode !== "none") {
              const authHeader = req.headers.get("authorization");
              const token = authHeader?.startsWith("Bearer ")
                ? authHeader.slice(7)
                : null;
              if (!token) {
                return new Response("Unauthorized: token required", {
                  status: 401,
                });
              }
              const authResult = await authenticateServerToken(
                token,
                resolvedRepoDir,
                repoContext,
              );
              if (!authResult.ok) {
                return new Response("Unauthorized", { status: 401 });
              }
            }
          }
          if (cancelMatch) {
            const executionType = cancelMatch[1] as
              | "workflow-run"
              | "method-run";
            const executionId = cancelMatch[2];
            // Check cancel registry first (WebSocket ad-hoc and webhook runs)
            let found = cancelRegistry.cancel(executionType, executionId);
            // For workflow runs, also check scheduled execution service
            if (
              !found && executionType === "workflow-run" && scheduledExecution
            ) {
              found = scheduledExecution.cancelByRunId(executionId);
            }
            if (found) {
              return Response.json({
                status: "cancelled",
                executionType,
                executionId,
              });
            }
            return Response.json({
              status: "not_found",
              message:
                `No active ${executionType} with id ${executionId} in this serve instance`,
            }, { status: 404 });
          }
          if (url.pathname === "/api/v1/cancel") {
            const body = await req.json().catch(() => ({}));
            const typeFilter = typeof body.executionType === "string"
              ? body.executionType
              : undefined;
            if (
              typeFilter && typeFilter !== "workflow-run" &&
              typeFilter !== "method-run"
            ) {
              return Response.json({
                status: "error",
                message: "executionType must be 'workflow-run' or 'method-run'",
              }, { status: 400 });
            }
            let count = cancelRegistry.cancelAll(typeFilter);
            if (
              (!typeFilter || typeFilter === "workflow-run") &&
              scheduledExecution
            ) {
              count += scheduledExecution.cancelAllRuns();
            }
            return Response.json({ status: "cancelled", count });
          }
        }

        // Device authorization endpoints (OAuth mode only)
        if (authConfig.mode === "oauth" && authConfig.oauthClientId) {
          const url = new URL(req.url);
          if (url.pathname === "/auth/device") {
            const deviceRemoteAddr = trustProxy
              ? (req.headers.get("x-forwarded-for")
                ?.split(",")[0]?.trim() ??
                info.remoteAddr.hostname)
              : info.remoteAddr.hostname;
            if (!checkRateLimit(deviceRemoteAddr)) {
              return new Response(
                JSON.stringify({ error: "Too Many Requests" }),
                {
                  status: 429,
                  headers: { "content-type": "application/json" },
                },
              );
            }
          }
          const oauthConfig = {
            ...authConfig,
            oauthClientId: authConfig.oauthClientId!,
          };
          const deviceAuthDeps = createDeviceAuthDeps(
            oauthConfig,
            oauthClientSecret,
            resolvedRepoDir,
            repoContext,
          );
          const deviceAuthResponse = await handleDeviceAuth(
            req,
            deviceAuthDeps,
          );
          if (deviceAuthResponse) return deviceAuthResponse;
        }

        // Auth discovery (unauthenticated — mode is not sensitive)
        if (
          req.method === "GET" && new URL(req.url).pathname === "/auth/info"
        ) {
          const authInfo: Record<string, string> = { mode: authConfig.mode };
          if (authConfig.mode === "oauth") {
            authInfo.verificationBaseUri = authConfig.oauthProvider;
          }
          return new Response(JSON.stringify(authInfo), {
            headers: { "content-type": "application/json" },
          });
        }

        // Health check endpoint
        if (req.method === "GET") {
          const url = new URL(req.url);
          if (url.pathname === "/" || url.pathname === "/health") {
            const schedules = scheduledExecution?.listSchedules().map((s) => ({
              workflowId: s.workflowId,
              cronExpression: s.cronExpression,
              nextRun: s.nextRun?.toISOString() ?? null,
              running: scheduledExecution!.isRunning(s.workflowId),
            })) ?? [];

            const webhooks = webhookService
              ? webhookService.listEndpoints().map((ep) => ({
                route: ep.route,
                workflow: ep.workflowIdOrName,
                scheme: ep.scheme,
              }))
              : [];

            return Response.json({
              status: "ok",
              version: "1",
              scheduling: {
                enabled: enableSchedule,
                schedules,
              },
              webhooks,
            });
          }
        }

        return new Response("Not found", { status: 404 });
      },
    );

    // Hot-reload: PID file + SIGHUP handler
    const hotReload = options.hotReload === true;
    const pidPath = hotReload ? swampPath(resolvedRepoDir, "serve.pid") : null;

    if (hotReload && pidPath) {
      if (Deno.build.os === "windows") {
        throw new UserError(
          "--hot-reload is not supported on Windows (SIGHUP is unavailable). " +
            "Restart the serve process to pick up extension changes.",
        );
      }
      await Deno.writeTextFile(pidPath, String(Deno.pid));
      logger.info`Hot-reload enabled, PID file written to ${pidPath}`;

      let reloading = false;
      Deno.addSignalListener("SIGHUP", () => {
        if (reloading) {
          logger.warn("Hot-reload already in progress, ignoring SIGHUP");
          return;
        }
        reloading = true;
        logger.info("SIGHUP received, reloading pulled extensions...");
        reloadPulledExtensions(resolvedRepoDir, extensionLockfilePath)
          .then((count) => {
            logger.info`Hot-reloaded ${count} type(s)`;
          })
          .catch((err) => {
            logger.error(
              "Hot-reload failed, continuing with old code: {error}",
              {
                error: err instanceof Error ? err.message : String(err),
              },
            );
          })
          .finally(() => {
            reloading = false;
          });
      });
    }

    // Handle SIGINT/SIGTERM for graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (isJson) {
        console.log(JSON.stringify({ status: "stopping" }));
      }
      logger.info("Shutting down...");
      if (webhookService) {
        await webhookService.stop();
      }
      if (scheduledExecution) {
        await scheduledExecution.stop();
      }
      if (collectiveRefreshService) {
        await collectiveRefreshService.dispose();
      }
      await policySnapshotLoader.dispose();
      rejectionGuard.dispose();
      setRemoteStepDispatcher(null);
      ac.abort();
      if (pidPath) {
        try {
          await Deno.remove(pidPath);
        } catch {
          // PID file may already be gone
        }
      }
      if (isJson) {
        console.log(JSON.stringify({ status: "stopped" }));
      }
    };
    registerShutdownHandler({
      handler: () => {
        shutdown().catch((e) =>
          logger.error("Shutdown error: {error}", {
            error: e instanceof Error ? e.message : String(e),
          })
        );
      },
      includePosixSignals: !hotReload,
    });
    if (hotReload) {
      // SIGHUP is handled by the hot-reload handler above, but
      // SIGTERM still needs to trigger shutdown on POSIX.
      if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", () => {
          shutdown().catch((e) =>
            logger.error("Shutdown error: {error}", {
              error: e instanceof Error ? e.message : String(e),
            })
          );
        });
      }
    }

    await server.finished;

    repoContext.catalogStore.close();
  })
  .command("reload", reloadCommand)
  .command("daemon", daemonCommand);
