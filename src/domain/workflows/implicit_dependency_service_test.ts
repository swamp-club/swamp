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

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { buildStepNodesWithImplicitDeps } from "./implicit_dependency_service.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Definition } from "../definitions/definition.ts";
import { ECHO_MODEL_TYPE } from "../models/echo/echo_model.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

async function withTempRepo(
  fn: (repo: YamlDefinitionRepository) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-implicit-deps-" });
  try {
    await ensureDir(join(dir, ".swamp/definitions"));
    const repo = new YamlDefinitionRepository(dir);
    await fn(repo);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("no implicit deps when steps have no model references", async () => {
  await withTempRepo(async (repo) => {
    const modelA = Definition.create({
      name: "model-a",
      methods: { write: { arguments: { message: "hello" } } },
    });
    const modelB = Definition.create({
      name: "model-b",
      methods: { write: { arguments: { message: "world" } } },
    });
    await repo.save(ECHO_MODEL_TYPE, modelA);
    await repo.save(ECHO_MODEL_TYPE, modelB);

    const job = Job.create({
      name: "test-job",
      steps: [
        Step.create({
          name: "step-a",
          task: StepTask.model("model-a", "write"),
        }),
        Step.create({
          name: "step-b",
          task: StepTask.model("model-b", "write"),
        }),
      ],
    });

    const { nodes, implicitDeps } = await buildStepNodesWithImplicitDeps(
      job,
      repo,
    );

    assertEquals(nodes.length, 2);
    assertEquals(implicitDeps.size, 0);
    assertEquals(nodes[0].dependencies, []);
    assertEquals(nodes[1].dependencies, []);
  });
});

Deno.test("extracts resource deps from model definition CEL expressions", async () => {
  await withTempRepo(async (repo) => {
    const vpcModel = Definition.create({
      name: "networking-vpc",
      methods: { write: { arguments: { cidr: "10.0.0.0/16" } } },
    });
    const routeTableModel = Definition.create({
      name: "public-route-table",
      methods: {
        write: {
          arguments: {
            vpcId:
              "${{ model.networking-vpc.resource.aws_vpc.main.attributes.VpcId }}",
          },
        },
      },
    });
    await repo.save(ECHO_MODEL_TYPE, vpcModel);
    await repo.save(ECHO_MODEL_TYPE, routeTableModel);

    const job = Job.create({
      name: "infra-job",
      steps: [
        Step.create({
          name: "create-vpc",
          task: StepTask.model("networking-vpc", "write"),
        }),
        Step.create({
          name: "create-route-table",
          task: StepTask.model("public-route-table", "write"),
        }),
      ],
    });

    const { nodes, implicitDeps } = await buildStepNodesWithImplicitDeps(
      job,
      repo,
    );

    assertEquals(nodes.length, 2);
    assertEquals(implicitDeps.size, 1);
    assertEquals(implicitDeps.get("create-route-table"), ["create-vpc"]);
    assertEquals(nodes[1].dependencies, ["create-vpc"]);
  });
});

Deno.test("extracts file.contents deps from model definition", async () => {
  await withTempRepo(async (repo) => {
    const sourceModel = Definition.create({
      name: "source-model",
      methods: { write: { arguments: { data: "source data" } } },
    });
    const consumerModel = Definition.create({
      name: "consumer-model",
      methods: {
        write: {
          arguments: {
            content: "${{ file.contents('source-model', 'config') }}",
          },
        },
      },
    });
    await repo.save(ECHO_MODEL_TYPE, sourceModel);
    await repo.save(ECHO_MODEL_TYPE, consumerModel);

    const job = Job.create({
      name: "file-job",
      steps: [
        Step.create({
          name: "write-source",
          task: StepTask.model("source-model", "write"),
        }),
        Step.create({
          name: "read-consumer",
          task: StepTask.model("consumer-model", "write"),
        }),
      ],
    });

    const { implicitDeps } = await buildStepNodesWithImplicitDeps(job, repo);

    assertEquals(implicitDeps.size, 1);
    assertEquals(implicitDeps.get("read-consumer"), ["write-source"]);
  });
});

Deno.test("extracts deps from task.inputs", async () => {
  await withTempRepo(async (repo) => {
    const vpcModel = Definition.create({
      name: "networking-vpc",
      methods: { write: { arguments: { cidr: "10.0.0.0/16" } } },
    });
    const subnetModel = Definition.create({
      name: "subnet-model",
      methods: { write: { arguments: {} } },
    });
    await repo.save(ECHO_MODEL_TYPE, vpcModel);
    await repo.save(ECHO_MODEL_TYPE, subnetModel);

    const job = Job.create({
      name: "infra-job",
      steps: [
        Step.create({
          name: "create-vpc",
          task: StepTask.model("networking-vpc", "write"),
        }),
        Step.create({
          name: "create-subnet",
          task: StepTask.model("subnet-model", "write", {
            vpcId:
              "${{ model.networking-vpc.resource.aws_vpc.main.attributes.VpcId }}",
          }),
        }),
      ],
    });

    const { implicitDeps } = await buildStepNodesWithImplicitDeps(job, repo);

    assertEquals(implicitDeps.size, 1);
    assertEquals(implicitDeps.get("create-subnet"), ["create-vpc"]);
  });
});

Deno.test("gracefully skips when model definition not found", async () => {
  await withTempRepo(async (repo) => {
    // Don't save any definitions - they won't be found
    const job = Job.create({
      name: "test-job",
      steps: [
        Step.create({
          name: "step-a",
          task: StepTask.model("nonexistent-model", "write"),
        }),
        Step.create({
          name: "step-b",
          task: StepTask.model("also-nonexistent", "write"),
        }),
      ],
    });

    const { nodes, implicitDeps } = await buildStepNodesWithImplicitDeps(
      job,
      repo,
    );

    assertEquals(nodes.length, 2);
    assertEquals(implicitDeps.size, 0);
  });
});

Deno.test("deduplicates repeated references to the same model", async () => {
  await withTempRepo(async (repo) => {
    const vpcModel = Definition.create({
      name: "networking-vpc",
      methods: { write: { arguments: { cidr: "10.0.0.0/16" } } },
    });
    const multiRefModel = Definition.create({
      name: "multi-ref-model",
      methods: {
        write: {
          arguments: {
            vpcId:
              "${{ model.networking-vpc.resource.aws_vpc.main.attributes.VpcId }}",
            subnetCidr:
              "${{ model.networking-vpc.resource.aws_vpc.main.attributes.CidrBlock }}",
          },
        },
      },
    });
    await repo.save(ECHO_MODEL_TYPE, vpcModel);
    await repo.save(ECHO_MODEL_TYPE, multiRefModel);

    const job = Job.create({
      name: "test-job",
      steps: [
        Step.create({
          name: "create-vpc",
          task: StepTask.model("networking-vpc", "write"),
        }),
        Step.create({
          name: "create-multi",
          task: StepTask.model("multi-ref-model", "write"),
        }),
      ],
    });

    const { implicitDeps } = await buildStepNodesWithImplicitDeps(job, repo);

    assertEquals(implicitDeps.size, 1);
    // Should only appear once despite two references
    assertEquals(implicitDeps.get("create-multi"), ["create-vpc"]);
  });
});
