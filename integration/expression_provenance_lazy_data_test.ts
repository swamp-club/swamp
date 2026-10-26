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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelResolver } from "../src/domain/expressions/model_resolver.ts";
import { ProvenanceMap } from "../src/domain/expressions/provenance_map.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { WorkflowExpressionEvaluator } from "../src/domain/workflows/expression_evaluators.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";

Deno.test("workflow provenance: definition reads leave stored data lazy", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lazy-provenance-" });
  const catalog = new CatalogStore(join(dir, "catalog.db"));
  try {
    await withMockedEnv({ SWAMP_DATA_NAMESPACE: undefined }, async () => {
      const definitions = new YamlDefinitionRepository(dir);
      const data = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalog,
      );
      const type = ModelType.create("test/lazy-provenance");
      const models: Definition[] = [];
      const write = async (model: Definition, value: string) => {
        await data.save(
          type,
          model.id,
          Data.create({
            name: "state",
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10,
            tags: { type: "resource", modelName: model.name },
            ownerDefinition: {
              ownerType: "model-method",
              ownerRef: "test/lazy-provenance:run",
            },
          }),
          new TextEncoder().encode(JSON.stringify({ value })),
        );
      };
      for (let i = 0; i < 12; i++) {
        const model = Definition.create({
          name: `b${i}`,
          globalArguments: { text: "ok" },
        });
        await definitions.save(type, model);
        await write(model, "old");
        models.push(model);
      }
      // A data-less behavior would trigger the global orphan scan if touched.
      await definitions.save(type, Definition.create({ name: "empty" }));
      const modelReads: string[] = [];
      const asyncModelReads: string[] = [];
      const contentReads: string[] = [];
      let globalScans = 0;
      const findModel = data.findAllForModelSync.bind(data);
      data.findAllForModelSync = (type, id) => {
        modelReads.push(id);
        return findModel(type, id);
      };
      const findModelAsync = data.findAllForModel.bind(data);
      data.findAllForModel = async (type, id) => {
        asyncModelReads.push(id);
        return await findModelAsync(type, id);
      };
      const findGlobal = data.findAllGlobalSync.bind(data);
      data.findAllGlobalSync = (options) => {
        globalScans++;
        return findGlobal(options);
      };
      const readContent = data.getContentSync.bind(data);
      data.getContentSync = (type, id, name, version) => {
        contentReads.push(id);
        return readContent(type, id, name, version);
      };
      const resolver = new ModelResolver(definitions, {
        repoDir: dir,
        dataRepo: data,
      });
      const context = await resolver.buildContext(new RunSensitiveValues());
      const cel = new CelEvaluator();
      const computed =
        '${{ model.b0.input.globalArguments.?text.orValue("fallback") }}';
      const workflow = Workflow.create({
        name: "lazy-provenance",
        description: computed,
        jobs: [Job.create({
          name: "j",
          steps: [Step.create({
            name: "s",
            description: computed,
            task: StepTask.model("b0", "run"),
          })],
        })],
      });
      const result = await new WorkflowExpressionEvaluator(cel).evaluate(
        workflow,
        context,
        "unrestricted",
      );
      assertEquals(result.workflow.description, "ok");
      assertEquals(result.workflow.jobs[0].steps[0].description, "ok");
      assertEquals(
        result.provenance.toData(),
        ProvenanceMap.fromEntries([
          "description",
          "jobs[0].steps[0].description",
        ], []).toData(),
      );
      assertEquals(result.expressionsEvaluated, 1);
      assertEquals(result.diagnostics.expressionOccurrences, 2);
      assertEquals(result.diagnostics.celEvaluations, 2);
      assertEquals(result.diagnostics.modelKeys, 26);
      assertEquals(modelReads, []);
      assertEquals(asyncModelReads, []);
      assertEquals(contentReads, []);
      assertEquals(globalScans, 0);

      // The context must still load current data when a later step reads it.
      await write(models[0], "new");
      assertEquals(
        await cel.evaluateAsync(
          "model.b0.resource.state.state.attributes.value",
          context,
        ),
        "new",
      );
      assertEquals(new Set(modelReads), new Set([models[0].id]));
      assertEquals(new Set(asyncModelReads), new Set([models[0].id]));
      assertEquals(new Set(contentReads), new Set([models[0].id]));
      assertEquals(globalScans, 0);
      assertEquals(context.model.b0, context.model[models[0].id]);
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
