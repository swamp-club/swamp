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
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import {
  type RotateTokenResult,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import {
  registerTokenRotationHandler,
  type WorkerCredential,
} from "./token_rotation_handler.ts";

function channelPair(): { worker: RpcChannel; orchestrator: RpcChannel } {
  const worker: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => orchestrator.handleRaw(data)),
  });
  const orchestrator: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => worker.handleRaw(data)),
  });
  return { worker, orchestrator };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-token-rotation-" });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

let nextMint = 1;

function rotate(
  orchestrator: RpcChannel,
  token: string,
  mintMs: number = nextMint++,
) {
  return orchestrator.call<RotateTokenResult>(WorkerMethod.rotateToken, {
    token,
    expiresAtMs: Date.parse("2027-01-01T00:00:00.000Z"),
    mintMs,
  });
}

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  const error = await assertRejects(() => promise, RpcError);
  return error.code;
}

Deno.test("registerTokenRotationHandler: writes the successor to the token file, keeping its mode, and swaps the credential", async () => {
  await withTempDir(async (dir) => {
    const tokenFile = join(dir, "token");
    await Deno.writeTextFile(tokenFile, "web-01.old\n");
    if (Deno.build.os !== "windows") await Deno.chmod(tokenFile, 0o640);
    const { worker, orchestrator } = channelPair();
    const credential: WorkerCredential = { token: "web-01.old" };
    registerTokenRotationHandler({ channel: worker, credential, tokenFile });

    assertEquals(await rotate(orchestrator, "web-01.new"), {
      persisted: true,
    });
    assertEquals(credential.token, "web-01.new");
    assertEquals(await Deno.readTextFile(tokenFile), "web-01.new\n");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(tokenFile)).mode! & 0o777, 0o640);
    }
  });
});

Deno.test("registerTokenRotationHandler: a symlinked token file keeps its link", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const target = join(dir, "real-token");
    const link = join(dir, "token");
    await Deno.writeTextFile(target, "web-01.old\n");
    await Deno.symlink(target, link, { type: "file" });
    const { worker, orchestrator } = channelPair();
    registerTokenRotationHandler({
      channel: worker,
      credential: { token: "web-01.old" },
      tokenFile: link,
    });

    await rotate(orchestrator, "web-01.new");
    assertEquals((await Deno.lstat(link)).isSymlink, true);
    assertEquals(await Deno.readTextFile(target), "web-01.new\n");
  });
});

Deno.test("registerTokenRotationHandler: without a token file the successor is held in memory only", async () => {
  const { worker, orchestrator } = channelPair();
  const credential: WorkerCredential = { token: "web-01.old" };
  registerTokenRotationHandler({ channel: worker, credential });

  assertEquals(await rotate(orchestrator, "web-01.new"), { persisted: false });
  assertEquals(credential.token, "web-01.new");
});

Deno.test("registerTokenRotationHandler: refuses a token issued under another name", async () => {
  let writes = 0;
  const { worker, orchestrator } = channelPair();
  const credential: WorkerCredential = { token: "web-01.old" };
  registerTokenRotationHandler({
    channel: worker,
    credential,
    tokenFile: "/unused",
    writeTokenFile: () => {
      writes++;
      return Promise.resolve();
    },
  });

  assertEquals(
    await refusalCode(rotate(orchestrator, "web-02.new")),
    "token_rename_refused",
  );
  assertEquals(credential.token, "web-01.old");
  assertEquals(writes, 0);
});

Deno.test("registerTokenRotationHandler: refuses a malformed token before touching the file", async () => {
  let writes = 0;
  const { worker, orchestrator } = channelPair();
  const credential: WorkerCredential = { token: "web-01.old" };
  registerTokenRotationHandler({
    channel: worker,
    credential,
    tokenFile: "/unused",
    writeTokenFile: () => {
      writes++;
      return Promise.resolve();
    },
  });

  for (const bad of ["web-01.", ".secret", "no-dot"]) {
    assertEquals(
      await refusalCode(rotate(orchestrator, bad)),
      "invalid_token",
    );
  }
  assertEquals(
    await refusalCode(
      orchestrator.call(WorkerMethod.rotateToken, { token: "" }),
    ),
    "invalid_params",
  );
  assertEquals(
    await refusalCode(rotate(orchestrator, "web-01.new\nextra")),
    "invalid_params",
  );
  assertEquals(credential.token, "web-01.old");
  assertEquals(writes, 0);
});

Deno.test("registerTokenRotationHandler: a token file it cannot write still takes the successor in memory", async () => {
  const { worker, orchestrator } = channelPair();
  const credential: WorkerCredential = { token: "web-01.old" };
  registerTokenRotationHandler({
    channel: worker,
    credential,
    tokenFile: "/read-only/token",
    writeTokenFile: () =>
      Promise.reject(new Deno.errors.PermissionDenied("read-only")),
  });

  assertEquals(await rotate(orchestrator, "web-01.new"), { persisted: false });
  assertEquals(credential.token, "web-01.new");
});

Deno.test("registerTokenRotationHandler: an older successor arriving late never replaces a newer one", async () => {
  const written: string[] = [];
  const { worker, orchestrator } = channelPair();
  const credential: WorkerCredential = { token: "web-01.old" };
  registerTokenRotationHandler({
    channel: worker,
    credential,
    tokenFile: "/token",
    writeTokenFile: (_path, token) => {
      written.push(token);
      return Promise.resolve();
    },
  });

  assertEquals(await rotate(orchestrator, "web-01.b", 200), {
    persisted: true,
  });
  assertEquals(await rotate(orchestrator, "web-01.a", 100), {
    persisted: true,
  });
  assertEquals(credential.token, "web-01.b");
  assertEquals(written, ["web-01.b"]);
});

Deno.test("registerTokenRotationHandler: concurrent successors are written one at a time, in arrival order", async () => {
  const events: string[] = [];
  const release = Promise.withResolvers<void>();
  const { worker, orchestrator } = channelPair();
  const credential: WorkerCredential = { token: "web-01.old" };
  registerTokenRotationHandler({
    channel: worker,
    credential,
    tokenFile: "/token",
    writeTokenFile: async (_path, token) => {
      events.push(`start ${token}`);
      if (token === "web-01.a") await release.promise;
      events.push(`end ${token}`);
    },
  });

  const first = rotate(orchestrator, "web-01.a", 100);
  const second = rotate(orchestrator, "web-01.b", 200);
  await waitFor(() => events.length === 1, "first write started");
  release.resolve();
  await Promise.all([first, second]);

  assertEquals(events, [
    "start web-01.a",
    "end web-01.a",
    "start web-01.b",
    "end web-01.b",
  ]);
  assertEquals(credential.token, "web-01.b");
});
