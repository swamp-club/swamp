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
import { consumeStream } from "../../libswamp/stream.ts";
import type { ExtensionContentMetadata } from "../../domain/extensions/extension_content.ts";
import type {
  ExtensionInfoData,
  ExtensionInfoEvent,
} from "../../libswamp/extensions/info.ts";
import { UserError } from "../../domain/errors.ts";
import type { Logger } from "@logtape/logtape";
import {
  createExtensionInfoRenderer,
  renderAcceptedWarnings,
} from "./extension_info.ts";
import { ACCEPTED_HEADER } from "./extension_findings_report.ts";

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
  datastores: [],
  reports: [],
  webhooks: [],
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

/** The lines renderAcceptedWarnings logs, as the formatter would print them. */
function acceptedWarningsLines(raw: unknown): string[] {
  const lines: string[] = [];
  const logger = {
    info: (message: string) =>
      lines.push(message.replaceAll("{{", "{").replaceAll("}}", "}")),
  } as unknown as Logger;
  renderAcceptedWarnings(logger, raw);
  return lines;
}

Deno.test("renderAcceptedWarnings: prints the accepted warnings in the push report's format", () => {
  assertEquals(
    acceptedWarningsLines({
      accepted: [
        {
          rule: "credentials-sensitive-field",
          file: "models/volume.ts",
          line: 12,
          reason: "the token is a {placeholder}",
          source: "inline",
        },
        { rule: "ipv4-literal", file: "README.txt", source: "sidecar" },
        { rule: "testing-completeness", source: "generated" },
      ],
      generated: { by: "gen-tool", source: "spec.yaml", commit: "abc123" },
      total: 3,
    }),
    [
      "",
      ACCEPTED_HEADER,
      "  generated by gen-tool from spec.yaml at abc123",
      "  credentials-sensitive-field — models/volume.ts:12: the token is a {placeholder}",
      "  ipv4-literal — README.txt",
      "  testing-completeness — (extension)",
    ],
  );
});

Deno.test("renderAcceptedWarnings: says how many accepted warnings the registry did not return", () => {
  assertEquals(
    acceptedWarningsLines({
      accepted: [{ rule: "ipv4-literal", file: "a.txt", source: "sidecar" }],
      total: 41,
    }).slice(2),
    ["  ipv4-literal — a.txt", "  and 40 more"],
  );
});

Deno.test("renderAcceptedWarnings: escapes control characters in author-supplied acceptance text", () => {
  assertEquals(
    acceptedWarningsLines({
      accepted: [{
        rule: "ipv4-literal",
        file: "a\x1b[2J.txt",
        line: 3,
        reason: "ok\x07\nnext",
        source: "sidecar",
      }],
      generated: { by: "gen\x1b]0;x", source: "s", commit: "c" },
      total: 1,
    }).slice(2),
    [
      "  generated by gen\\x1b]0;x from s at c",
      "  ipv4-literal — a\\x1b[2J.txt:3: ok\\x07\\x0anext",
    ],
  );
});

Deno.test("renderAcceptedWarnings: prints nothing when there are none, or the field is malformed", () => {
  for (
    const raw of [
      undefined,
      null,
      { accepted: "nope" },
      { accepted: [{ file: "x.ts" }], total: 1 },
    ]
  ) {
    assertEquals(acceptedWarningsLines(raw), []);
  }
});

Deno.test("LogExtensionInfoRenderer: renders accepted warnings without error", async () => {
  const renderer = createExtensionInfoRenderer("log");
  await consumeStream(
    toStream([{
      kind: "completed",
      data: makeInfoData({
        contentMetadata: {
          ...sampleContentMetadata,
          acceptances: {
            accepted: [{
              rule: "ipv4-literal",
              file: "a.txt",
              source: "sidecar",
            }],
            total: 1,
          },
        },
      }),
    }]),
    renderer.handlers(),
  );
});

Deno.test("JsonExtensionInfoRenderer: carries the accepted warnings in contentMetadata", async () => {
  const acceptances = {
    accepted: [{
      rule: "ipv4-literal",
      file: "a.txt",
      source: "sidecar" as const,
    }],
    total: 2,
  };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createExtensionInfoRenderer("json");
    await consumeStream(
      toStream([{
        kind: "completed",
        data: makeInfoData({
          contentMetadata: { ...sampleContentMetadata, acceptances },
        }),
      }]),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  assertEquals(
    JSON.parse(logs.join("\n")).contentMetadata.acceptances,
    acceptances,
  );
});
