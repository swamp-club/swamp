// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { registerShutdownHandler } from "./shutdown_handlers.ts";

Deno.test({
  name:
    "registerShutdownHandler: SIGINT delivery invokes handler and dispose cleans up (POSIX)",
  // Self-signaling via Deno.kill(Deno.pid, "SIGINT") cannot run in-process
  // here — it would also wake the parent test runner's own SIGINT
  // listener and tear the suite down. We spawn a child Deno process that
  // registers the handler, raises SIGINT to itself, and prints whether
  // the handler fired before exiting cleanly.
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const moduleUrl = new URL("./shutdown_handlers.ts", import.meta.url).href;
    const program = `
      import { registerShutdownHandler } from "${moduleUrl}";

      let invocations = 0;
      const handle = registerShutdownHandler({
        handler: () => {
          invocations++;
          // After the first SIGINT is observed, dispose and re-register
          // a fresh handler. A second SIGINT must invoke the *new*
          // handler — proving dispose() actually removed the listener.
          handle.dispose();
          const handle2 = registerShutdownHandler({
            handler: () => {
              console.log(JSON.stringify({
                phase: "second",
                first: invocations,
              }));
              handle2.dispose();
              Deno.exit(0);
            },
            includePosixSignals: false,
          });
          // Re-raise SIGINT to exercise the new handler.
          Deno.kill(Deno.pid, "SIGINT");
        },
      });

      // First signal: triggers the dispose-and-rewire flow above.
      setTimeout(() => Deno.kill(Deno.pid, "SIGINT"), 50);

      // Block forever — exit happens inside the second handler.
      await new Promise(() => {});
    `;

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(program));
    } finally {
      await writer.close();
    }

    const status = await Promise.race([
      child.status,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("child did not exit within 5s")),
          5_000,
        );
      }),
    ]);

    const stdout = new TextDecoder().decode(
      await new Response(child.stdout).arrayBuffer(),
    );
    await child.stderr.cancel();

    assertEquals(
      status.code,
      0,
      `expected child to exit 0; got ${status.code}; stdout=${stdout}`,
    );
    // The second handler prints { phase: "second", first: 1 } — proves
    // (a) the original handler fired exactly once, and (b) dispose let
    // the second handler take over.
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    assertEquals(
      last,
      '{"phase":"second","first":1}',
      `unexpected child stdout: ${stdout}`,
    );
  },
});

Deno.test({
  name:
    "registerShutdownHandler: registering on Windows does not throw on SIGTERM/SIGHUP",
  // The whole point of this helper. On Windows, naive
  // `Deno.addSignalListener("SIGTERM", ...)` throws. The helper must
  // suppress those registrations and still return a working handle.
  ignore: Deno.build.os !== "windows",
  fn: () => {
    const handle = registerShutdownHandler({
      handler: () => {},
      includePosixSignals: true,
    });
    // If we got here without throwing, the helper correctly skipped
    // SIGTERM/SIGHUP registration. Dispose must also not throw.
    handle.dispose();
  },
});

Deno.test("registerShutdownHandler: dispose is idempotent", () => {
  const handle = registerShutdownHandler({
    handler: () => {},
    // Use the lock-release shape so this runs cleanly on every OS —
    // SIGINT is universally supported and dispose's `removeSignalListener`
    // is silent when the listener is already gone.
    includePosixSignals: false,
  });
  handle.dispose();
  // Second call must be a no-op, not a throw.
  handle.dispose();
});

Deno.test("registerShutdownHandler: SIGINT-only mode registers without throwing", () => {
  // Pin the lock-release fast-path shape used by the datastore sync
  // coordinator: SIGINT-only registration must succeed on every OS,
  // including Windows where SIGTERM/SIGHUP are unsupported.
  const handle = registerShutdownHandler({
    handler: () => {},
    includePosixSignals: false,
  });
  handle.dispose();
});
