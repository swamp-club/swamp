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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { ExtensionInfo } from "../../infrastructure/http/extension_api_client.ts";
import {
  extensionInfo,
  type ExtensionInfoDeps,
  type ExtensionInfoEvent,
} from "./info.ts";

function makeFullExtensionInfo(
  overrides?: Partial<ExtensionInfo>,
): ExtensionInfo {
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
    ...overrides,
  };
}

function makeDeps(
  overrides?: Partial<ExtensionInfoDeps>,
): ExtensionInfoDeps {
  return {
    getExtension: () => Promise.resolve(null),
    ...overrides,
  };
}

Deno.test("extensionInfo: returns full metadata when extension exists", async () => {
  const info = makeFullExtensionInfo();
  const deps = makeDeps({
    getExtension: () => Promise.resolve(info),
  });
  const events = await collect<ExtensionInfoEvent>(
    extensionInfo(createLibSwampContext(), deps, {
      extensionName: "@stack72/aws-ec2",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const completed = events[1] as Extract<
    ExtensionInfoEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.name, "@stack72/aws-ec2");
  assertEquals(completed.data.namespace, "@stack72");
  assertEquals(completed.data.author?.username, "stack72");
  assertEquals(completed.data.platforms, ["aws"]);
  assertEquals(completed.data.labels, ["networking", "compute"]);
  assertEquals(completed.data.pullCount, 142);
  assertEquals(completed.data.score?.grade, "A");
  assertEquals(completed.data.repositoryVerified, true);
});

Deno.test("extensionInfo: handles nullable fields", async () => {
  const info = makeFullExtensionInfo({
    namespace: null,
    repository: null,
    homepageUrl: null,
    license: null,
    author: null,
    yankedAt: null,
    yankReason: null,
    repositoryVerified: null,
    repositoryVerifiedAt: null,
    repositoryVerifiedUrl: null,
    score: null,
  });
  const deps = makeDeps({
    getExtension: () => Promise.resolve(info),
  });
  const events = await collect<ExtensionInfoEvent>(
    extensionInfo(createLibSwampContext(), deps, {
      extensionName: "some-ext",
    }),
  );

  const completed = events[1] as Extract<
    ExtensionInfoEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.author, null);
  assertEquals(completed.data.repository, null);
  assertEquals(completed.data.score, null);
});

Deno.test("extensionInfo: yields not_found when extension does not exist", async () => {
  const deps = makeDeps({
    getExtension: () => Promise.resolve(null),
  });
  const events = await collect<ExtensionInfoEvent>(
    extensionInfo(createLibSwampContext(), deps, {
      extensionName: "@foo/bar",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const notFound = events[1] as Extract<
    ExtensionInfoEvent,
    { kind: "not_found" }
  >;
  assertEquals(notFound.kind, "not_found");
  assertEquals(notFound.extensionName, "@foo/bar");
});

Deno.test("extensionInfo: yields error event on API failure", async () => {
  const deps = makeDeps({
    getExtension: () => Promise.reject(new Error("Connection refused")),
  });
  const events = await collect<ExtensionInfoEvent>(
    extensionInfo(createLibSwampContext(), deps, {
      extensionName: "@myorg/broken",
    }),
  );

  assertEquals(events.length, 2);
  const errorEvent = events[1] as Extract<
    ExtensionInfoEvent,
    { kind: "error" }
  >;
  assertEquals(errorEvent.kind, "error");
  assertEquals(errorEvent.error.code, "info_lookup_failed");
  assertStringIncludes(errorEvent.error.message, "Connection refused");
});
