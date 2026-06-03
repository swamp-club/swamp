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

import type { SourceInfoResult } from "../../domain/source/source_service.ts";
import { SourceService } from "../../domain/source/source_service.ts";
import { HttpSourceDownloader } from "../../infrastructure/source/http_source_downloader.ts";
import { JsonSourceMetadataRepository } from "../../infrastructure/source/json_source_metadata_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/**
 * Data structure for the source path output.
 */
export type SourcePathData = SourceInfoResult;

export type SourcePathEvent =
  | { kind: "completed"; data: SourcePathData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the source path operation. */
export interface SourcePathDeps {
  getInfo: () => Promise<SourceInfoResult>;
}

/** Wires real infrastructure into SourcePathDeps. */
export function createSourcePathDeps(): SourcePathDeps {
  const downloader = new HttpSourceDownloader();
  const repository = new JsonSourceMetadataRepository();
  const service = new SourceService(downloader, repository);
  return {
    getInfo: () => service.getInfo(),
  };
}

/** Retrieves source path and version information. */
export async function* sourcePath(
  ctx: LibSwampContext,
  deps: SourcePathDeps,
): AsyncIterable<SourcePathEvent> {
  ctx.logger.debug`Retrieving source path info`;

  const result = await deps.getInfo();

  yield { kind: "completed", data: result };
}
