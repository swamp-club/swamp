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

import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreEngine } from "../../domain/datastore/datastore_format.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  Fingerprint,
  type FingerprintProps,
  type FingerprintWorkers,
} from "../../domain/serve/fingerprint.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import { serveFingerprint } from "../../libswamp/serve/fingerprint.ts";
import type { MergedServeOptions } from "../../serve/serve_config.ts";
import { fingerprintDatastoreFacts } from "./serve_fingerprint.ts";

export interface ServeFingerprintSources {
  readonly serveYamlVersion: 1 | 2;
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly datastoreConfig: DatastoreConfig;
  readonly datastoreEngine: DatastoreEngine;
  readonly lockfilePath: string;
  /** the settings in force, after any reload */
  readonly settings: () => MergedServeOptions;
}

export interface ServeRuntimeFacts {
  readonly role: "hub" | "member";
  readonly team: FingerprintProps["team"];
  readonly startedAt: string;
  readonly ready: boolean;
  /** counted by the caller; absent, every swamp/worker record is counted */
  readonly workers?: FingerprintWorkers;
}

/** read as swamp serve fingerprint reads it, plus what only a running serve knows */
export async function collectServeFingerprint(
  sources: ServeFingerprintSources,
  runtime: ServeRuntimeFacts,
): Promise<Fingerprint> {
  let fingerprint: Fingerprint | undefined;
  for await (
    const event of serveFingerprint(createLibSwampContext(), {
      buildVersion: () => VERSION,
      platform: () => ({ platform: Deno.build.os, arch: Deno.build.arch }),
      settings: sources.settings,
      serveYamlVersion: () => sources.serveYamlVersion,
      federationRole: () => runtime.role,
      datastore: () =>
        fingerprintDatastoreFacts(
          {
            datastoreConfig: sources.datastoreConfig,
            engine: sources.datastoreEngine,
          },
          sources.repoDir,
        ),
      vaultTypes: async () =>
        (await new YamlVaultConfigRepository(sources.repoDir).findAll())
          .map((vault) => vault.type),
      extensions: async () =>
        Object.entries(
          (await LockfileRepository.create(sources.lockfilePath))
            .getAllEntries(),
        ).map(([name, entry]) => ({ name, version: entry.version })),
      // workers counted by the caller need no datastore read
      queryData: async (predicate) =>
        runtime.workers !== undefined
          ? []
          : await sources.repoContext.dataQueryService.query(predicate, {
            loadAttributes: true,
          }) as DataRecord[],
    })
  ) {
    if (event.kind === "error") throw userErrorFromSwampError(event.error);
    if (event.kind === "completed") {
      fingerprint = Fingerprint.create({
        ...event.data.fingerprint,
        ...(runtime.workers !== undefined ? { workers: runtime.workers } : {}),
        team: runtime.team,
        startedAt: runtime.startedAt,
        ready: runtime.ready,
      });
    }
  }
  if (fingerprint === undefined) {
    throw new Error("This serve's fingerprint was not collected");
  }
  return fingerprint;
}
