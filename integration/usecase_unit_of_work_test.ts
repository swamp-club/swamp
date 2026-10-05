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

/**
 * Units of work for the write use cases the characterization suites don't
 * reach (swamp-club#3025). Each row runs through `runRow`, which builds every
 * repository-bound unit in reject mode and checks that the use cases' units
 * staged exactly the marks they made. Here each row must also have marked
 * something inside a use case, so the check cannot pass vacuously.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { saveData, saveModel, saveWorkflow } from "./serve_request_harness.ts";
import {
  type AnyRow,
  cacheDir,
  type Composition,
  row,
  type RowRepos,
  runCli,
  runRow,
  UNSET_ENV,
} from "./usecase_sync_fixtures.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

async function workflowSeed(repos: RowRepos): Promise<void> {
  const model = await saveModel(repos.serveRepo, "m1");
  await saveWorkflow(repos.serveRepo, "wf1", model);
}

const ROWS: AnyRow[] = [
  row({
    name: "model method run",
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({
      args: ["model", "method", "run", "m1", "noop", ...json(repos)],
    }),
    serve: () => ({
      type: "model.method.run",
      payload: { modelIdOrName: "m1", methodName: "noop" },
    }),
  }),
  row({
    name: "workflow run",
    seed: workflowSeed,
    cli: (repos) => ({ args: ["workflow", "run", "wf1", ...json(repos)] }),
    serve: () => ({
      type: "workflow.run",
      payload: { workflowIdOrName: "wf1" },
    }),
  }),
  row({
    name: "data delete (batch)",
    seed: async (repos) => {
      const model = await saveModel(repos.serveRepo, "m1");
      await saveData(repos.serveRepo, model, "state-a");
      await saveData(repos.serveRepo, model, "state-b");
    },
    cli: (repos) => ({
      args: ["data", "delete", "m1", "--all", "--force", ...json(repos)],
    }),
    serve: null,
  }),
  row({
    name: "run gc",
    seed: async (repos) => {
      await workflowSeed(repos);
      await runCli({ args: ["workflow", "run", "wf1", ...json(repos)] });
      // Run GC collects a finished run whose file mtime and completedAt are
      // both past the retention cutoff: make the run a month old.
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const runsDir = join(cacheDir(repos.repoA), "workflow-runs");
      for await (const entry of walk(runsDir, { includeDirs: false })) {
        const yaml = await Deno.readTextFile(entry.path);
        await Deno.writeTextFile(
          entry.path,
          yaml.replace(
            /^(\s*(?:startedAt|completedAt): ).*$/gm,
            `$1'${monthAgo.toISOString()}'`,
          ),
        );
        await Deno.utime(entry.path, monthAgo, monthAgo);
      }
    },
    cli: null,
    serve: () => ({
      type: "run.gc",
      payload: { workflowRunRetentionDays: 1, outputRetentionDays: 1 },
    }),
  }),
  row({
    name: "access token rotate",
    seed: async (repos) => {
      await runCli({
        args: [
          "access",
          "token",
          "mint",
          "tok1",
          "--principal",
          "user:adam",
          ...json(repos),
        ],
      });
    },
    cli: (repos) => ({
      args: ["access", "token", "rotate", "tok1", ...json(repos)],
    }),
    serve: () => ({ type: "access.token.rotate", payload: { name: "tok1" } }),
  }),
];

for (const useCase of ROWS) {
  for (const composition of ["cli", "serve"] as Composition[]) {
    if (useCase[composition] === null) continue;
    Deno.test(`use case unit of work: ${useCase.name} (${composition}) stages every mark it makes`, async () => {
      const observed = await withMockedEnv(
        UNSET_ENV,
        () => runRow(useCase, composition),
      );
      const outside = useCase.outsideUseCase?.[composition] ?? [];
      const inUseCase = observed.ops.filter((op) =>
        op.startsWith("markDirty") && !outside.includes(op)
      );
      assertEquals(
        inUseCase.length > 0,
        true,
        `${useCase.name} (${composition}) marked nothing inside a use case: ` +
          JSON.stringify(observed.ops),
      );
    });
  }
}
