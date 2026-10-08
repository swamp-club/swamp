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

import { assertEquals } from "@std/assert";
import type { ExtensionManifest } from "../src/domain/extensions/extension_manifest.ts";
import {
  ExtensionApiClient,
  MAX_REGISTRY_WARNINGS,
} from "../src/infrastructure/http/extension_api_client.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  extensionPush,
  type ExtensionPushEvent,
} from "../src/libswamp/extensions/push.ts";

const manifest: ExtensionManifest = {
  manifestVersion: 1,
  name: "@test/ext",
  version: "2026.10.08.1",
  description: "Test extension",
  repository: undefined,
  paths: { base: "typedDir" },
  workflows: [],
  models: ["echo.ts"],
  vaults: [],
  datastores: [],
  reports: [],
  webhooks: [],
  skills: [],
  include: [],
  additionalFiles: [],
  binaries: [],
  platforms: [],
  labels: [],
  releaseNotes: undefined,
  dependencies: [],
};

/**
 * Pushes through the real API client against a mock registry whose confirm
 * response carries `warnings`, and returns the run's last event.
 */
async function pushAgainstRegistry(
  warnings: unknown,
): Promise<ExtensionPushEvent | undefined> {
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/upload") {
      await req.arrayBuffer();
      return new Response(null, { status: 200 });
    }
    const body = await req.json() as Record<string, unknown>;
    if (url.pathname === "/api/v1/extensions/push") {
      return Response.json({
        uploadUrl: new URL("/upload", url).href,
        s3Key: "test-key",
        extensionId: "test-extension",
      });
    }
    if (url.pathname === "/api/v1/extensions/confirm") {
      return Response.json({
        name: body.name,
        version: body.version,
        extensionId: "test-extension",
        visibility: "public",
        ...(warnings !== undefined ? { warnings } : {}),
      }, { status: 201 });
    }
    return new Response(null, { status: 404 });
  });
  try {
    const serverUrl = `http://localhost:${server.addr.port}`;
    const client = new ExtensionApiClient(serverUrl);
    const events: ExtensionPushEvent[] = [];
    for await (
      const event of extensionPush(createLibSwampContext(), {
        loadCredentials: () =>
          Promise.resolve({ serverUrl, apiKey: "test-key" }),
        initiatePush: (_server, metadata, key) =>
          client.initiatePush(metadata, key),
        uploadArchive: (url, archive) => client.uploadArchive(url, archive),
        confirmPush: (_server, metadata, key) =>
          client.confirmPush(metadata, key),
        getExtensionVisibility: () => {
          throw new Error("Confirmation is authoritative");
        },
      }, {
        manifest,
        archiveBytes: new Uint8Array([0x1F, 0x8B, 0x00]),
        contentMetadata: undefined,
        counts: {
          models: 1,
          workflows: 0,
          bundles: 1,
          vaults: 0,
          datastores: 0,
          reports: 0,
          webhooks: 0,
          skills: 0,
        },
      })
    ) events.push(event);
    return events.at(-1);
  } finally {
    await server.shutdown();
  }
}

function registryWarnings(
  event: ExtensionPushEvent | undefined,
): string[] | undefined {
  assertEquals(event?.kind, "completed");
  return event?.kind === "completed" ? event.data.registryWarnings : undefined;
}

Deno.test("extension push: a registry warning on the confirm response reaches the completed event", async () => {
  const warning =
    "contentMetadata was rejected (too many methods); the registry listing was extracted from the archive instead";
  assertEquals(registryWarnings(await pushAgainstRegistry([warning])), [
    warning,
  ]);
});

Deno.test("extension push: registry warnings reach the completed event sanitised and capped", async () => {
  const sent = [
    "escape\x1b[2J\nsecond line",
    42,
    ...Array.from({ length: MAX_REGISTRY_WARNINGS + 1 }, (_, i) => `w${i}`),
  ];
  const received = registryWarnings(await pushAgainstRegistry(sent));
  assertEquals(received?.length, MAX_REGISTRY_WARNINGS + 1);
  assertEquals(received?.[0], "escape [2J second line");
  assertEquals(received?.[1], "w0");
  assertEquals(received?.at(-1), "2 more registry warnings omitted");
});

for (
  const [name, warnings] of [
    ["no warnings field", undefined],
    ["a malformed warnings field", { message: "rejected" }],
  ] as const
) {
  Deno.test(`extension push: completes without registryWarnings when the registry sends ${name}`, async () => {
    const last = await pushAgainstRegistry(warnings);
    assertEquals(last?.kind, "completed");
    if (last?.kind === "completed") {
      assertEquals("registryWarnings" in last.data, false);
    }
  });
}
