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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import { upgradeAuthorizationHeaders } from "../src/cli/commands/remote_token_test_helpers.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

await initializeLogging({});

async function parseMethodRun(args: string[]): Promise<void> {
  const { modelMethodRunCommand } = await import(
    "../src/cli/commands/model_method_run.ts"
  );
  const root = registerCompletionTypes(new Command())
    .globalOption("--json", "JSON output")
    .command("run", modelMethodRunCommand);
  await root.parse(["run", "my-model", "echo", "--json", ...args]);
}

function headersFor(
  args: (url: string) => string[],
  env: (url: string) => Record<string, string | undefined>,
): Promise<(string | null)[]> {
  return upgradeAuthorizationHeaders(
    undefined,
    (url) => parseMethodRun(args(url)),
    withMockedEnv,
    (url) => ({ SWAMP_SERVER_TOKEN: "env.secret", ...env(url) }),
  );
}

Deno.test({
  name:
    "behavior method run: SWAMP_SERVER_TOKEN reaches the serve --server, SWAMP_SERVE_URL or SWAMP_SERVER_URL names, never a .swamp.yaml-only one or one SWAMP_SERVER_URL does not pair",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const sent = ["Bearer env.secret"];
    assertEquals(
      await headersFor((url) => ["--server", url], () => ({})),
      sent,
      "--server",
    );
    assertEquals(
      await headersFor(() => [], (url) => ({ SWAMP_SERVE_URL: url })),
      sent,
      "SWAMP_SERVE_URL",
    );
    assertEquals(
      await headersFor(
        (url) => ["--server", url],
        (url) => ({ SWAMP_SERVER_URL: url }),
      ),
      sent,
      "SWAMP_SERVER_URL",
    );
    assertEquals(
      await headersFor(() => [], () => ({})),
      [null],
      ".swamp.yaml only",
    );
    assertEquals(
      await headersFor(
        (url) => ["--server", url],
        () => ({ SWAMP_SERVER_URL: "http://paired.invalid:1" }),
      ),
      [null],
      "paired elsewhere",
    );
  },
});
