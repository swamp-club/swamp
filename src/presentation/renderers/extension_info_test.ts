// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import {
  consumeStream,
  type ExtensionContentMetadata,
  type ExtensionInfoData,
  type ExtensionInfoEvent,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createExtensionInfoRenderer } from "./extension_info.ts";

function makeInfoData(
  overrides?: Partial<ExtensionInfoData>,
): ExtensionInfoData {
  return {
    id: "abc123",
    name: "@stack72/aws-ec2",
    namespace: "@stack72",
    description: "AWS EC2 model for swamp",
    repository: "https://github.com/stack72/swamp-aws-ec2",
    homepageUrl: "https://example.com",
    license: "MIT",
    platforms: ["aws"],
    labels: ["networking", "compute"],
    contentTypes: ["models"],
    contentNames: ["aws-ec2"],
    latestVersion: "2026.5.1",
    latestRc: null,
    latestBeta: null,
    author: { username: "stack72", displayName: "Paul Stack" },
    createdAt: "2026-01-15T10:30:00.000Z",
    updatedAt: "2026-05-20T14:22:00.000Z",
    yankedAt: null,
    yankReason: null,
    deprecatedAt: null,
    deprecatedByUserId: null,
    deprecationReason: null,
    supersededBy: null,
    repositoryVerified: true,
    repositoryVerifiedAt: "2026-05-20T14:25:00.000Z",
    repositoryVerifiedUrl: "https://github.com/stack72/swamp-aws-ec2",
    pullCount: 142,
    score: { percentage: 85, grade: "A" },
    contentMetadata: null,
    dependencies: [],
    ...overrides,
  };
}

const sampleContentMetadata: ExtensionContentMetadata = {
  models: [
    {
      fileName: "volume.ts",
      type: "@swamp/aws/ec2/volume",
      version: "2026.5.1",
      globalArguments: [
        {
          name: "region",
          type: "string",
          description: "AWS region",
          required: true,
        },
      ],
      methods: [
        { name: "get", description: "Get a volume", arguments: [] },
        {
          name: "sync",
          description: "Sync volume state",
          arguments: [
            {
              name: "force",
              type: "boolean",
              description: "Force sync",
              required: false,
            },
          ],
        },
      ],
      resources: [],
      files: [],
    },
    {
      fileName: "instance.ts",
      type: "@swamp/aws/ec2/instance",
      version: "2026.5.1",
      globalArguments: [],
      methods: [
        { name: "get", description: "Get an instance", arguments: [] },
        { name: "sync", description: "Sync instance state", arguments: [] },
        {
          name: "terminate",
          description: "Terminate an instance",
          arguments: [],
        },
      ],
      resources: [],
      files: [],
    },
  ],
  extensions: [],
  workflows: [],
  vaults: [],
  drivers: [],
  datastores: [],
  reports: [],
  skills: [],
};

const sampleContentMetadataWithExtensions: ExtensionContentMetadata = {
  ...sampleContentMetadata,
  extensions: [
    {
      fileName: "grafana_ext.ts",
      extendsType: "@keeb/grafana/instance",
      methods: [
        {
          name: "queryLogs",
          description: "Query Grafana Loki logs",
          arguments: [
            {
              name: "query",
              type: "string",
              description: "LogQL query",
              required: true,
            },
          ],
        },
      ],
      resources: [],
    },
  ],
};

async function* toStream(
  events: ExtensionInfoEvent[],
): AsyncGenerator<ExtensionInfoEvent> {
  for (const e of events) yield e;
}

Deno.test("LogExtensionInfoRenderer: completed event runs without error", async () => {
  const renderer = createExtensionInfoRenderer("log");
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: makeInfoData() },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogExtensionInfoRenderer: renders content metadata without error", async () => {
  const renderer = createExtensionInfoRenderer("log");
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: makeInfoData({ contentMetadata: sampleContentMetadata }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogExtensionInfoRenderer: verbose renders method detail without error", async () => {
  const renderer = createExtensionInfoRenderer("log", true);
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: makeInfoData({ contentMetadata: sampleContentMetadata }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonExtensionInfoRenderer: includes content metadata in JSON output", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionInfoRenderer("json");
    const events: ExtensionInfoEvent[] = [
      { kind: "resolving" },
      {
        kind: "completed",
        data: makeInfoData({ contentMetadata: sampleContentMetadata }),
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.contentMetadata.models.length, 2);
    assertEquals(
      parsed.contentMetadata.models[0].type,
      "@swamp/aws/ec2/volume",
    );
    assertEquals(parsed.contentMetadata.models[0].methods.length, 2);
    assertEquals(parsed.contentMetadata.models[0].methods[0].name, "get");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonExtensionInfoRenderer: null contentMetadata in JSON output", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionInfoRenderer("json");
    const events: ExtensionInfoEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: makeInfoData() },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.contentMetadata, null);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogExtensionInfoRenderer: renders extensions (type grafts) without error", async () => {
  const renderer = createExtensionInfoRenderer("log");
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: makeInfoData({
        contentMetadata: sampleContentMetadataWithExtensions,
      }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogExtensionInfoRenderer: verbose renders extension detail without error", async () => {
  const renderer = createExtensionInfoRenderer("log", true);
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: makeInfoData({
        contentMetadata: sampleContentMetadataWithExtensions,
      }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonExtensionInfoRenderer: includes extensions in JSON output", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionInfoRenderer("json");
    const events: ExtensionInfoEvent[] = [
      { kind: "resolving" },
      {
        kind: "completed",
        data: makeInfoData({
          contentMetadata: sampleContentMetadataWithExtensions,
        }),
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.contentMetadata.extensions.length, 1);
    assertEquals(
      parsed.contentMetadata.extensions[0].extendsType,
      "@keeb/grafana/instance",
    );
    assertEquals(
      parsed.contentMetadata.extensions[0].methods[0].name,
      "queryLogs",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogExtensionInfoRenderer: not_found throws UserError", () => {
  const renderer = createExtensionInfoRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.not_found({
        kind: "not_found",
        extensionName: "@foo/bar",
      }),
    UserError,
  );
});

Deno.test("LogExtensionInfoRenderer: null latestVersion shows prerelease channel", async () => {
  const renderer = createExtensionInfoRenderer("log");
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: makeInfoData({
        latestVersion: null,
        latestRc: "2026.07.19.1",
        latestBeta: "2026.07.18.3",
      }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogExtensionInfoRenderer: null latestVersion with only beta", async () => {
  const renderer = createExtensionInfoRenderer("log");
  const events: ExtensionInfoEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: makeInfoData({
        latestVersion: null,
        latestRc: null,
        latestBeta: "2026.07.18.3",
      }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogExtensionInfoRenderer: error event throws UserError", () => {
  const renderer = createExtensionInfoRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "lookup_failed", message: "Connection refused" },
      }),
    UserError,
  );
});
