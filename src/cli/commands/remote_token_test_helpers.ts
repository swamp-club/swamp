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

import { join } from "@std/path";
import {
  resetImplicitServeRouting,
  resetMarkerServerAddress,
  setMarkerServerAddress,
} from "../remote_run.ts";
import { resetWithheldTokenFiles } from "../../domain/auth/server_login_hint.ts";

/**
 * Runs a remote-capable command against an in-process serve that records the
 * `Authorization` header of each WebSocket upgrade, with
 * `SWAMP_SERVER_TOKEN_FILE` set and no environment address or stored
 * credential. `.swamp.yaml`'s serverAddress names that serve.
 *
 * `run` gets the serve's URL and parses the command; pass `--server` from it
 * or leave the address to the marker. The command's own failure (the serve
 * ends every request at once) is ignored: only the headers matter.
 *
 * `withEnv` is the caller's `withMockedEnv`: this file is not a `_test.ts`
 * file, so it may not import the test helper itself.
 *
 * @returns the Authorization header of each upgrade, `null` when none was sent.
 */
export async function upgradeAuthorizationHeaders(
  tokenFileContent: string,
  run: (serverUrl: string) => Promise<void>,
  withEnv: (
    env: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ) => Promise<void>,
): Promise<(string | null)[]> {
  const headers: (string | null)[] = [];
  const dir = await Deno.makeTempDir({ prefix: "swamp-token-file-binding-" });
  const previousExitCode = Deno.exitCode;
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    const tokenFile = join(dir, "token");
    await Deno.writeTextFile(tokenFile, `${tokenFileContent}\n`);
    server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        headers.push(req.headers.get("authorization"));
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (message) => {
          const request = JSON.parse(message.data as string) as {
            id: string;
          };
          socket.send(JSON.stringify({ type: "done", id: request.id }));
        };
        return response;
      },
    );
    const url = `ws://127.0.0.1:${server.addr.port}`;
    resetWithheldTokenFiles();
    setMarkerServerAddress(url);
    await withEnv({
      SWAMP_SERVE_URL: undefined,
      SWAMP_SERVER_URL: undefined,
      SWAMP_SERVER_TOKEN: undefined,
      SWAMP_SERVER_TOKEN_FILE: tokenFile,
      SWAMP_CONFIG_DIR: dir,
    }, async () => {
      try {
        await run(url);
      } catch {
        // The serve ends the request without a result; only headers matter.
      }
    });
    return headers;
  } finally {
    Deno.exitCode = previousExitCode;
    resetMarkerServerAddress();
    resetImplicitServeRouting();
    resetWithheldTokenFiles();
    await server?.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
