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
  createDataPlaneFetch,
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

Deno.test("DataPlaneClient: resource and writer-open bodies carry write overrides (swamp-club#3574)", async () => {
  const { client, requests } = clientWith((req) =>
    req.url.endsWith("/data/writers")
      ? Response.json({ writerId: "w-1", dataId: "d" })
      : Response.json({ dataId: "d", version: 1 })
  );
  await client.writeResource({
    specName: "result",
    name: "result",
    data: { ok: true },
    overrides: { tags: { provider: "claude" }, lifetime: "7d" },
  });
  await client.openWriter({
    specName: "log",
    name: "log",
    overrides: { contentType: "text/plain", tags: { probe: "file" } },
  });
  assertEquals(JSON.parse(requests[0].body!), {
    specName: "result",
    name: "result",
    data: { ok: true },
    overrides: { tags: { provider: "claude" }, lifetime: "7d" },
  });
  assertEquals(JSON.parse(requests[1].body!), {
    specName: "log",
    name: "log",
    overrides: { contentType: "text/plain", tags: { probe: "file" } },
  });
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

Deno.test("createDataPlaneFetch: uses the base fetch when no CA is configured", () => {
  const baseFetch = (() => Promise.resolve(new Response())) as typeof fetch;
  let clientsCreated = 0;
  const createClient = () => {
    clientsCreated++;
    return {} as Deno.HttpClient;
  };

  for (const caCerts of [undefined, []]) {
    assertEquals(
      createDataPlaneFetch(caCerts, createClient, baseFetch),
      baseFetch,
    );
  }
  assertEquals(clientsCreated, 0);
});

Deno.test("createDataPlaneFetch: every data-plane request trusts the configured CA", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const httpClient = {} as Deno.HttpClient;
  const clientOptions: Deno.CreateHttpClientOptions[] = [];
  const seen: Array<RequestInit & { client?: Deno.HttpClient }> = [];
  const dataPlaneFetch = createDataPlaneFetch(
    [pem],
    (options) => {
      clientOptions.push(options);
      return httpClient;
    },
    ((
      _input: URL | Request | string,
      init?: RequestInit & { client?: Deno.HttpClient },
    ) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response(new Uint8Array([1])));
    }) as typeof fetch,
  );
  const client = new DataPlaneClient({
    baseUrl: "https://orchestrator.test",
    credential: () => "cred-1",
    fetchImpl: dataPlaneFetch,
  });

  await client.readArtifact("/data/t/m/n/1");
  await client.fetchBundle("fp-1");

  assertEquals(clientOptions, [{ caCerts: [pem] }]);
  assertEquals(seen.length, 2);
  for (const init of seen) {
    assertEquals(init.client, httpClient);
    assertEquals(
      new Headers(init.headers).get("authorization"),
      "Bearer cred-1",
    );
  }
  assertEquals(seen.map((init) => init.method), ["GET", "GET"]);
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

/**
 * A data plane that answers every request `answerAfterMs` after it arrives,
 * or rejects with the abort reason as soon as the request's signal aborts —
 * a serve that is slow or stalled, not down.
 */
function slowClient(options: {
  answerAfterMs: number;
  timeoutMs: number;
  writeTimeoutMs: number;
}): DataPlaneClient {
  const handle = JSON.stringify({
    writerId: "w-1",
    dataId: "d",
    name: "result",
    specName: "result",
    kind: "resource",
    version: 1,
    size: 2,
    tags: {},
  });
  return new DataPlaneClient({
    baseUrl: "http://orchestrator.test",
    credential: () => "cred-1",
    timeoutMs: options.timeoutMs,
    writeTimeoutMs: options.writeTimeoutMs,
    fetchImpl: ((_input: URL | Request | string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? undefined;
        const timer = setTimeout(
          () =>
            resolve(new Response(handle)),
          options.answerAfterMs,
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      })) as typeof fetch,
  });
}

Deno.test("DataPlaneClient: a write serve answers after the read timeout still succeeds", async () => {
  // The read bound fires long before serve answers; writes must not use it,
  // or a step whose data serve saved fails (swamp-club#3519).
  const client = slowClient({
    answerAfterMs: 50,
    timeoutMs: 5,
    writeTimeoutMs: 60_000,
  });
  const written = await client.writeResource({
    specName: "result",
    name: "result",
    data: { ok: true },
  });
  assertEquals(written.version, 1);
  const opened = await client.openWriter({ specName: "log", name: "log" });
  assertEquals(opened.writerId, "w-1");
  await client.writeLine("w-1", "a line");
  const finalized = await client.finalizeWriter("w-1");
  assertEquals(finalized.dataId, "d");
  await client.deleteResource({ name: "result" });
});

Deno.test("DataPlaneClient: a write past the write timeout names the route and that serve may have saved it", async () => {
  const client = slowClient({
    answerAfterMs: 60_000,
    timeoutMs: 60_000,
    writeTimeoutMs: 5,
  });
  const error = await assertRejects(
    () =>
      client.writeResource({
        specName: "result",
        name: "result",
        data: { ok: true },
      }),
    Error,
  );
  assertEquals(
    error.message,
    "Serve did not answer POST /data/resource within 0.005s; serve may still have saved this write",
  );
});

Deno.test("DataPlaneClient: a read past the read timeout fails at the read bound", async () => {
  const client = slowClient({
    answerAfterMs: 60_000,
    timeoutMs: 5,
    writeTimeoutMs: 60_000,
  });
  const error = await assertRejects(
    () => client.readArtifact("/data/t/m/result/1"),
    Error,
  );
  assertEquals(
    error.message,
    "Serve did not answer GET /data/t/m/result/1 within 0.005s",
  );
});

Deno.test("DataPlaneClient: a cancelled write keeps the caller's abort reason", async () => {
  const client = slowClient({
    answerAfterMs: 60_000,
    timeoutMs: 60_000,
    writeTimeoutMs: 60_000,
  });
  const controller = new AbortController();
  const pending = client.writeResource(
    { specName: "result", name: "result", data: { ok: true } },
    controller.signal,
  );
  const reason = new Error("step cancelled");
  controller.abort(reason);
  const error = await assertRejects(() => pending, Error);
  assertEquals(error, reason);
});
