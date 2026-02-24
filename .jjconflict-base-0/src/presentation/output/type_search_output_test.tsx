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

// Additional interaction tests
// Note: ink-testing-library has limited support for keyboard events in Deno.
// Special keys (arrows, Enter, Escape) don't trigger useInput callbacks reliably.
// These tests verify the behavior that works reliably using initialQuery.

Deno.test({
  name: "TypeSearchUI first item is selected by default",
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
    // First item should have the selection indicator
    assertStringIncludes(output, "▶ swamp/echo");
  },
});

Deno.test({
  name: "TypeSearchUI initial query filters results",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="ec2"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should show filtered count
    assertStringIncludes(output, "1 / 3 types");
  },
});

Deno.test({
  name: "TypeSearchUI shows selection indicator on first matching item",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="docker"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // docker/run should be selected (only match)
    assertStringIncludes(output, "▶ docker/run");
  },
});

Deno.test({
  name: "TypeSearchUI fuzzy matches on normalized name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="vpc"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should match aws/ec2/vpc
    assertStringIncludes(output, "1 / 3 types");
    assertStringIncludes(output, "▶ aws/ec2/vpc");
  },
});

Deno.test({
  name: "TypeSearchUI fuzzy matches on raw name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="AWS"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should match AWS::EC2::VPC by raw name
    assertStringIncludes(output, "1 / 3 types");
  },
});

Deno.test({
  name: "TypeSearchUI handles no matches",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="nonexistent"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // No matches
    assertStringIncludes(output, "0 / 3 types");
    assertStringIncludes(output, "No matching types found");
  },
});

Deno.test({
  name: "TypeSearchUI limits visible results",
  ...inkTestOptions,
  fn: () => {
    // Create more than 10 types to test the limit
    const manyTypes: TypeSearchItem[] = Array.from({ length: 15 }, (_, i) => ({
      raw: `type-${i}`,
      normalized: `type-${i}`,
    }));

    const { lastFrame } = render(
      <TypeSearchUI
        types={manyTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should show "more below" message when there are hidden results
    assertStringIncludes(output, "15 / 15 types");
    assertStringIncludes(output, "more below");
  },
});

Deno.test({
  name: "TypeSearchUI partial matching",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <TypeSearchUI
        types={testTypes}
        initialQuery="swamp"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should match swamp/echo with partial query
    assertStringIncludes(output, "1 / 3 types");
  },
});

// Scrolling behavior tests
Deno.test({
  name: "TypeSearchUI does not show scroll indicators when all items visible",
  ...inkTestOptions,
  fn: () => {
    const fewTypes: TypeSearchItem[] = Array.from({ length: 5 }, (_, i) => ({
      raw: `type-${i}`,
      normalized: `type-${i}`,
    }));

    const { lastFrame } = render(
      <TypeSearchUI
        types={fewTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should not show "more above" or "more below"
    assertEquals(output.includes("more above"), false);
    assertEquals(output.includes("more below"), false);
  },
});

Deno.test({
  name: "TypeSearchUI shows correct count for items below visible window",
  ...inkTestOptions,
  fn: () => {
    // Create 15 types, window shows 10, so 5 should be "more below"
    const manyTypes: TypeSearchItem[] = Array.from({ length: 15 }, (_, i) => ({
      raw: `type-${String(i).padStart(2, "0")}`,
      normalized: `type-${String(i).padStart(2, "0")}`,
    }));

    const { lastFrame } = render(
      <TypeSearchUI
        types={manyTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should show "5 more below" (15 total - 10 visible = 5)
    assertStringIncludes(output, "5 more below");
    // Should not show "more above" when at start
    assertEquals(output.includes("more above"), false);
  },
});

Deno.test({
  name: "TypeSearchUI shows first 10 items when list exceeds limit",
  ...inkTestOptions,
  fn: () => {
    const manyTypes: TypeSearchItem[] = Array.from({ length: 15 }, (_, i) => ({
      raw: `type-${String(i).padStart(2, "0")}`,
      normalized: `type-${String(i).padStart(2, "0")}`,
    }));

    const { lastFrame } = render(
      <TypeSearchUI
        types={manyTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // First item should be visible and selected
    assertStringIncludes(output, "type-00");
    // Item 9 (index 9) should be visible
    assertStringIncludes(output, "type-09");
    // Item 10 (index 10) should NOT be visible (it's hidden)
    assertEquals(output.includes("type-10"), false);
  },
});

Deno.test({
  name: "TypeSearchUI handles exactly 10 items without scroll indicators",
  ...inkTestOptions,
  fn: () => {
    const exactTypes: TypeSearchItem[] = Array.from({ length: 10 }, (_, i) => ({
      raw: `type-${i}`,
      normalized: `type-${i}`,
    }));

    const { lastFrame } = render(
      <TypeSearchUI
        types={exactTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // All 10 items should be visible
    assertStringIncludes(output, "10 / 10 types");
    // No scroll indicators needed
    assertEquals(output.includes("more above"), false);
    assertEquals(output.includes("more below"), false);
  },
});

Deno.test({
  name: "TypeSearchUI handles exactly 11 items with scroll indicator",
  ...inkTestOptions,
  fn: () => {
    const elevenTypes: TypeSearchItem[] = Array.from(
      { length: 11 },
      (_, i) => ({
        raw: `type-${String(i).padStart(2, "0")}`,
        normalized: `type-${String(i).padStart(2, "0")}`,
      }),
    );

    const { lastFrame } = render(
      <TypeSearchUI
        types={elevenTypes}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should show 11 total types
    assertStringIncludes(output, "11 / 11 types");
    // Should show "1 more below"
    assertStringIncludes(output, "1 more below");
  },
});
