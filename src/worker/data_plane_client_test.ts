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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DataPlaneClient,
  dataPlaneUrlFromConnectUrl,
} from "./data_plane_client.ts";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body?: string;
}

function clientWith(
  respond: (req: RecordedRequest) => Response,
): { client: DataPlaneClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let credential = "cred-1";
  const client = new DataPlaneClient({
    baseUrl: "http://orchestrator.test",
    credential: () => credential,
    fetchImpl: ((input: URL | Request | string, init?: RequestInit) => {
      const request: RecordedRequest = {
        method: init?.method ?? "GET",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      requests.push(request);
      return Promise.resolve(respond(request));
    }) as typeof fetch,
  });
  return {
    client,
    requests,
    setCredential: (c: string) => (credential = c),
  } as unknown as {
    client: DataPlaneClient;
    requests: RecordedRequest[];
  };
}

Deno.test("DataPlaneClient: presents the bearer credential on every request", async () => {
  const { client, requests } = clientWith(() =>
    new Response(new Uint8Array([1, 2, 3]))
  );
  await client.readArtifact("/data/t/m/n/1");
  assertEquals(requests[0].authorization, "Bearer cred-1");
});

Deno.test("DataPlaneClient: artifact reads cache by immutable content path", async () => {
  const { client, requests } = clientWith(() =>
    new Response(new TextEncoder().encode("bytes"))
  );
  const first = await client.readArtifact("/data/t/m/n/1");
  const second = await client.readArtifact("/data/t/m/n/1");
  assertEquals(new TextDecoder().decode(first), "bytes");
  assertEquals(first, second);
  assertEquals(requests.length, 1);
  assertEquals(client.cachedArtifactCount, 1);
});

Deno.test("DataPlaneClient: non-OK responses surface status and detail", async () => {
  const { client } = clientWith(() =>
    new Response(JSON.stringify({ error: "no lease" }), { status: 400 })
  );
  const error = await assertRejects(
    () => client.writeResource({ specName: "out", name: "x", data: {} }),
    Error,
  );
  assertStringIncludes(error.message, "400");
  assertStringIncludes(error.message, "no lease");
});

Deno.test("DataPlaneClient: writer protocol routes and bodies", async () => {
  const { client, requests } = clientWith((req) => {
    if (req.url.endsWith("/data/writers")) {
      return new Response(JSON.stringify({ writerId: "w-1", dataId: "d" }));
    }
    if (req.url.includes("/line")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(
      JSON.stringify({
        dataId: "d",
        name: "log",
        specName: "log",
        kind: "file",
        version: 1,
        size: 5,
        tags: {},
      }),
    );
  });
  const opened = await client.openWriter({ specName: "log", name: "log" });
  assertEquals(opened.writerId, "w-1");
  await client.writeLine("w-1", "a log line");
  const handle = await client.finalizeWriter("w-1");
  assertEquals(handle.kind, "file");
  assertEquals(requests.map((r) => new URL(r.url).pathname), [
    "/data/writers",
    "/data/writers/w-1/line",
    "/data/writers/w-1/finalize",
  ]);
  assertEquals(requests[1].body, "a log line");
});

Deno.test("DataPlaneClient: bundle and asset fetch paths are fingerprint-keyed", async () => {
  const { client, requests } = clientWith((req) => {
    if (req.url.endsWith("/files")) {
      return new Response(JSON.stringify({ files: ["a.txt"] }));
    }
    return new Response("export {};");
  });
  await client.fetchBundle("fp-1");
  await client.listAssets("fp-1");
  await client.fetchAsset("fp-1", "templates/report.html");
  assertEquals(requests.map((r) => new URL(r.url).pathname), [
    "/bundle/fp-1",
    "/bundle/fp-1/files",
    "/bundle/fp-1/file/templates/report.html",
  ]);
});

Deno.test("DataPlaneClient: artifact cache evicts oldest entries at capacity", async () => {
  let fetchCount = 0;
  const client = new DataPlaneClient({
    baseUrl: "http://test",
    credential: () => "c",
    maxCacheEntries: 2,
    fetchImpl: (() => {
      fetchCount++;
      return Promise.resolve(
        new Response(new Uint8Array([fetchCount])),
      );
    }) as unknown as typeof fetch,
  });
  await client.readArtifact("/a");
  await client.readArtifact("/b");
  assertEquals(client.cachedArtifactCount, 2);
  assertEquals(fetchCount, 2);

  await client.readArtifact("/c");
  assertEquals(client.cachedArtifactCount, 2);
  assertEquals(fetchCount, 3);

  await client.readArtifact("/a");
  assertEquals(fetchCount, 4);

  await client.readArtifact("/c");
  assertEquals(fetchCount, 4);
});

Deno.test("dataPlaneUrlFromConnectUrl: maps ws→http and wss→https", () => {
  assertEquals(
    dataPlaneUrlFromConnectUrl("ws://orch.internal:4000"),
    "http://orch.internal:4000/",
  );
  assertEquals(
    dataPlaneUrlFromConnectUrl("wss://orch.internal:4443/path?x=1"),
    "https://orch.internal:4443/",
  );
});
