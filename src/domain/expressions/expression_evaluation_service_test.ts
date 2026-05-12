// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  containsEnvExpression,
  containsRuntimeExpression,
  containsVaultExpression,
  ExpressionEvaluationService,
} from "./expression_evaluation_service.ts";
import type { ExpressionContext } from "./model_resolver.ts";
import { SecretRedactor } from "../secrets/secret_redactor.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-eval-service-" });
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

// ============================================================================
// containsVaultExpression
// ============================================================================

Deno.test("containsVaultExpression returns true for vault-only expressions", () => {
  assertEquals(containsVaultExpression("vault.get(aws, myKey)"), true);
  assertEquals(
    containsVaultExpression("vault.get('aws', 'myKey')"),
    true,
  );
  assertEquals(
    containsVaultExpression('vault.get("aws", "myKey")'),
    true,
  );
});

Deno.test("containsVaultExpression returns true for mixed CEL+vault expressions", () => {
  assertEquals(
    containsVaultExpression(
      "model.foo.data.attributes.x + vault.get(aws, key)",
    ),
    true,
  );
});

Deno.test("containsVaultExpression returns false for CEL-only expressions", () => {
  assertEquals(
    containsVaultExpression("model.foo.data.attributes.message"),
    false,
  );
  assertEquals(containsVaultExpression("self.name"), false);
  assertEquals(containsVaultExpression("inputs.param"), false);
  assertEquals(containsVaultExpression("env.HOME"), false);
});

Deno.test("containsVaultExpression returns false for vault-like but not vault.get", () => {
  assertEquals(containsVaultExpression("vault.name"), false);
  assertEquals(containsVaultExpression("vault_get(foo)"), false);
});

Deno.test("containsVaultExpression returns true for quoted args with spaces", () => {
  assertEquals(
    containsVaultExpression('vault.get("infra", "Client ID")'),
    true,
  );
  assertEquals(
    containsVaultExpression(
      'vault.get("infra", "Tailscale K8s Operator/Client ID")',
    ),
    true,
  );
});

// ============================================================================
// containsEnvExpression
// ============================================================================

Deno.test("containsEnvExpression returns true for env references", () => {
  assertEquals(containsEnvExpression("env.FOO"), true);
  assertEquals(containsEnvExpression("env.HOME"), true);
  assertEquals(containsEnvExpression("env.AWS_REGION"), true);
});

Deno.test("containsEnvExpression returns true for mixed expressions with env", () => {
  assertEquals(
    containsEnvExpression("model.foo.input.name + env.SUFFIX"),
    true,
  );
});

Deno.test("containsEnvExpression returns false for non-env expressions", () => {
  assertEquals(containsEnvExpression("vault.get(aws, key)"), false);
  assertEquals(containsEnvExpression("model.x.input.name"), false);
  assertEquals(containsEnvExpression("self.name"), false);
  assertEquals(containsEnvExpression("inputs.param"), false);
});

Deno.test("containsEnvExpression returns false for env-like but not env.*", () => {
  // "environment" should not match because \b word boundary prevents it
  assertEquals(containsEnvExpression("environment.X"), false);
  assertEquals(containsEnvExpression("myenv.FOO"), false);
});

// ============================================================================
// containsRuntimeExpression
// ============================================================================

Deno.test("containsRuntimeExpression returns true for vault expressions", () => {
  assertEquals(
    containsRuntimeExpression("vault.get(aws, myKey)"),
    true,
  );
});

Deno.test("containsRuntimeExpression returns true for env expressions", () => {
  assertEquals(containsRuntimeExpression("env.HOME"), true);
});

Deno.test("containsRuntimeExpression returns true for mixed vault+env", () => {
  assertEquals(
    containsRuntimeExpression(
      'vault.get(main, key) + "-" + env.SUFFIX',
    ),
    true,
  );
});

Deno.test("containsRuntimeExpression returns false for model/self/inputs", () => {
  assertEquals(
    containsRuntimeExpression("model.foo.input.name"),
    false,
  );
  assertEquals(containsRuntimeExpression("self.name"), false);
  assertEquals(containsRuntimeExpression("inputs.param"), false);
});

// ============================================================================
// evaluateDefinition — ternary expression regression (#814)
// ============================================================================

// Regression test for issue #814: a ternary in globalArguments must resolve
// when the condition input is provided, even if one branch input is absent.
// Before the fix the regex pre-check treated all referenced inputs as required,
// so the whole expression was skipped and the globalArgument stayed as a raw
// ${{ }} string.
Deno.test("evaluateDefinition: ternary in globalArguments resolves when condition input provided and one branch input absent", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const definition = Definition.create({
      name: "transport-model",
      inputs: {
        properties: {
          transport: { type: "string" },
          lan_host: { type: "string" },
          tailnet_host: { type: "string" },
        },
        required: ["transport", "tailnet_host"],
      },
      globalArguments: {
        host:
          '${{ inputs.transport == "lan" ? inputs.lan_host : inputs.tailnet_host }}',
      },
      methods: { exec: { arguments: { run: "echo hello" } } },
    });

    const result = await service.evaluateDefinition(
      definition,
      type,
      { transport: "wan", tailnet_host: "100.64.0.1" }, // lan_host deliberately absent
    );

    assertEquals(result.definition.globalArguments.host, "100.64.0.1");
  });
});

// Confirms the original #653 fix still works: a directly-referenced missing
// input leaves the expression unresolved rather than throwing.
Deno.test("evaluateDefinition: directly-missing input in globalArguments stays unresolved", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const definition = Definition.create({
      name: "factory-model",
      inputs: {
        properties: {
          instanceName: { type: "string" },
          cidrBlock: { type: "string" },
        },
        required: ["instanceName", "cidrBlock"],
      },
      globalArguments: {
        run: '${{ "echo " + inputs.instanceName }}',
        unusedArg: "${{ inputs.cidrBlock }}",
      },
      methods: { execute: { arguments: { run: "echo fallback" } } },
    });

    const result = await service.evaluateDefinition(
      definition,
      type,
      { instanceName: "test-instance" }, // cidrBlock deliberately absent
    );

    // run is resolved, unusedArg stays as a raw expression
    assertEquals(result.definition.globalArguments.run, "echo test-instance");
    assertStringIncludes(
      result.definition.globalArguments.unusedArg as string,
      "${{",
    );
  });
});

// ============================================================================
// resolveAllExpressionsInData — driverConfig seam (swamp-club#291)
// ============================================================================

function makeContext(
  overrides: Partial<ExpressionContext> = {},
): ExpressionContext {
  return {
    model: {},
    env: {},
    ...overrides,
  };
}

Deno.test("resolveAllExpressionsInData: returns literals unchanged", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const data = {
      image: "alpine:3",
      volumes: ["/host/path:/container/path:ro"],
      env: { LITERAL: "value" },
    };
    const result = await service.resolveAllExpressionsInData(
      data,
      makeContext(),
    );
    assertEquals(result, data);
  });
});

Deno.test("resolveAllExpressionsInData: resolves env runtime expressions", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_HOME", "/tmp/test-home-291");
    try {
      const data = {
        volumes: ["${{ env.SWAMP_TEST_HOME }}:/host-home:ro"],
      };
      const result = await service.resolveAllExpressionsInData(
        data,
        makeContext(),
      ) as { volumes: string[] };
      assertEquals(result.volumes, ["/tmp/test-home-291:/host-home:ro"]);
    } finally {
      Deno.env.delete("SWAMP_TEST_HOME");
    }
  });
});

Deno.test("resolveAllExpressionsInData: resolves self.* via supplied CEL context", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const ctx = makeContext({
      self: {
        id: "test-id",
        name: "test",
        version: 1,
        tags: {},
        globalArguments: {},
        region: "us-west-2",
      },
    });
    const data = {
      env: { AWS_REGION: "${{ self.region }}" },
    };
    const result = await service.resolveAllExpressionsInData(
      data,
      ctx,
    ) as { env: Record<string, string> };
    assertEquals(result.env.AWS_REGION, "us-west-2");
  });
});

Deno.test("resolveAllExpressionsInData: walks nested arrays and objects", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_A", "alpha");
    Deno.env.set("SWAMP_TEST_B", "beta");
    try {
      const data = {
        extraArgs: [
          "--label",
          "${{ env.SWAMP_TEST_A }}",
          "--label",
          "${{ env.SWAMP_TEST_B }}",
        ],
        env: {
          FIRST: "${{ env.SWAMP_TEST_A }}",
          NESTED: { inner: "${{ env.SWAMP_TEST_B }}" },
        },
      };
      const result = await service.resolveAllExpressionsInData(
        data,
        makeContext(),
      ) as {
        extraArgs: string[];
        env: { FIRST: string; NESTED: { inner: string } };
      };
      assertEquals(result.extraArgs, [
        "--label",
        "alpha",
        "--label",
        "beta",
      ]);
      assertEquals(result.env.FIRST, "alpha");
      assertEquals(result.env.NESTED.inner, "beta");
    } finally {
      Deno.env.delete("SWAMP_TEST_A");
      Deno.env.delete("SWAMP_TEST_B");
    }
  });
});

Deno.test("resolveAllExpressionsInData: short-circuits with no expressions (no redactor calls)", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    let addedSecrets = 0;
    const redactor = new SecretRedactor();
    const origAdd = redactor.addSecret.bind(redactor);
    redactor.addSecret = (v: string) => {
      addedSecrets++;
      origAdd(v);
    };
    const data = { image: "alpine:3", volumes: ["/abs/path:/dst:ro"] };
    await service.resolveAllExpressionsInData(data, makeContext(), redactor);
    assertEquals(addedSecrets, 0);
  });
});

Deno.test("resolveAllExpressionsInData: env-only resolution does not register secrets with redactor", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_PUB", "public-value");
    try {
      let addedSecrets = 0;
      const redactor = new SecretRedactor();
      const origAdd = redactor.addSecret.bind(redactor);
      redactor.addSecret = (v: string) => {
        addedSecrets++;
        origAdd(v);
      };
      const data = { env: { VAR: "${{ env.SWAMP_TEST_PUB }}" } };
      await service.resolveAllExpressionsInData(data, makeContext(), redactor);
      assertEquals(addedSecrets, 0);
    } finally {
      Deno.env.delete("SWAMP_TEST_PUB");
    }
  });
});

// ============================================================================
// run.* namespace
// ============================================================================

Deno.test("resolveAllExpressionsInData: resolves run.id from context", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const ctx = makeContext({
      run: {
        id: "790f565a-c2e4-476f-88d9-39090bca11c5",
        workflowId: "wf-001",
        workflowName: "deploy",
        startedAt: "2026-05-12T15:00:00.000Z",
        tags: { env: "prod" },
      },
    });
    const data = {
      resourceKey: "filtered-vms-${{ run.id }}",
    };
    const result = await service.resolveAllExpressionsInData(
      data,
      ctx,
    ) as { resourceKey: string };
    assertEquals(
      result.resourceKey,
      "filtered-vms-790f565a-c2e4-476f-88d9-39090bca11c5",
    );
  });
});

Deno.test("resolveAllExpressionsInData: resolves run.workflowName and run.startedAt", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const ctx = makeContext({
      run: {
        id: "test-run-id",
        workflowId: "wf-002",
        workflowName: "kernel-update",
        startedAt: "2026-05-12T16:30:00.000Z",
        tags: {},
      },
    });
    const data = {
      name: "${{ run.workflowName }}",
      started: "${{ run.startedAt }}",
    };
    const result = await service.resolveAllExpressionsInData(
      data,
      ctx,
    ) as { name: string; started: string };
    assertEquals(result.name, "kernel-update");
    assertEquals(result.started, "2026-05-12T16:30:00.000Z");
  });
});

Deno.test("resolveAllExpressionsInData: resolves run.tags nested access", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const ctx = makeContext({
      run: {
        id: "test-run-id",
        workflowId: "wf-003",
        workflowName: "deploy",
        startedAt: "2026-05-12T15:00:00.000Z",
        tags: { env: "staging", team: "platform" },
      },
    });
    const data = {
      environment: "${{ run.tags.env }}",
    };
    const result = await service.resolveAllExpressionsInData(
      data,
      ctx,
    ) as { environment: string };
    assertEquals(result.environment, "staging");
  });
});
