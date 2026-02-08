// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  ModelValidateAllDisplay,
  type ModelValidateData,
  ModelValidateDisplay,
  renderModelValidate,
  renderModelValidateAll,
} from "./model_validate_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const allPassingData: ModelValidateData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "swamp/echo",
  validations: [
    { name: "Input schema", passed: true },
    { name: "Input attributes", passed: true },
    { name: "Resource schema", passed: true },
    { name: "Resource attributes", passed: true },
  ],
  passed: true,
};

const mixedResultsData: ModelValidateData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "swamp/echo",
  validations: [
    { name: "Input schema", passed: true },
    { name: "Input attributes", passed: true },
    { name: "Resource schema", passed: true },
    {
      name: "Resource attributes",
      passed: false,
      error: 'Expected string, received number at "message"',
    },
  ],
  passed: false,
};

const inputOnlyData: ModelValidateData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "swamp/echo",
  validations: [
    { name: "Input schema", passed: true },
    { name: "Input attributes", passed: true },
  ],
  passed: true,
};

Deno.test({
  name: "ModelValidateDisplay renders model name and type",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelValidateDisplay {...allPassingData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-model");
    assertStringIncludes(output, "swamp/echo");
  },
});

Deno.test({
  name: "ModelValidateDisplay renders checkmarks for passing validations",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelValidateDisplay {...allPassingData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "\u2713");
    assertStringIncludes(output, "Input schema");
    assertStringIncludes(output, "Input attributes");
  },
});

Deno.test({
  name: "ModelValidateDisplay renders X for failing validations",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateDisplay {...mixedResultsData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "\u2717");
    assertStringIncludes(output, "Resource attributes");
  },
});

Deno.test({
  name: "ModelValidateDisplay shows error message for failed validation",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateDisplay {...mixedResultsData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Expected string, received number");
    assertStringIncludes(output, "\u2192");
  },
});

Deno.test({
  name: "ModelValidateDisplay shows summary count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateDisplay {...mixedResultsData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "3/4 validations passed");
  },
});

Deno.test({
  name: "ModelValidateDisplay shows PASSED for all passing",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelValidateDisplay {...allPassingData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "PASSED");
  },
});

Deno.test({
  name: "ModelValidateDisplay shows FAILED when any validation fails",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateDisplay {...mixedResultsData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "FAILED");
  },
});

Deno.test({
  name: "ModelValidateDisplay works with input-only validations",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelValidateDisplay {...inputOnlyData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "2/2 validations passed");
    assertStringIncludes(output, "PASSED");
  },
});

Deno.test("renderModelValidate with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelValidate(allPassingData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, allPassingData.modelId);
    assertEquals(parsed.modelName, allPassingData.modelName);
    assertEquals(parsed.type, allPassingData.type);
    assertEquals(parsed.validations.length, 4);
    assertEquals(parsed.passed, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelValidate JSON includes error messages", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelValidate(mixedResultsData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.passed, false);

    const failedValidation = parsed.validations.find(
      (v: { passed: boolean }) => !v.passed,
    );
    assertEquals(failedValidation.name, "Resource attributes");
    assertEquals(
      failedValidation.error,
      'Expected string, received number at "message"',
    );
  } finally {
    console.log = originalLog;
  }
});

// Multi-model output tests

const multiModelData: ModelValidateData[] = [
  {
    modelId: "550e8400-e29b-41d4-a716-446655440001",
    modelName: "model-1",
    type: "swamp/echo",
    validations: [
      { name: "Input schema", passed: true },
      { name: "Input attributes", passed: true },
    ],
    passed: true,
  },
  {
    modelId: "550e8400-e29b-41d4-a716-446655440002",
    modelName: "model-2",
    type: "swamp/echo",
    validations: [
      { name: "Input schema", passed: true },
      {
        name: "Input attributes",
        passed: false,
        error: 'Required at "message"',
      },
    ],
    passed: false,
  },
];

const allPassingMultiModelData: ModelValidateData[] = [
  {
    modelId: "550e8400-e29b-41d4-a716-446655440001",
    modelName: "model-1",
    type: "swamp/echo",
    validations: [
      { name: "Input schema", passed: true },
      { name: "Input attributes", passed: true },
    ],
    passed: true,
  },
  {
    modelId: "550e8400-e29b-41d4-a716-446655440002",
    modelName: "model-2",
    type: "swamp/echo",
    validations: [
      { name: "Input schema", passed: true },
      { name: "Input attributes", passed: true },
    ],
    passed: true,
  },
];

Deno.test({
  name: "ModelValidateAllDisplay renders all model names",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateAllDisplay
        models={multiModelData}
        totalPassed={1}
        totalFailed={1}
        passed={false}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "model-1");
    assertStringIncludes(output, "model-2");
  },
});

Deno.test({
  name: "ModelValidateAllDisplay shows validating all models header",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateAllDisplay
        models={multiModelData}
        totalPassed={1}
        totalFailed={1}
        passed={false}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Validating all models...");
  },
});

Deno.test({
  name: "ModelValidateAllDisplay shows model summary count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateAllDisplay
        models={multiModelData}
        totalPassed={1}
        totalFailed={1}
        passed={false}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "1/2 models passed");
  },
});

Deno.test({
  name: "ModelValidateAllDisplay shows Overall FAILED when any model fails",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateAllDisplay
        models={multiModelData}
        totalPassed={1}
        totalFailed={1}
        passed={false}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Overall:");
    assertStringIncludes(output, "FAILED");
  },
});

Deno.test({
  name: "ModelValidateAllDisplay shows Overall PASSED when all models pass",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateAllDisplay
        models={allPassingMultiModelData}
        totalPassed={2}
        totalFailed={0}
        passed
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "2/2 models passed");
    assertStringIncludes(output, "Overall:");
    assertStringIncludes(output, "PASSED");
  },
});

Deno.test({
  name: "ModelValidateAllDisplay shows error messages for failing validations",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelValidateAllDisplay
        models={multiModelData}
        totalPassed={1}
        totalFailed={1}
        passed={false}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, 'Required at "message"');
  },
});

Deno.test("renderModelValidateAll with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelValidateAll(multiModelData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.models.length, 2);
    assertEquals(parsed.totalPassed, 1);
    assertEquals(parsed.totalFailed, 1);
    assertEquals(parsed.passed, false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelValidateAll JSON includes all model data", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelValidateAll(multiModelData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);

    assertEquals(parsed.models[0].modelName, "model-1");
    assertEquals(parsed.models[0].passed, true);
    assertEquals(parsed.models[1].modelName, "model-2");
    assertEquals(parsed.models[1].passed, false);

    const failedValidation = parsed.models[1].validations.find(
      (v: { passed: boolean }) => !v.passed,
    );
    assertEquals(failedValidation.error, 'Required at "message"');
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelValidateAll JSON shows passed true when all pass", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelValidateAll(allPassingMultiModelData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.totalPassed, 2);
    assertEquals(parsed.totalFailed, 0);
    assertEquals(parsed.passed, true);
  } finally {
    console.log = originalLog;
  }
});
