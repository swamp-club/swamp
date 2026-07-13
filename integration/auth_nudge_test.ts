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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeTestRepo } from "./test_helpers.ts";
import { CLI_ARGS } from "./test_helpers.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";
import {
  AUTH_FIRST_RUN_MESSAGE_LINES,
  AUTH_NUDGE_MESSAGE,
} from "../src/domain/auth/auth_nudge.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-auth-nudge-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function runCliCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
    env: { ...Deno.env.toObject(), ...env },
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test({
  name: "auth nudge: model method run shows nudge for unauthenticated user",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await withTempDir(async (configDir) => {
        await initializeTestRepo(repoDir);
        const definitionRepo = new YamlDefinitionRepository(repoDir);
        await definitionRepo.save(
          SHELL_MODEL_TYPE,
          Definition.create({
            name: "echo-model",
            methods: {
              execute: {
                arguments: { run: "echo hello", workingDir: "/tmp" },
              },
            },
          }),
        );

        const result = await runCliCommand(
          [
            "model",
            "method",
            "run",
            "echo-model",
            "execute",
            "--repo-dir",
            repoDir,
            "--no-telemetry",
          ],
          repoDir,
          { XDG_CONFIG_HOME: configDir, NO_COLOR: "1" },
        );

        assertEquals(result.code, 0, `run failed: ${result.stderr}`);
        const combined = result.stdout + result.stderr;
        assertStringIncludes(combined, AUTH_NUDGE_MESSAGE);
      });
    });
  },
});

Deno.test({
  name: "auth nudge: model method run suppresses nudge for authenticated user",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await withTempDir(async (configDir) => {
        await initializeTestRepo(repoDir);
        const definitionRepo = new YamlDefinitionRepository(repoDir);
        await definitionRepo.save(
          SHELL_MODEL_TYPE,
          Definition.create({
            name: "echo-model",
            methods: {
              execute: {
                arguments: { run: "echo hello", workingDir: "/tmp" },
              },
            },
          }),
        );

        // Simulate authenticated user via SWAMP_API_KEY
        const result = await runCliCommand(
          [
            "model",
            "method",
            "run",
            "echo-model",
            "execute",
            "--repo-dir",
            repoDir,
            "--no-telemetry",
          ],
          repoDir,
          {
            XDG_CONFIG_HOME: configDir,
            NO_COLOR: "1",
            SWAMP_API_KEY: "swamp_test_fake_key",
          },
        );

        assertEquals(result.code, 0, `run failed: ${result.stderr}`);
        const combined = result.stdout + result.stderr;
        assertEquals(
          combined.includes(AUTH_NUDGE_MESSAGE),
          false,
          "nudge should not appear for authenticated users",
        );
      });
    });
  },
});

Deno.test(
  "auth nudge: repo init includes auth login in next steps",
  async () => {
    await withTempDir(async (repoDir) => {
      await withTempDir(async (configDir) => {
        const result = await runCliCommand(
          ["repo", "init", "--tool", "none", "--no-telemetry"],
          repoDir,
          { XDG_CONFIG_HOME: configDir, NO_COLOR: "1" },
        );

        assertEquals(result.code, 0, `init failed: ${result.stderr}`);
        const combined = result.stdout + result.stderr;
        assertStringIncludes(combined, "swamp auth login");
      });
    });
  },
);

Deno.test({
  name:
    "auth nudge: exit banner shows for unauthenticated user and throttles to once per day",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await withTempDir(async (configDir) => {
        await initializeTestRepo(repoDir);

        // First run: first-run nudge should appear in stderr
        const first = await runCliCommand(
          ["version", "--no-telemetry"],
          repoDir,
          { XDG_CONFIG_HOME: configDir, NO_COLOR: "1" },
        );

        assertEquals(first.code, 0, `version failed: ${first.stderr}`);
        assertStringIncludes(
          first.stderr,
          AUTH_FIRST_RUN_MESSAGE_LINES[0],
        );
        assertStringIncludes(first.stderr, "swamp auth login");

        // Second run: nudge should be throttled (already shown today)
        const second = await runCliCommand(
          ["version", "--no-telemetry"],
          repoDir,
          { XDG_CONFIG_HOME: configDir, NO_COLOR: "1" },
        );

        assertEquals(second.code, 0, `version failed: ${second.stderr}`);
        assertEquals(
          second.stderr.includes(AUTH_FIRST_RUN_MESSAGE_LINES[0]),
          false,
          "first-run nudge should not repeat",
        );
        assertEquals(
          second.stderr.includes("Join & participate in the community"),
          false,
          "regular nudge should be throttled on second run within 24h",
        );
      });
    });
  },
});

Deno.test({
  name:
    "auth nudge: exit banner suppressed for auth commands even when unauthenticated",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await withTempDir(async (configDir) => {
        await initializeTestRepo(repoDir);

        const result = await runCliCommand(
          ["auth", "whoami", "--no-telemetry"],
          repoDir,
          { XDG_CONFIG_HOME: configDir, NO_COLOR: "1" },
        );

        const combined = result.stdout + result.stderr;
        assertEquals(
          combined.includes(AUTH_NUDGE_MESSAGE),
          false,
          "nudge should not appear after auth commands",
        );
      });
    });
  },
});

Deno.test({
  name: "auth nudge: exit banner suppressed in --json mode",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await withTempDir(async (configDir) => {
        await initializeTestRepo(repoDir);

        const result = await runCliCommand(
          ["--json", "version", "--no-telemetry"],
          repoDir,
          { XDG_CONFIG_HOME: configDir, NO_COLOR: "1" },
        );

        assertEquals(result.code, 0, `version failed: ${result.stderr}`);
        assertEquals(
          result.stderr.includes("Join & participate in the community"),
          false,
          "nudge should not appear in --json mode",
        );
      });
    });
  },
});
