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
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
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
/** The resource spec of a vaulting type whose every field is sensitive. */
const VAULTING_ALL_SPEC = "all";

/**
 * Registers a per-run model type whose `read` method takes one string. With
 * `withResource`, the type also declares a `secret` resource whose
 * `password` field is schema-sensitive and an `all` resource with
 * `sensitiveOutput`, so a dispatch of it can write those resources over the
 * data plane.
 */
function registerReaderType(
  withResource = false,
  globalOnly = false,
): ModelType {
  const type = ModelType.create(
    `test/secrets-baseline-allowlist-${crypto.randomUUID()}`,
  );
  modelRegistry.register({
    type,
    version: "2026.10.15.1",
    globalArguments: globalOnly
      ? z.object({ value: z.string() })
      : z.object({}),
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
          [VAULTING_ALL_SPEC]: {
            description: "a resource whose every top-level field is sensitive",
            schema: z.record(z.string(), z.string()),
            lifetime: "infinite" as const,
            garbageCollection: 5,
            sensitiveOutput: true,
          },
          collision: {
            schema: z.object({
              "***": z.string().meta({ sensitive: true, vaultKey: "stored" }),
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
        arguments: globalOnly ? z.object({}) : z.object({ value: z.string() }),
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

for (const argumentSource of ["method", "global"] as const) {
  Deno.test({
    name:
      `remote secrets baseline: allowlist: a workflow step's ${argumentSource} vault.get argument retains its reference after resolution (swamp-club#3529)`,
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

          const type = registerReaderType(false, argumentSource === "global");
          const args = {
            value: `\${{ vault.get('${BASELINE_VAULT}', '${key}') }}`,
          };
          const definition = Definition.create({
            name: "allowlist-reader",
            globalArguments: argumentSource === "global" ? args : {},
            methods: {
              read: { arguments: argumentSource === "method" ? args : {} },
            },
          });
          await o.repoContext.definitionRepo.save(type, definition);

          const workerName = `w-${crypto.randomUUID().slice(0, 8)}`;
          // A version 5 worker, whose frame carries the resolved arguments
          // this test pins; the reference-only frame a version 6 worker
          // receives is pinned in remote_secrets_mixed_fleet_test.ts.
          const worker = await connectInMemoryWorker(
            o,
            workerName,
            undefined,
            LEGACY_PLAINTEXT_PROTOCOL_VERSION,
          );
          const seen: Array<{
            methodArgs: Record<string, unknown>;
            globalArgs: Record<string, unknown>;
            allowedSecrets: VaultExtractionResult | undefined;
            resolved: { value?: unknown; refused?: string };
            unreferenced: { value?: unknown; refused?: string };
          }> = [];
          answerDispatches(
            o,
            worker,
            workerName,
            async ({ params, active }) => {
              seen.push({
                methodArgs: params.execution.methodArgs,
                globalArgs: params.execution.globalArgs,
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
            },
          );

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
          assertEquals(
            seen[0].methodArgs,
            argumentSource === "method" ? { value: secret } : {},
          );
          assertEquals(
            seen[0].globalArgs,
            argumentSource === "global" ? { value: secret } : {},
          );
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
}

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
        // Claims reach resolveSecret from a version 5 worker; a version 6
        // one claims through the load route, which verifies them alike
        // (remote_secrets_load_route_test.ts).
        const worker = await connectInMemoryWorker(
          o,
          workerName,
          undefined,
          LEGACY_PLAINTEXT_PROTOCOL_VERSION,
        );
        interface Observed {
          tags: Record<string, string>;
          content: Record<string, unknown>;
          targetClaim: { value?: unknown; refused?: string };
          storedClaims: Array<{ value?: unknown; refused?: string }>;
        }
        const observed: Record<string, Observed> = {};
        answerDispatches(o, worker, workerName, async ({ params, active }) => {
          const { dispatchCredential } = params as DispatchParams & {
            dispatchCredential?: string;
          };
          const client = new DataPlaneClient({
            baseUrl: o.dataPlaneUrl,
            credential: () => dispatchCredential ?? "",
          });
          const repo = o.repoContext.unifiedDataRepo;
          // A property containing a delivered secret would redact to the
          // sensitive field's name. The data plane must refuse that write
          // before a record can authorize the unvaulted reference.
          await assertRejects(
            () =>
              client.writeResource({
                specName: "collision",
                name: "collision",
                data: { "***": "benign", "known-secret": crafted },
              }),
            Error,
            "redaction would merge object property names",
          );
          assertEquals(
            await repo.findByName(
              active.modelType,
              active.modelId,
              "collision",
            ),
            null,
          );
          // The worker writes the crafted text as a sensitive value: a
          // schema-sensitive field, and under sensitiveOutput a top-level
          // key holding a dot, which the writer must address by its name.
          const writes = [
            {
              specName: VAULTING_SPEC,
              name: "crafted",
              data: { password: crafted, note: "n" },
            },
            {
              specName: VAULTING_ALL_SPEC,
              name: "crafted-all",
              data: { "a.b": crafted, note: "n" },
            },
          ];
          for (const write of writes) {
            await client.writeResource(write);
            const record = await repo.findByName(
              active.modelType,
              active.modelId,
              write.name,
            );
            if (!record) throw new Error(`${write.name} was not stored`);
            const bytes = await repo.getContent(
              active.modelType,
              active.modelId,
              write.name,
              record.version,
            );
            const content = JSON.parse(new TextDecoder().decode(bytes!));
            const claim = { name: write.name, version: record.version };
            observed[write.name] = {
              tags: record.tags,
              content,
              // A claim for the secret the crafted text names ...
              targetClaim: await tryResolve(
                o,
                workerName,
                params.dispatchId,
                BASELINE_VAULT,
                target,
                claim,
              ),
              // ... and one for each reference the writer stored instead.
              storedClaims: [],
            };
            for (
              const stored of sensitiveVaultReferences(
                content,
                parseSensitiveFieldsTag(record.tags),
              )
            ) {
              observed[write.name].storedClaims.push(
                await tryResolve(
                  o,
                  workerName,
                  params.dispatchId,
                  stored.vaultName,
                  stored.key,
                  claim,
                ),
              );
            }
          }
        });

        await o.dispatchService.executeRemote(
          {
            ...remoteRequest(type, { value: "plain" }),
            // Masked by serve's dispatch redactor, as a sensitive literal
            // the step's arguments hold is.
            redactorSeeds: ["known-secret"],
          },
        );

        // The writer vaulted the crafted text under keys of its own and
        // tagged the fields, which never hold the crafted reference ...
        const schema = observed["crafted"];
        const all = observed["crafted-all"];
        assertEquals(parseSensitiveFieldsTag(schema.tags), ["password"]);
        assertNotEquals(schema.content.password, crafted);
        assertEquals(parseSensitiveFieldsTag(all.tags), "*");
        assertNotEquals(all.content["a.b"], crafted);
        assertNotEquals(all.content.note, "n");
        // ... so the claim for the named secret is refused, and the claims
        // for the stored references yield the crafted text and the note,
        // never the secret the text names.
        for (const name of ["crafted", "crafted-all"]) {
          assertEquals(observed[name].targetClaim, {
            refused:
              `resolveSecret: secret '${target}' is not a tagged sensitive field of resource '${name}' (its sensitive fields do not reference it)`,
          });
        }
        assertEquals(schema.storedClaims, [{ value: crafted }]);
        assertEquals(all.storedClaims, [{ value: crafted }, { value: "n" }]);
      } finally {
        await o.shutdown();
      }
    }),
});
