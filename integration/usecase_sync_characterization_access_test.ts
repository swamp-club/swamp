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
import { queryGrants } from "../src/cli/commands/access_grant.ts";
import { initializeControlPlaneVaultForCli } from "../src/cli/control_plane_vault.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { WORKER_MODEL_TYPE } from "../src/domain/models/worker/worker_model.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { saveModel } from "./serve_request_harness.ts";
import {
  type AnyRow,
  checkRows,
  type Composition,
  type PinnedRow,
  row,
  type RowRepos,
  runCli,
} from "./usecase_sync_fixtures.ts";
import { checkRowsOnV3 } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

const HOUR_MS = 60 * 60_000;

async function createGrant(repos: RowRepos): Promise<string> {
  await runCli({
    args: [
      "access",
      "grant",
      "create",
      "--subject",
      "user:adam",
      "--allow",
      "run",
      "--on",
      "workflow:*",
      ...json(repos),
    ],
  });
  // A fresh context, so the catalog sees the grant the command wrote.
  const { repoContext } = await requireInitializedRepoUnlocked({
    repoDir: repos.repoA,
    outputMode: "json",
  });
  const grants = await queryGrants(repoContext);
  assertEquals(grants.length, 1);
  return grants[0].grant.id;
}

/**
 * the CLI creates the control-plane vault itself but serve creates it at
 * startup, so a serve row creates it first
 */
async function controlPlaneVaultForServe(
  repos: RowRepos,
  composition: Composition,
): Promise<void> {
  if (composition === "serve") {
    await initializeControlPlaneVaultForCli(repos.repoA, repos.a.syncService);
  }
}

async function staleWorker(repos: RowRepos): Promise<void> {
  const definition = Definition.create({
    name: "worker-w1",
    globalArguments: {},
  });
  await repos.a.repoContext.definitionRepo.save(WORKER_MODEL_TYPE, definition);
  const old = new Date(Date.now() - 24 * HOUR_MS).toISOString();
  const data = Data.create({
    name: "state-main",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: "worker-w1" },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${WORKER_MODEL_TYPE.normalized}:${definition.id}`,
    },
  });
  await repos.a.repoContext.unifiedDataRepo.save(
    WORKER_MODEL_TYPE,
    definition.id,
    data,
    new TextEncoder().encode(JSON.stringify({
      name: "w1",
      instanceUuid: crypto.randomUUID(),
      tokenName: "tok-w1",
      status: "disconnected",
      labels: {},
      platform: "linux",
      arch: "x86_64",
      swampVersion: "0.0.0",
      protocolVersion: 1,
      enrolledAt: old,
      lastSeenAt: old,
      disconnectedAt: old,
      capacity: 1,
      activeDispatchIds: [],
    })),
  );
}

async function managedConfigMarked(repos: RowRepos): Promise<boolean> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repos.repoA),
  );
  return marker?.datastore?.managedConfig === true;
}

const ROWS: AnyRow[] = [
  row({
    name: "access grant create",
    rootUnit: { cli: true },
    syncOrder: { cli: ["push"] },
    outsideUseCase: { cli: ["markDirty(bulk)"] },
    cli: (repos) => ({
      args: [
        "access",
        "grant",
        "create",
        "--subject",
        "user:adam",
        "--allow",
        "run",
        "--on",
        "workflow:*",
        ...json(repos),
      ],
    }),
    serve: null,
  }),
  row({
    name: "access grant revoke",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "prepare", "commit", "release"] },
    seed: createGrant,
    cli: (repos, grantId) => ({
      args: ["access", "grant", "revoke", grantId, ...json(repos)],
    }),
    serve: null,
  }),
  row({
    name: "access group create",
    rootUnit: { cli: true },
    syncOrder: { cli: ["push"] },
    outsideUseCase: { cli: ["markDirty(bulk)"] },
    cli: (repos) => ({
      args: ["access", "group", "create", "ops", ...json(repos)],
    }),
    serve: null,
  }),
  row({
    name: "access token mint",
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: ["pull", "push", "release"],
      serve: ["pull", "push", "release"],
    },
    outsideUseCase: { cli: ["markDirty(bulk)"] },
    seed: controlPlaneVaultForServe,
    cli: (repos) => ({
      args: [
        "access",
        "token",
        "mint",
        "tok1",
        "--principal",
        "user:adam",
        ...json(repos),
      ],
    }),
    serve: () => ({
      type: "access.token.mint",
      payload: {
        name: "tok1",
        principalId: "user:adam",
        principalEmail: "adam@example.com",
        durationMs: HOUR_MS,
      },
    }),
  }),
  row({
    name: "access token revoke",
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: ["pull", "prepare", "commit", "release"],
      serve: ["pull", "push", "release"],
    },
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
      args: ["access", "token", "revoke", "tok1", ...json(repos)],
    }),
    serve: () => ({ type: "access.token.revoke", payload: { name: "tok1" } }),
  }),
  row({
    name: "access token rotate",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "prepare", "commit", "release"] },
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
    serve: null,
  }),
  row({
    name: "worker token create",
    rootUnit: { cli: true, serve: true },
    syncOrder: { cli: ["push"], serve: ["push", "release"] },
    outsideUseCase: { cli: ["markDirty(bulk)"] },
    seed: controlPlaneVaultForServe,
    cli: (repos) => ({
      args: [
        "worker",
        "token",
        "create",
        "wt1",
        "--duration",
        "1h",
        ...json(repos),
      ],
    }),
    serve: () => ({
      type: "worker.token.create",
      payload: { name: "wt1", durationMs: HOUR_MS },
    }),
  }),
  row({
    name: "worker token revoke",
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: ["pull", "push", "prepare", "commit", "release"],
      serve: ["push", "release"],
    },
    outsideUseCase: { cli: ["markDirty(bulk)"] },
    seed: async (repos) => {
      await runCli({
        args: [
          "worker",
          "token",
          "create",
          "wt1",
          "--duration",
          "1h",
          ...json(repos),
        ],
      });
    },
    cli: (repos) => ({
      args: ["worker", "token", "revoke", "wt1", ...json(repos)],
    }),
    serve: () => ({ type: "worker.token.revoke", payload: { name: "wt1" } }),
  }),
  row({
    name: "worker prune",
    rootUnit: { cli: true, serve: true },
    syncOrder: { cli: ["push"], serve: ["push", "release"] },
    seed: staleWorker,
    cli: (repos) => ({
      args: [
        "worker",
        "prune",
        "--grace-period",
        "1m",
        "--force",
        ...json(repos),
      ],
    }),
    serve: () => ({
      type: "worker.prune",
      payload: { gracePeriodMs: 60_000 },
    }),
  }),
  row({
    name: "datastore config migrate",
    rootUnit: { cli: true },
    syncOrder: { cli: ["pull", "push", "push"] },
    outsideUseCase: {
      cli: [
        "markDirty(bulk)",
        "markDirty config/managed-config-migrated.json",
      ],
    },
    options: {
      remote: { capabilities: { twoPhaseSync: true, configRefresh: true } },
    },
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({
      args: ["datastore", "config", "migrate", ...json(repos)],
    }),
    serve: null,
    verify: async (repos) => {
      assertEquals(await managedConfigMarked(repos), true);
    },
  }),
  row({
    name: "datastore config migrate (no configRefresh)",
    refuses: true,
    seed: async (repos) => {
      await saveModel(repos.serveRepo, "m1");
    },
    cli: (repos) => ({
      args: ["datastore", "config", "migrate", ...json(repos)],
    }),
    serve: null,
    verify: async (repos) => {
      assertEquals(await managedConfigMarked(repos), false);
    },
  }),
];

/**
 * pins current behaviour per row, divergences and gaps included; update the
 * table when unit-of-work ownership moves into the use cases
 */
const EXPECTED: Record<string, PinnedRow> = {
  "access token rotate": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty outputs/swamp/server-token/rotate/<id>-<time>.yaml",
        "markDirty outputs/swamp/server-token/rotate/<id>-<time>.yaml",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "prepare[10]",
        "commit[10]",
      ],
      "remote": {
        "added": [
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/2/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/2/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary/2/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary/2/raw",
          "data/swamp/server-token/<id>/token-main/2/metadata.yaml",
          "data/swamp/server-token/<id>/token-main/2/raw",
          "outputs/swamp/server-token/rotate/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/server-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/server-token/<id>/token-main/latest",
        ],
      },
    },
    serve: null,
  },
  "access grant create": {
    cli: {
      "ops": [
        "markDirty auto-definitions/swamp/grant/grant-<suffix>.yaml",
        "markDirty auto-definitions/swamp/grant/grant-<suffix>.yaml",
        "markDirty definitions-evaluated/swamp/grant/grant-<suffix>.yaml",
        "markDirty definitions-evaluated/swamp/grant/grant-<suffix>.yaml",
        "markDirty data/swamp/grant/<id>/grant-main",
        "markDirty data/swamp/grant/<id>/grant-main",
        "markDirty outputs/swamp/grant/create/<id>-<time>.yaml",
        "markDirty outputs/swamp/grant/create/<id>-<time>.yaml",
        "markDirty(bulk)",
        "push[6]",
      ],
      "remote": {
        "added": [
          "auto-definitions/swamp/grant/grant-<suffix>.yaml",
          "data/swamp/grant/<id>/grant-main/1/metadata.yaml",
          "data/swamp/grant/<id>/grant-main/1/raw",
          "data/swamp/grant/<id>/grant-main/latest",
          "definitions-evaluated/swamp/grant/grant-<suffix>.yaml",
          "outputs/swamp/grant/create/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: null,
  },
  "access grant revoke": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/swamp/grant/grant-<suffix>.yaml",
        "markDirty definitions-evaluated/swamp/grant/grant-<suffix>.yaml",
        "markDirty data/swamp/grant/<id>/grant-main",
        "markDirty data/swamp/grant/<id>/grant-main",
        "markDirty outputs/swamp/grant/revoke/<id>-<time>.yaml",
        "markDirty outputs/swamp/grant/revoke/<id>-<time>.yaml",
        "prepare[4]",
        "commit[4]",
      ],
      "remote": {
        "added": [
          "data/swamp/grant/<id>/grant-main/2/metadata.yaml",
          "data/swamp/grant/<id>/grant-main/2/raw",
          "outputs/swamp/grant/revoke/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": ["data/swamp/grant/<id>/grant-main/latest"],
      },
    },
    serve: null,
  },
  "access group create": {
    cli: {
      "ops": [
        "markDirty auto-definitions/swamp/group/ops.yaml",
        "markDirty auto-definitions/swamp/group/ops.yaml",
        "markDirty definitions-evaluated/swamp/group/ops.yaml",
        "markDirty definitions-evaluated/swamp/group/ops.yaml",
        "markDirty data/swamp/group/<id>/group-main",
        "markDirty data/swamp/group/<id>/group-main",
        "markDirty outputs/swamp/group/create/<id>-<time>.yaml",
        "markDirty outputs/swamp/group/create/<id>-<time>.yaml",
        "markDirty(bulk)",
        "push[6]",
      ],
      "remote": {
        "added": [
          "auto-definitions/swamp/group/ops.yaml",
          "data/swamp/group/<id>/group-main/1/metadata.yaml",
          "data/swamp/group/<id>/group-main/1/raw",
          "data/swamp/group/<id>/group-main/latest",
          "definitions-evaluated/swamp/group/ops.yaml",
          "outputs/swamp/group/create/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: null,
  },
  "access token mint": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty auto-definitions/swamp/server-token/tok1.yaml",
        "markDirty auto-definitions/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty outputs/swamp/server-token/mint/<id>-<time>.yaml",
        "markDirty outputs/swamp/server-token/mint/<id>-<time>.yaml",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "markDirty(bulk)",
        "push[12]",
      ],
      "remote": {
        "added": [
          "auto-definitions/swamp/server-token/tok1.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/1/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/server-token/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary/1/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/server-token/<id>/token-main/1/metadata.yaml",
          "data/swamp/server-token/<id>/token-main/1/raw",
          "data/swamp/server-token/<id>/token-main/latest",
          "definitions-evaluated/swamp/server-token/tok1.yaml",
          "outputs/swamp/server-token/mint/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "pull[0]",
        "markDirty auto-definitions/swamp/server-token/tok1.yaml",
        "markDirty auto-definitions/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty outputs/swamp/server-token/mint/<id>-<time>.yaml",
        "markDirty outputs/swamp/server-token/mint/<id>-<time>.yaml",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "push[12]",
      ],
      "remote": {
        "added": [
          "auto-definitions/swamp/server-token/tok1.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/1/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/server-token/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary/1/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/server-token/<id>/token-main/1/metadata.yaml",
          "data/swamp/server-token/<id>/token-main/1/raw",
          "data/swamp/server-token/<id>/token-main/latest",
          "definitions-evaluated/swamp/server-token/tok1.yaml",
          "outputs/swamp/server-token/mint/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
  },
  "access token revoke": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty outputs/swamp/server-token/revoke/<id>-<time>.yaml",
        "markDirty outputs/swamp/server-token/revoke/<id>-<time>.yaml",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "prepare[10]",
        "commit[10]",
      ],
      "remote": {
        "added": [
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/2/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/2/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary/2/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary/2/raw",
          "data/swamp/server-token/<id>/token-main/2/metadata.yaml",
          "data/swamp/server-token/<id>/token-main/2/raw",
          "outputs/swamp/server-token/revoke/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/server-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/server-token/<id>/token-main/latest",
        ],
      },
    },
    serve: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty definitions-evaluated/swamp/server-token/tok1.yaml",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty data/swamp/server-token/<id>/token-main",
        "markDirty outputs/swamp/server-token/revoke/<id>-<time>.yaml",
        "markDirty outputs/swamp/server-token/revoke/<id>-<time>.yaml",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/server-token/<id>/report-swamp-method-summary-json",
        "push[10]",
      ],
      "remote": {
        "added": [
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/2/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/2/raw",
          "data/swamp/server-token/<id>/report-swamp-method-summary/2/metadata.yaml",
          "data/swamp/server-token/<id>/report-swamp-method-summary/2/raw",
          "data/swamp/server-token/<id>/token-main/2/metadata.yaml",
          "data/swamp/server-token/<id>/token-main/2/raw",
          "outputs/swamp/server-token/revoke/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [
          "data/swamp/server-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/server-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/server-token/<id>/token-main/latest",
        ],
      },
    },
  },
  "worker token create": {
    cli: {
      "ops": [
        "markDirty auto-definitions/swamp/enrollment-token/wt1.yaml",
        "markDirty auto-definitions/swamp/enrollment-token/wt1.yaml",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty outputs/swamp/enrollment-token/mint/<id>-<time>.yaml",
        "markDirty outputs/swamp/enrollment-token/mint/<id>-<time>.yaml",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "markDirty(bulk)",
        "push[12]",
      ],
      "remote": {
        "added": [
          "auto-definitions/swamp/enrollment-token/wt1.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/1/raw",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/1/raw",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/enrollment-token/<id>/token-main/1/metadata.yaml",
          "data/swamp/enrollment-token/<id>/token-main/1/raw",
          "data/swamp/enrollment-token/<id>/token-main/latest",
          "definitions-evaluated/swamp/enrollment-token/wt1.yaml",
          "outputs/swamp/enrollment-token/mint/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty auto-definitions/swamp/enrollment-token/wt1.yaml",
        "markDirty auto-definitions/swamp/enrollment-token/wt1.yaml",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty outputs/swamp/enrollment-token/mint/<id>-<time>.yaml",
        "markDirty outputs/swamp/enrollment-token/mint/<id>-<time>.yaml",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "push[12]",
      ],
      "remote": {
        "added": [
          "auto-definitions/swamp/enrollment-token/wt1.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/1/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/1/raw",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/1/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/1/raw",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/enrollment-token/<id>/token-main/1/metadata.yaml",
          "data/swamp/enrollment-token/<id>/token-main/1/raw",
          "data/swamp/enrollment-token/<id>/token-main/latest",
          "definitions-evaluated/swamp/enrollment-token/wt1.yaml",
          "outputs/swamp/enrollment-token/mint/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
  },
  "worker token revoke": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty outputs/swamp/enrollment-token/revoke/<id>-<time>.yaml",
        "markDirty outputs/swamp/enrollment-token/revoke/<id>-<time>.yaml",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "markDirty(bulk)",
        "push[10]",
        "prepare[0]",
        "commit[0]",
      ],
      "remote": {
        "added": [
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/2/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/2/raw",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/2/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/2/raw",
          "data/swamp/enrollment-token/<id>/token-main/2/metadata.yaml",
          "data/swamp/enrollment-token/<id>/token-main/2/raw",
          "outputs/swamp/enrollment-token/revoke/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/enrollment-token/<id>/token-main/latest",
        ],
      },
    },
    serve: {
      "ops": [
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty definitions-evaluated/swamp/enrollment-token/wt1.yaml",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty data/swamp/enrollment-token/<id>/token-main",
        "markDirty outputs/swamp/enrollment-token/revoke/<id>-<time>.yaml",
        "markDirty outputs/swamp/enrollment-token/revoke/<id>-<time>.yaml",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "markDirty data/swamp/enrollment-token/<id>/report-swamp-method-summary-json",
        "push[10]",
      ],
      "remote": {
        "added": [
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/2/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/2/raw",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/2/metadata.yaml",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/2/raw",
          "data/swamp/enrollment-token/<id>/token-main/2/metadata.yaml",
          "data/swamp/enrollment-token/<id>/token-main/2/raw",
          "outputs/swamp/enrollment-token/revoke/<id>-<time>.yaml",
        ],
        "removed": [],
        "changed": [
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary-json/latest",
          "data/swamp/enrollment-token/<id>/report-swamp-method-summary/latest",
          "data/swamp/enrollment-token/<id>/token-main/latest",
        ],
      },
    },
  },
  "worker prune": {
    cli: {
      "ops": [
        "markDirty data/swamp/worker/<id>/state-main/1",
        "markDirty data/swamp/worker/<id>/state-main/latest",
        "markDirty data/swamp/worker/<id>/state-main/1",
        "markDirty data/swamp/worker/<id>/state-main/latest",
        "markDirty definitions-evaluated/swamp/worker/<id>.yaml",
        "markDirty definitions-evaluated/swamp/worker/<id>.yaml",
        "push[0 del 3]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/swamp/worker/<id>/state-main/1/metadata.yaml",
          "data/swamp/worker/<id>/state-main/1/raw",
          "data/swamp/worker/<id>/state-main/latest",
        ],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty data/swamp/worker/<id>/state-main/1",
        "markDirty data/swamp/worker/<id>/state-main/latest",
        "markDirty data/swamp/worker/<id>/state-main/1",
        "markDirty data/swamp/worker/<id>/state-main/latest",
        "markDirty definitions-evaluated/swamp/worker/<id>.yaml",
        "markDirty definitions-evaluated/swamp/worker/<id>.yaml",
        "push[0 del 3]",
      ],
      "remote": {
        "added": [],
        "removed": [
          "data/swamp/worker/<id>/state-main/1/metadata.yaml",
          "data/swamp/worker/<id>/state-main/1/raw",
          "data/swamp/worker/<id>/state-main/latest",
        ],
        "changed": [],
      },
    },
  },
  "datastore config migrate": {
    cli: {
      "ops": [
        "pull[0]",
        "markDirty(bulk)",
        "push[1]",
        "markDirty config/managed-config-migrated.json",
        "push[1]",
      ],
      "remote": {
        "added": [
          "config/managed-config-migrated.json",
          "config/models/<type>/m1.yaml",
        ],
        "removed": [],
        "changed": [],
      },
    },
    serve: null,
  },
  "datastore config migrate (no configRefresh)": {
    cli: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
      "error":
        'The datastore extension "@test/remote-<id>" does not support managed config sync yet. Update the extension to the latest version that supports the configRefresh capability before migrating.\n\nRefusing to migrate \u2014 a partial migration would leave config in the datastore that other instances cannot pull.',
    },
    serve: null,
  },
};

Deno.test("use case sync characterization: access, token, worker and datastore use cases mark and push today's paths", async (t) => {
  await checkRows(t, ROWS, EXPECTED);
});

Deno.test("use-case sync characterization: on a v3 datastore every access row commits what the second checkout reads (swamp-club#3279)", async (t) => {
  await checkRowsOnV3(t, ROWS, {
    "datastore config migrate":
      "migrating existing config into a v3 datastore is Phase 6; refused " +
      "on v3 (datastore_v3_opt_in_test.ts)",
    "datastore config migrate (no configRefresh)":
      "migrating existing config into a v3 datastore is Phase 6; refused " +
      "on v3 (datastore_v3_opt_in_test.ts)",
  });
});

Deno.test("use-case sync characterization: on a namespaced v3 datastore every access row commits what the second checkout reads (swamp-club#3279)", async (t) => {
  await checkRowsOnV3(t, ROWS, {
    "datastore config migrate":
      "migrating existing config into a v3 datastore is Phase 6; refused " +
      "on v3 (datastore_v3_opt_in_test.ts)",
    "datastore config migrate (no configRefresh)":
      "migrating existing config into a v3 datastore is Phase 6; refused " +
      "on v3 (datastore_v3_opt_in_test.ts)",
  }, { namespace: "team" });
});
