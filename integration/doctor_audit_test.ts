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

// Stream-0 regression net for `swamp doctor audit` on POSIX. Stream B will
// touch shellouts (which/where, xattr, codesign), and Stream C will touch
// signal/env/path code. Pinning the doctor-audit happy path catches a class
// of regressions where a refactor accidentally drops a check or breaks the
// JSON contract.

import { assertEquals } from "@std/assert";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

interface AuditDoctorReport {
  overallStatus: "pass" | "fail" | "warn";
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    message: string;
  }>;
}

Deno.test({
  name:
    "doctor audit (--tool none): runs preflight checks and emits JSON report on POSIX",
  // SIGINT/which/where machinery downstream of this test path differs
  // on Windows. Stream B owns the Windows variant; this pins POSIX.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-doctor-audit-",
    });
    try {
      await initializeTestRepo(repoDir);

      const { stdout, code } = await runCliCommand(
        ["--json", "doctor", "audit", "--tool", "none"],
        repoDir,
      );

      // Find the first `{` so any cliffy bootstrap chatter doesn't break
      // the JSON parse — defensive, matches doctor_extensions_test.ts.
      const firstBrace = stdout.indexOf("{");
      assertEquals(
        firstBrace >= 0,
        true,
        `expected JSON object on stdout; got: ${stdout}`,
      );
      const parsed = JSON.parse(stdout.slice(firstBrace)) as AuditDoctorReport;

      // The overall status must be reported and exit code must reflect it.
      // For `--tool none`, every check should pass or be skipped (no AI
      // tool means no agent config to validate). The exact set of checks
      // is allowed to evolve; what we pin is that at least one preflight
      // check ran AND the JSON contract holds.
      assertEquals(
        parsed.overallStatus === "pass" || parsed.overallStatus === "warn",
        true,
        `expected overallStatus pass/warn for --tool none; got ${parsed.overallStatus} (stdout=${stdout})`,
      );
      assertEquals(
        Array.isArray(parsed.checks),
        true,
        `expected checks array; got: ${JSON.stringify(parsed)}`,
      );
      assertEquals(
        parsed.checks.length > 0,
        true,
        `expected at least one preflight check ran; got: ${
          JSON.stringify(parsed.checks)
        }`,
      );
      // Every check must carry a name and a status from the canonical set.
      for (const check of parsed.checks) {
        assertEquals(
          typeof check.name === "string" && check.name.length > 0,
          true,
          `check missing name: ${JSON.stringify(check)}`,
        );
        assertEquals(
          ["pass", "fail", "skip"].includes(check.status),
          true,
          `check has unexpected status: ${JSON.stringify(check)}`,
        );
      }

      // Exit code 0 when overallStatus is pass/warn (no failures gate CI).
      assertEquals(
        code,
        0,
        `expected exit 0 when overall pass/warn; got code=${code}, stdout=${stdout}`,
      );
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
});
