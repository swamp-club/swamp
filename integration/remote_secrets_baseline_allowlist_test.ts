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
 * Remote-secrets baseline, path 1: the per-dispatch secret allowlist
 * (swamp-club#3512).
 *
 * Serve registers each dispatch with `allowedSecrets`: the references the
 * step's secret bag holds, passed on the dispatch request because the
 * dispatched args carry resolved values, plus any `vault.get()` expression
 * still written in those args (swamp-club#3529). `resolveSecret` from the
 * worker is held to it, after the reserved-vault and key-prefix denylists,
 * unless it carries a resource claim serve verifies against the record (see
 * the readResource baseline, path 2). These tests pin how the allowlist is
 * derived on the production path and what each check admits or refuses.
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { setRemoteStepDispatcher } from "../src/domain/remote/remote_dispatch.ts";
import {
  type DispatchParams,
  type DispatchResult,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import type { ActiveDispatch } from "../src/serve/dispatch_registry.ts";
import { DataPlaneClient } from "../src/worker/data_plane_client.ts";
import {
  parseSensitiveFieldsTag,
  sensitiveVaultReferences,
} from "../src/domain/models/data_writer.ts";
import type { VaultExtractionResult } from "../src/domain/expressions/vault_reference_extractor.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { tokenSecretKey } from "../src/domain/models/worker/enrollment_token_model.ts";
import {
  BASELINE_VAULT,
  type BaselineOrchestrator,
  canary,
  connectInMemoryWorker,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

const SUCCESS: DispatchResult = {
  status: "success",
  outputs: [],
  logs: [],
  durationMs: 1,
};

/** The resource spec of a vaulting type: `password` is schema-sensitive. */
const VAULTING_SPEC = "secret";

/**
 * Registers a per-run model type whose `read` method takes one string. With
 * `withResource`, the type also declares a `secret` resource whose
 * `password` field is schema-sensitive, so a dispatch of it can write that
 * resource over the data plane.
 */
function registerReaderType(withResource = false): ModelType {
  const type = ModelType.create(
    `test/secrets-baseline-allowlist-${crypto.randomUUID()}`,
  );
  modelRegistry.register({
    type,
    version: "2026.10.15.1",
    globalArguments: z.object({}),
    ...(withResource
      ? {
        resources: {
          [VAULTING_SPEC]: {
            description: "a resource with one sensitive field",
            schema: z.object({
              password: z.string().meta({ sensitive: true }),
              note: z.string(),
            }),
            lifetime: "infinite" as const,
            garbageCollection: 5,
          },
        },
      }
      : {}),
    methods: {
      read: {
        description: "Runs on a worker; the body never runs in-process",
        arguments: z.object({ value: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
  });
  return type;
}

/** What the in-memory worker saw while a dispatch was active on serve. */
interface Observed {
  params: DispatchParams;
  active: ActiveDispatch;
}

/**
 * Makes `workerName` answer every dispatch by running `inside` while the
 * dispatch is still registered on serve, then reporting success.
 */
function answerDispatches(
  o: BaselineOrchestrator,
  worker: Awaited<ReturnType<typeof connectInMemoryWorker>>,
  workerName: string,
  inside: (observed: Observed) => Promise<void>,
): void {
  worker.channel.register(WorkerMethod.dispatch, async (raw) => {
    const params = raw as DispatchParams;
    const active = o.dispatches.forWorker(workerName).find((d) =>
      d.dispatchId === params.dispatchId
    );
    if (!active) throw new Error("dispatch not registered on serve");
    await inside({ params, active });
    return SUCCESS;
  });
}

/**
 * Calls the worker-facing `resolveSecret` verb, with a resource claim when
 * given; returns the value or the refusal.
 */
async function tryResolve(
  o: BaselineOrchestrator,
  workerName: string,
  dispatchId: string | undefined,
  vaultName: string,
  secretKey: string,
  resource?: { name: string; version: number },
): Promise<{ value?: unknown; refused?: string }> {
  try {
    const { value } = await o.capabilityService.resolveSecret(workerName, {
      vaultName,
      secretKey,
      ...(dispatchId ? { dispatchId } : {}),
      ...(resource ? { resource } : {}),
    });
    return { value };
  } catch (error) {
    return { refused: (error as Error).message };
  }
}

/** A direct remote step request for `type`, as a workflow step would build it. */
function remoteRequest(
  type: ModelType,
  methodArgs: Record<string, unknown>,
) {
  const id = crypto.randomUUID();
  return {
    placement: { labels: { tier: "baseline" } },
    modelDef: modelRegistry.get(type)!,
    modelType: type,
    modelId: id,
    methodName: "read",
    definitionName: "allowlist-def",
    definitionTags: {},
    definitionMeta: { id, name: "allowlist-def", version: 1, tags: {} },
    globalArgs: {},
    methodArgs,
    workflowName: "allowlist-wf",
    stepName: "allowlist-step",
  };
}

async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
): Promise<{ status?: string; errors: string[] }> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  let status: string | undefined;
  const errors: string[] = [];
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "completed") status = event.run.status;
      if (event.kind !== "started") {
        errors.push(JSON.stringify(event).slice(0, 600));
      }
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  return { status, errors };
}

Deno.test({
  name:
    "remote secrets baseline: allowlist: a workflow step's vault.get argument reaches serve already resolved, and its allowlist still names the reference, so the worker reads that secret and no other (swamp-club#3529)",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      setRemoteStepDispatcher(o.dispatchService);
      try {
        const key = `allowlist-${crypto.randomUUID()}`;
        const secret = canary("allowlist-e2e");
        await o.putSecret(key, secret);
        const other = `allowlist-other-${crypto.randomUUID()}`;
        await o.putSecret(other, canary("allowlist-other"));

        const type = registerReaderType();
        const definition = Definition.create({
          name: "allowlist-reader",
          methods: {
            read: {
              arguments: {
                value: `\${{ vault.get('${BASELINE_VAULT}', '${key}') }}`,
              },
            },
          },
        });
        await o.repoContext.definitionRepo.save(type, definition);

        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        const worker = await connectInMemoryWorker(o, workerName);
        const seen: Array<{
          methodArgs: Record<string, unknown>;
          allowedSecrets: VaultExtractionResult | undefined;
          resolved: { value?: unknown; refused?: string };
          unreferenced: { value?: unknown; refused?: string };
        }> = [];
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          seen.push({
            methodArgs: params.execution.methodArgs,
            allowedSecrets: active.allowedSecrets,
            resolved: await tryResolve(
              o,
              workerName,
              params.dispatchId,
              BASELINE_VAULT,
              key,
            ),
            unreferenced: await tryResolve(
              o,
              workerName,
              params.dispatchId,
              BASELINE_VAULT,
              other,
            ),
          });
        });

        const { status, errors } = await runWorkflow(
          dir,
          Workflow.create({
            name: `allowlist-${crypto.randomUUID().slice(0, 8)}`,
            jobs: [Job.create({
              name: "main",
              steps: [Step.create({
                name: "read",
                task: StepTask.model("allowlist-reader", "read"),
                labels: { tier: "baseline" },
              })],
            })],
          }),
        );
        assertEquals(status, "succeeded", errors.join("\n"));
        assertEquals(seen.length, 1);

        // The dispatched args hold the plaintext, not the expression ...
        assertEquals(seen[0].methodArgs, { value: secret });
        // ... so the allowlist comes from the step's secret bag, exact and
        // not dynamic (swamp-club#3529) ...
        assertEquals(seen[0].allowedSecrets, {
          staticRefs: [{ vaultName: BASELINE_VAULT, secretKey: key }],
          hasDynamicRefs: false,
        });
        // ... and the worker reads that secret and no other.
        assertEquals(seen[0].resolved, { value: secret });
        assertEquals(seen[0].unreferenced, {
          refused:
            `resolveSecret: secret '${other}' is not referenced by the dispatched step`,
        });
      } finally {
        setRemoteStepDispatcher(null);
        await o.shutdown();
      }
    }),
});

Deno.test({
  name:
    "remote secrets baseline: allowlist: a literal vault.get left in dispatched args admits that secret and refuses every other key",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const key = `listed-${crypto.randomUUID()}`;
        const other = `unlisted-${crypto.randomUUID()}`;
        const secret = canary("listed");
        await o.putSecret(key, secret);
        await o.putSecret(other, canary("unlisted"));

        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        const worker = await connectInMemoryWorker(o, workerName);
        let allowedSecrets: VaultExtractionResult | undefined;
        const results: Array<{ value?: unknown; refused?: string }> = [];
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          allowedSecrets = active.allowedSecrets;
          results.push(
            await tryResolve(
              o,
              workerName,
              params.dispatchId,
              BASELINE_VAULT,
              key,
            ),
          );
          results.push(
            await tryResolve(
              o,
              workerName,
              params.dispatchId,
              BASELINE_VAULT,
              other,
            ),
          );
        });

        await o.dispatchService.executeRemote(
          remoteRequest(registerReaderType(), {
            value: `\${{ vault.get('${BASELINE_VAULT}', '${key}') }}`,
          }),
        );

        assertEquals(allowedSecrets, {
          staticRefs: [{ vaultName: BASELINE_VAULT, secretKey: key }],
          hasDynamicRefs: false,
        });
        assertEquals(results, [
          { value: secret },
          {
            refused:
              `resolveSecret: secret '${other}' is not referenced by the dispatched step`,
          },
        ]);
      } finally {
        await o.shutdown();
      }
    }),
});

Deno.test({
  name:
    "remote secrets baseline: allowlist: a dynamic vault.get reference in dispatched args turns the allowlist off for the dispatch",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const key = `any-${crypto.randomUUID()}`;
        const secret = canary("dynamic");
        await o.putSecret(key, secret);

        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        const worker = await connectInMemoryWorker(o, workerName);
        let allowedSecrets: VaultExtractionResult | undefined;
        let result: { value?: unknown; refused?: string } = {};
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          allowedSecrets = active.allowedSecrets;
          result = await tryResolve(
            o,
            workerName,
            params.dispatchId,
            BASELINE_VAULT,
            key,
          );
        });

        await o.dispatchService.executeRemote(
          remoteRequest(registerReaderType(), {
            value: "${{ vault.get(inputs.vault, inputs.key) }}",
          }),
        );

        assertEquals(allowedSecrets, { staticRefs: [], hasDynamicRefs: true });
        // Expected by design: a reference serve cannot evaluate statically
        // disables the allowlist rather than refusing the step.
        assertEquals(result, { value: secret });
      } finally {
        await o.shutdown();
      }
    }),
});

Deno.test({
  name:
    "remote secrets baseline: allowlist: resolveSecret from a worker with no active dispatch is refused",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const key = `idle-${crypto.randomUUID()}`;
        await o.putSecret(key, canary("idle"));
        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        await connectInMemoryWorker(o, workerName);

        assertEquals(
          await tryResolve(o, workerName, undefined, BASELINE_VAULT, key),
          {
            refused:
              `resolveSecret: worker '${workerName}' has no active dispatch`,
          },
        );
        await assertRejects(
          () =>
            o.capabilityService.putSecret(workerName, {
              vaultName: BASELINE_VAULT,
              secretKey: key,
              secretValue: "overwrite",
            }),
          Error,
          `putSecret: worker '${workerName}' has no active dispatch`,
        );
      } finally {
        await o.shutdown();
      }
    }),
});

Deno.test({
  name:
    "remote secrets baseline: allowlist: the reserved vault and infrastructure key prefixes are refused before the allowlist, even when it is off",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        const worker = await connectInMemoryWorker(o, workerName);
        // The worker's own enrollment-token secret sits in the ordinary vault.
        const tokenKey = tokenSecretKey(workerName);
        const results: Array<{ value?: unknown; refused?: string }> = [];
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          assertEquals(active.allowedSecrets?.hasDynamicRefs, true);
          results.push(
            await tryResolve(
              o,
              workerName,
              params.dispatchId,
              TOKEN_SECRETS_VAULT_NAME,
              "anything",
            ),
          );
          results.push(
            await tryResolve(
              o,
              workerName,
              params.dispatchId,
              BASELINE_VAULT,
              tokenKey,
            ),
          );
          results.push(
            await tryResolve(
              o,
              workerName,
              params.dispatchId,
              BASELINE_VAULT,
              tokenKey.toUpperCase(),
            ),
          );
        });

        await o.dispatchService.executeRemote(
          remoteRequest(registerReaderType(), {
            value: "${{ vault.get(inputs.vault, inputs.key) }}",
          }),
        );

        const infra =
          "resolveSecret: access denied — infrastructure secrets are not accessible from dispatched methods";
        assertEquals(results, [
          {
            refused:
              `resolveSecret: access denied — reserved vault '${TOKEN_SECRETS_VAULT_NAME}' is not accessible from dispatched methods`,
          },
          { refused: infra },
          // The prefix match is case-insensitive.
          { refused: infra },
        ]);
      } finally {
        await o.shutdown();
      }
    }),
});

Deno.test({
  name:
    "remote secrets baseline: allowlist: putSecret is not held to the allowlist, only to the denylists and an active dispatch",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const written = `written-${crypto.randomUUID()}`;
        const value = canary("put");
        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        const worker = await connectInMemoryWorker(o, workerName);
        let allowedSecrets: VaultExtractionResult | undefined;
        let put: { ok?: boolean; refused?: string } = {};
        let reservedPut: { ok?: boolean; refused?: string } = {};
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          allowedSecrets = active.allowedSecrets;
          try {
            put = await o.capabilityService.putSecret(workerName, {
              vaultName: BASELINE_VAULT,
              secretKey: written,
              secretValue: value,
              dispatchId: params.dispatchId,
            });
          } catch (error) {
            put = { refused: (error as Error).message };
          }
          try {
            reservedPut = await o.capabilityService.putSecret(workerName, {
              vaultName: BASELINE_VAULT,
              secretKey: tokenSecretKey(workerName),
              secretValue: value,
              dispatchId: params.dispatchId,
            });
          } catch (error) {
            reservedPut = { refused: (error as Error).message };
          }
        });

        // No vault reference at all: an empty static allowlist.
        await o.dispatchService.executeRemote(
          remoteRequest(registerReaderType(), { value: "plain" }),
        );

        assertEquals(allowedSecrets, { staticRefs: [], hasDynamicRefs: false });
        assertEquals(put, { ok: true });
        assertEquals(reservedPut, {
          refused:
            "putSecret: access denied — infrastructure secrets are not accessible from dispatched methods",
        });
      } finally {
        await o.shutdown();
      }
    }),
});

Deno.test({
  name:
    "remote secrets baseline: allowlist: a crafted reference written into a sensitive field is vaulted as text, so a resource claim cannot launder a read of the secret it names (swamp-club#3529)",
  ...SANITIZE,
  fn: () =>
    withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const target = `launder-target-${crypto.randomUUID()}`;
        const targetSecret = canary("launder-target");
        await o.putSecret(target, targetSecret);
        const crafted = `\${{ vault.get('${BASELINE_VAULT}', '${target}') }}`;

        const type = registerReaderType(true);
        const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
        const worker = await connectInMemoryWorker(o, workerName);
        const observed: {
          tags?: Record<string, string>;
          content?: Record<string, unknown>;
          targetClaim?: { value?: unknown; refused?: string };
          storedClaim?: { value?: unknown; refused?: string };
        } = {};
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          const { dispatchCredential } = params as DispatchParams & {
            dispatchCredential?: string;
          };
          const client = new DataPlaneClient({
            baseUrl: o.dataPlaneUrl,
            credential: () => dispatchCredential ?? "",
          });
          // The worker writes the crafted text as the sensitive value.
          await client.writeResource({
            specName: VAULTING_SPEC,
            name: "crafted",
            data: { password: crafted, note: "n" },
          });
          const repo = o.repoContext.unifiedDataRepo;
          const record = await repo.findByName(
            active.modelType,
            active.modelId,
            "crafted",
          );
          if (!record) throw new Error("the crafted resource was not stored");
          const bytes = await repo.getContent(
            active.modelType,
            active.modelId,
            "crafted",
            record.version,
          );
          observed.tags = record.tags;
          observed.content = JSON.parse(new TextDecoder().decode(bytes!));
          const claim = { name: "crafted", version: record.version };
          // A claim for the secret the crafted text names ...
          observed.targetClaim = await tryResolve(
            o,
            workerName,
            params.dispatchId,
            BASELINE_VAULT,
            target,
            claim,
          );
          // ... and one for the reference the writer stored instead.
          const [stored] = sensitiveVaultReferences(
            observed.content!,
            parseSensitiveFieldsTag(record.tags),
          );
          observed.storedClaim = await tryResolve(
            o,
            workerName,
            params.dispatchId,
            stored.vaultName,
            stored.key,
            claim,
          );
        });

        await o.dispatchService.executeRemote(
          remoteRequest(type, { value: "plain" }),
        );

        // The writer vaulted the crafted text under a key of its own and
        // tagged the field, which never holds the crafted reference ...
        assertEquals(parseSensitiveFieldsTag(observed.tags!), ["password"]);
        assertNotEquals(observed.content!.password, crafted);
        // ... so the claim for the named secret is refused, and the claim
        // for the stored reference yields the crafted text, never the
        // secret it names.
        assertEquals(observed.targetClaim, {
          refused:
            `resolveSecret: secret '${target}' is not a tagged sensitive field of resource 'crafted' (its sensitive fields do not reference it)`,
        });
        assertEquals(observed.storedClaim, { value: crafted });
      } finally {
        await o.shutdown();
      }
    }),
});
