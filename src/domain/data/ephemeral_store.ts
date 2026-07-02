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
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { InMemoryUnifiedDataRepository } from "../../infrastructure/persistence/in_memory_data_repository.ts";
import { DataQueryService } from "./data_query_service.ts";

const logger = getLogger(["swamp", "data", "ephemeral"]);
import { CompositeUnifiedDataRepository } from "./composite_data_repository.ts";
import { CompositeDataQueryService } from "./composite_data_query_service.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { Namespace } from "./namespace.ts";

export interface EphemeralStore {
  repo: InMemoryUnifiedDataRepository;
  catalog: CatalogStore;
  dispose(): void;
}

export function createEphemeralStore(
  namespace?: Namespace,
  options?: { isResume?: boolean },
): EphemeralStore {
  if (options?.isResume) {
    logger.info(
      "Ephemeral data from before suspension is not available in resumed runs — use 'workflow' or 'infinite' lifetime to persist across gates.",
    );
  }
  const catalog = new CatalogStore(":memory:");
  const repo = new InMemoryUnifiedDataRepository(catalog, namespace);
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
