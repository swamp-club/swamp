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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  processSensitiveResourceData,
  resolveVaultRefsInData,
} from "../src/domain/models/data_writer.ts";
import { basename, dirname, join } from "@std/path";
import { walk } from "@std/fs";
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
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { initializeTestRepo } from "./test_helpers.ts";

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
