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
import { methodSummaryReport } from "./method_summary_report.ts";
import type { MethodReportContext } from "../report_context.ts";
import { ModelType } from "../../models/model_type.ts";
import { createDataId } from "../../data/data_id.ts";

function makeMethodContext(
  overrides: Partial<MethodReportContext> = {},
): MethodReportContext {
  return {
    scope: "method",
    repoDir: "/tmp/test-repo",
    // deno-lint-ignore no-explicit-any
    logger: {} as any,
    // deno-lint-ignore no-explicit-any
    dataRepository: {} as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType: ModelType.create("server"),
    modelId: "def-123",
    definition: {
      id: "def-123",
      name: "my-server",
      version: 1,
      tags: {},
    },
    globalArgs: {},
    methodArgs: {},
    methodName: "deploy",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
    ...overrides,
  };
}

Deno.test("methodSummaryReport: succeeded method with data handles shows narrative and pointers", async () => {
  const ctx = makeMethodContext({
    executionStatus: "succeeded",
    globalArgs: { region: "us-east-1" },
    methodArgs: { force: true },
    dataHandles: [
      {
        name: "output.json",
        specName: "output",
        kind: "file",
        dataId: createDataId("d-1"),
        version: 1,
        size: 256,
        tags: {},
        // deno-lint-ignore no-explicit-any
        metadata: {} as any,
      },
    ],
  });

  const result = await methodSummaryReport.execute(ctx);

  // Markdown checks: title, narrative, retrieval hint (compact for humans)
  assertStringIncludes(
    result.markdown,
    "# my-server (server) \u2192 deploy: succeeded",
  );
  assertStringIncludes(
    result.markdown,
    "deploy on my-server (server) succeeded, producing 1 file (output).",
  );
  assertStringIncludes(result.markdown, "## Data Output");
  assertStringIncludes(result.markdown, "| Name | Kind | Retrieval Command |");
  assertStringIncludes(
    result.markdown,
    "| **output.json** | file | `swamp data get my-server output.json --version 1` |",
  );
  // No schema in markdown — that's JSON-only for agents
  assertEquals(result.markdown.includes("## Output Schema"), false);

  // Arguments shown in markdown
  assertStringIncludes(result.markdown, "**Global Arguments**");
  assertStringIncludes(result.markdown, "**Method Arguments**");
  assertStringIncludes(result.markdown, '"region": "us-east-1"');
  assertStringIncludes(result.markdown, '"force": true');

  // JSON checks
  assertEquals(result.json.status, "succeeded");
  assertEquals(result.json.modelId, "def-123");
  assertEquals(result.json.modelName, "my-server");
  assertEquals(result.json.modelType, "server");
  assertEquals(result.json.methodName, "deploy");
  assertStringIncludes(
    result.json.narrative as string,
    "succeeded, producing 1 file (output)",
  );

  const items = result.json.dataProduced as Array<Record<string, unknown>>;
  assertEquals(items.length, 1);
  assertEquals(items[0].name, "output.json");
  assertEquals(items[0].kind, "file");
  assertEquals(items[0].specName, "output");
  assertEquals(
    items[0].retrievalCommand,
    "swamp data get my-server output.json --version 1",
  );
});

Deno.test("methodSummaryReport: failed method status", async () => {
  const ctx = makeMethodContext({ executionStatus: "failed" });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(
    result.markdown,
    "# my-server (server) \u2192 deploy: failed",
  );
  assertStringIncludes(
    result.markdown,
    "deploy on my-server (server) failed",
  );
  assertEquals(result.json.status, "failed");
});

Deno.test("methodSummaryReport: failed method with error message", async () => {
  const ctx = makeMethodContext({
    executionStatus: "failed",
    errorMessage: "Connection refused: could not reach server at 10.0.0.1:8080",
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(
    result.markdown,
    "# my-server (server) \u2192 deploy: failed",
  );
  assertStringIncludes(result.markdown, "## Error");
  assertStringIncludes(
    result.markdown,
    "Connection refused: could not reach server at 10.0.0.1:8080",
  );
  // Narrative includes error
  assertStringIncludes(
    result.markdown,
    "deploy on my-server (server) failed: Connection refused",
  );
  assertEquals(result.json.status, "failed");
  assertEquals(
    result.json.error,
    "Connection refused: could not reach server at 10.0.0.1:8080",
  );
});

Deno.test("methodSummaryReport: succeeded method has no error section", async () => {
  const ctx = makeMethodContext({ executionStatus: "succeeded" });

  const result = await methodSummaryReport.execute(ctx);

  assertEquals(result.markdown.includes("## Error"), false);
  assertEquals(result.json.error, undefined);
});

Deno.test("methodSummaryReport: empty dataHandles shows no data output", async () => {
  const ctx = makeMethodContext({ dataHandles: [] });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "succeeded with no data output.");
  assertEquals(result.markdown.includes("## Data Output"), false);
  assertEquals(result.json.dataProduced, []);
});

Deno.test("methodSummaryReport: output specs render schema section in markdown and JSON", async () => {
  const ctx = makeMethodContext({
    dataHandles: [
      {
        name: "episode-1",
        specName: "episodes",
        kind: "resource",
        dataId: createDataId("d-3"),
        version: 1,
        size: 512,
        tags: {},
        // deno-lint-ignore no-explicit-any
        metadata: {} as any,
      },
    ],
    outputSpecs: [
      {
        specName: "episodes",
        kind: "resource",
        description: "Anime episode listing",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            episode: { type: "number" },
            resolution: { type: "string" },
          },
        },
      },
      {
        specName: "logs",
        kind: "file",
        description: "Execution logs",
        contentType: "text/plain",
      },
    ],
  });

  const result = await methodSummaryReport.execute(ctx);

  // Schema NOT in markdown (compact for humans), only in JSON
  assertEquals(result.markdown.includes("## Output Schema"), false);
  assertEquals(result.markdown.includes("- title: string"), false);

  // JSON includes outputSpecs for agent retrieval
  const specs = result.json.outputSpecs as Array<Record<string, unknown>>;
  assertEquals(specs.length, 2);
  assertEquals(specs[0].specName, "episodes");
  assertEquals(specs[1].specName, "logs");
});

Deno.test("methodSummaryReport: no outputSpecs omits schema section", async () => {
  const ctx = makeMethodContext({});

  const result = await methodSummaryReport.execute(ctx);

  assertEquals(result.markdown.includes("## Output Schema"), false);
  assertEquals(result.json.outputSpecs, undefined);
});

Deno.test("methodSummaryReport: multiple data handles grouped by specName", async () => {
  const ctx = makeMethodContext({
    dataHandles: [
      {
        name: "item-1",
        specName: "items",
        kind: "resource",
        dataId: createDataId("d-4"),
        version: 1,
        size: 100,
        tags: {},
        // deno-lint-ignore no-explicit-any
        metadata: {} as any,
      },
      {
        name: "item-2",
        specName: "items",
        kind: "resource",
        dataId: createDataId("d-5"),
        version: 1,
        size: 200,
        tags: {},
        // deno-lint-ignore no-explicit-any
        metadata: {} as any,
      },
      {
        name: "log.txt",
        specName: "logs",
        kind: "file",
        dataId: createDataId("d-6"),
        version: 1,
        size: 50,
        tags: {},
        // deno-lint-ignore no-explicit-any
        metadata: {} as any,
      },
    ],
  });

  const result = await methodSummaryReport.execute(ctx);

  // Narrative mentions counts
  assertStringIncludes(result.markdown, "2 resources (items)");
  assertStringIncludes(result.markdown, "1 file (logs)");

  // Data output table with retrieval commands
  assertStringIncludes(result.markdown, "## Data Output");
  assertStringIncludes(
    result.markdown,
    "| **item-1** | resource | `swamp data get my-server item-1 --version 1` |",
  );
  assertStringIncludes(
    result.markdown,
    "| **item-2** | resource | `swamp data get my-server item-2 --version 1` |",
  );
  assertStringIncludes(
    result.markdown,
    "| **log.txt** | file | `swamp data get my-server log.txt --version 1` |",
  );

  // JSON dataProduced includes specName
  const items = result.json.dataProduced as Array<Record<string, unknown>>;
  assertEquals(items.length, 3);
  assertEquals(items[0].specName, "items");
  assertEquals(items[2].specName, "logs");
});

Deno.test("methodSummaryReport: both args empty shows 'No arguments.'", async () => {
  const ctx = makeMethodContext({
    globalArgs: {},
    methodArgs: {},
    dataHandles: [],
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "## Arguments");
  assertStringIncludes(result.markdown, "No arguments.");
  assertEquals(result.markdown.includes("**Global Arguments**"), false);
  assertEquals(result.markdown.includes("**Method Arguments**"), false);
  assertEquals(result.markdown.includes("```json\n{}"), false);

  // JSON still contains both fields
  assertEquals(result.json.globalArgs, {});
  assertEquals(result.json.methodArgs, {});
});

Deno.test("methodSummaryReport: only globalArgs populated omits method args section", async () => {
  const ctx = makeMethodContext({
    globalArgs: { region: "us-west-2" },
    methodArgs: {},
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "**Global Arguments**");
  assertStringIncludes(result.markdown, '"region": "us-west-2"');
  assertEquals(result.markdown.includes("**Method Arguments**"), false);
  assertEquals(result.markdown.includes("No arguments."), false);
});

Deno.test("methodSummaryReport: only methodArgs populated omits global args section", async () => {
  const ctx = makeMethodContext({
    globalArgs: {},
    methodArgs: { force: true },
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "**Method Arguments**");
  assertStringIncludes(result.markdown, '"force": true');
  assertEquals(result.markdown.includes("**Global Arguments**"), false);
  assertEquals(result.markdown.includes("No arguments."), false);
});

Deno.test("methodSummaryReport: JSON output structure matches expected shape", async () => {
  const ctx = makeMethodContext({
    dataHandles: [
      {
        name: "state.json",
        specName: "state",
        kind: "resource",
        dataId: createDataId("d-2"),
        version: 2,
        size: 1024,
        tags: {},
        // deno-lint-ignore no-explicit-any
        metadata: {} as any,
      },
    ],
  });

  const result = await methodSummaryReport.execute(ctx);
  const json = result.json;

  // Verify all expected keys exist
  const expectedKeys = [
    "status",
    "modelId",
    "modelName",
    "modelType",
    "methodName",
    "narrative",
    "globalArgs",
    "methodArgs",
    "dataProduced",
  ];
  assertEquals(Object.keys(json).sort(), expectedKeys.sort());

  // Verify dataProduced item shape
  const items = json.dataProduced as Array<Record<string, unknown>>;
  assertEquals(items.length, 1);
  assertEquals(
    Object.keys(items[0]).sort(),
    ["kind", "name", "retrievalCommand", "specName", "version"],
  );
});

Deno.test("methodSummaryReport: redactSensitiveArgs masks sensitive fields in markdown and JSON", async () => {
  const ctx = makeMethodContext({
    globalArgs: { region: "us-east-1", apiKey: "sk-secret-12345" },
    methodArgs: { target: "prod", password: "hunter2" },
    redactSensitiveArgs: (
      args: Record<string, unknown>,
      argsKind: "global" | "method",
    ): Record<string, unknown> => {
      const redacted = structuredClone(args);
      if (argsKind === "global" && "apiKey" in redacted) {
        redacted.apiKey = "***";
      }
      if (argsKind === "method" && "password" in redacted) {
        redacted.password = "***";
      }
      return redacted;
    },
  });

  const result = await methodSummaryReport.execute(ctx);

  // Markdown: sensitive values replaced with ***
  assertStringIncludes(result.markdown, '"apiKey": "***"');
  assertStringIncludes(result.markdown, '"password": "***"');
  // Non-sensitive values still present
  assertStringIncludes(result.markdown, '"region": "us-east-1"');
  assertStringIncludes(result.markdown, '"target": "prod"');
  // Original secrets must NOT appear
  assertEquals(result.markdown.includes("sk-secret-12345"), false);
  assertEquals(result.markdown.includes("hunter2"), false);

  // JSON: same redaction applied
  const globalArgs = result.json.globalArgs as Record<string, unknown>;
  assertEquals(globalArgs.apiKey, "***");
  assertEquals(globalArgs.region, "us-east-1");
  const methodArgs = result.json.methodArgs as Record<string, unknown>;
  assertEquals(methodArgs.password, "***");
  assertEquals(methodArgs.target, "prod");
});

Deno.test("methodSummaryReport: without redactSensitiveArgs, args render as-is", async () => {
  const ctx = makeMethodContext({
    globalArgs: { apiKey: "sk-secret-12345" },
    methodArgs: { password: "hunter2" },
  });

  const result = await methodSummaryReport.execute(ctx);

  // Without redaction, raw values appear
  assertStringIncludes(result.markdown, '"apiKey": "sk-secret-12345"');
  assertStringIncludes(result.markdown, '"password": "hunter2"');

  const globalArgs = result.json.globalArgs as Record<string, unknown>;
  assertEquals(globalArgs.apiKey, "sk-secret-12345");
  const methodArgs = result.json.methodArgs as Record<string, unknown>;
  assertEquals(methodArgs.password, "hunter2");
});
