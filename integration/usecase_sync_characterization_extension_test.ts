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
 * Use-case sync characterization, extension rows (swamp-club#2860). See
 * `usecase_sync_fixtures.ts` for how each row runs and what is observed.
 * No row reaches the registry: the lockfile names files that are already
 * on disk in the current layout, so nothing needs pulling.
 */

import "../src/domain/models/models.ts";
import { dirname, join } from "@std/path";
import { resolveManagedLockfileForWrite } from "../src/cli/repo_context.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { markLockfilePublishPending } from "../src/infrastructure/persistence/pending_lockfile_publish.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import {
  type AnyRow,
  checkRows,
  type PinnedRow,
  row,
  type RowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

const EXTENSION = "@test/ext";
const EXTENSION_FILE = ".swamp/pulled-extensions/@test/ext/models/model.ts";
const ENTRY = {
  version: "1.0.0",
  pulledAt: "2026-01-01T00:00:00Z",
  files: [EXTENSION_FILE],
};

/**
 * Records `@test/ext` in A's managed lockfile and puts its one file on
 * disk. With `pending`, also records the entry as not yet published, as an
 * interrupted pull leaves it for `extension install` to publish.
 */
async function installedExtension(
  repos: RowRepos,
  pending: boolean,
): Promise<void> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repos.repoA),
  );
  const { lockfilePath } = await resolveManagedLockfileForWrite(
    repos.repoA,
    marker,
  );
  await Deno.mkdir(dirname(lockfilePath), { recursive: true });
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({ [EXTENSION]: ENTRY }, null, 2),
  );
  const file = join(repos.repoA, ...EXTENSION_FILE.split("/"));
  await Deno.mkdir(dirname(file), { recursive: true });
  await Deno.writeTextFile(file, "export const model = {};\n");
  if (pending) {
    await markLockfilePublishPending(repos.repoA, {
      upserts: { [EXTENSION]: ENTRY },
      removals: [],
    });
  }
}

const ROWS: AnyRow[] = [
  row({
    name: "extension install (publish pending)",
    // The lockfile publish marks the lockfile outside any use case:
    // createDatastoreLockfileSync (CLI) and extensionLockfileTransaction
    // (serve) in PINNED_MARK_CALL_SITES.
    outsideUseCase: {
      cli: ["markDirty config/upstream_extensions.json"],
      serve: ["markDirty config/upstream_extensions.json"],
    },
    options: { managedConfig: true },
    // The seed is the unpublished lockfile change install publishes, so it
    // must not be settled onto the remote first.
    noSettle: true,
    seed: (repos) => installedExtension(repos, true),
    cli: (repos) => ({ args: ["extension", "install", ...json(repos)] }),
    serve: () => ({ type: "extension.install", payload: {} }),
  }),
  row({
    name: "extension install (nothing pending)",
    options: { managedConfig: true },
    cli: (repos) => ({ args: ["extension", "install", ...json(repos)] }),
    serve: () => ({ type: "extension.install", payload: {} }),
  }),
  row({
    name: "extension rm",
    // The lockfile publish marks the lockfile outside any use case:
    // createDatastoreLockfileSync (CLI) and extensionLockfileTransaction
    // (serve) in PINNED_MARK_CALL_SITES.
    outsideUseCase: {
      cli: ["markDirty config/upstream_extensions.json"],
      serve: ["markDirty config/upstream_extensions.json"],
    },
    options: { managedConfig: true },
    seed: (repos) => installedExtension(repos, false),
    cli: (repos) => ({
      args: ["extension", "rm", EXTENSION, "--force", ...json(repos)],
    }),
    serve: () => ({
      type: "extension.rm",
      payload: { extensionName: EXTENSION },
    }),
  }),
];

/**
 * Today's behaviour, one entry per row. Every divergence and gap noted
 * below was deliberately left unfixed: datastore refactor phase 2 moves
 * unit-of-work ownership into the use cases and is expected to change these
 * rows, and should update this table as it does.
 */
const EXPECTED: Record<string, PinnedRow> = {
  "extension install (publish pending)": {
    // Both compositions publish the pending lockfile change by path.
    cli: {
      "ops": [
        "pull[0]",
        "markDirty config/upstream_extensions.json",
        "push[1]",
      ],
      "remote": {
        "added": ["config/upstream_extensions.json"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "pull[0]",
        "markDirty config/upstream_extensions.json",
        "push[1]",
      ],
      "remote": {
        "added": ["config/upstream_extensions.json"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "extension install (nothing pending)": {
    // Nothing pending: only the managed-config pull.
    cli: {
      "ops": ["pull[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
    serve: {
      "ops": ["pull[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "extension rm": {
    // The CLI pulls twice before writing (managed config base resolution and
    // the lockfile transaction); serve pulls once. Datastore refactor phase 2
    // is expected to change this.
    cli: {
      "ops": [
        "pull[0]",
        "pull[0]",
        "markDirty config/upstream_extensions.json",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/upstream_extensions.json"],
      },
    },
    serve: {
      "ops": [
        "pull[0]",
        "markDirty config/upstream_extensions.json",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/upstream_extensions.json"],
      },
    },
  },
};

Deno.test("use case sync characterization: extension use cases mark and push today's paths", async (t) => {
  await checkRows(t, ROWS, EXPECTED);
});
