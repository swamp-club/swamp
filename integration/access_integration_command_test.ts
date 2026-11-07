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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { integrationCredentialHash } from "../src/domain/access/integration_credential.ts";
import {
  accessIntegrationCommand,
  pullLatestForIntegrationChange,
  runIntegrationChange,
} from "../src/cli/commands/access_integration.ts";

import "../src/domain/models/models.ts";

await initializeLogging({});

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

const RECORD = {
  id: "app",
  name: "App",
  credentialHash: `sha256:${"a".repeat(64)}`,
  ceiling: { version: 1, ceiling: [] },
  ceilingDigest: "sha256:x",
  state: "active",
  createdAt: new Date(0).toISOString(),
};

const LISTED = { ...RECORD, credentialHash: undefined };

/** answers the existence check a register makes first, with no integrations */
function answeredList(socket: WebSocket, data: string): boolean {
  const { id, type } = JSON.parse(data) as { id: string; type: string };
  if (type !== "access.integration.list") return false;
  socket.send(JSON.stringify({
    type,
    id,
    payload: { data: { integrations: [], count: 0 } },
  }));
  return true;
}

function fakeServe(
  events: (request: Sent) => Record<string, unknown>[],
  listed: unknown[] = [LISTED],
) {
  const sent: Sent[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as Sent & {
          id: string;
        };
        sent.push(request);
        if (request.type === "access.integration.list") {
          socket.send(JSON.stringify({
            type: request.type,
            id: request.id,
            payload: { data: { integrations: listed, count: listed.length } },
          }));
          return;
        }
        for (const event of events(request)) {
          socket.send(JSON.stringify({ type: "event", id: request.id, event }));
        }
        socket.send(JSON.stringify({ type: "done", id: request.id }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    sent,
    shutdown: () => server.shutdown(),
  };
}

const COMPLETED = (attributes: unknown) => ({
  kind: "completed",
  run: {
    status: "succeeded",
    dataArtifacts: [{ name: "integration-main", attributes }],
  },
});

function run(args: string[]): Promise<unknown> {
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("integration", accessIntegrationCommand);
  return root.noExit().parse(["integration", ...args, "--json"]);
}

function capturingLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => console.log = original };
}

async function refusal(args: string[], text: string): Promise<void> {
  await assertRejects(() => run(args), Error, text);
}

Deno.test("access integration register: needs a ceiling or --empty, and not both", async () => {
  await refusal(["register", "app", "--name", "A"], "at least one --ceiling");
  await refusal(
    [
      "register",
      "app",
      "--name",
      "A",
      "--empty",
      "--ceiling",
      "run=workflow:*",
    ],
    "both --ceiling and --empty",
  );
});

Deno.test("access integration register: refuses a bad ceiling or id before anything is sent", async () => {
  for (
    const [args, text] of [
      [["--ceiling", "run"], "<actions>=<selector>"],
      [["--ceiling", "write=workflow:*"], "not allowed"],
      [["--ceiling", "run=model:*"], "only workflow resources"],
    ] as const
  ) {
    await refusal(["register", "app", "--name", "A", ...args], text);
  }
  await refusal(
    ["register", "Bad_Id", "--name", "A", "--empty"],
    "Invalid integration id",
  );
  await refusal(
    ["register", "a".repeat(53), "--name", "A", "--empty"],
    "at most 52 characters",
  );
});

Deno.test("access integration register: sends only the hash, and shows the credential that matches it", async () => {
  const serve = fakeServe(() => [COMPLETED(RECORD)], []);
  const log = capturingLog();
  try {
    await run([
      "register",
      "app",
      "--name",
      "App",
      "--ceiling",
      "run=workflow:deploy",
      "--server",
      serve.url,
      "--token",
      "t.s",
    ]);
  } finally {
    log.restore();
    await serve.shutdown();
  }
  const shown = JSON.parse(log.lines.at(-1)!);
  assert(shown.credential.startsWith("swi1.app."));
  const inputs = serve.sent[1].payload.inputs as Record<string, unknown>;
  assertEquals(
    inputs.credentialHash,
    await integrationCredentialHash(shown.credential),
  );
  assert(!JSON.stringify(serve.sent).includes(shown.credential));
  assertEquals(serve.sent[1].payload.skipAllReports, true);
});

Deno.test("access integration register: a stream that ends with no record warns that it may have registered", async () => {
  const serve = fakeServe(() => [], []);
  try {
    const error = await assertRejects(() =>
      run([
        "register",
        "app",
        "--name",
        "App",
        "--empty",
        "--server",
        serve.url,
        "--token",
        "t.s",
      ])
    ) as Error;
    assertStringIncludes(error.message, "may still have registered");
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration register: a connection lost after the run was accepted warns that it may have registered", async () => {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        if (answeredList(socket, message.data as string)) return;
        const { id } = JSON.parse(message.data as string) as { id: string };
        socket.send(JSON.stringify({
          type: "event",
          id,
          event: { kind: "run.accepted", runId: "r-1" },
        }));
        socket.close(1011, "gone");
      };
      return response;
    },
  );
  try {
    const error = await assertRejects(() =>
      run([
        "register",
        "app",
        "--name",
        "App",
        "--empty",
        "--server",
        `ws://127.0.0.1:${server.addr.port}`,
        "--token",
        "t.s",
      ])
    ) as Error;
    assertStringIncludes(error.message, "may still have registered");
  } finally {
    await server.shutdown();
  }
});

function frameServer(frame: Record<string, unknown>) {
  return Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        if (answeredList(socket, message.data as string)) return;
        const { id } = JSON.parse(message.data as string) as { id: string };
        socket.send(JSON.stringify({
          type: "event",
          id,
          event: COMPLETED(RECORD),
        }));
        socket.send(JSON.stringify({ type: "error", id, error: frame }));
      };
      return response;
    },
  );
}

async function registerError(url: string): Promise<Error> {
  return await assertRejects(() =>
    run([
      "register",
      "app",
      "--name",
      "App",
      "--empty",
      "--server",
      url,
      "--token",
      "t.s",
    ])
  ) as Error;
}

Deno.test("access integration register: a failure after the write warns, and names the server to check", async () => {
  const server = frameServer({
    code: "method_execution_failed",
    message: "replication was not confirmed",
  });
  const url = `ws://127.0.0.1:${server.addr.port}`;
  try {
    const { message } = await registerError(url);
    assertStringIncludes(message, "may still have registered");
    assertStringIncludes(
      message,
      `swamp access integration show app --server ${url}`,
    );
    assertStringIncludes(
      message,
      `swamp access integration revoke app --server ${url}`,
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("access integration register: an unauthorized reply doesn't warn", async () => {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const { id } = JSON.parse(message.data as string) as { id: string };
        socket.send(JSON.stringify({
          type: "error",
          id,
          error: { code: "unauthorized", message: "Access denied" },
        }));
      };
      return response;
    },
  );
  try {
    const { message } = await registerError(
      `ws://127.0.0.1:${server.addr.port}`,
    );
    assertEquals(message.includes("may still have registered"), false);
  } finally {
    await server.shutdown();
  }
});

Deno.test("access integration register: an unreachable server doesn't warn that it may have registered", async () => {
  const unused = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const { port } = unused.addr as Deno.NetAddr;
  unused.close();
  const error = await assertRejects(() =>
    run([
      "register",
      "app",
      "--name",
      "App",
      "--empty",
      "--server",
      `ws://127.0.0.1:${port}`,
      "--token",
      "t.s",
    ])
  ) as Error;
  assertEquals(error.message.includes("may still have registered"), false);
});

Deno.test("access integration register: a refusal doesn't warn that it may have registered", async () => {
  const serve = fakeServe(() => [{
    kind: "error",
    error: { message: "Access denied: user:alice does not have it" },
  }], []);
  try {
    const error = await assertRejects(() =>
      run([
        "register",
        "app",
        "--name",
        "App",
        "--empty",
        "--server",
        serve.url,
        "--token",
        "t.s",
      ])
    ) as Error;
    assertEquals(error.message.includes("may still have registered"), false);
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration register: a reused id is reported plainly", async () => {
  const serve = fakeServe(() => [{
    kind: "error",
    error: { message: "Integration 'app' already exists" },
  }], []);
  try {
    const error = await assertRejects(() =>
      run([
        "register",
        "app",
        "--name",
        "App",
        "--empty",
        "--server",
        serve.url,
        "--token",
        "t.s",
      ])
    ) as Error;
    assertEquals(error.message.includes("may still have registered"), false);
  } finally {
    await serve.shutdown();
  }
});

function registerApp(url: string): Promise<unknown> {
  return run([
    "register",
    "app",
    "--name",
    "App",
    "--empty",
    "--server",
    url,
    "--token",
    "t.s",
  ]);
}

Deno.test("access integration register: a taken id sends no run, so a pre-write failure can't advise revoking a live integration", async () => {
  // what a lock timeout on a re-register looks like, were the run ever sent
  const serve = fakeServe(() => [{ kind: "lock.timeout" }], [LISTED]);
  try {
    const error = await assertRejects(() => registerApp(serve.url)) as Error;
    assertStringIncludes(error.message, "Integration 'app' already exists");
    assertEquals(error.message.includes("revoke"), false);
    assertEquals(serve.sent.map((request) => request.type), [
      "access.integration.list",
    ]);
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration register: a revoked id sends no run, and says why", async () => {
  const serve = fakeServe(() => [COMPLETED(RECORD)], [
    { ...LISTED, state: "revoked" },
  ]);
  try {
    const error = await assertRejects(() => registerApp(serve.url)) as Error;
    assertStringIncludes(error.message, "a revoked id can't be used again");
    assertEquals(serve.sent.length, 1);
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration register: an unreadable record of that id still takes it", async () => {
  const serve = fakeServe(() => [COMPLETED(RECORD)], [
    { ...LISTED, state: "unreadable" },
  ]);
  try {
    const error = await assertRejects(() => registerApp(serve.url)) as Error;
    assertStringIncludes(error.message, "already exists");
    assertEquals(serve.sent.length, 1);
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration register: a failed existence check sends no run and doesn't warn", async () => {
  const types: string[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          id: string;
          type: string;
        };
        types.push(request.type);
        socket.send(JSON.stringify({
          type: "error",
          id: request.id,
          error: { code: "lock_timeout", message: "timed out" },
        }));
      };
      return response;
    },
  );
  try {
    const error = await assertRejects(() =>
      registerApp(`ws://127.0.0.1:${server.addr.port}`)
    ) as Error;
    assertEquals(error.message.includes("may still have registered"), false);
    assertEquals(types, ["access.integration.list"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("access integration revoke: an unlisted id sends no run, so a user behavior of that name is safe", async () => {
  const serve = fakeServe(() => [COMPLETED(RECORD)], []);
  try {
    await refusal(
      ["revoke", "app", "--server", serve.url, "--token", "t.s"],
      "does not exist",
    );
    assertEquals(serve.sent.map((s) => s.type), ["access.integration.list"]);
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration revoke: a cancelled run is an error, not a success", async () => {
  const serve = fakeServe(() => [{ kind: "cancelled", run: {} }]);
  try {
    await refusal(
      ["revoke", "app", "--server", serve.url, "--token", "t.s"],
      "was cancelled",
    );
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration revoke: says when it was already revoked", async () => {
  const serve = fakeServe(
    () => [{
      kind: "completed",
      run: { status: "succeeded", dataArtifacts: [] },
    }],
    [{ ...LISTED, state: "revoked" }],
  );
  const log = capturingLog();
  try {
    await run(["revoke", "app", "--server", serve.url, "--token", "t.s"]);
  } finally {
    log.restore();
    await serve.shutdown();
  }
  assertEquals(JSON.parse(log.lines.at(-1)!).alreadyRevoked, true);
});

Deno.test("access integration revoke: no record back is an error while it is still listed as not revoked", async () => {
  for (const state of ["active", "unreadable"]) {
    const serve = fakeServe(() => [], [{ ...LISTED, state }]);
    const log = capturingLog();
    try {
      const error = await assertRejects(() =>
        run(["revoke", "app", "--server", serve.url, "--token", "t.s"])
      ) as Error;
      assertStringIncludes(error.message, `it is listed as ${state}`);
      assertStringIncludes(
        error.message,
        `swamp access integration show app --server ${serve.url}`,
      );
      assertEquals(log.lines.join().includes("alreadyRevoked"), false);
    } finally {
      log.restore();
      await serve.shutdown();
    }
  }
});

Deno.test("access integration ceiling: no record back says to check, on the same server", async () => {
  const serve = fakeServe(() => []);
  try {
    const error = await assertRejects(() =>
      run([
        "ceiling",
        "app",
        "--empty",
        "--server",
        serve.url,
        "--token",
        "t.s",
      ])
    ) as Error;
    assertStringIncludes(error.message, "may or may not have applied");
    assertStringIncludes(
      error.message,
      `swamp access integration show app --server ${serve.url}`,
    );
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration register: the recovery hint leaves out a credential in the server address", async () => {
  const server = frameServer({
    code: "method_execution_failed",
    message: "replication was not confirmed",
  });
  const base = `ws://127.0.0.1:${server.addr.port}/`;
  try {
    const error = await assertRejects(() =>
      run([
        "register",
        "app",
        "--name",
        "App",
        "--empty",
        "--server",
        `${base}?token=secret-in-url`,
        "--token",
        "t.s",
      ])
    ) as Error;
    assertStringIncludes(error.message, "may still have registered");
    assertEquals(error.message.includes("secret-in-url"), false);
  } finally {
    await server.shutdown();
  }
});

Deno.test("access integration ceiling: a failed run is an error in the command's own words", async () => {
  const serve = fakeServe(() => [{
    kind: "completed",
    run: { status: "failed", dataArtifacts: [] },
  }]);
  try {
    await refusal(
      ["ceiling", "app", "--empty", "--server", serve.url, "--token", "t.s"],
      "Changing the ceiling of 'app' failed",
    );
  } finally {
    await serve.shutdown();
  }
});

Deno.test("access integration show: an unknown id is refused", async () => {
  const serve = fakeServe(() => [], []);
  try {
    await refusal(
      ["show", "nope", "--server", serve.url, "--token", "t.s"],
      "does not exist",
    );
  } finally {
    await serve.shutdown();
  }
});

Deno.test("pullLatestForIntegrationChange: pulls the namespace, then drops the cached catalog", async () => {
  const steps: string[] = [];
  await pullLatestForIntegrationChange(
    {
      pullChanged: (options) => {
        steps.push(`pull ${options?.namespace}`);
        return Promise.resolve(0);
      },
    },
    "team",
    { invalidate: () => steps.push("invalidate") },
  );
  assertEquals(steps, ["pull team", "invalidate"]);
});

Deno.test("pullLatestForIntegrationChange: a failed pull stops the change", async () => {
  await assertRejects(
    () =>
      pullLatestForIntegrationChange(
        { pullChanged: () => Promise.reject(new Error("bucket unreachable")) },
        undefined,
        { invalidate: () => {} },
      ),
    Error,
    "bucket unreachable",
  );
});

Deno.test("pullLatestForIntegrationChange: a repo with no sync has nothing to pull", async () => {
  let invalidated = false;
  await pullLatestForIntegrationChange(undefined, undefined, {
    invalidate: () => invalidated = true,
  });
  assertEquals(invalidated, false);
});

Deno.test("access integration: the local path pulls before it reads anything to decide on", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/cli/commands/access_integration.ts", import.meta.url),
  );
  const body = source.slice(
    source.indexOf("async function runIntegrationMethod"),
  );
  const pull = body.indexOf("await pullLatestForIntegrationChange(");
  assert(pull !== -1, "the local path must pull");
  assert(pull < body.indexOf("await listFromRepo(repoContext)"));
  assert(pull < body.indexOf("await findDefinitionByIdOrName("));
});

const noDirty = { markDirty: () => Promise.resolve() };
const revoking = { id: "app", methodName: "revoke", verb: "Revoking" } as const;

Deno.test("runIntegrationChange: a failed push fails the change, and says it can be sent again", async () => {
  let warned = false;
  const error = await assertRejects(
    () =>
      runIntegrationChange(noDirty, revoking, {
        push: () => Promise.reject(new Error("upload refused")),
        onCleanupError: () => warned = true,
      }, () => Promise.resolve()),
    Error,
    "didn't reach the datastore",
  );
  assertStringIncludes(error.message, "upload refused");
  assertStringIncludes(error.message, "Run the same command again");
  assertEquals(warned, true);
});

Deno.test("runIntegrationChange: a register can't be re-sent, so it doesn't say to", async () => {
  const error = await assertRejects(
    () =>
      runIntegrationChange(noDirty, {
        id: "app",
        methodName: "register",
        verb: "Registering",
      }, {
        push: () => Promise.reject(new Error("no")),
      }, () => Promise.resolve()),
    Error,
  );
  assertEquals(error.message.includes("Run the same command"), false);
});

Deno.test("runIntegrationChange: a failed release after a good push is only a warning", async () => {
  let warned = false;
  await runIntegrationChange(noDirty, revoking, {
    push: () => Promise.resolve(),
    release: () => Promise.reject(new Error("release failed")),
    onCleanupError: () => warned = true,
  }, () => Promise.resolve());
  assertEquals(warned, true);
});

Deno.test("runIntegrationChange: a failed run keeps its own error", async () => {
  await assertRejects(
    () =>
      runIntegrationChange(noDirty, revoking, {
        push: () => Promise.resolve(),
      }, () => Promise.reject(new Error("the method refused"))),
    Error,
    "the method refused",
  );
});
