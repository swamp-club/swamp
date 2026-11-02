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
import { dirname, join, relative } from "@std/path";
import { walk } from "@std/fs/walk";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { runAsUserConfigEdit } from "../src/infrastructure/datastore_v3/config_edit_scope.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  type Client,
  MEMBER,
  readCommand,
  type Scratch,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

const GRANTS: readonly GrantSpec[] = [
  ...MEMBER,
  { actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
];

const SEED_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a11";
const COPY_ID = "1c6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a12";

function userEdit(
  scratch: Scratch,
  client: Client,
  env: Record<string, string | undefined>,
  fn: (repos: RepositoryContext) => Promise<unknown>,
): Promise<unknown> {
  return runAsUserConfigEdit(() => writeCommand(scratch, client, env, fn));
}

async function savedFile(root: string, name: string): Promise<string> {
  for await (const entry of walk(root, { includeDirs: false })) {
    if (entry.name === name) return entry.path;
  }
  throw new Error(`${name} was not saved under ${root}`);
}

// named by id, as a git checkout leaves it; adoption sends it under that id key
async function copyIntoTree(
  client: Client,
  saved: string,
  fileName: string,
  name: { from: string; to: string },
): Promise<void> {
  const base = join(client.repoDir, ".swamp", "config");
  const dir = join(client.repoDir, relative(base, dirname(saved)));
  await Deno.mkdir(dir, { recursive: true });
  const text = await Deno.readTextFile(saved);
  await Deno.writeTextFile(
    join(dir, fileName),
    text.replaceAll(SEED_ID, COPY_ID).replace(
      new RegExp(`^name: ${name.from}$`, "m"),
      `name: ${name.to}`,
    ),
  );
}

Deno.test({
  name:
    "serve upstream: a member renames a behavior serve holds under its id key (swamp-club#4294)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ managedConfig: true });
      const client = await scratch.client("a", {
        bucket: scratch.bucket(),
        managedConfig: true,
      });
      const env = serveEnv(serve, "alice-token");
      const type = serve.modelType;
      await userEdit(
        scratch,
        client,
        env,
        (repos) =>
          repos.definitionRepo.save(
            type,
            Definition.create({
              id: SEED_ID,
              name: "seed",
              globalArguments: {},
            }),
          ),
      );
      await copyIntoTree(
        client,
        await savedFile(client.repoDir, "seed.yaml"),
        `${COPY_ID}.yaml`,
        { from: "seed", to: "producer" },
      );

      await userEdit(scratch, client, env, async (repos) => {
        const found = await repos.definitionRepo.findByName(type, "producer");
        assertEquals(found?.id, COPY_ID);
        await repos.definitionRepo.save(
          type,
          Definition.create({
            id: COPY_ID,
            name: "producer-renamed",
            globalArguments: {},
          }),
        );
      });

      const names = await readCommand(scratch, client, env, async (repos) => [
        (await repos.definitionRepo.findByName(type, "producer"))?.id,
        (await repos.definitionRepo.findByName(type, "producer-renamed"))?.id,
      ]);
      assertEquals(names, [undefined, COPY_ID]);
    });
  },
});

Deno.test({
  name:
    "serve upstream: a member renames a workflow serve holds under its id key (swamp-club#4294)",
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
      const env = serveEnv(serve, "alice-token");
      const workflow = (id: string, name: string) =>
        Workflow.create({
          id,
          name,
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "approve-me",
                  task: StepTask.manualApproval("Approve?"),
                }),
              ],
            }),
          ],
        });
      await userEdit(
        scratch,
        client,
        env,
        (repos) => repos.workflowRepo.save(workflow(SEED_ID, "seed")),
      );
      await copyIntoTree(
        client,
        await savedFile(client.repoDir, "workflow-seed.yaml"),
        `workflow-${COPY_ID}.yaml`,
        { from: "seed", to: "pipeline" },
      );

      await userEdit(scratch, client, env, async (repos) => {
        const found = await repos.workflowRepo.findByName("pipeline");
        assertEquals(found?.id, COPY_ID);
        await repos.workflowRepo.save(workflow(COPY_ID, "pipeline-renamed"));
      });

      const names = await readCommand(scratch, client, env, async (repos) => [
        (await repos.workflowRepo.findByName("pipeline"))?.id,
        (await repos.workflowRepo.findByName("pipeline-renamed"))?.id,
      ]);
      assertEquals(names, [undefined, COPY_ID]);
    });
  },
});
