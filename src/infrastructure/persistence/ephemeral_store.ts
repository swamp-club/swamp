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

import { getLogger } from "@logtape/logtape";
import { CatalogStore } from "./catalog_store.ts";
import {
  DEFAULT_EPHEMERAL_MAX_BYTES,
  InMemoryUnifiedDataRepository,
} from "./in_memory_data_repository.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { CompositeUnifiedDataRepository } from "../../domain/data/composite_data_repository.ts";
import { CompositeDataQueryService } from "../../domain/data/composite_data_query_service.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { Namespace } from "../../domain/data/namespace.ts";

const logger = getLogger(["swamp", "data", "ephemeral"]);

export function parseByteSize(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmg]?b?)?$/i);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  if (isNaN(num) || num < 0) return undefined;
  const suffix = (match[2] ?? "").toLowerCase();
  switch (suffix) {
    case "k":
    case "kb":
      return Math.floor(num * 1024);
    case "m":
    case "mb":
      return Math.floor(num * 1024 * 1024);
    case "g":
    case "gb":
      return Math.floor(num * 1024 * 1024 * 1024);
    case "":
    case "b":
      return Math.floor(num);
    default:
      return undefined;
  }
}

function resolveMaxBytes(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const envValue = Deno.env.get("SWAMP_EPHEMERAL_BUDGET");
  if (envValue) {
    const parsed = parseByteSize(envValue);
    if (parsed !== undefined) {
      logger
        .info`Ephemeral budget set to ${envValue} via SWAMP_EPHEMERAL_BUDGET`;
      return parsed;
    }
    logger
      .warn`Invalid SWAMP_EPHEMERAL_BUDGET value ${envValue}, using default ${DEFAULT_EPHEMERAL_MAX_BYTES}`;
  }
  return DEFAULT_EPHEMERAL_MAX_BYTES;
}

export interface EphemeralStore {
  repo: InMemoryUnifiedDataRepository;
  catalog: CatalogStore;
  dispose(): void;
}

export function createEphemeralStore(
  namespace?: Namespace,
  options?: { isResume?: boolean; maxBytes?: number },
): EphemeralStore {
  if (options?.isResume) {
    logger.info(
      "Ephemeral data from before suspension is not available in resumed runs — use 'workflow' or 'infinite' lifetime to persist across gates.",
    );
  }
  const maxBytes = resolveMaxBytes(options?.maxBytes);
  const catalog = new CatalogStore(":memory:");
  const repo = new InMemoryUnifiedDataRepository(
    catalog,
    namespace,
    maxBytes,
  );
  return {
    repo,
    catalog,
    dispose() {
      repo.dispose();
    },
  };
}

export function wrapWithEphemeral(
  persistentRepo: UnifiedDataRepository,
  persistentCatalog: CatalogStore,
  store: EphemeralStore,
): {
  dataRepo: CompositeUnifiedDataRepository;
  dataQueryService: CompositeDataQueryService;
} {
  return {
    dataRepo: new CompositeUnifiedDataRepository(
      persistentRepo,
      store.repo,
    ),
    dataQueryService: new CompositeDataQueryService(
      persistentCatalog,
      persistentRepo,
      new DataQueryService(store.catalog, store.repo),
    ),
  };
}
