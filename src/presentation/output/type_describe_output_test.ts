import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderTypeDescribe,
  type TypeDescribeData,
} from "./type_describe_output.ts";

await initializeLogging({});

const testData: TypeDescribeData = {
  type: {
    raw: "swamp/echo",
    normalized: "swamp/echo",
  },
  version: 1,
  inputAttributesSchema: {
    type: "object",
    properties: {
      message: { type: "string", minLength: 1 },
    },
    required: ["message"],
  },
  methods: [
    {
      name: "write",
      description:
        "Write the definition message to a data artifact with a timestamp",
      inputAttributesSchema: {
        type: "object",
        properties: {
          message: { type: "string", minLength: 1 },
        },
        required: ["message"],
      },
    },
  ],
};

Deno.test("renderTypeDescribe with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderTypeDescribe(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.type.raw, testData.type.raw);
    assertEquals(parsed.type.normalized, testData.type.normalized);
    assertEquals(parsed.version, testData.version);
    assertEquals(parsed.methods.length, 1);
    assertEquals(parsed.methods[0].name, "write");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderTypeDescribe with log mode does not throw", () => {
  renderTypeDescribe(testData, "log");
});
