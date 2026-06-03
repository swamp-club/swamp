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

import { UserError } from "../../domain/errors.ts";

/** Handle returned by startCallbackServer. */
export interface CallbackServerHandle {
  /** The localhost port the server is listening on. */
  port: number;
  /** Resolves with the session token once the browser redirects back. */
  token: Promise<string>;
  /** Shut down the server. */
  shutdown(): Promise<void>;
}

const ERROR_HTML = `<!DOCTYPE html>
<html>
<head><title>swamp CLI</title></head>
<body style="background:#000;color:#ff4444;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h1 style="font-size:2rem">Authentication failed</h1>
<p>State mismatch — possible CSRF attack. Please try again.</p>
</div>
</body>
</html>`;

const TIMEOUT_MS = 120_000;

/**
 * Start an ephemeral localhost HTTP server that waits for a single
 * callback from the browser containing a session token.
 *
 * @param expectedState  The random state nonce the CLI generated.
 * @param serverUrl      The swamp-club server URL used to build the success redirect.
 */
export function startCallbackServer(
  expectedState: string,
  serverUrl: string,
): CallbackServerHandle {
  let resolveToken: (token: string) => void;
  let rejectToken: (err: Error) => void;

  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const ac = new AbortController();

  // Timeout: reject if the browser never comes back
  const timer = setTimeout(() => {
    rejectToken(
      new UserError(
        "Login timed out — no callback received within 2 minutes.",
      ),
    );
    ac.abort();
  }, TIMEOUT_MS);

  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen() {} },
    (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }

      const token = url.searchParams.get("token");
      const state = url.searchParams.get("state");

      if (state !== expectedState) {
        return new Response(ERROR_HTML, {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (!token) {
        return new Response(ERROR_HTML, {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      clearTimeout(timer);
      resolveToken(token);

      const successUrl = `${serverUrl}/cli/success`;
      return new Response(null, {
        status: 302,
        headers: { Location: successUrl },
      });
    },
  );

  const port = (server.addr as Deno.NetAddr).port;

  return {
    port,
    token: tokenPromise,
    async shutdown() {
      clearTimeout(timer);
      // Brief delay so the 302 redirect response flushes to the browser
      // before we tear down the server.
      await new Promise((r) => setTimeout(r, 500));
      ac.abort();
      await server.finished;
    },
  };
}
