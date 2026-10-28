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
 * Shared harness for the remote-secrets baseline (swamp-club#3512).
 *
 * These tests characterize, with no behavior change, how a worker is
 * authorized to read secrets today and where secret plaintext travels
 * between serve, the worker supervisor and the runner. Typed-secrets Phase 5
 * replaces this path (design/enablers/typed-secrets.md §7.1, §9); a test here
 * failing means that behavior changed, which Phase 5 expects to do on purpose.
 *
 * The orchestrator here differs from the one in remote_execution_test.ts in
 * one way that matters: the CapabilityService gets the DispatchRegistry, as
 * `swamp serve` wires it (src/cli/commands/serve.ts), so the per-dispatch
 * secret allowlist is enforced. Workers connect in-process through
 * `WorkerGateway.attachTransport`; nothing here spawns a process.
 */

import { configure, type LogRecord } from "@logtape/logtape";

import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createStderrSink,
  initializeLogging,
} from "../src/infrastructure/logging/logger.ts";
import { textFormatter } from "../src/infrastructure/logging/log_format.ts";
import { setConsoleGuardStderrWriter } from "../src/domain/models/console_guard.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { DispatchService } from "../src/serve/dispatch_service.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  tokenSecretKey,
} from "../src/domain/models/worker/enrollment_token_model.ts";
import { sweepStaleRecords } from "../src/serve/boot_reconciliation.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import type { SessionCredentialService } from "../src/domain/remote/session_credential.ts";
import {
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../src/domain/remote/protocol.ts";

/** The vault every baseline repo is created with. */
export const BASELINE_VAULT = "local";

/** A secret value unique to one test run, so a match can only be a leak. */
export function canary(label: string): string {
  return `canary-${label}-${crypto.randomUUID()}`;
}

export async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-secrets-baseline-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** One captured log record, rendered with its interpolated values. */
export interface CapturedLog {
  category: string;
  level: string;
  text: string;
}

function renderRecord(record: LogRecord): CapturedLog {
  return {
    category: record.category.join("."),
    level: record.level,
    text: record.message.map((part) =>
      typeof part === "string" ? part : String(part)
    ).join(""),
  };
}

/**
 * Runs `fn` with every LogTape category captured at debug and above, then
 * restores the normal logging setup. LogTape's configuration is
 * process-global, so callers must not run two captures at once.
 */
export async function captureLogs(
  fn: () => Promise<void>,
): Promise<CapturedLog[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: [], lowestLevel: "debug", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured.map(renderRecord);
}

/**
 * Runs `fn` with what a runner writes to stderr collected instead: the real
 * stderr sink (`createStderrSink`) for every LogTape category at debug and
 * above, and the console guard's stderr writer, both into the returned
 * lines. That is exactly the stream a worker supervisor reads from a runner.
 * Restores the normal logging setup and the default console-guard writer
 * afterwards; both are process-global, so callers must not run two captures
 * at once.
 */
export async function captureRunnerStderr(
  fn: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const write = (text: string) => {
    lines.push(...text.replace(/\n$/, "").split("\n"));
  };
  await configure({
    sinks: { stderr: createStderrSink(textFormatter(), write) },
    loggers: [
      { category: [], lowestLevel: "debug", sinks: ["stderr"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  setConsoleGuardStderrWriter((line) => lines.push(line));
  try {
    await fn();
  } finally {
    setConsoleGuardStderrWriter(undefined);
    await initializeLogging({ _reset: true });
  }
  return lines;
}

/** The records whose rendered text contains `value`. */
export function logsHolding(
  logs: CapturedLog[],
  value: string,
): CapturedLog[] {
  return logs.filter((log) => log.text.includes(value));
}

export interface BaselineOrchestrator {
  repoDir: string;
  repoContext: ReturnType<typeof createRepositoryContext>;
  dispatches: DispatchRegistry;
  bundles: BundleRegistry;
  capabilityService: CapabilityService;
  dispatchService: DispatchService;
  gateway: WorkerGateway;
  dataPlane: DataPlane;
  /** `http://127.0.0.1:<port>` for the data plane. */
  dataPlaneUrl: string;
  /** Stores a secret in the repo's vault. */
  putSecret: (key: string, value: string) => Promise<void>;
  /** Mints an enrollment token and returns its redeemable form. */
  mintToken: (name: string) => Promise<string>;
  shutdown: () => Promise<void>;
}

async function initRepo(repoDir: string): Promise<void> {
  const libCtx = createLibSwampContext({});
  await consumeStream(
    repoInit(libCtx, createRepoInitDeps("20260101.120000.0"), {
      path: repoDir,
      force: false,
      version: "20260101.120000.0",
      // No tool scaffolding: the default ["claude"] would install bundled
      // skills into the real ~/.claude/skills.
      tools: [],
    }),
    withDefaults({
      error: (event) => {
        throw new Error(String(event.error?.message ?? "repo init failed"));
      },
    }),
  );
  await consumeStream(
    vaultCreate(libCtx, await createVaultCreateDeps(repoDir), {
      vaultType: "local_encryption",
      name: BASELINE_VAULT,
      config: { auto_generate: true, base_dir: repoDir },
      repoDir,
    }),
    withDefaults({
      error: (event) => {
        throw new Error(String(event.error?.message ?? "vault create failed"));
      },
    }),
  );
}

export interface BaselineOrchestratorOptions {
  /** The gateway's credential service, for an injected clock and timers. */
  sessionCredentials?: SessionCredentialService;
  /** Wraps the vault the data plane reads, so a test can hold its reads. */
  wrapDataPlaneVault?: (vault: VaultService) => VaultService;
}

/**
 * A real orchestrator assembly over a temp repo with a local_encryption
 * vault: gateway, capability service (allowlist enforced), dispatch service
 * and the HTTP data plane on a port-0 localhost listener.
 */
export async function startBaselineOrchestrator(
  repoDir: string,
  options: BaselineOrchestratorOptions = {},
): Promise<BaselineOrchestrator> {
  await initRepo(repoDir);
  const repoContext = createRepositoryContext({ repoDir });

  const runModelMethod = async (input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  }) => {
    const deps = await createWorkerModelRunDeps(repoDir, repoContext);
    for await (
      const event of modelMethodRun(createLibSwampContext({}), deps, {
        modelIdOrName: input.definitionName,
        methodName: input.methodName,
        inputs: input.inputs,
        lastEvaluated: false,
        typeArg: input.typeArg,
        definitionName: input.definitionName,
      })
    ) {
      if (event.kind === "error") {
        const detail = event.error as { message?: unknown };
        throw new Error(String(detail?.message ?? "model method failed"));
      }
    }
  };

  const dispatches = new DispatchRegistry();
  const bundles = new BundleRegistry();
  const capabilityService = new CapabilityService({
    repoDir,
    repoContext,
    dispatches,
  });
  const dispatchService = new DispatchService({
    repoDir,
    repoContext,
    dispatches,
    bundles,
    queueTimeoutMs: 15_000,
    captureEnvironment: () => ({}),
  });
  const gateway = new WorkerGateway({
    repoDir,
    repoContext,
    capabilityService,
    sessionCredentials: options.sessionCredentials,
    graceWindowMs: 1_000,
    onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
    onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
    onWorkerEnrolled: (worker) => dispatchService.notifyWorkerEnrolled(worker),
    onWorkerDraining: (worker) => dispatchService.notifyWorkerDraining(worker),
  });
  dispatchService.bindGateway(gateway);
  const wrapDataPlaneVault = options.wrapDataPlaneVault;
  const dataPlane = new DataPlane({
    repoDir,
    repoContext,
    sessions: gateway.sessions,
    dispatches,
    bundles,
    onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
    ...(wrapDataPlaneVault
      ? {
        createVaultService: async () =>
          wrapDataPlaneVault(await VaultService.fromRepository(repoDir)),
      }
      : {}),
  });
  dispatchService.setOnDispatchEnd((id) => dataPlane.releaseDispatch(id));

  await sweepStaleRecords({ repoContext });

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) =>
      (await dataPlane.handle(req)) ??
        new Response("Not found", { status: 404 }),
  );

  const vault = await VaultService.fromRepository(repoDir);

  return {
    repoDir,
    repoContext,
    dispatches,
    bundles,
    capabilityService,
    dispatchService,
    gateway,
    dataPlane,
    dataPlaneUrl: `http://127.0.0.1:${server.addr.port}`,
    putSecret: (key, value) => vault.put(BASELINE_VAULT, key, value),
    mintToken: async (name) => {
      await runModelMethod({
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: name,
        methodName: "mint",
        inputs: { durationMs: 10 * 60 * 1000, vaultName: BASELINE_VAULT },
      });
      const fresh = await VaultService.fromRepository(repoDir);
      const plaintext = await fresh.get(BASELINE_VAULT, tokenSecretKey(name));
      return `${name}.${plaintext}`;
    },
    shutdown: async () => {
      gateway.dispose();
      await server.shutdown();
      // Bookkeeping a dispatch records without waiting (a pending dispatch's
      // end) lands before the test removes the repo (swamp-club#4038).
      await dispatchService.settled();
    },
  };
}

export interface InMemoryWorker {
  /** The worker's side of the control channel; register dispatch here. */
  channel: RpcChannel;
  enrollResult: EnrollResult;
  dropSocket: () => void;
}

/**
 * Connects and enrolls a worker over an in-memory control socket, at
 * `protocolVersion` (the current one unless a test pins the version 5 frame
 * of the deprecation window). Register `WorkerMethod.dispatch` on the
 * returned channel to act as the worker.
 */
export async function connectInMemoryWorker(
  orchestrator: BaselineOrchestrator,
  name: string,
  labels: Record<string, string> = { tier: "baseline" },
  protocolVersion: number = REMOTE_PROTOCOL_VERSION,
): Promise<InMemoryWorker> {
  const token = await orchestrator.mintToken(name);
  const channel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => attached.feed(data)),
  });
  const attached = orchestrator.gateway.attachTransport({
    send: (data) => void Promise.resolve().then(() => channel.handleRaw(data)),
  }, () => attached.closed());
  const enrollResult = await channel.call<EnrollResult>(RemoteMethod.enroll, {
    token,
    instanceUuid: crypto.randomUUID(),
    machineId: `machine-${name}`,
    protocolVersion,
    swampVersion: "test",
    platform: "linux",
    arch: "x86_64",
    labels,
  });
  return { channel, enrollResult, dropSocket: () => attached.closed() };
}
