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

import { assertEquals, assertRejects } from "@std/assert";
import {
  type WorkspaceEntry,
  WorkspaceRegistry,
  type WorkspaceRegistryRepository,
} from "../domain/workspace/workspace_registry.ts";
import {
  ControlRuntime,
  type ControlRuntimeOptions,
} from "./control_runtime.ts";
import { ENGINE_PROTOCOL, readEngineFrames } from "./protocol.ts";

const GENERATION = "generation-1";

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
    isRepo: (path) => Promise.resolve(path !== "/repos/gone"),
    realPath: (path) => Promise.resolve(`/real${path}`),
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

Deno.test("ControlRuntime: workspace.list reports every registered workspace", async () => {
  const replies = await exchange(options(), [
    hello,
    request("list", "workspace.list"),
  ]);
  assertEquals(
    (replies.list.result as { workspaces: unknown[] }).workspaces,
    [
      { name: "alpha", path: "/repos/alpha", trusted: true },
      { name: "beta", path: "/repos/beta", trusted: false },
      { name: "gone", path: "/repos/gone", trusted: false },
    ],
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
