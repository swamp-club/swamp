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
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import {
  consumeStream,
  createLibSwampContext,
  reportDescribe,
  type ReportDescribeDeps,
} from "../../libswamp/mod.ts";
import { createReportDescribeRenderer } from "../../presentation/renderers/report_describe.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const reportDescribeCommand = new Command()
  .name("describe")
  .description("Show report definition metadata from the registry")
  .arguments("<report_name:string>")
  .action(async function (options: AnyOptions, reportName: string) {
    const ctx = createContext(options as GlobalOptions, [
      "report",
      "describe",
    ]);

    const deps: ReportDescribeDeps = {
      getReport: (name) => reportRegistry.get(name),
    };

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createReportDescribeRenderer(ctx.outputMode);

    await consumeStream(
      reportDescribe(libCtx, deps, reportName),
      renderer.handlers(),
    );

    ctx.logger.debug("Report describe command completed");
  });
