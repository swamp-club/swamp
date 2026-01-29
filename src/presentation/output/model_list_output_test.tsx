// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  type ModelListData,
  type ModelListItem,
  ModelListUI,
  renderModelList,
} from "./model_list_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testModels: ModelListItem[] = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-echo-1",
    type: "swamp/echo",
  },
  {
    id: "660e8400-e29b-41d4-a716-446655440001",
    name: "test-echo-2",
    type: "swamp/echo",
    resourceId: "770e8400-e29b-41d4-a716-446655440002",
  },
];

const testData: ModelListData = {
  query: "",
  results: testModels,
};

Deno.test({
  name: "ModelListUI renders search prompt",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelListUI
        models={testModels}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Search:");
  },
});

Deno.test({
  name: "ModelListUI renders model names",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelListUI
        models={testModels}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-echo-1");
    assertStringIncludes(output, "test-echo-2");
  },
});

Deno.test({
  name: "ModelListUI renders model types",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelListUI
        models={testModels}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "swamp/echo");
  },
});

Deno.test({
  name: "ModelListUI renders results count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelListUI
        models={testModels}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "2 / 2 models");
  },
});

Deno.test({
  name: "ModelListUI renders help text",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelListUI
        models={testModels}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Navigate");
    assertStringIncludes(output, "Select");
    assertStringIncludes(output, "Cancel");
  },
});

Deno.test({
  name: "ModelListUI shows no results message when empty",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelListUI
        models={[]}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "No matching models found");
  },
});

Deno.test("renderModelList with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelList(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.query, "");
    assertEquals(parsed.results.length, 2);
    assertEquals(parsed.results[0].name, "test-echo-1");
    assertEquals(parsed.results[1].name, "test-echo-2");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelList with json mode includes resourceId when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelList(testData, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.results[0].resourceId, undefined);
    assertEquals(
      parsed.results[1].resourceId,
      "770e8400-e29b-41d4-a716-446655440002",
    );
  } finally {
    console.log = originalLog;
  }
});
