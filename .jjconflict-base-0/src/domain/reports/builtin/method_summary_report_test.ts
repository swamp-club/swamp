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
    ...overrides,
  };
}

Deno.test("methodSummaryReport: succeeded method with args and data handles", async () => {
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

  // Markdown checks
  assertStringIncludes(
    result.markdown,
    "# my-server (server) \u2192 deploy: succeeded",
  );
  assertStringIncludes(result.markdown, "**Global Arguments**");
  assertStringIncludes(result.markdown, '"region": "us-east-1"');
  assertStringIncludes(result.markdown, "**Method Arguments**");
  assertStringIncludes(result.markdown, '"force": true');
  assertStringIncludes(result.markdown, "| **output.json** | file |");
  assertStringIncludes(
    result.markdown,
    "`swamp data get my-server output.json`",
  );

  // JSON checks
  assertEquals(result.json.status, "succeeded");
  assertEquals(result.json.modelId, "def-123");
  assertEquals(result.json.modelName, "my-server");
  assertEquals(result.json.modelType, "server");
  assertEquals(result.json.methodName, "deploy");
  assertEquals(result.json.globalArgs, { region: "us-east-1" });
  assertEquals(result.json.methodArgs, { force: true });
  assertEquals(result.json.dataProduced, [
    {
      name: "output.json",
      kind: "file",
      retrievalCommand: "swamp data get my-server output.json",
    },
  ]);
});

Deno.test("methodSummaryReport: failed method status", async () => {
  const ctx = makeMethodContext({ executionStatus: "failed" });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(
    result.markdown,
    "# my-server (server) \u2192 deploy: failed",
  );
  assertEquals(result.json.status, "failed");
});

Deno.test("methodSummaryReport: both args empty shows no arguments", async () => {
  const ctx = makeMethodContext({ globalArgs: {}, methodArgs: {} });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "No arguments.");
});

Deno.test("methodSummaryReport: only globalArgs present omits method section", async () => {
  const ctx = makeMethodContext({
    globalArgs: { env: "prod" },
    methodArgs: {},
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "**Global Arguments**");
  assertStringIncludes(result.markdown, '"env": "prod"');
  assertEquals(result.markdown.includes("**Method Arguments**"), false);
});

Deno.test("methodSummaryReport: only methodArgs present omits global section", async () => {
  const ctx = makeMethodContext({
    globalArgs: {},
    methodArgs: { count: 3 },
  });

  const result = await methodSummaryReport.execute(ctx);

  assertEquals(result.markdown.includes("**Global Arguments**"), false);
  assertStringIncludes(result.markdown, "**Method Arguments**");
  assertStringIncludes(result.markdown, '"count": 3');
});

Deno.test("methodSummaryReport: undefined globalArgs shows no arguments", async () => {
  const ctx = makeMethodContext({
    // deno-lint-ignore no-explicit-any
    globalArgs: undefined as any,
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "No arguments.");
  assertEquals(result.json.globalArgs, {});
});

Deno.test("methodSummaryReport: undefined methodArgs shows no arguments", async () => {
  const ctx = makeMethodContext({
    // deno-lint-ignore no-explicit-any
    methodArgs: undefined as any,
  });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "No arguments.");
  assertEquals(result.json.methodArgs, {});
});

Deno.test("methodSummaryReport: empty dataHandles shows no data output", async () => {
  const ctx = makeMethodContext({ dataHandles: [] });

  const result = await methodSummaryReport.execute(ctx);

  assertStringIncludes(result.markdown, "No data output.");
  assertEquals(result.json.dataProduced, []);
});

Deno.test("methodSummaryReport: JSON output structure matches expected shape", async () => {
  const ctx = makeMethodContext({
    globalArgs: { env: "prod" },
    methodArgs: { count: 3 },
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
    ["kind", "name", "retrievalCommand"],
  );
});

Deno.test("methodSummaryReport: redactSensitiveArgs redacts sensitive fields in markdown and JSON", async () => {
  const ctx = makeMethodContext({
    globalArgs: { region: "us-east-1", apiKey: "secret-key-123" },
    methodArgs: { target: "prod", password: "hunter2" },
    redactSensitiveArgs: (
      args: Record<string, unknown>,
      argsKind: "global" | "method",
    ) => {
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

  // Markdown: sensitive values redacted, non-sensitive pass through
  assertStringIncludes(result.markdown, '"region": "us-east-1"');
  assertStringIncludes(result.markdown, '"apiKey": "***"');
  assertStringIncludes(result.markdown, '"target": "prod"');
  assertStringIncludes(result.markdown, '"password": "***"');

  // JSON: same redaction
  const globalArgs = result.json.globalArgs as Record<string, unknown>;
  assertEquals(globalArgs.region, "us-east-1");
  assertEquals(globalArgs.apiKey, "***");
  const methodArgs = result.json.methodArgs as Record<string, unknown>;
  assertEquals(methodArgs.target, "prod");
  assertEquals(methodArgs.password, "***");
});

Deno.test("methodSummaryReport: without redactSensitiveArgs, args render as-is", async () => {
  const ctx = makeMethodContext({
    globalArgs: { apiKey: "secret-key-123" },
    methodArgs: { password: "hunter2" },
  });

  const result = await methodSummaryReport.execute(ctx);

  // Without redactSensitiveArgs, values pass through unchanged
  assertStringIncludes(result.markdown, '"apiKey": "secret-key-123"');
  assertStringIncludes(result.markdown, '"password": "hunter2"');
  assertEquals(
    (result.json.globalArgs as Record<string, unknown>).apiKey,
    "secret-key-123",
  );
  assertEquals(
    (result.json.methodArgs as Record<string, unknown>).password,
    "hunter2",
  );
});
