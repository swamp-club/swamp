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

import { join, resolve } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  ROOT_SERVE,
  type ServeId,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { readCredentialFile } from "../../infrastructure/persistence/api_key_source.ts";
import { HostedWorkspaceFileRepository } from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import { validateEndEntityCert } from "../../infrastructure/runtime/tls_cert_validation.ts";
import {
  acquireHostStateLock,
  type HostStateLock,
} from "../../infrastructure/persistence/host_state_lock.ts";
import { type HostConfig, isWithin } from "./host_config.ts";
import type { ServeChildSpec, ServeProcessPort } from "./serve_process.ts";
import { createStatusWriter, type StatusWriter } from "./status_writer.ts";
import {
  createServeSupervisor,
  type ServeAdmission,
  type ServeSupervisor,
  type ServeSupervisorOptions,
} from "./supervisor.ts";
import {
  REPO_MARKER_FILE,
  scanWorkspaces,
} from "../../infrastructure/persistence/hosted_workspace_folder_scan.ts";
import {
  DEFAULT_RESCAN_MS,
  SkipLog,
  watchWorkspaces,
  type WorkspaceChange,
  type WorkspaceWatcher,
} from "./workspace_folder.ts";
import {
  type CreatedWorkspaceRemoval,
  createWorkspaceReconciler,
  readWantedFiles,
  type WorkspaceReconciler,
} from "./workspace_reconciler.ts";
import {
  createWorkspaceRegistrar,
  RegistryProblemLog,
  type WorkspaceRegistrar,
} from "./workspace_registration.ts";
import { createWorkspaceRoster } from "./workspace_roster.ts";
import { freshFolderClaim } from "../../libswamp/workspace/hosted_roster.ts";
import {
  type HostedRegistryDeps,
  registeredFolderOf,
  unregisterCreatedWorkspace,
} from "../../libswamp/workspace/hosted_registration.ts";
import { workspacesRoot } from "../../libswamp/workspace/workspace_store.ts";
import {
  createWorkspaceRouter,
  type WorkspaceDirectory,
  type WorkspaceRoute,
} from "./workspace_router.ts";

const logger = getSwampLogger(["serve", "host"]);

export interface ServeHostOptions {
  readonly config: HostConfig;
  readonly processPort: ServeProcessPort;
  /** every child's whole environment */
  readonly childEnv: Readonly<Record<string, string>>;
  readonly workspaceStore: HostedRegistryDeps;
  /** workspaces.dir as set, where a host with no host folder creates; undefined for the data dir's own */
  readonly configuredParent?: () => Promise<string | undefined>;
  readonly onWorkspaceChange?: (change: WorkspaceChange) => void;
  readonly rescanMs?: number;
  readonly supervisor?: Pick<
    ServeSupervisorOptions,
    "clock" | "policy" | "readyTimeoutMs" | "stopGraceMs"
  >;
}

export interface ServeHost {
  readonly hostname: string;
  readonly port: number;
  /** the workspaces found at startup, sorted */
  readonly workspaces: readonly string[];
  reload(): void;
  shutdown(): Promise<void>;
  readonly finished: Promise<void>;
}

export function createdWorkspaceRemoval(
  options: Pick<ServeHostOptions, "workspaceStore" | "configuredParent">,
): CreatedWorkspaceRemoval {
  const store = options.workspaceStore;
  return {
    async registeredFolder(name) {
      const read = await registeredFolderOf(store, name);
      if (read.kind === "unreadable") throw new Error(read.reason);
      return read.folder;
    },
    async unregister(name, path) {
      const result = await unregisterCreatedWorkspace(store, {
        name,
        folder: path,
      });
      if (result.kind === "unreadable") throw new Error(result.reason);
    },
    async locations() {
      const dirs = [workspacesRoot(store.dataDir)];
      const configured = await options.configuredParent?.().catch(() =>
        undefined
      );
      if (configured !== undefined) dirs.push(configured);
      return dirs;
    },
  };
}

export async function startServeHost(
  options: ServeHostOptions,
): Promise<ServeHost> {
  const { config } = options;

  // before any wanted file is read or status written, and released on every failed start
  const lock = await acquireHostStateLock(config.stateDir);
  try {
    return await startLocked(options, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function startLocked(
  options: ServeHostOptions,
  lock: HostStateLock,
): Promise<ServeHost> {
  const { config, processPort, childEnv } = options;
  const rescanMs = options.rescanMs ?? DEFAULT_RESCAN_MS;
  const repos = config.hostFolder !== null;

  const tls = await readTls(config);
  if (config.root !== null) await requireRootRepo(config.root);
  if (config.oauthClient !== null) {
    // read only to refuse what each child would refuse; the value is dropped
    readCredentialFile(
      config.oauthClient.secretFile,
      "host.yaml oauth-client.secret-file",
    );
  }
  const skipLog = new SkipLog();
  const scan = await scanWorkspaces(config.stateDir, { repos });
  skipLog.report(scan.skipped, rescanMs);
  const repository = new HostedWorkspaceFileRepository(config.stateDir);
  const reads = await readWantedFiles(repository, scan);
  const registryProblems = new RegistryProblemLog();
  const roster = createWorkspaceRoster({
    workspacesDir: config.stateDir,
    hostFolder: repos,
    rootRepo: config.root,
    store: options.workspaceStore,
    problems: registryProblems,
  });
  const folders = await roster.read(scan, reads);

  const statusWriter = createStatusWriter({
    workspacesDir: config.stateDir,
  });
  const supervisor = createServeSupervisor({
    ...options.supervisor,
    processPort,
    admit: noAuthAdmission(config),
    onStatus: (status) => statusWriter.report(status),
  });
  const routerAbort = new AbortController();
  const router = createWorkspaceRouter({
    directory: hostDirectory(config, supervisor),
    protocol: config.protocol,
    trustProxy: config.trustProxy,
    signal: routerAbort.signal,
  });

  let server: Deno.HttpServer<Deno.NetAddr>;
  try {
    server = Deno.serve({
      hostname: config.listen.host,
      port: config.listen.port,
      ...tls,
      // the command prints its own listening line
      onListen: () => {},
    }, (req, info) => router.handle(req, info));
  } catch (error) {
    routerAbort.abort();
    await supervisor.shutdown();
    const reason = error instanceof Error ? error.message : String(error);
    throw new UserError(
      `The host cannot listen on ${config.listen.host}:${config.listen.port}: ${reason}. Set listen.host or listen.port in host.yaml.`,
    );
  }
  const bound = server.addr;

  const specOf = (id: ServeId, repoDir: string): ServeChildSpec => ({
    id,
    repoDir,
    address: id.kind === "root" ? config.address : config.childAddress(id.name),
    trustedHost: config.trustedHost,
    env: childEnv,
    oauthClient: config.oauthClient,
    ...(id.kind === "root"
      ? {
        hostWorkspaces: {
          dir: config.stateDir,
          address: config.address,
          hasFolder: repos,
        },
      }
      // the root answers at the host's address
      : config.root !== null
      ? { rootAddress: config.address }
      : {}),
  });

  const registrar = createWorkspaceRegistrar({
    workspacesDir: config.stateDir,
    store: options.workspaceStore,
    problems: registryProblems,
  });
  const secretFile = config.oauthClient === null
    ? null
    // a workspace's folder is compared by its real path, so the file is too
    : await Deno.realPath(config.oauthClient.secretFile).catch(() =>
      resolve(config.oauthClient!.secretFile)
    );
  const reconciler = createWorkspaceReconciler({
    workspacesDir: config.stateDir,
    hostFolder: repos,
    created: repos ? undefined : createdWorkspaceRemoval(options),
    holdsOAuthSecret: (folder) =>
      secretFile !== null && isWithin(realPathSyncOrSelf(folder), secretFile),
    supervisor,
    specOf: (name, folder) => specOf(workspaceServe(name), folder),
    repository,
    statusWriter,
    registrar,
    freshClaim: (name) =>
      freshFolderClaim({
        store: options.workspaceStore,
        workspacesDir: config.stateDir,
        name,
      }),
  });
  const stack: HostStack = {
    lock,
    watcher: null,
    supervisor,
    reconciler,
    registrar,
    statusWriter,
    routerAbort,
    server,
  };
  let started: readonly string[] = [];
  try {
    // no await between the bind and these adds, so no request sees a
    // scanned workspace before the supervisor knows it
    if (config.root !== null) supervisor.add(specOf(ROOT_SERVE, config.root));
    started = reconciler.begin(scan, reads, folders);
    stack.watcher = watchWorkspaces({
      dir: config.stateDir,
      repos,
      // changes are reported against what the host announced it started
      initial: started,
      rescanMs,
      onChange: (change) => options.onWorkspaceChange?.(change),
      onRescan: async (rescan) => {
        const rescanReads = await readWantedFiles(repository, rescan);
        reconciler.reconcile(
          rescan,
          rescanReads,
          await roster.read(rescan, rescanReads),
        );
      },
      served: () => reconciler.served(),
    }, skipLog);
  } catch (error) {
    await stopAll(stack).catch(
      (cleanup) => {
        logger.error("Stopping the host after a failed start failed: {error}", {
          error: cleanup,
        });
      },
    );
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    hostname: bound.hostname,
    port: bound.port,
    workspaces: started,
    reload() {
      const asked = supervisor.reload();
      logger.info("Asked {count} ready serves to reload", { count: asked });
    },
    shutdown() {
      stopping ??= stopAll(stack);
      return stopping;
    },
    finished: server.finished,
  };
}

interface HostStack {
  readonly lock: HostStateLock;
  watcher: WorkspaceWatcher | null;
  readonly supervisor: ServeSupervisor;
  readonly reconciler: WorkspaceReconciler;
  readonly registrar: WorkspaceRegistrar;
  readonly statusWriter: StatusWriter;
  readonly routerAbort: AbortController;
  readonly server: Deno.HttpServer<Deno.NetAddr>;
}

// the listener closes last, so a request during the drain is answered, not
// refused; status files are marked stopped once no serve can report again
async function stopAll(stack: HostStack): Promise<void> {
  try {
    stack.registrar.close();
    await stack.watcher?.stop();
    await stack.supervisor.shutdown();
    await stack.reconciler.drain();
    await stack.registrar.drain();
    stack.statusWriter.markShutDown();
    await stack.statusWriter.drain();
    stack.routerAbort.abort();
    await stack.server.shutdown();
  } finally {
    stack.lock.release();
  }
}

export function noAuthAdmission(
  config: HostConfig,
): ServeAdmission | undefined {
  const refusal = config.noAuthRefusal();
  if (refusal === null) return undefined;
  return (_spec, listened) => listened.authMode === "none" ? refusal : null;
}

/** a removed workspace answers 404; one not ready answers 503 with its state */
export function hostDirectory(
  config: HostConfig,
  supervisor: Pick<ServeSupervisor, "lookup">,
): WorkspaceDirectory {
  const routeOf = (id: ServeId): WorkspaceRoute | undefined => {
    const status = supervisor.lookup(id);
    if (status === undefined || status.wanted === "deleted") return undefined;
    if (status.observed === "ready" && status.port !== null) {
      return { kind: "running", port: status.port };
    }
    return {
      kind: "unavailable",
      state: status.refusal !== null ? "refused" : status.observed,
    };
  };
  return {
    workspace: (name) => routeOf(workspaceServe(name)),
    root: () => config.root === null ? undefined : routeOf(ROOT_SERVE),
  };
}

// a workspace in workspaces/ is listed by its spelled path, which a symlinked host folder hides
function realPathSyncOrSelf(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return resolve(path);
  }
}

async function readTls(
  config: HostConfig,
): Promise<{ cert: string; key: string } | Record<never, never>> {
  const { certFile, keyFile } = config.listen;
  if (certFile === null || keyFile === null) return {};
  const cert = await readListenFile("listen.cert-file", certFile);
  const key = await readListenFile("listen.key-file", keyFile);
  for (const warning of validateEndEntityCert(cert)) {
    logger.warn("{warning}", { warning: warning.message });
  }
  return { cert, key };
}

// a mistyped root would otherwise crash-loop until it is held as failed
async function requireRootRepo(root: string): Promise<void> {
  try {
    if ((await Deno.stat(join(root, REPO_MARKER_FILE))).isFile) return;
  } catch {
    // reported below
  }
  throw markErrorPaths(
    new UserError(
      `The root ${root} named in host.yaml is not a swamp repo: it has no ${REPO_MARKER_FILE}.`,
    ),
    [root],
  );
}

async function readListenFile(field: string, path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw markErrorPaths(
      new UserError(`Cannot read ${field} ${path}: ${reason}`),
      [path],
    );
  }
}
