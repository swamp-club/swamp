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
import { walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import {
  parseInputs,
  parseKeyValueInputs,
  parseStdinContent,
} from "../src/cli/input_parser.ts";
import {
  Definition,
  type InputsSchema,
} from "../src/domain/definitions/definition.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { KeyPath } from "../src/domain/models/data_field_extractor.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelMethodRun,
  type ModelMethodRunEvent,
} from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VAULT = "secrets";
const VAULT_VALUE = "DUMMY-SECRET-4649-5ca1ab1e";
const VAULT_REF = `\${{ vault.get('${VAULT}', 'probe') }}`;

interface Harness {
  dir: string;
  type: ModelType;
  received: Record<string, unknown>[];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-4649-data-args-" });
  const type = ModelType.create(`@test/data-args-${crypto.randomUUID()}`);
  const received: Record<string, unknown>[] = [];
  // the #4596 shape: the method digests the payload it received and stores both
  const recordArtifact = async (
    args: unknown,
    context: { writeResource?: (...a: never[]) => unknown },
  ) => {
    received.push(args as Record<string, unknown>);
    const { name, payload } = args as { name: string; payload: string };
    const write = context.writeResource as unknown as (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => Promise<unknown>;
    const handle = await write("artifact", name, {
      payload,
      digest: await sha256(payload),
    });
    return { dataHandles: [handle] };
  };
  const capture = (args: unknown) => {
    received.push(args as Record<string, unknown>);
    return Promise.resolve({ dataHandles: [] });
  };
  modelRegistry.register({
    type,
    version: "2026.11.11.1",
    globalArguments: z.object({ label: z.string().optional() }),
    resources: {
      artifact: {
        description: "What record wrote",
        schema: z.object({ payload: z.string(), digest: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      record: {
        description: "record",
        arguments: z.object({
          name: z.string(),
          payload: z.string().meta({ data: true }),
        }),
        // deno-lint-ignore no-explicit-any
        execute: recordArtifact as any,
      },
      recordPlain: {
        description: "recordPlain",
        arguments: z.object({ name: z.string(), payload: z.string() }),
        // deno-lint-ignore no-explicit-any
        execute: recordArtifact as any,
      },
      nested: {
        description: "nested",
        arguments: z.object({
          body: z.object({
            text: z.string().meta({ data: true }),
            note: z.string().optional(),
          }),
        }),
        execute: capture,
      },
    },
  });
  try {
    await initializeTestRepo(dir);
    await new YamlVaultConfigRepository(dir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, "local_encryption", {
        auto_generate: true,
        base_dir: dir,
      }),
    );
    const vault = await VaultService.fromRepository(dir);
    await vault.put(VAULT, "probe", VAULT_VALUE);
    await fn({ dir, type, received });
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function define(
  h: Harness,
  name: string,
  method: string,
  args: Record<string, unknown>,
  inputs?: InputsSchema,
): Promise<void> {
  const repo = createRepositoryContext({ repoDir: h.dir });
  try {
    await repo.definitionRepo.save(
      h.type,
      Definition.create({
        name,
        type: h.type.normalized,
        ...(inputs ? { inputs } : {}),
        methods: { [method]: { arguments: args } },
      }),
    );
  } finally {
    repo.catalogStore.close();
  }
}

async function run(
  h: Harness,
  name: string,
  method: string,
  inputs: Record<string, unknown>,
  options: {
    dataInputPaths?: KeyPath[];
    typeArg?: string;
  } = {},
): Promise<ModelMethodRunEvent[]> {
  const repo = createRepositoryContext({ repoDir: h.dir });
  try {
    const deps = await createModelMethodRunDeps(h.dir, repo, {
      directExecution: options.typeArg !== undefined,
    });
    return await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: options.typeArg ?? name,
        methodName: method,
        inputs,
        lastEvaluated: false,
        ...(options.dataInputPaths
          ? { dataInputPaths: options.dataInputPaths }
          : {}),
        ...(options.typeArg
          ? { typeArg: options.typeArg, definitionName: name }
          : {}),
      }),
    );
  } finally {
    repo.catalogStore.close();
  }
}

function errorsOf(events: ModelMethodRunEvent[]) {
  return events.flatMap((event) => event.kind === "error" ? [event.error] : []);
}

function assertCompleted(events: ModelMethodRunEvent[]): void {
  assertEquals(errorsOf(events), []);
  assertEquals(events.some((event) => event.kind === "completed"), true);
}

async function swampFilesHolding(dir: string, text: string): Promise<string[]> {
  const hits: string[] = [];
  for await (
    const entry of walk(join(dir, ".swamp"), { includeDirs: false })
  ) {
    const bytes = await Deno.readFile(entry.path);
    if (new TextDecoder().decode(bytes).includes(text)) hits.push(entry.path);
  }
  return hits;
}

/** the stored artifact whose digest the method computed */
async function storedArtifact(
  dir: string,
  digest: string,
): Promise<{ payload: string; digest: string }> {
  for (const path of await swampFilesHolding(dir, digest)) {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(path));
      if (parsed?.digest === digest) return parsed;
    } catch {
      // not the artifact's own bytes
    }
  }
  throw new Error(`no stored artifact with digest ${digest}`);
}

async function assertStoredAsReceived(
  h: Harness,
  expected: string,
): Promise<void> {
  const received = h.received.at(-1)!.payload as string;
  assertEquals(received, expected);
  const digest = await sha256(received);
  const stored = await storedArtifact(h.dir, digest);
  assertEquals(stored.payload, received);
  assertEquals(await sha256(stored.payload), stored.digest);
  assertEquals(await swampFilesHolding(h.dir, VAULT_VALUE), []);
}

Deno.test("data argument: an --input value holding a resolvable vault.get reaches the method verbatim and is stored as the method saw it (swamp-club#4596)", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "record", {});
    const payload = `plan: rotate ${VAULT_REF} next week`;
    assertCompleted(await run(h, "art", "record", { name: "a1", payload }));
    await assertStoredAsReceived(h, payload);
  });
});

Deno.test("data argument: an unmarked argument still resolves the same reference, so the method sees the secret and the store holds the mask", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "recordPlain", {});
    const payload = `plan: rotate ${VAULT_REF} next week`;
    assertCompleted(
      await run(h, "art", "recordPlain", { name: "a1", payload }),
    );
    assertEquals(
      h.received.at(-1)!.payload,
      `plan: rotate ${VAULT_VALUE} next week`,
    );
    const digest = await sha256(`plan: rotate ${VAULT_VALUE} next week`);
    const stored = await storedArtifact(h.dir, digest);
    assertEquals(stored.payload, "plan: rotate *** next week");
    assertEquals(await sha256(stored.payload) === stored.digest, false);
  });
});

Deno.test("data argument: an --input key=@file value is data in a marked argument", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "record", {});
    const file = join(h.dir, "result.md");
    const content = `result mentions ${VAULT_REF}\n`;
    await Deno.writeTextFile(file, content);
    const inputs = await parseKeyValueInputs(["name=a1", `payload=@${file}`]);
    assertCompleted(await run(h, "art", "record", inputs));
    await assertStoredAsReceived(h, content);
  });
});

Deno.test("data argument: an --input-file value is data in a marked argument", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "record", {});
    const file = join(h.dir, "inputs.yaml");
    await Deno.writeTextFile(
      file,
      `name: a1\npayload: "review ${VAULT_REF}"\n`,
    );
    const { inputs } = await parseInputs({ inputFile: file });
    assertCompleted(await run(h, "art", "record", inputs));
    await assertStoredAsReceived(h, `review ${VAULT_REF}`);
  });
});

Deno.test("data argument: a --stdin item is data in a marked argument", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "record", {});
    const [item] = parseStdinContent(
      JSON.stringify({ name: "a1", payload: `checkpoint ${VAULT_REF}` }),
    );
    assertCompleted(await run(h, "art", "record", item));
    await assertStoredAsReceived(h, `checkpoint ${VAULT_REF}`);
  });
});

Deno.test("data argument: a marked field nested in an object argument is data", async () => {
  await withHarness(async (h) => {
    await define(h, "nest", "nested", {});
    assertCompleted(
      await run(h, "nest", "nested", {
        body: { text: `nested ${VAULT_REF}` },
      }),
    );
    assertEquals(h.received.at(-1)!.body, { text: `nested ${VAULT_REF}` });
  });
});

Deno.test("data argument: a definition input the marked argument reads through inputs is data", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "record", {
      name: "a1",
      payload: "${{ inputs.text }}",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    assertCompleted(
      await run(h, "art", "record", { text: `spliced ${VAULT_REF}` }),
    );
    await assertStoredAsReceived(h, `spliced ${VAULT_REF}`);
  });
});

Deno.test("data argument: a vault reference written in the definition itself still resolves in a marked argument", async () => {
  await withHarness(async (h) => {
    await define(h, "nest", "nested", { body: { text: VAULT_REF } });
    assertCompleted(await run(h, "nest", "nested", {}));
    assertEquals(h.received.at(-1)!.body, { text: VAULT_VALUE });
  });
});

Deno.test("data argument: a direct type execution passes a marked value verbatim", async () => {
  await withHarness(async (h) => {
    const payload = `direct ${VAULT_REF}`;
    assertCompleted(
      await run(h, "direct-art", "record", { name: "a1", payload }, {
        typeArg: h.type.normalized,
      }),
    );
    await assertStoredAsReceived(h, payload);
  });
});

Deno.test("data argument: a workflow input wired into a marked argument reaches the method verbatim", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "record", {
      name: "a1",
      payload: "${{ inputs.text }}",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    const repo = createRepositoryContext({ repoDir: h.dir });
    try {
      const workflow = Workflow.create({
        name: "art-flow",
        inputs: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "probe",
                task: StepTask.model("art", "record", {
                  text: "${{ inputs.text }}",
                }),
              }),
            ],
          }),
        ],
      });
      await repo.workflowRepo.save(workflow);
      const service = new WorkflowExecutionService(
        repo.workflowRepo,
        repo.workflowRunRepo,
        h.dir,
        undefined,
        undefined,
        repo.catalogStore,
      );
      const result = await service.execute(workflow.name, {
        inputs: { text: `step ${VAULT_REF}` },
      });
      assertEquals(
        result.status,
        "succeeded",
        result.getJob("main")?.getStep("probe")?.error,
      );
    } finally {
      repo.catalogStore.close();
    }
    await assertStoredAsReceived(h, `step ${VAULT_REF}`);
  });
});

Deno.test("data input: a path the caller names as data is verbatim in an unmarked argument", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "recordPlain", {});
    const payload = `from file ${VAULT_REF}`;
    assertCompleted(
      await run(h, "art", "recordPlain", { name: "a1", payload }, {
        dataInputPaths: [["payload"]],
      }),
    );
    await assertStoredAsReceived(h, payload);
  });
});

Deno.test("data input: a definition input named as data is data where the definition splices it", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "recordPlain", {
      name: "a1",
      payload: "${{ inputs.text }}",
    }, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    assertCompleted(
      await run(h, "art", "recordPlain", { text: `spliced ${VAULT_REF}` }, {
        dataInputPaths: [["text"]],
      }),
    );
    await assertStoredAsReceived(h, `spliced ${VAULT_REF}`);
  });
});

Deno.test("data input: a data path routed to a global argument is refused when it holds expression text, and stored when it holds none", async () => {
  await withHarness(async (h) => {
    const refused = await run(
      h,
      "direct-glob",
      "recordPlain",
      { name: "a1", payload: "p", label: `lbl ${VAULT_REF}` },
      { typeArg: h.type.normalized, dataInputPaths: [["label"]] },
    );
    assertEquals(errorsOf(refused).length, 1);
    assertEquals(h.received.length, 0);
    assertCompleted(
      await run(
        h,
        "direct-glob",
        "recordPlain",
        { name: "a1", payload: "p", label: "plain label" },
        { typeArg: h.type.normalized, dataInputPaths: [["label"]] },
      ),
    );
  });
});

Deno.test("data input: a data path naming no supplied input is refused before the method runs", async () => {
  await withHarness(async (h) => {
    await define(h, "art", "recordPlain", {});
    const events = await run(h, "art", "recordPlain", {
      name: "a1",
      payload: "p",
    }, { dataInputPaths: [["payloda"]] });
    const [error] = errorsOf(events);
    assertStringIncludes(error.message, "payloda");
    assertEquals(h.received.length, 0);
  });
});
