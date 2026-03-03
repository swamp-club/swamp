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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { SourceService } from "../../domain/source/mod.ts";
import { HttpSourceDownloader } from "../../infrastructure/source/http_source_downloader.ts";
import { JsonSourceMetadataRepository } from "../../infrastructure/source/json_source_metadata_repository.ts";
import { renderSourcePath } from "../../presentation/output/source_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const sourcePathCommand = new Command()
  .description("Show swamp source location and version")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["source", "path"]);
    ctx.logger.debug("Executing source path command");

    const downloader = new HttpSourceDownloader();
    const repository = new JsonSourceMetadataRepository();
    const service = new SourceService(downloader, repository);

    const result = await service.getInfo();

    renderSourcePath(result, ctx.outputMode);

    ctx.logger.debug("Source path command completed");
  });
