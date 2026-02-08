// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  type ModelEditData,
  ModelEditDisplay,
  renderModelEdit,
} from "./model_edit_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testInputData: ModelEditData = {
  path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  editor: "VS Code",
  status: "opened",
  name: "test-echo",
  type: "swamp/echo",
  editType: "input",
};

const testResourceData: ModelEditData = {
  path: "resources/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  editor: "VS Code",
  status: "opened",
  name: "test-echo",
  type: "swamp/echo",
  editType: "resource",
};

Deno.test({
  name: "ModelEditDisplay renders all fields for input",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelEditDisplay {...testInputData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-echo");
    assertStringIncludes(output, "swamp/echo");
    assertStringIncludes(output, "VS Code");
    assertStringIncludes(output, "input file");
    assertStringIncludes(
      output,
      "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
    );
  },
});

Deno.test({
  name: "ModelEditDisplay renders resource type correctly",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelEditDisplay {...testResourceData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "resource file");
  },
});

Deno.test({
  name: "ModelEditDisplay shows 'Opening' message",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelEditDisplay {...testInputData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Opening");
  },
});

Deno.test("renderModelEdit with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelEdit(testInputData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.path, testInputData.path);
    assertEquals(parsed.editor, testInputData.editor);
    assertEquals(parsed.status, testInputData.status);
    assertEquals(parsed.name, testInputData.name);
    assertEquals(parsed.type, testInputData.type);
    assertEquals(parsed.editType, testInputData.editType);
  } finally {
    console.log = originalLog;
  }
});

Deno.test({
  name: "ModelEditDisplay shows 'Updated' message for updated status",
  ...inkTestOptions,
  fn: () => {
    const updatedData: ModelEditData = {
      path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
      status: "updated",
      name: "test-echo",
      type: "swamp/echo",
      editType: "definition",
    };
    const { lastFrame } = render(<ModelEditDisplay {...updatedData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "Updated definition from stdin");
  },
});

Deno.test(
  "renderModelEdit with json mode outputs valid JSON for updated status",
  () => {
    const updatedData: ModelEditData = {
      path: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
      status: "updated",
      name: "test-echo",
      type: "swamp/echo",
      editType: "definition",
    };
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderModelEdit(updatedData, "json");
      assertEquals(logs.length, 1);
      const parsed = JSON.parse(logs[0]);
      assertEquals(parsed.path, updatedData.path);
      assertEquals(parsed.status, "updated");
      assertEquals(parsed.name, updatedData.name);
      assertEquals(parsed.type, updatedData.type);
      assertEquals(parsed.editType, updatedData.editType);
      assertEquals(parsed.editor, undefined);
    } finally {
      console.log = originalLog;
    }
  },
);
