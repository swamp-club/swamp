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
import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { serveUpstreamRunsLocally } from "../src/cli/serve_upstream.ts";
import {
  type Client,
  endCommand,
  MEMBER,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";
import { runCli, runCliRejecting, withStdin } from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const GRANTS: readonly GrantSpec[] = [
  ...MEMBER,
  { actions: ["read", "write"], kind: "vault", pattern: "*" },
];

async function vault(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  args: string[],
  stdin?: string,
): Promise<Record<string, unknown>> {
  const path = ["vault", args[0]];
  // As startup does for a format-3 checkout.
  setImplicitServeRouting(!serveUpstreamRunsLocally(path));
  try {
    const out = await withClientEnv(
      scratch,
      serveEnv(serve, "alice-token"),
      path,
      () =>
        runCli({
          args: ["vault", ...args, "--json", "--repo-dir", client.repoDir],
          ...(stdin === undefined ? {} : { stdin }),
        }),
    );
    return JSON.parse(out.join("\n"));
  } finally {
    resetImplicitServeRouting();
    await endCommand();
  }
}

Deno.test({
  name:
    "serve upstream: a member renames a local_encryption vault through serve's vault edit (swamp-club#4294)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: GRANTS,
        managedConfig: true,
      });
      const client = await scratch.client("a", {
        bucket: scratch.bucket(),
        managedConfig: true,
      });
      await vault(scratch, serve, client, [
        "create",
        "local_encryption",
        "old-vault",
      ]);
      await vault(scratch, serve, client, [
        "put",
        "old-vault",
        "API_KEY",
        "s3cret",
      ]);
      const config = await vault(scratch, serve, client, ["get", "old-vault"]);

      const yaml = parseYaml(
        stringifyYaml({ ...config, name: "new-vault" }),
      ) as Record<string, unknown>;
      const edited = await vault(
        scratch,
        serve,
        client,
        ["edit", "old-vault"],
        stringifyYaml({
          id: yaml.id,
          name: "new-vault",
          type: yaml.type,
          config: yaml.config ?? {},
          createdAt: yaml.createdAt,
        }),
      );
      assertEquals(edited.name, "new-vault");
      const renamed = await vault(scratch, serve, client, ["get", "new-vault"]);
      assertEquals(renamed.id, config.id);
      const keys = await vault(scratch, serve, client, [
        "list-keys",
        "new-vault",
      ]);
      assertEquals(JSON.stringify(keys).includes("API_KEY"), true);
    });
  },
});

Deno.test({
  name:
    "serve upstream: a member's local_encryption vault rename serve refuses leaves the checkout's secrets under the old name (swamp-club#4294)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: GRANTS,
        managedConfig: true,
      });
      const client = await scratch.client("a", {
        bucket: scratch.bucket(),
        managedConfig: true,
      });
      await vault(scratch, serve, client, [
        "create",
        "local_encryption",
        "old-vault",
      ]);
      await vault(scratch, serve, client, [
        "put",
        "old-vault",
        "API_KEY",
        "s3cret",
      ]);
      const config = await vault(scratch, serve, client, ["get", "old-vault"]);

      const path = ["vault", "edit"];
      setImplicitServeRouting(!serveUpstreamRunsLocally(path));
      try {
        const error = await withClientEnv(
          scratch,
          serveEnv(serve, "alice-token"),
          path,
          () =>
            withStdin(
              stringifyYaml({
                id: config.id,
                name: "new-vault",
                type: config.type,
                // serve keeps a local_encryption key source as it set it
                config: { base_dir: "/elsewhere" },
                createdAt: config.createdAt,
              }),
              () =>
                runCliRejecting({
                  args: [
                    "vault",
                    "edit",
                    "old-vault",
                    "--json",
                    "--repo-dir",
                    client.repoDir,
                  ],
                }),
            ),
        );
        assertStringIncludes(String(error), "vault_edit_failed");
      } finally {
        resetImplicitServeRouting();
        await endCommand();
      }

      const keys = await vault(scratch, serve, client, [
        "list-keys",
        "old-vault",
      ]);
      assertEquals(JSON.stringify(keys).includes("API_KEY"), true);
    });
  },
});
