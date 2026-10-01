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
 * Use-case sync characterization, data rows (swamp-club#2860). See
 * `usecase_sync_fixtures.ts` for how each row runs and what is observed.
 */

import "../src/domain/models/models.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { saveData, saveModel } from "./serve_request_harness.ts";
import {
  type AnyRow,
  checkRows,
  type PinnedRow,
  row,
  type RowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

/** Saves `versions` versions of `name` keeping only the newest. */
async function saveVersions(
  repos: RowRepos,
  model: Definition,
  name: string,
  versions: number,
): Promise<void> {
  for (let i = 0; i < versions; i++) {
    const data = Data.create({
      name,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 1,
      tags: { type: "resource", modelName: model.name },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${repos.modelType.normalized}:${model.id}`,
      },
    });
    await repos.a.repoContext.unifiedDataRepo.save(
      repos.modelType,
      model.id,
      data,
      new TextEncoder().encode(JSON.stringify({ i })),
    );
  }
}

const ROWS: AnyRow[] = [
  row({
    name: "data delete",
    seed: async (repos) => {
      const model = await saveModel(repos.serveRepo, "m1");
      await saveData(repos.serveRepo, model, "state");
    },
    cli: (repos) => ({
      args: ["data", "delete", "m1", "state", "--force", ...json(repos)],
    }),
    serve: () => ({
      type: "data.delete",
      payload: { modelIdOrName: "m1", dataName: "state" },
    }),
  }),
  row({
    name: "data rename",
    seed: async (repos) => {
      const model = await saveModel(repos.serveRepo, "m1");
      await saveData(repos.serveRepo, model, "state");
    },
    cli: (repos) => ({
      args: ["data", "rename", "m1", "state", "renamed", ...json(repos)],
    }),
    serve: () => ({
      type: "data.rename",
      payload: { modelIdOrName: "m1", oldName: "state", newName: "renamed" },
    }),
  }),
  row({
    name: "data gc",
    // collectGarbage removes versions in parallel batches, so it marks them
    // in filesystem order.
    parallelMarks: true,
    seed: async (repos) => {
      const model = await saveModel(repos.serveRepo, "m1");
      await saveVersions(repos, model, "state", 3);
    },
    cli: (repos) => ({ args: ["data", "gc", "--force", ...json(repos)] }),
    serve: () => ({ type: "data.gc", payload: {} }),
  }),
  row({
    name: "data prune",
    seed: async (repos) => {
      // Data whose model definition was never saved is orphaned.
      const orphan = Definition.create({ name: "gone", globalArguments: {} });
      await saveData(repos.serveRepo, orphan, "state");
    },
    cli: (repos) => ({ args: ["data", "prune", "--force", ...json(repos)] }),
    serve: () => ({ type: "data.prune", payload: {} }),
  }),
];

/**
 * Today's behaviour, one entry per row. Every divergence and gap noted
 * below was deliberately left unfixed: datastore refactor phase 2 moves
 * unit-of-work ownership into the use cases and is expected to change these
 * rows, and should update this table as it does.
 */
const EXPECTED: Record<string, PinnedRow> = {
  "data delete": {
    // The model-lock acquisition pulls and its flush pushes two-phase
    // (prepare/commit); serve neither pulls nor goes two-phase, pushing once
    // from the handler. Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty data/<type>/<id>/state/1",
        "markDirty data/<type>/<id>/state/latest",
        "prepare[0 del 3]",
        "commit[0 del 3]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/<type>/<id>/state/1/metadata.yaml",
          "data/<type>/<id>/state/1/raw",
          "data/<type>/<id>/state/latest",
        ],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty data/<type>/<id>/state/1",
        "markDirty data/<type>/<id>/state/latest",
        "push[0 del 3]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/<type>/<id>/state/1/metadata.yaml",
          "data/<type>/<id>/state/1/raw",
          "data/<type>/<id>/state/latest",
        ],
        "changed": [],
      },
    },
  },
  "data rename": {
    // Same shape as data delete: lock pull, then a two-phase flush. Datastore
    // refactor phase 2 is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty data/<type>/<id>/state",
        "markDirty data/<type>/<id>/renamed",
        "prepare[6]",
        "commit[6]",
      ],
      "remote": {
        "added": [
          "data/<type>/<id>/renamed/1/metadata.yaml",
          "data/<type>/<id>/renamed/1/raw",
          "data/<type>/<id>/renamed/latest",
          "data/<type>/<id>/state/2/metadata.yaml",
          "data/<type>/<id>/state/2/raw",
        ],
        "removed": [],
        "changed": ["data/<type>/<id>/state/latest"],
      },
    },
    serve: {
      "ops": [
        "markDirty data/<type>/<id>/state",
        "markDirty data/<type>/<id>/renamed",
        "push[6]",
      ],
      "remote": {
        "added": [
          "data/<type>/<id>/renamed/1/metadata.yaml",
          "data/<type>/<id>/renamed/1/raw",
          "data/<type>/<id>/renamed/latest",
          "data/<type>/<id>/state/2/metadata.yaml",
          "data/<type>/<id>/state/2/raw",
        ],
        "removed": [],
        "changed": ["data/<type>/<id>/state/latest"],
      },
    },
  },
  "data gc": {
    // Opened with requireInitializedRepo: the coordinator pulls when the repo
    // registers and pushes single-phase at the teardown flush, unlike data
    // delete's two-phase lock flush. Datastore refactor phase 2 is expected to
    // change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty data/<type>/<id>/state/1",
        "markDirty data/<type>/<id>/state/2",
        "push[0 del 4]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/<type>/<id>/state/1/metadata.yaml",
          "data/<type>/<id>/state/1/raw",
          "data/<type>/<id>/state/2/metadata.yaml",
          "data/<type>/<id>/state/2/raw",
        ],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty data/<type>/<id>/state/1",
        "markDirty data/<type>/<id>/state/2",
        "push[0 del 4]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/<type>/<id>/state/1/metadata.yaml",
          "data/<type>/<id>/state/1/raw",
          "data/<type>/<id>/state/2/metadata.yaml",
          "data/<type>/<id>/state/2/raw",
        ],
        "changed": [],
      },
    },
  },
  "data prune": {
    // As data gc: the coordinator's pull on open and single-phase flush.
    // Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty data/<type>/<id>/state/1",
        "markDirty data/<type>/<id>/state/latest",
        "push[0 del 3]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/<type>/<id>/state/1/metadata.yaml",
          "data/<type>/<id>/state/1/raw",
          "data/<type>/<id>/state/latest",
        ],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty data/<type>/<id>/state/1",
        "markDirty data/<type>/<id>/state/latest",
        "push[0 del 3]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/<type>/<id>/state/1/metadata.yaml",
          "data/<type>/<id>/state/1/raw",
          "data/<type>/<id>/state/latest",
        ],
        "changed": [],
      },
    },
  },
};

Deno.test("use case sync characterization: data use cases mark and push today's paths", async (t) => {
  await checkRows(t, ROWS, EXPECTED);
});
