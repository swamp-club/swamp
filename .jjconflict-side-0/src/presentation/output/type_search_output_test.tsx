// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  renderTypeSearch,
  type TypeSearchData,
  type TypeSearchItem,
  TypeSearchUI,
} from "./type_search_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testTypes: TypeSearchItem[] = [
  { raw: "swamp/echo", normalized: "swamp/echo" },
  { raw: "AWS::EC2::VPC", normalized: "aws/ec2/vpc" },
  { raw: "docker run", normalized: "docker/run" },
];

const testData: TypeSearchData = {
  query: "",
  results: testTypes,
};

Deno.test({
  name: "TypeSearchUI renders search prompt",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
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
  name: "TypeSearchUI renders type count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "3 / 3 types");
  },
});

Deno.test({
  name: "TypeSearchUI renders all types when no query",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "swamp/echo");
    assertStringIncludes(output, "aws/ec2/vpc");
    assertStringIncludes(output, "docker/run");
  },
});

Deno.test({
  name: "TypeSearchUI renders initial query",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="echo"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "echo");
  },
});

Deno.test({
  name: "TypeSearchUI shows raw name when different from normalized",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    // aws/ec2/vpc should show (AWS::EC2::VPC)
    assertStringIncludes(output, "(AWS::EC2::VPC)");
    // docker/run should show (docker run)
    assertStringIncludes(output, "(docker run)");
  },
});

Deno.test({
  name: "TypeSearchUI renders help text",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
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
  name: "TypeSearchUI shows no results message when empty",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={[]}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "No matching types found");
  },
});

Deno.test("renderTypeSearch with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderTypeSearch(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.query, "");
    assertEquals(parsed.results.length, 3);
    assertEquals(parsed.results[0].raw, "swamp/echo");
    assertEquals(parsed.results[0].normalized, "swamp/echo");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderTypeSearch with json mode includes query", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const dataWithQuery: TypeSearchData = {
    query: "echo",
    results: [{ raw: "swamp/echo", normalized: "swamp/echo" }],
  };

  try {
    renderTypeSearch(dataWithQuery, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.query, "echo");
    assertEquals(parsed.results.length, 1);
  } finally {
    console.log = originalLog;
  }
});
