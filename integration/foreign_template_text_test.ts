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

// Integration test for swamp-club#2491: the definition pass and the run-time
// guard on global arguments share one judgement of which `${{ ... }}` text is
// swamp's. The definition pass leaves another templating system's text raw;
// the guard must then hand it to the method, while still refusing swamp
// expressions that failed or that it cannot parse.

import { assertEquals, assertThrows } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";

import { DefinitionExpressionEvaluator } from "../src/domain/workflows/expression_evaluators.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { buildMethodContext } from "../src/domain/models/method_context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { MethodDefinition } from "../src/domain/models/model.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  CelEvaluator,
  createExtensionCelEnvironment,
} from "../src/infrastructure/cel/cel_evaluator.ts";

const MODEL_TYPE = ModelType.create("test/foreign-template-text");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-foreign-template-" });
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

Deno.test("foreign template text: the definition pass and the globalArgs guard agree (swamp-club#2491)", async () => {
  const source = Definition.create({
    name: "deploy-notifier",
    type: MODEL_TYPE.normalized,
    inputs: { properties: { region: { type: "string" } } },
    globalArguments: {
      // Swamp's: a declared input given no value, so evaluation fails.
      region: "${{ inputs.region }}",
      // Swamp's, but cut short at the }} inside its string literal.
      label: '${{ "a}}" + inputs.region }}',
      // GitHub Actions and Datadog text.
      message: "deploy ${{ github.sha }}",
      alert: "crashed on {{host.name}}",
    },
    methods: { run: { arguments: {} } },
  });

  const { definition, failedExpressions } =
    await new DefinitionExpressionEvaluator(new CelEvaluator()).evaluate(
      source,
      { model: {}, env: {}, inputs: {} },
      "unrestricted",
    );
  assertEquals(failedExpressions.has("${{ inputs.region }}"), true);
  assertEquals(failedExpressions.has("${{ github.sha }}"), false);

  const read: Record<string, unknown> = {};
  const method: MethodDefinition = {
    description: "run",
    arguments: z.object({}),
    execute: (_args, context) => {
      read.message = context.globalArgs.message;
      read.alert = context.globalArgs.alert;
      assertThrows(
        () => context.globalArgs.region,
        Error,
        "Unresolved expression in globalArguments.region",
      );
      assertThrows(
        () => context.globalArgs.label,
        Error,
        "Unresolved expression in globalArguments.label",
      );
      return Promise.resolve({});
    },
  };

  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, ".swamp", "data"));
    await ensureDir(join(repoDir, "models"));
    const catalogStore = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    try {
      const context = buildMethodContext(
        {
          dataRepository: new FileSystemUnifiedDataRepository(
            repoDir,
            undefined,
            catalogStore,
          ),
          definitionRepository: new YamlDefinitionRepository(repoDir),
          createCelEnvironment: createExtensionCelEnvironment,
        },
        {
          signal: new AbortController().signal,
          repoDir,
          modelType: MODEL_TYPE,
          modelId: definition.id,
          globalArgs: {},
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName: "run",
          logger: getLogger(["test", "foreign-template-text"]),
        },
      );

      await new DefaultMethodExecutionService().execute(
        definition,
        method,
        context,
      );
    } finally {
      catalogStore.close();
    }
  });
  assertEquals(read, {
    message: "deploy ${{ github.sha }}",
    alert: "crashed on {{host.name}}",
  });
});
