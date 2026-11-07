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
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Command } from "@cliffy/command";
import { modelDeleteCommand } from "../src/cli/commands/model_delete.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { serveUpstreamRunsLocally } from "../src/cli/serve_upstream.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type Client,
  dataOf,
  endCommand,
  json,
  latestOf,
  MEMBER,
  readCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

async function deleteBehavior(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  name: string,
): Promise<void> {
  const root = registerCompletionTypes(
    new Command()
      .noExit()
      .globalOption("--json", "JSON output"),
  ).command("model", new Command().command("delete", modelDeleteCommand));
  setImplicitServeRouting(!serveUpstreamRunsLocally(["model", "delete"]));
  const log = console.log;
  console.log = () => {};
  try {
    await withClientEnv(
      scratch,
      env,
      ["model", "delete"],
      () =>
        root.parse([
          "model",
          "delete",
          name,
          "--force",
          "--json",
          "--repo-dir",
          client.repoDir,
        ]),
    );
  } finally {
    console.log = log;
    resetImplicitServeRouting();
    await endCommand();
  }
}

async function withData(
  scratch: Scratch,
  serve: Serve,
  member: Client,
): Promise<void> {
  await writeCommand(
    scratch,
    member,
    serveEnv(serve, "alice-token"),
    (repos) =>
      repos.unifiedDataRepo.save(
        serve.modelType,
        serve.models.web,
        dataOf("vpc"),
        json({ cidr: "10.0.0.0/16" }),
      ),
  );
}

Deno.test({
  name:
    "serve upstream delete: a member who may delete a behavior's data but not the behavior deletes nothing, and is told why",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        managedConfig: true,
        grants: [
          ...MEMBER,
          {
            user: "bob",
            actions: ["read", "run"],
            kind: "model",
            pattern: "*",
          },
          {
            user: "bob",
            actions: ["read", "write"],
            kind: "data",
            pattern: "*",
          },
        ],
      });
      const member = await scratch.client("a", { managedConfig: true });
      await withData(scratch, serve, member);
      const bob = serveEnv(serve, "bob-token");

      const refused = await assertRejects(() =>
        deleteBehavior(scratch, member, bob, "web")
      );
      assert(String(refused).includes("Not authorized"), String(refused));

      const kept = await readCommand(
        scratch,
        member,
        bob,
        (repos) => latestOf(repos, serve.modelType, serve.models.web, "vpc"),
      );
      assertEquals(kept?.content, JSON.stringify({ cidr: "10.0.0.0/16" }));
    });
  },
});

Deno.test({
  name:
    "serve upstream delete: a member with every grant it needs deletes the behavior and its data",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ managedConfig: true });
      const member = await scratch.client("a", { managedConfig: true });
      await withData(scratch, serve, member);
      const alice = serveEnv(serve, "alice-token");

      await deleteBehavior(scratch, member, alice, "web");

      const gone = await readCommand(
        scratch,
        member,
        alice,
        (repos) =>
          repos.definitionRepo.findById(
            serve.modelType,
            createDefinitionId(serve.models.web),
          ),
      );
      assertEquals(gone, null);
    });
  },
});
