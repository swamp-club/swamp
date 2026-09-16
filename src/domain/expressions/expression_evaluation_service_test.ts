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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  collectAuthoredExpressions,
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

Deno.test("containsEnvExpression returns false for env-like but not env", () => {
  // "environment" should not match because \b word boundary prevents it
  assertEquals(containsEnvExpression("environment.X"), false);
  assertEquals(containsEnvExpression("myenv.FOO"), false);
  // Member access on another namespace is not the env map.
  assertEquals(containsEnvExpression("inputs.env"), false);
  assertEquals(containsEnvExpression("self.env + '-suffix'"), false);
  // Dotted continuation too: the old `\benv\.` regex wrongly deferred this to runtime.
  assertEquals(containsEnvExpression("self.env.region"), false);
});

Deno.test("containsEnvExpression ignores env inside string literals", () => {
  assertEquals(containsEnvExpression('self.tags["env"]'), false);
  assertEquals(containsEnvExpression("self.tags['env']"), false);
  assertEquals(containsEnvExpression('"env" + self.name'), false);
  assertEquals(containsEnvExpression('"a\\"env" + self.name'), false);
  // A real reference next to a literal is still runtime.
  assertEquals(containsEnvExpression('env["env"]'), true);
  assertEquals(containsEnvExpression('"prefix" + env.FOO'), true);
  assertEquals(containsVaultExpression('"vault.get(" + self.name'), false);
});

Deno.test("containsEnvExpression returns true for every form of env access", () => {
  // The persist-phase context carries the process environment, so any form
  // that is not classified as runtime would be evaluated there. The
  // bracket-index form was the confirmed bypass of the first fix.
  assertEquals(containsEnvExpression("env['SECRET']"), true);
  assertEquals(containsEnvExpression('env["SECRET"]'), true);
  assertEquals(containsEnvExpression("[env][0].SECRET"), true);
  assertEquals(containsEnvExpression("[env].map(e, e.SECRET)[0]"), true);
  assertEquals(containsEnvExpression("string(env['A'])"), true);
  assertEquals(containsEnvExpression("has(env.A) ? env.A : ''"), true);
});

Deno.test("containsEnvExpression ignores a macro-bound variable named env", () => {
  // `env` bound by a comprehension macro shadows the root identifier, so the
  // expression never touches the process environment and must stay in the
  // persist phase (where `self` is available) rather than defer to runtime.
  assertEquals(
    containsEnvExpression("self.globalArguments.environments.map(env, env)"),
    false,
  );
  assertEquals(containsEnvExpression("self.a.filter(env, env.on)"), false);
  assertEquals(containsEnvExpression("self.a.exists_one(env, env)"), false);
  // The bound name only shadows inside the macro's own arguments.
  assertEquals(containsEnvExpression("env.list.map(env, env)"), true);
  assertEquals(
    containsEnvExpression("self.a.filter(env, env.on).map(e, env)"),
    true,
  );
  assertEquals(containsEnvExpression("self.a.map(e, env[e])"), true);
});

Deno.test("containsEnvExpression handles triple-quoted, raw and bytes string literals", () => {
  // A naive single-quote regex pairs the quotes of `"""..."""` wrongly and
  // can swallow a real env reference as string content.
  assertEquals(
    containsEnvExpression('"""prefix " suffix""" + env.DEMO + "suffix"'),
    true,
  );
  assertEquals(containsEnvExpression("'''a ' b''' + env.X"), true);
  assertEquals(containsEnvExpression('r"a\\" + env.X + "b"'), true);
  assertEquals(containsEnvExpression('"""env""" + self.name'), false);
  assertEquals(containsEnvExpression("'''env.X''' + self.name"), false);
  assertEquals(containsEnvExpression('r"env" + b"env" + self.name'), false);
});

Deno.test("containsEnvExpression ignores `env` as an optional or spaced member name", () => {
  assertEquals(containsEnvExpression("self.tags.?env"), false);
  assertEquals(containsEnvExpression("self.tags . env"), false);
  assertEquals(containsEnvExpression("self.tags.? env"), false);
  assertEquals(
    containsEnvExpression("self.tags.?env == 'x' ? env.A : ''"),
    true,
  );
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
// resolveAllExpressionsInData — CEL + runtime two-pass seam (swamp-club#291)
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
      undefined,
      collectAuthoredExpressions(data),
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
        undefined,
        collectAuthoredExpressions(data),
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
      undefined,
      collectAuthoredExpressions(data),
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
        undefined,
        collectAuthoredExpressions(data),
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
    await service.resolveAllExpressionsInData(
      data,
      makeContext(),
      redactor,
      collectAuthoredExpressions(data),
    );
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
      await service.resolveAllExpressionsInData(
        data,
        makeContext(),
        redactor,
        collectAuthoredExpressions(data),
      );
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
      undefined,
      collectAuthoredExpressions(data),
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
      undefined,
      collectAuthoredExpressions(data),
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
      undefined,
      collectAuthoredExpressions(data),
    ) as { environment: string };
    assertEquals(result.environment, "staging");
  });
});

// ============================================================================
// Invalid-CEL-in-prose tolerance (swamp-club#291 follow-up)
//
// When the ${{ ... }} sequence appears inside prose (a plan body, an issue
// description, a method-input string that documents expression syntax), the
// inner CEL is often syntactically invalid (e.g. `env.*`, `vault.get(...)`).
// These must be left as raw text rather than failing the surrounding call,
// otherwise any model whose inputs round-trip such prose becomes unrunnable.
// ============================================================================

Deno.test("evaluateData: leaves invalid-CEL prose unchanged", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const data = {
      doc:
        "driverConfig.volumes does not resolve ${{ inputs.* }} expressions yet",
    };
    const result = await service.resolveAllExpressionsInData(
      data,
      makeContext(),
      undefined,
      collectAuthoredExpressions(data),
    ) as { doc: string };
    assertEquals(result.doc, data.doc);
  });
});

Deno.test("resolveRuntimeExpressionsInData: leaves invalid env.* prose unchanged", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const data = {
      reasoning:
        "driverConfig.volumes does not resolve ${{ env.* }} / ${{ vault.get(...) }} expressions",
    };
    const result = await service.resolveRuntimeExpressionsInData(
      data,
      undefined,
      undefined,
      "unrestricted",
    ) as { reasoning: string };
    assertEquals(result.reasoning, data.reasoning);
  });
});

Deno.test("resolveAllExpressionsInData: mixed prose and valid env resolves only the valid one", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_MIXED", "ok");
    try {
      const data = {
        doc: "documentation: ${{ env.* }} is invalid syntax",
        real: "${{ env.SWAMP_TEST_MIXED }}",
      };
      const result = await service.resolveAllExpressionsInData(
        data,
        makeContext(),
        undefined,
        collectAuthoredExpressions(data),
      ) as { doc: string; real: string };
      assertEquals(result.doc, data.doc);
      assertEquals(result.real, "ok");
    } finally {
      Deno.env.delete("SWAMP_TEST_MIXED");
    }
  });
});

Deno.test("resolveRuntimeExpressionsInDefinition: leaves invalid env.* prose in method args unchanged", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);

    const definition = Definition.create({
      name: "prose-model",
      methods: {
        triage: {
          arguments: {
            reasoning:
              "driverConfig.volumes does not resolve ${{ env.* }} / ${{ vault.get(...) }}",
          },
        },
      },
    });

    const result = await service.resolveRuntimeExpressionsInDefinition(
      definition,
      undefined,
      undefined,
      "unrestricted",
    );

    assertEquals(
      result.definition.getMethodArguments("triage").reasoning,
      "driverConfig.volumes does not resolve ${{ env.* }} / ${{ vault.get(...) }}",
    );
  });
});

// ============================================================================
// evaluateDefinition — nested globalArguments
// ============================================================================

Deno.test("evaluateDefinition: resolves expressions in nested globalArguments objects and arrays", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const definition = Definition.create({
      name: "nested-ga-test",
      inputs: {
        properties: {
          region: { type: "string" },
          key_name: { type: "string" },
        },
        required: ["region", "key_name"],
      },
      globalArguments: {
        name: "my-pool",
        config: {
          region: "${{ inputs.region }}",
          keys: ["${{ inputs.key_name }}"],
          nested: {
            deep_value: '${{ "resolved-" + inputs.region }}',
          },
        },
      },
      methods: { exec: { arguments: { run: "echo hello" } } },
    });

    const result = await service.evaluateDefinition(
      definition,
      type,
      { region: "us-east-1", key_name: "my-key" },
    );

    const ga = result.definition.globalArguments;
    assertEquals(ga.name, "my-pool");

    const config = ga.config as Record<string, unknown>;
    assertEquals(config.region, "us-east-1");
    assertEquals((config.keys as string[])[0], "my-key");

    const nested = config.nested as Record<string, unknown>;
    assertEquals(nested.deep_value, "resolved-us-east-1");
  });
});

// ============================================================================
// evaluateDefinition — definition scanning (swamp-club#2123)
// ============================================================================

/**
 * Counts full-repository walks so tests can assert on work avoided rather
 * than on elapsed time.
 */
class CountingDefinitionRepository extends YamlDefinitionRepository {
  findAllGlobalCalls = 0;

  override findAllGlobal(): Promise<
    { definition: Definition; type: ModelType }[]
  > {
    this.findAllGlobalCalls++;
    return super.findAllGlobal();
  }
}

Deno.test("evaluateDefinition: inputs-only expressions load no definitions", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new CountingDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const definition = Definition.create({
      name: "inputs-only",
      inputs: { properties: { msg: { type: "string" } } },
      methods: { execute: { arguments: { run: "echo ${{ inputs.msg }}" } } },
    });
    await definitionRepo.save(type, definition);

    const result = await service.evaluateDefinition(definition, type, {
      msg: "hello",
    });

    assertEquals(
      result.definition.getMethodArguments("execute").run,
      "echo hello",
    );
    assertEquals(definitionRepo.findAllGlobalCalls, 0);
  });
});

Deno.test("evaluateDefinition: data expressions load no definitions", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new CountingDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const definition = Definition.create({
      name: "data-only",
      methods: {
        execute: {
          arguments: {
            run: 'echo ${{ data.latest("other", "state").attributes.id }}',
          },
        },
      },
    });
    await definitionRepo.save(type, definition);

    await service.evaluateDefinition(definition, type);

    assertEquals(definitionRepo.findAllGlobalCalls, 0);
  });
});

Deno.test("evaluateDefinition: model references load definitions once", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new CountingDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const source = Definition.create({
      name: "source",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(type, source);

    const definition = Definition.create({
      name: "consumer",
      methods: {
        execute: {
          arguments: {
            run: "echo ${{ model.source.definition.globalArguments.region }}",
          },
        },
      },
    });
    await definitionRepo.save(type, definition);

    const result = await service.evaluateDefinition(definition, type);

    assertEquals(
      result.definition.getMethodArguments("execute").run,
      "echo us-east-1",
    );
    assertEquals(definitionRepo.findAllGlobalCalls, 1);
  });
});

Deno.test("evaluateAllDefinitions: walks the repository once", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new CountingDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    const type = ModelType.create("command/shell");

    const source = Definition.create({
      name: "source",
      globalArguments: { region: "us-east-1" },
    });
    await definitionRepo.save(type, source);

    const consumer = Definition.create({
      name: "consumer",
      methods: {
        execute: {
          arguments: {
            run: "echo ${{ model.source.definition.globalArguments.region }}",
          },
        },
      },
    });
    await definitionRepo.save(type, consumer);

    const results = await service.evaluateAllDefinitions();

    assertEquals(results.length, 2);
    assertEquals(definitionRepo.findAllGlobalCalls, 1);
  });
});

// ============================================================================
// collectAuthoredExpressions — provenance for the runtime pass
// ============================================================================

Deno.test("collectAuthoredExpressions: collects vault and env expressions", () => {
  const authored = collectAuthoredExpressions({
    a: "${{ vault.get('v', 'k') }}",
    b: "${{ env.HOME }}",
  });

  assertEquals(authored.size, 2);
  assertEquals(authored.has("${{ vault.get('v', 'k') }}"), true);
  assertEquals(authored.has("${{ env.HOME }}"), true);
});

Deno.test("collectAuthoredExpressions: collects non-runtime expressions too", () => {
  // After the first substitution ANY expression is a re-entry vector, not
  // only vault and env ones, so the set records every expression kind.
  const authored = collectAuthoredExpressions({
    a: "${{ data.latest('m', 'd').attributes.x }}",
    b: "${{ inputs.name }}",
    c: "${{ model.other.resource.id }}",
  });

  assertEquals(authored.size, 3);
  assertEquals(authored.has("${{ inputs.name }}"), true);
});

Deno.test("collectAuthoredExpressions: walks nested objects and arrays", () => {
  const authored = collectAuthoredExpressions({
    jobs: [
      { steps: [{ run: "echo ${{ vault.get('v', 'deep') }}" }] },
    ],
  });

  assertEquals(authored.has("${{ vault.get('v', 'deep') }}"), true);
});

Deno.test("collectAuthoredExpressions: accumulates into an existing set", () => {
  const authored = collectAuthoredExpressions({
    a: "${{ env.FIRST }}",
  });
  collectAuthoredExpressions({ b: "${{ env.SECOND }}" }, authored);

  assertEquals(authored.size, 2);
  assertEquals(authored.has("${{ env.FIRST }}"), true);
  assertEquals(authored.has("${{ env.SECOND }}"), true);
});

Deno.test("collectAuthoredExpressions: collects mixed vault and CEL expressions", () => {
  const authored = collectAuthoredExpressions({
    a: "${{ vault.get('v', inputs.key) }}",
  });

  assertEquals(authored.has("${{ vault.get('v', inputs.key) }}"), true);
});

// ============================================================================
// Authored-expression gate — swamp-club#2172
// ============================================================================

Deno.test("resolveRuntimeExpressionsInDefinition: resolves an env expression the author wrote", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_AUTHORED", "resolved");

    try {
      const definition = Definition.create({
        name: "authored-model",
        globalArguments: { token: "${{ env.SWAMP_TEST_AUTHORED }}" },
      });

      const result = await service.resolveRuntimeExpressionsInDefinition(
        definition,
        undefined,
        undefined,
        collectAuthoredExpressions(definition.toData()),
      );

      assertEquals(result.definition.globalArguments.token, "resolved");
    } finally {
      Deno.env.delete("SWAMP_TEST_AUTHORED");
    }
  });
});

Deno.test("resolveRuntimeExpressionsInDefinition: refuses an env expression absent from the authored set", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_INJECTED", "leaked-secret");

    try {
      // Stands in for a definition that CEL substitution spliced data content
      // into: the expression is present in the tree but was never authored.
      const definition = Definition.create({
        name: "injected-model",
        globalArguments: { note: "${{ env.SWAMP_TEST_INJECTED }}" },
      });

      const result = await service.resolveRuntimeExpressionsInDefinition(
        definition,
        undefined,
        undefined,
        new Set<string>(),
      );

      assertEquals(
        result.definition.globalArguments.note,
        "${{ env.SWAMP_TEST_INJECTED }}",
      );
    } finally {
      Deno.env.delete("SWAMP_TEST_INJECTED");
    }
  });
});

Deno.test("resolveRuntimeExpressionsInDefinition: resolves only the authored expression when both are present", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_OK", "fine");
    Deno.env.set("SWAMP_TEST_BAD", "leaked-secret");

    try {
      const definition = Definition.create({
        name: "mixed-model",
        globalArguments: {
          authored: "${{ env.SWAMP_TEST_OK }}",
          injected: "${{ env.SWAMP_TEST_BAD }}",
        },
      });

      const result = await service.resolveRuntimeExpressionsInDefinition(
        definition,
        undefined,
        undefined,
        new Set(["${{ env.SWAMP_TEST_OK }}"]),
      );

      assertEquals(result.definition.globalArguments.authored, "fine");
      assertEquals(
        result.definition.globalArguments.injected,
        "${{ env.SWAMP_TEST_BAD }}",
      );
    } finally {
      Deno.env.delete("SWAMP_TEST_OK");
      Deno.env.delete("SWAMP_TEST_BAD");
    }
  });
});

Deno.test("resolveRuntimeExpressionsInData: refuses an env expression absent from the authored set", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_DATA_INJECTED", "leaked-secret");

    try {
      const result = await service.resolveRuntimeExpressionsInData(
        { note: "${{ env.SWAMP_TEST_DATA_INJECTED }}" },
        undefined,
        undefined,
        new Set<string>(),
      ) as { note: string };

      assertEquals(result.note, "${{ env.SWAMP_TEST_DATA_INJECTED }}");
    } finally {
      Deno.env.delete("SWAMP_TEST_DATA_INJECTED");
    }
  });
});

Deno.test("resolveAllExpressionsInData: refuses a runtime expression its own CEL pass introduced", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);
    Deno.env.set("SWAMP_TEST_SPLICED", "leaked-secret");

    try {
      // `note` holds attacker-controlled text; CEL splices it into `run`, and
      // the runtime pass must not then treat it as a definition-source
      // expression. This is swamp-club#2172 in miniature.
      const result = await service.resolveAllExpressionsInData(
        { run: "echo ${{ inputs.note }}" },
        makeContext({
          inputs: { note: "${{ env.SWAMP_TEST_SPLICED }}" },
        }),
        undefined,
        collectAuthoredExpressions({ run: "echo ${{ inputs.note }}" }),
      ) as { run: string };

      assertEquals(result.run, "echo ${{ env.SWAMP_TEST_SPLICED }}");
    } finally {
      Deno.env.delete("SWAMP_TEST_SPLICED");
    }
  });
});

Deno.test("evaluateData: refuses an expression absent from the authored set", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);

    // Stands in for step inputs the workflow evaluator already substituted
    // data into: the expression is present but was never authored.
    const result = await service.evaluateData(
      { run: "echo ${{ inputs.note }}" },
      makeContext({ inputs: { note: "leaked" } }),
      new Set<string>(),
    ) as { run: string };

    assertEquals(result.run, "echo ${{ inputs.note }}");
  });
});

Deno.test("evaluateData: resolves an authored expression and refuses an injected one side by side", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);

    const result = await service.evaluateData(
      {
        authored: "${{ inputs.ok }}",
        injected: "${{ inputs.bad }}",
      },
      makeContext({ inputs: { ok: "fine", bad: "leaked" } }),
      new Set(["${{ inputs.ok }}"]),
    ) as { authored: string; injected: string };

    assertEquals(result.authored, "fine");
    assertEquals(result.injected, "${{ inputs.bad }}");
  });
});

Deno.test("evaluateData: unrestricted evaluates everything", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);

    const result = await service.evaluateData(
      { run: "echo ${{ inputs.note }}" },
      makeContext({ inputs: { note: "value" } }),
      "unrestricted",
    ) as { run: string };

    assertEquals(result.run, "echo value");
  });
});

Deno.test("evaluateData: bracket-index env reference is deferred, never evaluated in the CEL pass", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);

    // Even with the gate wide open, env access in any form is runtime-only.
    const result = await service.evaluateData(
      { run: "echo ${{ env['SWAMP_TEST_BRACKET'] }}" },
      makeContext({ env: { SWAMP_TEST_BRACKET: "leaked" } }),
      "unrestricted",
    ) as { run: string };

    assertEquals(result.run, "echo ${{ env['SWAMP_TEST_BRACKET'] }}");
  });
});

Deno.test("containsEnvExpression: cel.bind scopes its body but not its initializer", () => {
  for (
    const expression of [
      'cel.bind(env, {"HOME": "local"}, env.HOME)',
      "cel.bind(env, {}, cel.bind(value, env, value))",
      "cel.bind(value, {}, cel.bind(env, value, env))",
      "cel.bind(env, {}, cel.bind(env, env, env))",
    ]
  ) {
    assertEquals(containsEnvExpression(expression), false, expression);
  }
  for (
    const expression of [
      'cel.bind(env, env["HOME"], env)',
      "cel.bind(value, env, value.HOME)",
      "cel.bind(value, {}, cel.bind(env, env.HOME, env))",
      "cel.bind(env, {}, env) == env",
      "other.bind(env, {}, env)",
    ]
  ) {
    assertEquals(containsEnvExpression(expression), true, expression);
  }
});

Deno.test("runtime resolvers: preserve supplied namespaces and refresh env", async () => {
  await withTempDir(async (repoDir) => {
    const service = new ExpressionEvaluationService(
      new YamlDefinitionRepository(repoDir),
      repoDir,
    );
    const originalToObject = Deno.env.toObject;
    Deno.env.toObject = () => ({ HOME: "runtime-home" });
    try {
      let queries = 0;
      const context: ExpressionContext = {
        env: { HOME: "stale-home" },
        model: {
          source: {
            input: {
              id: "source",
              name: "upstream",
              version: 1,
              tags: {},
              globalArguments: {},
            },
          },
        },
        self: {
          id: "iteration",
          name: "supplied-self",
          version: 2,
          tags: {},
          globalArguments: {},
          item: "iteration-value",
        },
        inputs: { suffix: "input-value" },
        workflow: { name: "workflow-value" },
        steps: { previous: { status: "succeeded" } },
        file: { contents: () => "file-value" },
        data: {
          version: () => Promise.resolve(null),
          latest: () => Promise.resolve(null),
          listVersions: () => [],
          findByTag: () => Promise.resolve([]),
          findBySpec: () => Promise.resolve([]),
          query: () => {
            queries++;
            return Promise.resolve(["data-value"]);
          },
        },
      };
      const args = {
        value:
          '${{ env["HOME"] + ":" + self.name + ":" + self.item + ":" + inputs.suffix + ":" + model.source.input.name + ":" + workflow.name + ":" + steps.previous.status + ":" + file.contents("source", "file") + ":" + data.query("true")[0] }}',
      };
      const authored = collectAuthoredExpressions(args);
      const definition = Definition.create({
        name: "runtime-context",
        globalArguments: args,
      });
      const evaluated = await service.evaluateDefinition(
        definition,
        ModelType.create("test/model"),
        undefined,
        { ...context },
      );
      assertEquals(evaluated.definition.globalArguments, args);
      const resolved = await service.resolveRuntimeExpressionsInDefinition(
        evaluated.definition,
        undefined,
        context,
        authored,
      );
      const expected = {
        value:
          "runtime-home:supplied-self:iteration-value:input-value:upstream:workflow-value:succeeded:file-value:data-value",
      };
      assertEquals(resolved.definition.globalArguments, expected);
      assertEquals(
        await service.resolveRuntimeExpressionsInData(
          args,
          undefined,
          context,
          authored,
        ),
        expected,
      );
      assertEquals(queries, 2);
      assertEquals(context.env.HOME, "stale-home");
      assertEquals(evaluated.definition.globalArguments, args);
    } finally {
      Deno.env.toObject = originalToObject;
    }
  });
});

Deno.test("resolveRuntimeExpressionsInDefinition: supplies missing model self fields", async () => {
  await withTempDir(async (repoDir) => {
    const service = new ExpressionEvaluationService(
      new YamlDefinitionRepository(repoDir),
      repoDir,
    );
    const originalToObject = Deno.env.toObject;
    Deno.env.toObject = () => ({ HOME: "runtime-home" });
    try {
      const definition = Definition.create({
        name: "default-self",
        globalArguments: {
          value:
            '${{ env["HOME"] + ":" + self.name + ":" + string(self.version) }}',
        },
      });
      for (const context of [undefined, { model: {}, env: {} }]) {
        const result = await service.resolveRuntimeExpressionsInDefinition(
          definition,
          undefined,
          context,
          collectAuthoredExpressions(definition.toData()),
        );
        assertEquals(
          result.definition.globalArguments.value,
          "runtime-home:default-self:1",
        );
      }
    } finally {
      Deno.env.toObject = originalToObject;
    }
  });
});

// ============================================================================
// buildRuntimeContext

Deno.test("buildRuntimeContext: loads the model namespace only when a remaining expression reads it", async () => {
  await withTempDir(async (repoDir) => {
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("command/shell");
    await definitionRepo.save(type, Definition.create({ name: "producer" }));
    const service = new ExpressionEvaluationService(definitionRepo, repoDir);

    const envOnly = Definition.create({
      name: "env-only",
      methods: { exec: { arguments: { run: "${{ env.HOME }}" } } },
    });
    const light = await service.buildRuntimeContext(envOnly, { a: 1 });
    assertEquals(light.model, {});
    assertEquals(light.inputs, { a: 1 });
    assertEquals(typeof light.data, "object");

    const mixed = Definition.create({
      name: "mixed",
      methods: {
        exec: {
          arguments: {
            run: "${{ env['HOME'] + model.producer.input.name }}",
          },
        },
      },
    });
    const full = await service.buildRuntimeContext(mixed);
    assertEquals(full.model.producer?.input.name, "producer");
    assertEquals(full.inputs, undefined);
  });
});

Deno.test("resolveAllExpressionsInData: requires provenance from before earlier substitution", async () => {
  await withTempDir(async (dir) => {
    const service = new ExpressionEvaluationService(
      new YamlDefinitionRepository(dir),
      dir,
    );
    const data = { ordinary: "${{ 1 + 1 }}", runtime: "${{ env.HOME }}" };
    assertEquals(
      await service.resolveAllExpressionsInData(
        data,
        makeContext(),
        undefined,
        new Set(),
      ),
      data,
    );
  });
});
