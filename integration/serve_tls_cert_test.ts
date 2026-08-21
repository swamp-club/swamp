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

import { assert, assertStringIncludes } from "@std/assert";
import { diagnoseTlsError } from "../src/cli/remote_run.ts";

async function run(cmd: string, args: string[]): Promise<void> {
  const p = new Deno.Command(cmd, { args, stdout: "null", stderr: "null" });
  const { success } = await p.output();
  if (!success) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

async function withTlsServer(
  cert: string,
  key: string,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const ac = new AbortController();
  const port = await new Promise<number>((resolve) => {
    Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      cert,
      key,
      signal: ac.signal,
      onListen({ port: p }) {
        resolve(p);
      },
    }, (req) => {
      if (req.headers.get("upgrade") === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onopen = () => {
          socket.send("ok");
          socket.close();
        };
        return response;
      }
      return new Response("OK");
    });
  });
  try {
    await fn(port);
  } finally {
    ac.abort();
  }
}

Deno.test("diagnoseTlsError: detects CaUsedAsEndEntity for CA:TRUE self-signed cert", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-keyout",
      `${tmpDir}/server.key`,
      "-out",
      `${tmpDir}/server.crt`,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ]);
    const cert = await Deno.readTextFile(`${tmpDir}/server.crt`);
    const key = await Deno.readTextFile(`${tmpDir}/server.key`);

    await withTlsServer(cert, key, async (port) => {
      const diagnosis = await diagnoseTlsError(`wss://127.0.0.1:${port}/`);
      assert(diagnosis !== undefined, "Expected a TLS diagnosis");
      assertStringIncludes(diagnosis, "CA:TRUE");
      assertStringIncludes(diagnosis, "basicConstraints");
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("diagnoseTlsError: detects UnknownIssuer for untrusted CA:FALSE cert", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-keyout",
      `${tmpDir}/server.key`,
      "-out",
      `${tmpDir}/server.crt`,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ]);
    const cert = await Deno.readTextFile(`${tmpDir}/server.crt`);
    const key = await Deno.readTextFile(`${tmpDir}/server.key`);

    await withTlsServer(cert, key, async (port) => {
      const diagnosis = await diagnoseTlsError(`wss://127.0.0.1:${port}/`);
      assert(diagnosis !== undefined, "Expected a TLS diagnosis");
      assertStringIncludes(diagnosis, "not trusted");
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("diagnoseTlsError: returns undefined for non-wss URL", async () => {
  const diagnosis = await diagnoseTlsError("ws://127.0.0.1:4000/");
  assert(diagnosis === undefined, "Expected no diagnosis for ws:// URL");
});

Deno.test("diagnoseTlsError: returns error for unreachable host", async () => {
  const diagnosis = await diagnoseTlsError("wss://127.0.0.1:1/");
  assert(diagnosis !== undefined, "Expected a diagnosis for unreachable host");
  assertStringIncludes(diagnosis, "TLS connection failed");
});
