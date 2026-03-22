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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-eval-service-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
