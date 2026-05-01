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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { NoToolConfiguredError } from "../../libswamp/mod.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("doctorAuditCommand module loads", async () => {
  const mod = await import("./doctor_audit.ts");
  assertEquals(typeof mod.doctorAuditCommand, "object");
});

Deno.test("doctorAuditCommand is registered as subcommand of doctorCommand", async () => {
  const { doctorCommand } = await import("./doctor.ts");
  const commands = doctorCommand.getCommands();
  const auditCmd = commands.find((c) => c.getName() === "audit");
  assertEquals(auditCmd !== undefined, true);
});

Deno.test("doctorAuditCommand has the expected option set", async () => {
  const { doctorAuditCommand } = await import("./doctor_audit.ts");
  const options = doctorAuditCommand.getOptions();
  const names = options.map((o) => o.name);
  // Must expose --tool and --repo-dir; inherits --json from the global context
  if (!names.includes("tool")) {
    throw new Error(`expected --tool option, got: ${names.join(", ")}`);
  }
  if (!names.includes("repo-dir")) {
    throw new Error(`expected --repo-dir option, got: ${names.join(", ")}`);
  }
});

Deno.test(
  "resolveTargetTool: returns flag tool when explicit override is provided",
  async () => {
    const { resolveTargetTool } = await import("./doctor_audit.ts");
    assertEquals(resolveTargetTool("kiro", "claude"), "kiro");
  },
);

Deno.test(
  "resolveTargetTool: falls back to marker tool when no flag provided",
  async () => {
    const { resolveTargetTool } = await import("./doctor_audit.ts");
    assertEquals(resolveTargetTool(undefined, "cursor"), "cursor");
  },
);

Deno.test(
  "resolveTargetTool: throws NoToolConfiguredError when neither flag nor marker has a tool",
  async () => {
    const { resolveTargetTool } = await import("./doctor_audit.ts");
    assertThrows(
      () => resolveTargetTool(undefined, undefined),
      NoToolConfiguredError,
    );
  },
);

Deno.test(
  "resolveTargetTool: flag value is validated against the AiTool union (rejects garbage)",
  async () => {
    const { resolveTargetTool } = await import("./doctor_audit.ts");
    // Arbitrary strings must fail validation, not silently pass through
    assertThrows(
      () => resolveTargetTool("not-a-tool", "kiro"),
      UserError,
    );
  },
);

Deno.test(
  "resolveTargetTool: flag wins even when marker is set",
  async () => {
    const { resolveTargetTool } = await import("./doctor_audit.ts");
    assertEquals(resolveTargetTool("opencode", "kiro"), "opencode");
  },
);

Deno.test(
  "resolveTargetTool: accepts the audit-skip tools (codex/copilot/none) as valid overrides",
  async () => {
    const { resolveTargetTool } = await import("./doctor_audit.ts");
    // The service short-circuits these to skip; the CLI must still accept them
    // as valid --tool values so the user can explicitly check them.
    assertEquals(resolveTargetTool("codex", undefined), "codex");
    assertEquals(resolveTargetTool("copilot", undefined), "copilot");
    assertEquals(resolveTargetTool("none", undefined), "none");
  },
);

function makeStdinPipedCommand(args: string[]): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
}

Deno.test(
  "runChildWithAbort: throws AbortError without spawning when signal is already aborted",
  async () => {
    const { runChildWithAbort } = await import("./doctor_audit.ts");
    const controller = new AbortController();
    controller.abort();
    // Use deno itself as a stand-in process — but it should never be spawned
    // because the function must short-circuit on the pre-aborted signal.
    const cmd = makeStdinPipedCommand([
      "eval",
      "console.log('should not run')",
    ]);
    await assertRejects(
      () => runChildWithAbort(cmd, "", controller.signal),
      DOMException,
      "doctor audit aborted",
    );
  },
);

Deno.test(
  "runChildWithAbort: aborting a SIGTERM-respecting child terminates it promptly",
  // SIGTERM is not a portable kill signal on Windows; the underlying Deno
  // ChildProcess.kill semantics differ. The bug being fixed is POSIX-only.
  { ignore: Deno.build.os === "windows" },
  async () => {
    const { runChildWithAbort } = await import("./doctor_audit.ts");
    const controller = new AbortController();
    // A child that blocks for 30s so we control its lifetime; default
    // SIGTERM handling exits the child immediately.
    const cmd = makeStdinPipedCommand([
      "eval",
      "await new Promise((r) => setTimeout(r, 30_000));",
    ]);
    const start = performance.now();
    setTimeout(() => controller.abort(), 100);
    const result = await runChildWithAbort(cmd, "", controller.signal);
    const elapsed = performance.now() - start;
    // A well-behaved child dies on SIGTERM in well under a second.
    if (elapsed > 2_000) {
      throw new Error(
        `expected SIGTERM-responding child to exit promptly; took ${elapsed}ms`,
      );
    }
    // SIGTERM exit on POSIX yields code 143 (128 + 15) or similar non-zero.
    assertEquals(result.exitCode === 0, false);
  },
);

Deno.test(
  "runChildWithAbort: escalates to SIGKILL when child traps SIGTERM",
  { ignore: Deno.build.os === "windows" },
  async () => {
    const { runChildWithAbort } = await import("./doctor_audit.ts");
    const controller = new AbortController();
    // Child registers a no-op SIGTERM handler so SIGTERM alone won't
    // terminate it; only SIGKILL will. Tight escalation window keeps the
    // test fast.
    const cmd = makeStdinPipedCommand([
      "eval",
      "Deno.addSignalListener('SIGTERM', () => {}); " +
      "await new Promise((r) => setTimeout(r, 30_000));",
    ]);
    const start = performance.now();
    setTimeout(() => controller.abort(), 100);
    const result = await runChildWithAbort(cmd, "", controller.signal, {
      sigkillAfterMs: 200,
    });
    const elapsed = performance.now() - start;
    // SIGTERM lands at ~100ms, SIGKILL ~200ms later, plus reaping slack.
    if (elapsed > 2_000) {
      throw new Error(
        `expected SIGKILL escalation to terminate child; took ${elapsed}ms`,
      );
    }
    assertEquals(result.exitCode === 0, false);
  },
);
