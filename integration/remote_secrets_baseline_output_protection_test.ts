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
 * Remote-secrets baseline, path 6: output protection (swamp-club#3512).
 *
 * Pins where a secret the step was dispatched with, or one the worker
 * learns during the dispatch, ends up redacted and where it travels
 * verbatim: the worker's result error and the step lease it is stored on,
 * the runner's stderr logs and the supervisor's re-log of them, serve's
 * per-dispatch redactor, and the data-plane write routes. Typed-secrets
 * Phase 5 changes several of these on purpose (design/enablers/
 * typed-secrets.md §7.1 and §9); a failure here means one of them changed.
 *
 * All in-process except the supervisor test, which spawns the baseline
 * runner entry (a runner, not the CLI): the supervisor reads runner stderr
 * only from a child process.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import {
  type DispatchParams,
  type DispatchResult,
  REMOTE_PROTOCOL_VERSION,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import type { RemoteStepRequest } from "../src/domain/remote/remote_dispatch.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../src/domain/remote/stdio_transport.ts";
import {
  leaseDataName,
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../src/domain/models/worker/step_lease_model.ts";
import { runDispatchRunner } from "../src/worker/exec_dispatch.ts";
import { registerDispatchHandler } from "../src/worker/dispatch_handler.ts";
import { DataPlaneClient } from "../src/worker/data_plane_client.ts";
import type { RunnerBootstrapParams } from "../src/worker/runner_protocol.ts";
import { OUTPUT_BASELINE_TYPE } from "./remote_secrets_baseline_output_protection_model.ts";
import {
  BASELINE_VAULT,
  canary,
  captureLogs,
  connectInMemoryWorker,
  logsHolding,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const RUNNER_ENTRY = join(
  dirname(fromFileUrl(import.meta.url)),
  "test_fixtures",
  "remote_secrets_baseline_runner_entry.ts",
);
const RUNNER_COMMAND = {
  cmd: Deno.execPath(),
  args: [
    "run",
    "--unstable-bundle",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--allow-net",
    "--allow-sys",
    RUNNER_ENTRY,
  ],
};

const decoder = new TextDecoder();

/** A dispatch of the fixture's `fail` method carrying `secret`. */
function failDispatch(secret: string): DispatchParams {
  return {
    dispatchId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    execution: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      modelType: OUTPUT_BASELINE_TYPE.normalized,
      modelId: crypto.randomUUID(),
      methodName: "fail",
      globalArgs: {},
      // Resolved plaintext, as #executeRemotely sends it.
      methodArgs: { secret },
      definitionMeta: {
        id: crypto.randomUUID(),
        name: "output-baseline",
        version: 1,
        tags: {},
      },
    },
    bundleFingerprint: `builtin:${OUTPUT_BASELINE_TYPE.normalized}`,
    reportBundleFingerprints: [],
    environmentSnapshot: {},
    secretValues: [secret],
  };
}

interface RunnerRun {
  result: DispatchResult;
  /** Every frame the runner wrote to stdout, the result frame included. */
  frames: string[];
}

/** Runs one dispatch through the runner in this process. */
async function runInProcess(bootstrap: RunnerBootstrapParams): Promise<
  RunnerRun
> {
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdinWriter = new StdioTransport(stdin.writable);
  stdinWriter.send(JSON.stringify(bootstrap));
  const written: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  await runDispatchRunner(stdin.readable, stdout);
  stdinWriter.close();
  await stdin.writable.close();
  const frames: string[] = [];
  await createStdioReader(
    ReadableStream.from(written),
    (frame) => frames.push(frame),
    () => {},
  );
  const resultFrame = frames.map((f) => JSON.parse(f)).find((f) =>
    f.type === "runner.result"
  );
  assertExists(resultFrame, "the runner sent a result frame");
  return { result: resultFrame.result as DispatchResult, frames };
}

async function withCacheDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-baseline-cache-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function stepRequest(
  overrides: Partial<RemoteStepRequest> & {
    methodArgs: Record<string, unknown>;
  },
): RemoteStepRequest {
  const definitionId = crypto.randomUUID();
  return {
    placement: { labels: { tier: "baseline" } },
    modelDef: modelRegistry.get(OUTPUT_BASELINE_TYPE)!,
    modelType: OUTPUT_BASELINE_TYPE,
    modelId: definitionId,
    methodName: "fail",
    definitionName: "output-baseline",
    definitionTags: {},
    definitionMeta: {
      id: definitionId,
      name: "output-baseline",
      version: 1,
      tags: {},
    },
    globalArgs: {},
    workflowName: "baseline-workflow",
    stepName: "baseline-step",
    ...overrides,
  };
}

Deno.test({
  name:
    "remote secrets baseline: output protection: the worker result error carries the secret verbatim while result logs are redacted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withCacheDir(async (cacheDirPath) => {
      const secret = canary("result-error");
      const { result, frames } = await runInProcess({
        sessionCredential: "unused",
        dataPlaneUrl: "http://127.0.0.1:9",
        cacheDirPath,
        dispatch: failDispatch(secret),
      });

      assertEquals(result.status, "error");
      // Disclosure (swamp-club#3525): the thrown message goes
      // into result.error unredacted, though the runner holds a redactor
      // that knows the value. Only result.logs are scrubbed.
      assertStringIncludes(result.error ?? "", secret);
      assertEquals(result.logs.filter((line) => line.includes(secret)), []);
      assert(result.logs.includes("console line ***"));
      // Output events streamed to serve before the result are scrubbed.
      const events = frames.filter((f) => f.includes("runner.event"));
      assert(events.length > 0, "the method log line was streamed");
      assertEquals(events.filter((f) => f.includes(secret)), []);
      assert(events.some((f) => f.includes("method log line ***")));
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: output protection: the step lease's fail record stores the worker error verbatim",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const worker = await connectInMemoryWorker(o, "lease-worker");
        let leaseId: string | undefined;
        // The worker runs the dispatch through the real runner, in-process.
        worker.channel.register(WorkerMethod.dispatch, async (raw) => {
          const params = raw as DispatchParams & {
            dispatchCredential?: string;
          };
          leaseId = params.leaseId;
          let run: RunnerRun | undefined;
          await withCacheDir(async (cacheDirPath) => {
            run = await runInProcess({
              sessionCredential: params.dispatchCredential ?? "",
              dataPlaneUrl: o.dataPlaneUrl,
              cacheDirPath,
              dispatch: params,
            });
          });
          return run!.result;
        });

        const secret = canary("lease-error");
        await assertRejects(
          () =>
            o.dispatchService.executeRemote(stepRequest({
              methodArgs: { secret },
              secretValues: [secret],
            })),
          Error,
          secret,
        );

        assertExists(leaseId);
        const leaseDef = await o.repoContext.definitionRepo.findByName(
          STEP_LEASE_MODEL_TYPE,
          STEP_LEASE_INSTANCE_NAME,
        );
        assertExists(leaseDef);
        const content = await o.repoContext.unifiedDataRepo.getContent(
          STEP_LEASE_MODEL_TYPE,
          leaseDef.id,
          leaseDataName(leaseId),
        );
        assertExists(content);
        const lease = JSON.parse(decoder.decode(content));
        assertEquals(lease.state, "failed");
        // Disclosure (swamp-club#3525): serve passes the worker's
        // result.error to the lease unredacted, though its own dispatch
        // redactor holds the value.
        assertStringIncludes(lease.error, secret);
      } finally {
        await o.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: output protection: the runner's own logs hold the method log line and the failure unredacted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withCacheDir(async (cacheDirPath) => {
      const secret = canary("runner-log");
      const logs = await captureLogs(async () => {
        await runInProcess({
          sessionCredential: "unused",
          dataPlaneUrl: "http://127.0.0.1:9",
          cacheDirPath,
          dispatch: failDispatch(secret),
        });
      });

      // Disclosure (swamp-club#3526): the method logger writes
      // through to the runner's own sink before the scrubbed copy is
      // streamed, and the failure is logged with the raw message. The
      // runner's sink is its stderr, which the supervisor reads.
      const holding = logsHolding(logs, secret).map((log) =>
        `${log.category} ${log.level}: ${log.text}`
      );
      assertEquals(holding.sort(), [
        `worker.method-context info: method log line ${secret}`,
        `worker.runner warning: Runner dispatch failed: method failed holding ${secret}`,
      ]);
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: output protection: the supervisor re-logs runner stderr, secret included, at debug",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const worker = await connectInMemoryWorker(o, "supervisor-worker");
        registerDispatchHandler({
          channel: worker.channel,
          sessionCredential: () => worker.enrollResult.sessionCredential,
          dataPlaneUrl: o.dataPlaneUrl,
          cacheDirPath: join(dir, "worker-cache"),
          capacity: 1,
          runnerCommand: RUNNER_COMMAND,
        });

        const secret = canary("supervisor-log");
        const logs = await captureLogs(async () => {
          await assertRejects(
            () =>
              o.dispatchService.executeRemote(stepRequest({
                methodArgs: { secret },
                secretValues: [secret],
              })),
            Error,
            secret,
          );
        });
        const dispatchId = logs.map((log) =>
          /^Runner \[([^\]]+)\]: /.exec(log.text)?.[1]
        ).find((id) => id !== undefined);
        assertExists(dispatchId, "the supervisor logged runner stderr");

        // Disclosure (swamp-club#3526): every runner stderr line
        // is re-logged on the worker at debug, unredacted.
        const relogged = logsHolding(logs, secret).filter((log) =>
          log.category === "worker.dispatch" && log.level === "debug" &&
          log.text.startsWith(`Runner [${dispatchId}]: `)
        );
        assert(
          relogged.some((log) => log.text.includes("method log line")),
          "the method log line is re-logged",
        );
        assert(
          relogged.some((log) => log.text.includes("Runner dispatch failed")),
          "the runner's failure line is re-logged",
        );
      } finally {
        await o.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: output protection: serve's dispatch redactor knows the pre-dispatch values only, and only the resource route uses it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const worker = await connectInMemoryWorker(o, "redactor-worker");
        const shipped = canary("shipped");
        const learned = canary("learned");
        const learnedKey = `baseline-learned-${crypto.randomUUID()}`;
        await o.putSecret(learnedKey, learned);

        const observed: {
          resolved?: unknown;
          redactorView?: string;
          resource?: { name: string; version: number };
          lines?: { name: string; version: number };
          content?: { name: string; version: number };
        } = {};
        worker.channel.register(WorkerMethod.dispatch, async (raw) => {
          const params = raw as DispatchParams & {
            dispatchCredential?: string;
          };
          // The secret the worker learns mid-dispatch, over the capability
          // verb. The step's args name it, so the allowlist admits it.
          const { value } = await o.capabilityService.resolveSecret(
            "redactor-worker",
            {
              vaultName: BASELINE_VAULT,
              secretKey: learnedKey,
              dispatchId: params.dispatchId,
            },
          );
          observed.resolved = value;
          const active = o.dispatches.forWorker("redactor-worker").find((d) =>
            d.dispatchId === params.dispatchId
          );
          assertExists(active?.redactor);
          observed.redactorView = active.redactor.redact(
            `shipped=${shipped} learned=${learned}`,
          );

          const client = new DataPlaneClient({
            baseUrl: o.dataPlaneUrl,
            credential: () => params.dispatchCredential ?? "",
          });
          observed.resource = await client.writeResource({
            specName: "out",
            name: "out-main",
            data: { note: `shipped=${shipped} learned=${learned}` },
          });
          const lineWriter = await client.openWriter({
            specName: "log",
            name: "log-lines",
          });
          await client.writeLine(lineWriter.writerId, `line ${shipped}`);
          observed.lines = await client.finalizeWriter(lineWriter.writerId);
          const contentWriter = await client.openWriter({
            specName: "log",
            name: "log-content",
          });
          observed.content = await client.writeContent(
            contentWriter.writerId,
            `content ${shipped}\n`,
          );
          return {
            status: "success",
            outputs: [],
            logs: [],
            durationMs: 1,
          } satisfies DispatchResult;
        });

        const request = stepRequest({
          methodArgs: {
            secret: shipped,
            note: `\${{ vault.get('${BASELINE_VAULT}', '${learnedKey}') }}`,
          },
          secretValues: [shipped],
        });
        await o.dispatchService.executeRemote(request);

        assertEquals(observed.resolved, learned);
        // Disclosure (swamp-club#3527): a value serve hands the
        // worker through resolveSecret is never added to the dispatch's
        // redactor, so serve-side scrubbing misses it.
        assertEquals(observed.redactorView, `shipped=*** learned=${learned}`);

        const read = async (stored?: { name: string; version: number }) => {
          assertExists(stored);
          const bytes = await o.repoContext.unifiedDataRepo.getContent(
            OUTPUT_BASELINE_TYPE,
            request.modelId,
            stored.name,
            stored.version,
          );
          assertExists(bytes, `${stored.name} was stored`);
          return decoder.decode(bytes);
        };
        // POST /data/resource scrubs with the dispatch redactor, so the
        // shipped value is masked and the learned one is not.
        assertEquals(JSON.parse(await read(observed.resource)), {
          note: `shipped=*** learned=${learned}`,
        });
        // The file-writer routes have no redactor: a documented known limit
        // (design/enablers/remote-execution.md), not a new finding.
        assertEquals(await read(observed.lines), `line ${shipped}\n`);
        assertEquals(await read(observed.content), `content ${shipped}\n`);
      } finally {
        await o.shutdown();
      }
    });
  },
});
