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
  type ExtensionSearchData,
  type ExtensionSearchResultItem,
  ExtensionSearchUI,
  renderExtensionSearch,
} from "./extension_search_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testExtensions: ExtensionSearchResultItem[] = [
  {
    name: "@stack72/aws-vpc",
    description: "Manage AWS VPCs",
    latestVersion: "2026.03.01.1",
    platforms: ["aws"],
    labels: ["networking", "infrastructure"],
    contentTypes: ["models"],
    createdAt: "2026-02-15T10:00:00Z",
    updatedAt: "2026-03-01T12:00:00Z",
  },
  {
    name: "@stack72/docker-compose",
    description: "Docker Compose management",
    latestVersion: "2026.02.28.1",
    platforms: ["docker"],
    labels: ["containers"],
    contentTypes: ["models", "workflows"],
    createdAt: "2026-02-10T10:00:00Z",
    updatedAt: "2026-02-28T12:00:00Z",
  },
  {
    name: "@example/k8s-deploy",
    description: "Kubernetes deployment automation",
    latestVersion: "2026.01.15.1",
    platforms: ["kubernetes"],
    labels: ["deploy", "containers"],
    contentTypes: [],
    createdAt: "2026-01-10T10:00:00Z",
    updatedAt: "2026-01-15T12:00:00Z",
  },
];

const testMeta = { total: 3, page: 1, perPage: 20 };

Deno.test({
  name: "ExtensionSearchUI renders filter prompt",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "Filter:");
  },
});

Deno.test({
  name: "ExtensionSearchUI renders extension count",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "3 / 3 extensions");
  },
});

Deno.test({
  name: "ExtensionSearchUI renders all extensions when no filter",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "@stack72/aws-vpc");
    assertStringIncludes(output, "@stack72/docker-compose");
    assertStringIncludes(output, "@example/k8s-deploy");
  },
});

Deno.test({
  name: "ExtensionSearchUI renders pagination info",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={{ total: 50, page: 2, perPage: 20 }}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "Page 2");
    assertStringIncludes(output, "50 total");
  },
});

Deno.test({
  name: "ExtensionSearchUI shows version info",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "v2026.03.01.1");
  },
});

Deno.test({
  name: "ExtensionSearchUI shows labels",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "networking, infrastructure");
  },
});

Deno.test({
  name: "ExtensionSearchUI first item is selected by default",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "▶ @stack72/aws-vpc");
  },
});

Deno.test({
  name: "ExtensionSearchUI renders help text",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={testExtensions}
        meta={testMeta}
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
  name: "ExtensionSearchUI shows no results message when empty",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={[]}
        meta={{ total: 0, page: 1, perPage: 20 }}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "No matching extensions found");
  },
});

Deno.test({
  name: "ExtensionSearchUI shows scroll indicator for many results",
  ...inkTestOptions,
  fn: () => {
    const manyExtensions: ExtensionSearchResultItem[] = Array.from(
      { length: 15 },
      (_, i) => ({
        name: `@ns/ext-${String(i).padStart(2, "0")}`,
        description: `Extension ${i}`,
        latestVersion: "1.0.0",
        platforms: [],
        labels: [],
        contentTypes: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );

    const { lastFrame } = render(
      <ExtensionSearchUI
        extensions={manyExtensions}
        meta={{ total: 15, page: 1, perPage: 20 }}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "5 more below");
  },
});

Deno.test("renderExtensionSearch with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const data: ExtensionSearchData = {
    extensions: testExtensions,
    meta: testMeta,
  };

  try {
    renderExtensionSearch(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions.length, 3);
    assertEquals(parsed.extensions[0].name, "@stack72/aws-vpc");
    assertEquals(parsed.meta.total, 3);
    assertEquals(parsed.meta.page, 1);
    assertEquals(parsed.meta.perPage, 20);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderExtensionSearch with json mode omits empty platforms and labels", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const data: ExtensionSearchData = {
    extensions: [{
      name: "@keeb/terraria",
      description: "Terraria server control via Docker tmux",
      latestVersion: "2026.02.27.1",
      platforms: [],
      labels: [],
      contentTypes: [],
      createdAt: "2026-02-27T17:06:27.544Z",
      updatedAt: "2026-02-27T17:06:27.544Z",
    }],
    meta: { total: 1, page: 1, perPage: 20 },
  };

  try {
    renderExtensionSearch(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions[0].name, "@keeb/terraria");
    assertEquals(parsed.extensions[0].platforms, undefined);
    assertEquals(parsed.extensions[0].labels, undefined);
    assertEquals(parsed.extensions[0].contentTypes, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderExtensionSearch with json mode includes contentTypes when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const data: ExtensionSearchData = {
    extensions: [testExtensions[0]],
    meta: { total: 1, page: 1, perPage: 20 },
  };

  try {
    renderExtensionSearch(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions[0].contentTypes, ["models"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderExtensionSearch with json mode keeps non-empty platforms and labels", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const data: ExtensionSearchData = {
    extensions: [testExtensions[0]],
    meta: { total: 1, page: 1, perPage: 20 },
  };

  try {
    renderExtensionSearch(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions[0].platforms, ["aws"]);
    assertEquals(parsed.extensions[0].labels, ["networking", "infrastructure"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderExtensionSearch with json mode includes meta", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  const data: ExtensionSearchData = {
    extensions: [testExtensions[0]],
    meta: { total: 100, page: 5, perPage: 10 },
  };

  try {
    renderExtensionSearch(data, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.meta.total, 100);
    assertEquals(parsed.meta.page, 5);
    assertEquals(parsed.meta.perPage, 10);
  } finally {
    console.log = originalLog;
  }
});
