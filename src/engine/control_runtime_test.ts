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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type WorkspaceEntry,
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../domain/workspace/workspace_registry.ts";
import {
  ASSET_CHUNK_BYTES,
  ControlRuntime,
  type ControlRuntimeOptions,
} from "./control_runtime.ts";
import { ENGINE_PROTOCOL, readEngineFrames } from "./protocol.ts";

const GENERATION = "generation-1";

const ASSET = new Uint8Array(ASSET_CHUNK_BYTES * 2 + 7).map((_, i) => i % 251);

function registryOf(
  entries: WorkspaceEntry[],
  failure?: Error,
): WorkspaceRegistryRepository {
  return {
    load: () =>
      failure
        ? Promise.reject(failure)
        : Promise.resolve(WorkspaceRegistry.fromEntries(entries)),
    update: () => Promise.reject(new Error("read-only in tests")),
  };
}

function options(
  overrides: Partial<ControlRuntimeOptions> = {},
): ControlRuntimeOptions {
  return {
    workspaces: registryOf([
      {
        name: "alpha",
        path: "/repos/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        trustedAt: "2026-01-02T00:00:00Z",
      },
      { name: "beta", path: "/repos/beta", createdAt: "2026-01-01T00:00:00Z" },
      { name: "gone", path: "/repos/gone", createdAt: "2026-01-01T00:00:00Z" },
    ]),
    listServes: (path) =>
      Promise.resolve(
        path === "/real/repos/alpha"
          ? [{
            pid: 41,
            host: "127.0.0.1",
            port: 9190,
            url: "http://127.0.0.1:9190",
            authMode: "token",
            dashboard: true,
            startedAt: "2026-11-05T10:00:00Z",
            version: "dev",
          }]
          : [],
      ),
    configuredServePort: (path) =>
      path === "/real/repos/alpha"
        ? Promise.resolve(9190)
        : path === "/real/repos/beta"
        ? Promise.resolve(undefined)
        : Promise.reject(new Error("bad serve.yaml")),
    isRepo: (path) => Promise.resolve(!path.endsWith("/repos/gone")),
    realPath: (path) =>
      path.startsWith("/missing")
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(path.startsWith("/real") ? path : `/real${path}`),
    locateAsset: (subPath) =>
      Promise.resolve(
        subPath.includes("..") ? "forbidden" : {
          file: subPath.startsWith("assets/")
            ? `/dist/${subPath}`
            : "/dist/index.html",
          contentType: "application/javascript",
          cacheControl: subPath.startsWith("assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      ),
    readAsset: (_file, offset, length) => {
      const bytes = ASSET.subarray(offset, offset + length);
      return Promise.resolve({ bytes, size: ASSET.length });
    },
    engineVersion: "1.2.3",
    gitSha: "abc",
    ...overrides,
  };
}

function request(id: string, method: string, params?: Record<string, unknown>) {
  return {
    version: ENGINE_PROTOCOL.version,
    generation: GENERATION,
    id,
    method,
    ...(params ? { params } : {}),
  };
}

const hello = request("hello", "hello", {
  profile: ENGINE_PROTOCOL.hubControl.profile,
});

async function exchange(
  runtimeOptions: ControlRuntimeOptions,
  requests: unknown[],
): Promise<Record<string, Record<string, unknown>>> {
  const pipe = new TransformStream<Uint8Array, Uint8Array>();
  const runtime = new ControlRuntime(runtimeOptions, pipe.writable);
  const replies: Record<string, Record<string, unknown>> = {};
  const reading = (async () => {
    for await (const frame of readEngineFrames(pipe.readable)) {
      const reply = frame as Record<string, unknown>;
      replies[reply.id as string] = reply;
    }
  })();
  try {
    await runtime.serve((async function* () {
      yield* requests;
    })());
  } finally {
    // The writer releases the stream; the process owner closes it.
    await pipe.writable.close();
    await reading;
  }
  return replies;
}

Deno.test("ControlRuntime: hello advertises the hub control profile from the shared manifest", async () => {
  const replies = await exchange(options(), [hello]);
  assertEquals(replies.hello.result, {
    version: ENGINE_PROTOCOL.version,
    profile: ENGINE_PROTOCOL.hubControl.profile,
    controls: ENGINE_PROTOCOL.hubControl.controls,
    engineVersion: "1.2.3",
    gitSha: "abc",
  });
});

Deno.test("ControlRuntime: workspace.resolve returns the realpath and the user's trust", async () => {
  const replies = await exchange(options(), [
    hello,
    request("a", "workspace.resolve", { name: "alpha" }),
    request("b", "workspace.resolve", { name: "beta" }),
  ]);
  assertEquals(replies.a.result, {
    name: "alpha",
    path: "/real/repos/alpha",
    trusted: true,
  });
  assertEquals(replies.b.result, {
    name: "beta",
    path: "/real/repos/beta",
    trusted: false,
  });
});

Deno.test("ControlRuntime: unregistered, malformed and vanished workspaces are all unknown", async () => {
  const replies = await exchange(options(), [
    hello,
    request("missing", "workspace.resolve", { name: "missing" }),
    request("malformed", "workspace.resolve", { name: "../alpha" }),
    request("untyped", "workspace.resolve", { name: 7 }),
    request("gone", "workspace.resolve", { name: "gone" }),
  ]);
  for (const id of ["missing", "malformed", "untyped", "gone"]) {
    assertEquals(
      (replies[id].error as { code: string }).code,
      "unknown_workspace",
      id,
    );
  }
});

Deno.test("ControlRuntime: registry failures cross the pipe without their paths", async () => {
  const replies = await exchange(
    options({
      workspaces: registryOf(
        [],
        new Error("cannot read /home/someone/.config/swamp/workspaces.json"),
      ),
    }),
    [hello, request("a", "workspace.resolve", { name: "alpha" })],
  );
  assertEquals(replies.a.error, {
    code: "engine_error",
    message: "Hub control failed",
  });
});

Deno.test("ControlRuntime: workspace.list reports the registered folders that are still repos", async () => {
  const replies = await exchange(options(), [
    hello,
    request("list", "workspace.list"),
  ]);
  assertEquals(
    (replies.list.result as { workspaces: unknown[] }).workspaces,
    [
      { name: "alpha", path: "/repos/alpha", trusted: true },
      { name: "beta", path: "/repos/beta", trusted: false },
    ],
  );
});

Deno.test("ControlRuntime: workspace.inspect answers a repo's realpath and refuses anything else", async () => {
  const replies = await exchange(options(), [
    hello,
    request("repo", "workspace.inspect", { path: "/repos/alpha" }),
    request("plain", "workspace.inspect", { path: "/repos/gone" }),
    request("missing", "workspace.inspect", { path: "/missing/x" }),
    request("untyped", "workspace.inspect", { path: 3 }),
  ]);
  assertEquals(replies.repo.result, { path: "/real/repos/alpha" });
  for (const id of ["plain", "missing", "untyped"]) {
    assertEquals(
      (replies[id].error as { code: string }).code,
      "not_a_repo",
      id,
    );
  }
});

Deno.test("ControlRuntime: asset.get returns a file in chunks that fit a control reply", async () => {
  const replies = await exchange(options(), [
    hello,
    request("c0", "asset.get", { path: "assets/app.js", offset: 0 }),
    request("c1", "asset.get", {
      path: "assets/app.js",
      offset: ASSET_CHUNK_BYTES,
    }),
    request("c2", "asset.get", {
      path: "assets/app.js",
      offset: ASSET_CHUNK_BYTES * 2,
    }),
  ]);
  const chunks = ["c0", "c1", "c2"].map((id) =>
    replies[id].result as {
      data: string;
      done: boolean;
      size: number;
      offset: number;
      cacheControl: string;
    }
  );
  assertEquals(chunks.map((c) => c.done), [false, false, true]);
  assertEquals(chunks[0].cacheControl, "public, max-age=31536000, immutable");
  const joined = chunks.flatMap((c) =>
    Array.from(atob(c.data), (ch) => ch.charCodeAt(0))
  );
  assertEquals(new Uint8Array(joined), ASSET);
  for (const id of ["c0", "c1", "c2"]) {
    assert(JSON.stringify(replies[id]).length < 64 * 1024, id);
  }
});

Deno.test("ControlRuntime: asset.get refuses a path outside the bundle and bad offsets", async () => {
  const replies = await exchange(options(), [
    hello,
    request("escape", "asset.get", { path: "../secret", offset: 0 }),
    request("negative", "asset.get", { path: "index.html", offset: -1 }),
    request("fallback", "asset.get", { path: "w/alpha", offset: 0 }),
  ]);
  assertEquals(
    (replies.escape.error as { code: string }).code,
    "unknown_asset",
  );
  assertEquals(
    (replies.negative.error as { code: string }).code,
    "invalid_request",
  );
  assertEquals(
    (replies.fallback.result as { cacheControl: string }).cacheControl,
    "no-cache",
  );
});

Deno.test("ControlRuntime: asset.get without a bundle says so", async () => {
  const replies = await exchange(
    options({ locateAsset: () => Promise.resolve(null) }),
    [hello, request("a", "asset.get", { path: "", offset: 0 })],
  );
  assertEquals(
    (replies.a.error as { code: string }).code,
    "assets_unavailable",
  );
});

Deno.test("ControlRuntime: it is always idle and quiesce ends it", async () => {
  const replies = await exchange(options(), [
    hello,
    request("status", "engine.status"),
    request("quiesce", "engine.quiesce", { deadlineMs: 1000 }),
    request("after", "workspace.list"),
  ]);
  assertEquals(
    (replies.status.result as { sessions: number; requests: number }).sessions,
    0,
  );
  assertEquals(replies.quiesce.result, { quiescent: true });
  assertEquals(replies.after, undefined);
});

Deno.test("ControlRuntime: the first frame must be the hub control hello", async () => {
  await assertRejects(() =>
    exchange(options(), [
      request("hello", "hello", { profile: ENGINE_PROTOCOL.profile }),
    ])
  );
  await assertRejects(() =>
    exchange(options(), [request("a", "workspace.list")])
  );
});

Deno.test("ControlRuntime: workspace.trust records trust for a registered repo and nothing else", async () => {
  let registry = WorkspaceRegistry.fromEntries([
    { name: "beta", path: "/repos/beta", createdAt: "2026-01-01T00:00:00Z" },
    { name: "gone", path: "/repos/gone", createdAt: "2026-01-01T00:00:00Z" },
  ]);
  const workspaces: WorkspaceRegistryRepository = {
    load: () => Promise.resolve(registry),
    update: (change) => {
      const next = WorkspaceRegistry.fromEntries(registry.list());
      const result = change(next);
      registry = next;
      return Promise.resolve(result);
    },
  };
  const replies = await exchange(
    options({ workspaces, now: () => new Date("2026-11-05T12:00:00Z") }),
    [
      hello,
      request("beta", "workspace.trust", { name: "beta" }),
      request("gone", "workspace.trust", { name: "gone" }),
      request("nope", "workspace.trust", { name: "nope" }),
      request("bad", "workspace.trust", { name: "../x" }),
    ],
  );
  assertEquals(replies.beta.result, {
    name: "beta",
    path: "/real/repos/beta",
    trusted: true,
  });
  assertEquals(registry.isTrusted("/repos/beta"), true);
  assertEquals(registry.get("beta")?.trustedAt, "2026-11-05T12:00:00.000Z");
  assertEquals(registry.isTrusted("/repos/gone"), false);
  for (const id of ["gone", "nope", "bad"]) {
    assertEquals(
      (replies[id].error as { code: string }).code,
      "unknown_workspace",
      id,
    );
  }
});

Deno.test("ControlRuntime: workspace.serves lists the recorded serves of each repo path", async () => {
  const replies = await exchange(options(), [
    hello,
    request("serves", "workspace.serves", {
      paths: ["/repos/alpha", "/repos/beta", "/repos/gone", "/missing/x"],
    }),
    request("bad", "workspace.serves", { paths: "/repos/alpha" }),
  ]);
  const result = replies.serves.result as {
    workspaces: { path: string; serves: { pid: number }[] }[];
  };
  assertEquals(
    result.workspaces.map((w) => [w.path, w.serves.map((s) => s.pid)]),
    [["/repos/alpha", [41]], ["/repos/beta", []]],
  );
  assertEquals((replies.bad.error as { code: string }).code, "invalid_params");
});

Deno.test("ControlRuntime: workspace.serveConfig reports a configured port only when the repo sets one", async () => {
  const replies = await exchange(options(), [
    hello,
    request("alpha", "workspace.serveConfig", { name: "alpha" }),
    request("beta", "workspace.serveConfig", { name: "beta" }),
    request("nope", "workspace.serveConfig", { name: "nope" }),
  ]);
  assertEquals(replies.alpha.result, {
    name: "alpha",
    path: "/real/repos/alpha",
    trusted: true,
    port: 9190,
  });
  assertEquals(replies.beta.result, {
    name: "beta",
    path: "/real/repos/beta",
    trusted: false,
  });
  assertEquals(
    (replies.nope.error as { code: string }).code,
    "unknown_workspace",
  );
});
