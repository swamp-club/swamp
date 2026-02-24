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
  type ModelSearchData,
  type ModelSearchItem,
  ModelSearchUI,
  renderModelSearch,
} from "./model_search_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testModels: ModelSearchItem[] = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test-echo-1",
    type: "swamp/echo",
  },
  {
    id: "660e8400-e29b-41d4-a716-446655440001",
    name: "test-echo-2",
    type: "swamp/echo",
  },
];

const testData: ModelSearchData = {
  query: "",
  results: testModels,
};

Deno.test({
  name: "ModelSearchUI renders search prompt",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
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
  name: "ModelSearchUI renders model names",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
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
  name: "ModelSearchUI renders model types",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
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
  name: "ModelSearchUI renders results count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
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
  name: "ModelSearchUI renders help text",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
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
  name: "ModelSearchUI shows no results message when empty",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
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

Deno.test("renderModelSearch with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelSearch(testData, "json");
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

// Additional interaction tests
// Note: ink-testing-library has limited support for keyboard events in Deno.
// Special keys (arrows, Enter, Escape) don't trigger useInput callbacks reliably.
// These tests verify the behavior that works reliably using initialQuery.

Deno.test({
  name: "ModelSearchUI first item is selected by default",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
        models={testModels}
        initialQuery=""
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // First item should have the selection indicator
    assertStringIncludes(output, "> test-echo-1");
  },
});

Deno.test({
  name: "ModelSearchUI renders initial query",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
        models={testModels}
        initialQuery="test-echo"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // The search box should show the initial query
    assertStringIncludes(output, "Search:");
    assertStringIncludes(output, "test-echo");
  },
});

Deno.test({
  name: "ModelSearchUI initial query filters results",
  ...inkTestOptions,
  fn: () => {
    const models: ModelSearchItem[] = [
      { id: "1", name: "alpha-server", type: "swamp/echo" },
      { id: "2", name: "beta-database", type: "swamp/echo" },
      { id: "3", name: "gamma-server", type: "swamp/echo" },
    ];

    const { lastFrame } = render(
      <ModelSearchUI
        models={models}
        initialQuery="server"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should show filtered count
    assertStringIncludes(output, "2 / 3 models");
  },
});

Deno.test({
  name: "ModelSearchUI shows selection indicator on first matching item",
  ...inkTestOptions,
  fn: () => {
    const models: ModelSearchItem[] = [
      { id: "1", name: "alpha-server", type: "swamp/echo" },
      { id: "2", name: "beta-database", type: "swamp/echo" },
      { id: "3", name: "gamma-server", type: "swamp/echo" },
    ];

    const { lastFrame } = render(
      <ModelSearchUI
        models={models}
        initialQuery="database"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // beta-database should be selected (only match)
    assertStringIncludes(output, "> beta-database");
  },
});

Deno.test({
  name: "ModelSearchUI fuzzy matches on model name",
  ...inkTestOptions,
  fn: () => {
    const models: ModelSearchItem[] = [
      { id: "1", name: "production-api", type: "swamp/echo" },
      { id: "2", name: "staging-api", type: "swamp/echo" },
      { id: "3", name: "development-db", type: "swamp/database" },
    ];

    const { lastFrame } = render(
      <ModelSearchUI
        models={models}
        initialQuery="api"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should match models with "api" in name
    assertStringIncludes(output, "2 / 3 models");
  },
});

Deno.test({
  name: "ModelSearchUI fuzzy matches on model type",
  ...inkTestOptions,
  fn: () => {
    const models: ModelSearchItem[] = [
      { id: "1", name: "server-1", type: "swamp/echo" },
      { id: "2", name: "server-2", type: "swamp/database" },
    ];

    const { lastFrame } = render(
      <ModelSearchUI
        models={models}
        initialQuery="database"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // Should match by type
    assertStringIncludes(output, "1 / 2 models");
  },
});

Deno.test({
  name: "ModelSearchUI handles empty query after filtering",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelSearchUI
        models={testModels}
        initialQuery="nonexistent"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );

    const output = lastFrame() ?? "";
    // No matches
    assertStringIncludes(output, "0 / 2 models");
    assertStringIncludes(output, "No matching models found");
  },
});
