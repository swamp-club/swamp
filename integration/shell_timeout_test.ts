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

/**
 * In-repo regression guard for swamp-club#247: built-in command/shell must
 * honor `--timeout` end-to-end. Drives the CLI binary against a long-running
 * shell command and asserts the run aborts well before the natural sleep
 * duration. Catches regressions in PRs before swamp-uat picks them up on
 * a separate release cadence.
 */

import { assertEquals } from "@std/assert";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-shell-timeout-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test({
  name:
    "CLI: --timeout aborts a long-running command/shell run well before completion",
  // Uses POSIX `sleep`. PowerShell variant via `Start-Sleep` is plausible
  // but would need a separate model definition; defer until needed.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await initializeTestRepo(repoDir);

      // Sleep 30s — picked so a working --timeout cannot be confused with
      // natural completion under any reasonable CI jitter.
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const definition = Definition.create({
        name: "long-sleep",
        methods: {
          execute: {
            arguments: {
              run: "sleep 30",
              workingDir: "/tmp",
            },
          },
        },
      });
      await definitionRepo.save(SHELL_MODEL_TYPE, definition);

      const start = performance.now();
      const result = await runCliCommand(
        [
          "model",
          "method",
          "run",
          "long-sleep",
          "execute",
          "--repo-dir",
          repoDir,
          "--timeout",
          "1s",
          "--json",
        ],
        Deno.cwd(),
      );
      const elapsed = performance.now() - start;

      // Non-zero exit confirms the run did not complete naturally.
      assertEquals(
        result.code !== 0,
        true,
        `expected non-zero exit on --timeout abort, got ${result.code}. ` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      // Generous 10s ceiling absorbs CI jitter and CLI startup time
      // (worktree may need to compile fresh deps); still well below the
      // 30s natural duration that would indicate the abort never fired.
      assertEquals(
        elapsed < 10_000,
        true,
        `expected --timeout to abort within 10s, took ${elapsed.toFixed(0)}ms`,
      );
      // The output should mention the abort/cancellation. The exact
      // envelope shape (`code: "cancelled"` vs generic
      // `method_execution_failed`) depends on libswamp's TimeoutError
      // handling — match loosely so this guards the user-visible
      // contract without pinning the wire format.
      // The JSON envelope must carry `code: "cancelled"` so callers can
      // distinguish a deadline abort from a generic execution failure.
      // Without the driver-layer AbortError preservation, this surfaces
      // as `method_execution_failed` and the contract regresses.
      const envelope = JSON.parse(result.stdout) as {
        code?: string;
        error?: string;
      };
      assertEquals(
        envelope.code,
        "cancelled",
        `expected envelope.code === "cancelled", got ${envelope.code}. ` +
          `full stdout: ${result.stdout}`,
      );
    });
  },
});
