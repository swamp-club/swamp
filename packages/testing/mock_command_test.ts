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
import { withMockedCommand } from "./mock_command.ts";

// --- Sequential mode ---

Deno.test("withMockedCommand: sequential mode returns outputs in order", async () => {
  const { result, calls } = await withMockedCommand([
    { stdout: "first", code: 0 },
    { stdout: "second", code: 0 },
  ], async () => {
    const c1 = new Deno.Command("echo", { args: ["first"] });
    const c2 = new Deno.Command("echo", { args: ["second"] });
    const o1 = await c1.output();
    const o2 = await c2.output();
    return {
      first: new TextDecoder().decode(o1.stdout),
      second: new TextDecoder().decode(o2.stdout),
    };
  });

  assertEquals(result.first, "first");
  assertEquals(result.second, "second");
  assertEquals(calls.length, 2);
  assertEquals(calls[0].command, "echo");
  assertEquals(calls[0].args, ["first"]);
  assertEquals(calls[1].args, ["second"]);
});

Deno.test("withMockedCommand: sequential mode throws when exhausted", async () => {
  await assertRejects(
    () =>
      withMockedCommand([
        { stdout: "ok", code: 0 },
      ], async () => {
        const c1 = new Deno.Command("cmd1");
        await c1.output();
        const c2 = new Deno.Command("cmd2");
        await c2.output();
      }),
    Error,
    "no more outputs",
  );
});

// --- Handler mode ---

Deno.test("withMockedCommand: handler mode routes by command", async () => {
  const { result } = await withMockedCommand((cmd, args) => {
    if (cmd === "op" && args.includes("read")) {
      return { stdout: "secret-value", code: 0 };
    }
    return { stdout: "", stderr: "unknown command", code: 1 };
  }, async () => {
    const c = new Deno.Command("op", { args: ["read", "op://vault/key"] });
    const out = await c.output();
    return new TextDecoder().decode(out.stdout);
  });

  assertEquals(result, "secret-value");
});

Deno.test("withMockedCommand: handler receives full args", async () => {
  const { calls } = await withMockedCommand(() => {
    return { stdout: "", code: 0 };
  }, async () => {
    const c = new Deno.Command("git", {
      args: ["commit", "-m", "test message"],
    });
    await c.output();
  });

  assertEquals(calls[0].command, "git");
  assertEquals(calls[0].args, ["commit", "-m", "test message"]);
});

// --- Exit code and stderr ---

Deno.test("withMockedCommand: non-zero exit code sets success=false", async () => {
  const { result } = await withMockedCommand([
    { stdout: "", stderr: "not found", code: 1 },
  ], async () => {
    const c = new Deno.Command("failing-cmd");
    const out = await c.output();
    return {
      success: out.success,
      code: out.code,
      stderr: new TextDecoder().decode(out.stderr),
    };
  });

  assertEquals(result.success, false);
  assertEquals(result.code, 1);
  assertEquals(result.stderr, "not found");
});

Deno.test("withMockedCommand: zero exit code sets success=true", async () => {
  const { result } = await withMockedCommand([
    { stdout: "ok", code: 0 },
  ], async () => {
    const c = new Deno.Command("succeeding-cmd");
    const out = await c.output();
    return out.success;
  });

  assertEquals(result, true);
});

// --- Restore ---

Deno.test("withMockedCommand: restores original Deno.Command after success", async () => {
  const OriginalCommand = Deno.Command;
  await withMockedCommand([], () => {});
  assertEquals(Deno.Command, OriginalCommand);
});

Deno.test("withMockedCommand: restores original Deno.Command after error", async () => {
  const OriginalCommand = Deno.Command;
  try {
    await withMockedCommand([], () => {
      throw new Error("test error");
    });
  } catch {
    // expected
  }
  assertEquals(Deno.Command, OriginalCommand);
});

// --- Return value ---

Deno.test("withMockedCommand: returns callback result", async () => {
  const { result } = await withMockedCommand([
    { stdout: "42", code: 0 },
  ], async () => {
    const c = new Deno.Command("echo", { args: ["42"] });
    const out = await c.output();
    return parseInt(new TextDecoder().decode(out.stdout));
  });

  assertEquals(result, 42);
});

// --- Uint8Array input ---

Deno.test("withMockedCommand: accepts Uint8Array stdout", async () => {
  const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const { result } = await withMockedCommand([
    { stdout: bytes, code: 0 },
  ], async () => {
    const c = new Deno.Command("binary-cmd");
    const out = await c.output();
    return out.stdout;
  });

  assertEquals(result, bytes);
});
