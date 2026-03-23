// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { SourceFetchResult } from "../../domain/source/source_service.ts";
import { SourceService } from "../../domain/source/source_service.ts";
import { HttpSourceDownloader } from "../../infrastructure/source/http_source_downloader.ts";
import { JsonSourceMetadataRepository } from "../../infrastructure/source/json_source_metadata_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the source fetch output.
 */
export type SourceFetchData = SourceFetchResult;

export type SourceFetchEvent =
  | { kind: "fetching" }
  | { kind: "completed"; data: SourceFetchData }
  | { kind: "error"; error: SwampError };

/** Input for the source fetch operation. */
export interface SourceFetchInput {
  version: string;
}

/** Dependencies for the source fetch operation. */
export interface SourceFetchDeps {
  fetch: (version: string) => Promise<SourceFetchResult>;
}

/** Wires real infrastructure into SourceFetchDeps. */
export function createSourceFetchDeps(): SourceFetchDeps {
  const downloader = new HttpSourceDownloader();
  const repository = new JsonSourceMetadataRepository();
  const service = new SourceService(downloader, repository);
  return {
    fetch: (version) => service.fetch(version),
  };
}

/** Fetches swamp source code for the given version. */
export async function* sourceFetch(
  ctx: LibSwampContext,
  deps: SourceFetchDeps,
  input: SourceFetchInput,
): AsyncIterable<SourceFetchEvent> {
  yield* withGeneratorSpan(
    "swamp.source.fetch",
    {},
    (async function* () {
      ctx.logger.debug`Fetching source version: ${input.version}`;

      yield { kind: "fetching" };

      const result = await deps.fetch(input.version);

      yield { kind: "completed", data: result };
    })(),
  );
}
