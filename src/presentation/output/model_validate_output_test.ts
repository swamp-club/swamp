import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  type ModelValidateData,
  renderModelValidate,
  renderModelValidateAll,
} from "./model_validate_output.ts";

await initializeLogging({});

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

Deno.test("renderModelValidate with log mode does not throw", () => {
  renderModelValidate(allPassingData, "log");
});

Deno.test("renderModelValidateAll with log mode does not throw", () => {
  renderModelValidateAll(multiModelData, "log");
});
