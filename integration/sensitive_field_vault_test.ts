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
 * Integration tests for sensitive field vault storage.
 *
 * Tests the full flow: resource data with sensitive fields → processSensitiveResourceData →
 * vault storage → data has vault references instead of plaintext.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { ensureDir, walk } from "@std/fs";
import { z } from "zod";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  createResourceReader,
  createResourceWriter,
  processSensitiveResourceData,
  resolveVaultRefsInData,
  SENSITIVE_FIELD_JSON_TAG,
  SENSITIVE_FIELD_KEYS_TAG,
  SENSITIVE_FIELDS_TAG,
} from "../src/domain/models/data_writer.ts";
import {
  getNestedValue,
  setNestedValue,
} from "../src/domain/models/sensitive_field_extractor.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { fromData } from "../src/domain/data/data_record_mapper.ts";
import { SecretRedactor } from "../src/domain/secrets/mod.ts";
import { adaptDataRecord } from "../src/infrastructure/cel/sensitive_record_adapter.ts";
import { runInFaultScope } from "../src/infrastructure/cel/secret_fault_context.ts";
import {
  isSecret,
  secretParts,
} from "../src/infrastructure/cel/secret_value.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import {
  createWorkflowRunClaims,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import {
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "../src/serve/deps.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createWorkflowApproveDeps,
  workflowApprove,
} from "../src/libswamp/workflows/approve.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import { SecretBoundary } from "../src/infrastructure/cel/secret_boundary.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import {
  rehydrateReferences,
  toPersistedForm,
} from "../src/domain/secrets/persisted_sensitive_form.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

Deno.test("Integration: sensitive output fields stored in vault with references in persisted data", async () => {
  const modelType = ModelType.create("test/sensitive-output");
  const modelId = crypto.randomUUID();
  const methodName = "createKeyPair";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      keyId: z.string(),
      keyMaterial: z.string().meta({ sensitive: true }),
      publicKey: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = {
    keyId: "key-12345",
    keyMaterial:
      "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
    publicKey: "ssh-rsa AAAAB3... user@host",
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
    "keypair",
    "main",
  );

  // Non-sensitive fields unchanged
  assertEquals(data.keyId, "key-12345");
  assertEquals(data.publicKey, "ssh-rsa AAAAB3... user@host");

  // Sensitive field replaced with vault reference
  const keyMaterialRef = data.keyMaterial as string;
  assertStringIncludes(keyMaterialRef, "vault.get");
  assertStringIncludes(keyMaterialRef, "'test-vault'");
  assertStringIncludes(keyMaterialRef, "${{ vault.get('test-vault'");

  // Verify the actual secret was stored in the vault
  const vaultKey =
    `test-sensitive-output-${modelId}-${methodName}-keypair-main-keyMaterial`;
  const storedSecret = await vaultService.get("test-vault", vaultKey);
  assertEquals(
    storedSecret,
    "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
  );

  // Verify data can be serialized to JSON (simulates persistence)
  const persistedJson = JSON.stringify(data);
  const parsed = JSON.parse(persistedJson);
  assertEquals(parsed.keyId, "key-12345");
  assertStringIncludes(parsed.keyMaterial, "vault.get");
  assertEquals(parsed.publicKey, "ssh-rsa AAAAB3... user@host");
});

Deno.test("Integration: sensitiveOutput flag vaults all fields", async () => {
  const modelType = ModelType.create("test/all-sensitive");
  const modelId = crypto.randomUUID();
  const methodName = "generate";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      field1: z.string(),
      field2: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,
  };

  const data: Record<string, unknown> = {
    field1: "secret-value-1",
    field2: "secret-value-2",
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
    "secrets",
    "main",
  );

  // Both fields should be vault references
  assertStringIncludes(data.field1 as string, "vault.get");
  assertStringIncludes(data.field2 as string, "vault.get");

  // Verify values stored in vault
  const key1 =
    `test-all-sensitive-${modelId}-${methodName}-secrets-main-field1`;
  const key2 =
    `test-all-sensitive-${modelId}-${methodName}-secrets-main-field2`;
  assertEquals(
    await vaultService.get("test-vault", key1),
    "secret-value-1",
  );
  assertEquals(
    await vaultService.get("test-vault", key2),
    "secret-value-2",
  );
});

Deno.test("Integration: custom vaultKey from schema metadata", async () => {
  const modelType = ModelType.create("test/custom-key");
  const modelId = crypto.randomUUID();
  const methodName = "generate";

  const spec: ResourceOutputSpec = {
    schema: z.object({
      apiKey: z.string().meta({
        sensitive: true,
        vaultKey: "generated-api-key",
      }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  };

  const data: Record<string, unknown> = { apiKey: "sk-live-abc123def456" };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "test-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    methodName,
    "apikeys",
    "main",
  );

  // Verify vault reference uses custom key with quoted strings
  assertEquals(
    data.apiKey,
    "${{ vault.get('test-vault', 'generated-api-key') }}",
  );

  // Verify stored with custom key
  assertEquals(
    await vaultService.get("test-vault", "generated-api-key"),
    "sk-live-abc123def456",
  );
});

/**
 * The persisted payloads of the resources the given behavior type wrote,
 * keyed by data name (the directory holding each version).
 */
async function persistedResources(
  repoDir: string,
  modelType: ModelType,
): Promise<Map<string, Record<string, unknown>>> {
  const byName = new Map<string, Record<string, unknown>>();
  const root = join(
    repoDir,
    ".swamp",
    "data",
    ...modelType.normalized.split("/"),
  );
  for await (const entry of walk(root, { includeDirs: false })) {
    if (entry.name !== "raw") continue;
    const name = basename(dirname(dirname(entry.path)));
    // Method summary reports are written beside the resources.
    if (name.startsWith("report-")) continue;
    byName.set(name, JSON.parse(await Deno.readTextFile(entry.path)));
  }
  return byName;
}

/**
 * Runs a workflow whose forEach step writes a sensitive token per value of
 * `envs`, varying the `creds` spec on that input, against a temp repo with a
 * local_encryption vault. Hands `check` the persisted records by data name
 * and the repo's vault service. `names` lengthens the behavior type and
 * method, and nests the token under `credentials`, as a realistic
 * provider-style behavior would.
 */
async function withVaryWorkflowRun(
  envs: string[],
  check: (
    records: Map<string, Record<string, unknown>>,
    vaultService: VaultService,
  ) => Promise<void>,
  names: { typePrefix: string; methodName: string; nested: boolean } = {
    typePrefix: "test/vary-secret-writer",
    methodName: "write",
    nested: false,
  },
): Promise<void> {
  await initializeLogging({});
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3633-" });
  try {
    await initializeTestRepo(repoDir);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), "secrets", "local_encryption", {
        auto_generate: true,
        base_dir: repoDir,
      }),
    );

    // A per-run type, so the registration holds under --repeats.
    const WriteArgs = z.object({ environment: z.string() });
    const modelType = ModelType.create(
      `${names.typePrefix}-${crypto.randomUUID()}`,
    );
    const tokenSchema = z.string().meta({ sensitive: true });
    modelRegistry.register({
      type: modelType,
      version: "2026.10.19.1",
      globalArguments: z.object({}),
      resources: {
        creds: {
          description: "Per-environment credentials",
          schema: names.nested
            ? z.object({ credentials: z.object({ token: tokenSchema }) })
            : z.object({ token: tokenSchema }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
      methods: {
        [names.methodName]: {
          description: "Writes the environment's token",
          arguments: WriteArgs,
          execute: async (args, context) => {
            const { environment } = WriteArgs.parse(args);
            const token = `token-for-${environment}`;
            const handle = await context.writeResource!(
              "creds",
              "creds",
              names.nested ? { credentials: { token } } : { token },
            );
            return { dataHandles: [handle] };
          },
        },
      },
    });

    const workflow = Workflow.create({
      name: "vary-secrets",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "write-${{ self._index }}",
              task: StepTask.directExecution(
                modelType.normalized,
                "writer",
                names.methodName,
                { environment: "${{ self.env }}" },
              ),
              forEach: { item: "env", in: "${{ inputs.envs }}" },
              dataOutputOverrides: [{
                specName: "creds",
                vary: ["environment"],
              }],
            }),
          ],
        }),
      ],
    });
    await new YamlWorkflowRepository(repoDir).save(workflow);

    const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    let status: string | undefined;
    const events: string[] = [];
    await executeWorkflowWithLocks(
      resolved,
      repoContext,
      datastoreConfig,
      { workflowIdOrName: workflow.name, inputs: { envs } },
      new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "completed") status = event.run.status;
        if (event.kind !== "started") {
          events.push(JSON.stringify(event).slice(0, 600));
        }
      },
      syncService,
      undefined,
      { syncGate: undefined },
    );
    assertEquals(status, "succeeded", events.join("\n"));

    await check(
      await persistedResources(repoDir, modelType),
      await VaultService.fromRepository(repoDir),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("Integration: a forEach step varying on its input vaults each instance's sensitive field under its own key (swamp-club#3633)", async () => {
  await withVaryWorkflowRun(["dev", "prod"], async (records, vaultService) => {
    assertEquals([...records.keys()].sort(), ["creds-dev", "creds-prod"]);
    const keys = new Set<string>();
    for (const env of ["dev", "prod"]) {
      const reference = String(records.get(`creds-${env}`)?.token);
      const match = /vault\.get\('([^']+)', '([^']+)'\)/.exec(reference);
      if (!match) throw new Error(`Not a vault reference: ${reference}`);
      const [, vaultName, vaultKey] = match;
      keys.add(vaultKey);
      assertStringIncludes(vaultKey, `-creds-creds-${env}-token`);
      // Each record's reference reads back its own environment's value.
      assertEquals(
        await vaultService.get(vaultName, vaultKey),
        `token-for-${env}`,
      );
    }
    assertEquals(keys.size, 2);
  });
});

Deno.test("Integration: vary values the key sanitizer would fold together, or too long for a file name, each read back their own secret (swamp-club#3633)", async () => {
  // a'b and a-b, and x@y and xy, would share one sanitized key; a 200
  // character value would put the key past local_encryption's file name limit.
  const envs = ["a'b", "a-b", "x@y", "xy", "v".repeat(200)];
  await withVaryWorkflowRun(envs, async (records, vaultService) => {
    assertEquals(
      [...records.keys()].sort(),
      envs.map((env) => `creds-${env}`).sort(),
    );
    for (const env of envs) {
      const record = { ...records.get(`creds-${env}`) };
      await resolveVaultRefsInData(record, vaultService);
      assertEquals(record.token, `token-for-${env}`, env);
    }
  });
});

Deno.test("Integration: a vary write by a long-named behavior stays within local_encryption's file name limit (swamp-club#3633)", async () => {
  // These names alone give a key of over 210 bytes, close to the 255-byte
  // file name local_encryption stores it under. Before the vary suffix was
  // capped at the hashed form's length, a 61-character value overflowed it.
  const envs = ["k".repeat(32), "s".repeat(61), "ip-10-0-0-1.ec2.internal"];
  await withVaryWorkflowRun(
    envs,
    async (records, vaultService) => {
      for (const env of envs) {
        const record = structuredClone(records.get(`creds-${env}`) ?? {});
        await resolveVaultRefsInData(record, vaultService);
        assertEquals(
          (record.credentials as Record<string, unknown> | undefined)?.token,
          `token-for-${env}`,
          env,
        );
      }
    },
    {
      typePrefix:
        "@user/very-long-vendor-name/service-category/resource-type-name",
      methodName: "createOrUpdateResourceConfiguration",
      nested: true,
    },
  );
});

/**
 * Runs a one-step workflow whose method writes a sensitive token, against a
 * temp repo with two local_encryption vaults, and returns the fallback vault
 * (the first user vault) and the vault the stored reference names. `setup`
 * is handed the vault that is not the fallback, and returns the definition's
 * resources overrides, the step's data output override and the run inputs.
 */
async function storedVaultOfStepRun(
  setup: (target: string, fallback: string) => {
    resources?: Record<string, { vaultName?: string }>;
    override?: { specName: string; vaultName?: string; vary?: string[] };
    inputs?: Record<string, unknown>;
    /** The repo's defaultVault, passed to the run as serve passes it. */
    defaultVault?: string;
    /**
     * Puts a manual approval gate before the step, so the step runs when
     * the approved run is resumed.
     */
    gated?: boolean;
    /** Runs the step in a child workflow the run's one step invokes. */
    nested?: boolean;
  },
): Promise<{ fallback: string; target: string; stored: string }> {
  await initializeLogging({});
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3606-" });
  try {
    await initializeTestRepo(repoDir);
    const vaultRepo = new YamlVaultConfigRepository(repoDir);
    for (const name of ["vault-a", "vault-b"]) {
      await vaultRepo.save(
        VaultConfig.create(crypto.randomUUID(), name, "local_encryption", {
          auto_generate: true,
          base_dir: repoDir,
        }),
      );
    }
    const [fallback, target] = (await VaultService.fromRepository(repoDir))
      .getUserVaultNames();
    const { resources, override, inputs, defaultVault, gated, nested } = setup(
      target,
      fallback,
    );

    // A per-run type, so the registration holds under --repeats.
    const WriteArgs = z.object({ env: z.string().optional() });
    const modelType = ModelType.create(
      `test/step-vault-writer-${crypto.randomUUID()}`,
    );
    modelRegistry.register({
      type: modelType,
      version: "2026.10.20.1",
      globalArguments: z.object({}),
      resources: {
        creds: {
          description: "Credentials",
          schema: z.object({ token: z.string().meta({ sensitive: true }) }),
          lifetime: "infinite",
          garbageCollection: 5,
        },
      },
      methods: {
        create: {
          description: "Writes a token",
          arguments: WriteArgs,
          execute: async (_args, context) => {
            const handle = await context.writeResource!("creds", "creds", {
              token: "step-vault-token",
            });
            return { dataHandles: [handle] };
          },
        },
      },
    });
    await new YamlDefinitionRepository(repoDir).save(
      modelType,
      Definition.create({
        name: "secret-maker",
        type: modelType.normalized,
        ...(resources ? { resources } : {}),
      }),
    );

    const inner = Workflow.create({
      name: nested ? "step-vault-child" : "step-vault",
      inputs: { properties: { vault: { type: "string" } } },
      jobs: [
        Job.create({
          name: "main",
          steps: [
            ...(gated
              ? [Step.create({
                name: "gate",
                task: StepTask.manualApproval("go?"),
              })]
              : []),
            Step.create({
              name: "make-secret",
              task: StepTask.model("secret-maker", "create", { env: "dev" }),
              ...(override ? { dataOutputOverrides: [override] } : {}),
              ...(gated
                ? {
                  dependsOn: [{
                    step: "gate",
                    condition: TriggerCondition.succeeded(),
                  }],
                }
                : {}),
            }),
          ],
        }),
      ],
    });
    const workflow = nested
      ? Workflow.create({
        name: "step-vault",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "child",
                task: StepTask.workflow(inner.name),
              }),
            ],
          }),
        ],
      })
      : inner;
    if (nested) await new YamlWorkflowRepository(repoDir).save(inner);
    await new YamlWorkflowRepository(repoDir).save(workflow);

    const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
      await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
    let status: string | undefined;
    let runId: string | undefined;
    const events: string[] = [];
    await executeWorkflowWithLocks(
      resolved,
      repoContext,
      datastoreConfig,
      { workflowIdOrName: workflow.name, inputs: inputs ?? {} },
      new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "started") runId = event.runId;
        if (event.kind === "suspended") status = "suspended";
        if (event.kind === "completed") status = event.run.status;
        if (event.kind !== "started") {
          events.push(JSON.stringify(event).slice(0, 600));
        }
      },
      syncService,
      undefined,
      { syncGate: undefined, defaultVault },
    );
    if (gated) {
      assertEquals(status, "suspended", events.join("\n"));
      const runClaims = createWorkflowRunClaims(datastoreConfig);
      for await (
        const event of workflowApprove(
          createLibSwampContext(),
          createWorkflowApproveDeps(
            repoContext.workflowRepo,
            repoContext.workflowRunRepo,
            runClaims,
          ),
          {
            workflowIdOrName: workflow.name,
            stepName: "gate",
            runId: runId!,
            decidedBy: "user:test",
          },
        )
      ) {
        if (event.kind === "error") throw new Error(event.error.message);
      }
      // Resumed through serve's run deps, as its resume launcher does.
      const deps = await createWorkflowRunDeps(
        resolved,
        repoContext,
        datastoreConfig,
        undefined,
        undefined,
        { defaultVault },
      );
      const service = deps.createExecutionService(
        repoContext.workflowRepo,
        repoContext.workflowRunRepo,
        resolved,
        repoContext.catalogStore,
      );
      service.runClaims = runClaims;
      for await (const event of service.resume(workflow.name, runId!)) {
        if (event.kind === "completed") status = event.run.status;
      }
    }
    assertEquals(status, "succeeded", events.join("\n"));

    const records = [
      ...(await persistedResources(repoDir, modelType)).values(),
    ];
    assertEquals(records.length, 1);
    const reference = String(records[0].token);
    const match = /vault\.get\('([^']+)', '([^']+)'\)/.exec(reference);
    if (!match) throw new Error(`Not a vault reference: ${reference}`);
    const vaultService = await VaultService.fromRepository(repoDir);
    assertEquals(
      await vaultService.get(match[1], match[2]),
      "step-vault-token",
    );
    return { fallback, target, stored: match[1] };
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("Integration: with no override a step's sensitive output lands in the fallback vault (swamp-club#3606)", async () => {
  const { fallback, stored } = await storedVaultOfStepRun(() => ({}));
  assertEquals(stored, fallback);
});

Deno.test("Integration: a step's data output override vaultName routes its sensitive output (swamp-club#3606)", async () => {
  const { target, stored } = await storedVaultOfStepRun((target) => ({
    override: { specName: "creds", vaultName: target },
  }));
  assertEquals(stored, target);
});

Deno.test("Integration: a step override that sets only vary keeps the definition's resources vaultName (swamp-club#3606)", async () => {
  const { target, stored } = await storedVaultOfStepRun((target) => ({
    resources: { creds: { vaultName: target } },
    override: { specName: "creds", vary: ["env"] },
  }));
  assertEquals(stored, target);
});

Deno.test("Integration: a step override vaultName from a workflow input routes to the evaluated vault (swamp-club#3606)", async () => {
  const { target, stored } = await storedVaultOfStepRun((target) => ({
    override: { specName: "creds", vaultName: "${{ inputs.vault }}" },
    inputs: { vault: target },
  }));
  assertEquals(stored, target);
});

Deno.test("Integration: a step's sensitive output lands in the repo's defaultVault when it is not the first vault (swamp-club#3680)", async () => {
  const { fallback, target, stored } = await storedVaultOfStepRun((
    target,
  ) => ({ defaultVault: target }));
  assertEquals(stored, target, `stored in ${stored}, first vault ${fallback}`);
});

Deno.test("Integration: a step override vaultName wins over the repo's defaultVault (swamp-club#3680)", async () => {
  const { fallback, stored } = await storedVaultOfStepRun((
    target,
    fallback,
  ) => ({
    defaultVault: target,
    override: { specName: "creds", vaultName: fallback },
  }));
  assertEquals(stored, fallback);
});

Deno.test("Integration: a step resumed after an approval gate stores in the repo's defaultVault (swamp-club#3680)", async () => {
  const { target, stored } = await storedVaultOfStepRun((target) => ({
    defaultVault: target,
    gated: true,
  }));
  assertEquals(stored, target);
});

Deno.test("Integration: a step in a nested workflow stores in the repo's defaultVault (swamp-club#3680)", async () => {
  const { target, stored } = await storedVaultOfStepRun((target) => ({
    defaultVault: target,
    nested: true,
  }));
  assertEquals(stored, target);
});

// --- fields inside arrays, records and unions (swamp-club#3038) ---

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-sensitive-elements-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** A resource shaped like a generated cloud app spec. */
const appSpec: ResourceOutputSpec = {
  schema: z.object({
    spec: z.object({
      services: z.array(z.object({
        name: z.string(),
        image: z.object({
          registry_credentials: z.string().meta({ sensitive: true }),
        }),
        // Not strings: they must read back as a number and an object.
        port: z.number().meta({ sensitive: true }),
        env: z.record(z.string(), z.string()).meta({ sensitive: true }),
      })),
    }),
    tokens: z.record(z.string(), z.string().meta({ sensitive: true })),
    auth: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("basic"),
        password: z.string().meta({ sensitive: true }),
      }),
      z.object({ kind: z.literal("none") }),
    ]),
    // Not sensitive: a reference-shaped string here must stay as written.
    notes: z.record(z.string(), z.unknown()),
  }),
  lifetime: "infinite",
  garbageCollection: 10,
};

const SECRETS = [
  "registry-zero",
  "registry-one",
  "token-prod",
  "token-eu",
  "basic-password",
  "env-web",
  "env-worker",
];

function appData(): Record<string, unknown> {
  return {
    spec: {
      services: [
        {
          name: "web",
          image: { registry_credentials: "registry-zero" },
          port: 8080,
          env: { API_KEY: "env-web" },
        },
        {
          name: "worker",
          image: { registry_credentials: "registry-one" },
          port: 9090,
          env: { API_KEY: "env-worker" },
        },
      ],
    },
    tokens: { prod: "token-prod", "eu.west": "token-eu" },
    auth: { kind: "basic", password: "basic-password" },
    // Where a dot split of tokens.eu.west would land, were it written so.
    notes: { eu: { west: "${{ vault.get('test-vault', 'planted') }}" } },
  };
}

async function writeApp(dir: string) {
  await ensureDir(join(dir, ".swamp", "data"));
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const vaultService = new VaultService();
  vaultService.registerVault({ name: "test-vault", type: "mock", config: {} });
  await vaultService.put("test-vault", "planted", "planted-secret");
  const modelType = ModelType.create("test/sensitive-elements");
  const modelId = crypto.randomUUID();
  const { writeResource } = createResourceWriter(
    dataRepo,
    modelType,
    modelId,
    { app: appSpec },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );
  let handle, record, content;
  try {
    handle = await writeResource("app", "main", appData());
    record = await dataRepo.findByName(modelType, modelId, "main");
    content = await dataRepo.getContent(modelType, modelId, "main");
  } catch (error) {
    // The caller closes the catalog only once it has this fixture.
    catalog.close();
    throw error;
  }
  return {
    catalog,
    dataRepo,
    vaultService,
    modelType,
    modelId,
    handle,
    record: record!,
    stored: new TextDecoder().decode(content!),
  };
}

type AppServices = {
  services: { image: unknown; port: unknown; env: unknown }[];
};

function assertResolved(data: Record<string, unknown> | null | undefined) {
  const app = data as ReturnType<typeof appData>;
  const services = (app.spec as AppServices).services;
  assertEquals(services.map((s) => s.image), [
    { registry_credentials: "registry-zero" },
    { registry_credentials: "registry-one" },
  ]);
  assertEquals(services.map((s) => [s.port, s.env]), [
    [8080, { API_KEY: "env-web" }],
    [9090, { API_KEY: "env-worker" }],
  ]);
  assertEquals(app.tokens, { prod: "token-prod", "eu.west": "token-eu" });
  assertEquals(app.auth, { kind: "basic", password: "basic-password" });
  assertEquals(app.notes, appData().notes);
}

Deno.test("Integration: sensitive fields inside arrays, records and unions are stored in a vault and read back", async () => {
  await withTempDir(async (dir) => {
    const w = await writeApp(dir);
    try {
      for (const secret of SECRETS) {
        assertEquals(w.stored.includes(secret), false, secret);
      }
      assertEquals(JSON.parse(w.record.tags[SENSITIVE_FIELDS_TAG]), [
        "spec.services.0.image.registry_credentials",
        "spec.services.0.port",
        "spec.services.0.env",
        "spec.services.1.image.registry_credentials",
        "spec.services.1.port",
        "spec.services.1.env",
        "tokens.prod",
        "auth.password",
      ]);
      assertEquals(JSON.parse(w.record.tags[SENSITIVE_FIELD_KEYS_TAG]), [
        ["tokens", "eu.west"],
      ]);
      assertEquals(JSON.parse(w.record.tags[SENSITIVE_FIELD_JSON_TAG]), [
        ["spec", "services", 0, "port"],
        ["spec", "services", 0, "env"],
        ["spec", "services", 1, "port"],
        ["spec", "services", 1, "env"],
      ]);

      // readResource, as a method sees prior state.
      const redactor = new SecretRedactor();
      const readResource = createResourceReader(
        w.dataRepo,
        w.modelType,
        w.modelId,
        w.vaultService,
        redactor,
      );
      assertResolved(await readResource("main"));
      assertEquals(
        redactor.redact("creds registry-one and token-eu"),
        "creds *** and ***",
      );

      // data get, through the data record mapper.
      const mapped = await fromData(
        w.record,
        w.modelType,
        w.modelId,
        w.dataRepo,
        { vaultService: w.vaultService },
      );
      assertResolved(mapped?.attributes);
    } finally {
      w.catalog.close();
    }
  });
});

Deno.test("Integration: CEL reads every vaulted place of an array, record and union field as a Secret, a key-list place included", async () => {
  await withTempDir(async (dir) => {
    const w = await writeApp(dir);
    try {
      // As data.latest() reads it: the stored record, references in place,
      // through the typed-secret accessor adapter.
      const stored = await fromData(
        w.record,
        w.modelType,
        w.modelId,
        w.dataRepo,
      );
      const keyOf = (value: unknown): string => {
        assert(isSecret(value));
        return (secretParts(value)![0] as { reference: { key: string } })
          .reference.key;
      };
      runInFaultScope((scope) => {
        const view = adaptDataRecord(stored, undefined, "data.latest") as {
          attributes: ReturnType<typeof appData>;
        };
        const app = view.attributes;
        const services = (app.spec as AppServices).services;
        const storedKeys = new Set<string>();
        for (const service of services) {
          storedKeys.add(
            keyOf(
              (service.image as Record<string, unknown>).registry_credentials,
            ),
          );
          storedKeys.add(keyOf(service.port));
          storedKeys.add(keyOf(service.env));
        }
        const tokens = app.tokens as Record<string, unknown>;
        storedKeys.add(keyOf(tokens.prod));
        storedKeys.add(keyOf(tokens["eu.west"]));
        storedKeys.add(keyOf((app.auth as Record<string, unknown>).password));
        // Nine distinct vault keys, every one the record holds.
        assertEquals(storedKeys.size, 9);
        assertEquals(
          [...scope.sensitiveReferences.values()].map((r) => r.key).sort(),
          [...storedKeys].sort(),
        );
        // Text that only looks like a reference, where nothing was vaulted,
        // stays text.
        assertEquals(app.notes, appData().notes);
      });
    } finally {
      w.catalog.close();
    }
  });
});

Deno.test("Integration: a number the JSON tag lists reaches a step as a number at a whole value, an object as its JSON text, and both as text inside text, also after a persisted round trip (swamp-club#3967)", async () => {
  await withTempDir(async (dir) => {
    const w = await writeApp(dir);
    try {
      // As data.latest() reads it, released from CEL into a run's bag.
      const stored = await fromData(
        w.record,
        w.modelType,
        w.modelId,
        w.dataRepo,
      );
      const values = new RunSensitiveValues(
        undefined,
        new SecretBagRegistry(),
      );
      const bag = new VaultSecretBag(values.sentinels);
      const args = runInFaultScope(() => {
        const view = adaptDataRecord(stored, undefined, "data.latest") as {
          attributes: ReturnType<typeof appData>;
        };
        const service = (view.attributes.spec as AppServices).services[0];
        const boundary = new SecretBoundary(bag);
        const port = boundary.release(service.port) as string;
        const env = boundary.release(service.env) as string;
        const token = boundary.release(
          (service.image as Record<string, unknown>).registry_credentials,
        ) as string;
        return {
          port,
          nested: { env, list: [port] },
          token,
          text: `port=${port} env=${env}`,
        };
      });
      const loader = new SecretLoader(() => Promise.resolve(w.vaultService));
      // The port as the number written; the env map as its JSON text, which
      // is what the run's redactor holds.
      const expected = {
        port: 8080,
        nested: { env: '{"API_KEY":"env-web"}', list: [8080] },
        token: "registry-zero",
        text: 'port=8080 env={"API_KEY":"env-web"}',
      };
      assertEquals((await loader.load(bag, args)).resolveDeep(args), expected);

      // A resumed run restores the references with their marks.
      const form = toPersistedForm(args, values);
      const resumed = new VaultSecretBag(new SecretBagRegistry());
      const restored = rehydrateReferences(
        form.data,
        form.writtenReferences,
        resumed,
        "run-1",
      );
      assertEquals(
        (await loader.load(resumed, restored)).resolveDeep(restored),
        expected,
      );
    } finally {
      w.catalog.close();
    }
  });
});

Deno.test("Integration: a sensitive container holding sensitive fields reads in CEL as an object of Secrets, and through readResource as an object of their values", async () => {
  await withTempDir(async (dir) => {
    await ensureDir(join(dir, ".swamp", "data"));
    const catalog = new CatalogStore(
      join(dir, ".swamp", "data", "_catalog.db"),
    );
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalog,
      );
      const vaultService = new VaultService();
      vaultService.registerVault({
        name: "test-vault",
        type: "mock",
        config: {},
      });
      const modelType = ModelType.create("test/sensitive-container");
      const modelId = crypto.randomUUID();
      const spec: ResourceOutputSpec = {
        schema: z.object({
          credentials: z.object({
            apiKey: z.string().meta({
              sensitive: true,
              vaultKey: "prod-api-key",
            }),
            region: z.string(),
            db: z.object({
              host: z.string(),
              password: z.string().meta({ sensitive: true }),
            }),
          }).meta({ sensitive: true }),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
      };
      const { writeResource } = createResourceWriter(
        dataRepo,
        modelType,
        modelId,
        { app: spec },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        vaultService,
        "create",
      );
      await writeResource("app", "main", {
        credentials: {
          apiKey: "key-value",
          region: "us-east-1",
          db: { host: "db.internal", password: "db-pass" },
        },
      });
      assertEquals(
        await vaultService.get("test-vault", "prod-api-key"),
        "key-value",
      );
      const record = await dataRepo.findByName(modelType, modelId, "main");
      assert(record);

      // As data.latest() and model.<name>.resource read it.
      const stored = await fromData(record, modelType, modelId, dataRepo);
      runInFaultScope((scope) => {
        const view = adaptDataRecord(stored, undefined, "data.latest") as {
          attributes: Record<string, Record<string, unknown>>;
        };
        const credentials = view.attributes.credentials;
        assert(!isSecret(credentials));
        const keyOf = (value: unknown): string => {
          assert(isSecret(value));
          return (secretParts(value)![0] as { reference: { key: string } })
            .reference.key;
        };
        assertEquals(keyOf(credentials.apiKey), "prod-api-key");
        keyOf((credentials.db as Record<string, unknown>).password);
        assertEquals(scope.faults, []);
      });

      // As a method reads its prior state.
      const readResource = createResourceReader(
        dataRepo,
        modelType,
        modelId,
        vaultService,
      );
      assertEquals((await readResource("main"))?.credentials, {
        apiKey: "key-value",
        db: { password: "db-pass" },
      });
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Integration: a release that reads only the dot-path tag resolves every element path it lists", async () => {
  await withTempDir(async (dir) => {
    const w = await writeApp(dir);
    try {
      // How swamp releases before swamp-club#3038 resolve a record: the dot
      // paths of _swamp.sensitiveFields, through getNestedValue and
      // setNestedValue, and nothing from the key-list tag.
      const data = JSON.parse(w.stored) as Record<string, unknown>;
      for (const path of JSON.parse(w.record.tags[SENSITIVE_FIELDS_TAG])) {
        const ref = getNestedValue(data, path) as string;
        const match = /vault\.get\('([^']+)', '([^']+)'\)/.exec(ref);
        setNestedValue(
          data,
          path,
          await w.vaultService.get(match![1], match![2]),
        );
      }
      const app = data as ReturnType<typeof appData>;
      const services = (app.spec as AppServices).services;
      assertEquals(services.map((s) => s.image), [
        { registry_credentials: "registry-zero" },
        { registry_credentials: "registry-one" },
      ]);
      // Such a release ignores the JSON tag and reads values that were not
      // strings as their JSON text, as it reads top-level ones.
      assertEquals(services.map((s) => [s.port, s.env]), [
        ["8080", '{"API_KEY":"env-web"}'],
        ["9090", '{"API_KEY":"env-worker"}'],
      ]);
      assertEquals((app.tokens as Record<string, string>).prod, "token-prod");
      assertEquals(app.auth, { kind: "basic", password: "basic-password" });
      // The value under a key holding a dot stays a reference for such a
      // release, and nothing reached the reference-shaped note.
      assertStringIncludes(
        (app.tokens as Record<string, string>)["eu.west"],
        "vault.get",
      );
      assertEquals(app.notes, appData().notes);
    } finally {
      w.catalog.close();
    }
  });
});
