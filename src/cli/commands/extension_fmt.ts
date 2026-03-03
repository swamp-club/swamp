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
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveExtensionFiles } from "../resolve_extension_files.ts";
import { UserError } from "../../domain/errors.ts";
import { checkExtensionQuality } from "../../domain/extensions/extension_quality_checker.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  renderExtensionFmt,
  renderExtensionFmtCheck,
} from "../../presentation/output/extension_fmt_output.ts";

interface ExtensionFmtOptions extends GlobalOptions {
  repoDir: string;
  check?: boolean;
}

export const extensionFmtCommand = new Command()
  .name("fmt")
  .description("Format and lint extension TypeScript files")
  .arguments("<manifest-path:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--check", "Check only, do not auto-fix")
  .action(async function (options: ExtensionFmtOptions, manifestPath: string) {
    const ctx = createContext(options, ["extension", "fmt"]);
    ctx.logger.debug`Starting extension fmt`;

    // 1. Validate repo
    const repoDir = options.repoDir ?? ".";
    const { repoContext } = await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // 2. Resolve extension files (manifest, models, workflows, additional files)
    const { allModelFiles, allVaultFiles, additionalFilePaths } =
      await resolveExtensionFiles({
        repoDir,
        manifestPath,
        repoContext,
        logger: ctx.logger,
      });

    // 3. Combine all files and filter to .ts
    //    (fmt only operates on TypeScript files)
    const allFiles = [
      ...allModelFiles,
      ...allVaultFiles,
      ...additionalFilePaths,
    ];
    const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));

    if (tsFiles.length === 0) {
      if (ctx.outputMode === "json") {
        console.log(JSON.stringify({ status: "passed", fileCount: 0 }));
      } else {
        ctx.logger.info("No TypeScript files to check.");
      }
      return;
    }

    // 4. Get deno binary
    const denoRuntime = new EmbeddedDenoRuntime();
    const denoPath = await denoRuntime.ensureDeno();

    // 5. Check-only mode
    if (options.check) {
      const result = await checkExtensionQuality(tsFiles, denoPath);
      renderExtensionFmtCheck(result, ctx.outputMode);
      if (!result.passed) {
        throw new UserError(
          "Quality checks failed. Run 'swamp extension fmt <manifest-path>' to fix.",
        );
      }
      return;
    }

    // 6. Auto-fix mode: run deno fmt and deno lint --fix
    const fmtCommand = new Deno.Command(denoPath, {
      args: ["fmt", "--no-config", ...tsFiles],
      stdout: "piped",
      stderr: "piped",
    });
    const fmtOutput = await fmtCommand.output();
    const fmtText = (
      new TextDecoder().decode(fmtOutput.stderr) +
      new TextDecoder().decode(fmtOutput.stdout)
    ).trim();

    const lintCommand = new Deno.Command(denoPath, {
      args: ["lint", "--fix", "--no-config", ...tsFiles],
      stdout: "piped",
      stderr: "piped",
    });
    const lintOutput = await lintCommand.output();
    const lintText = (
      new TextDecoder().decode(lintOutput.stderr) +
      new TextDecoder().decode(lintOutput.stdout)
    ).trim();

    // 7. Re-check to detect remaining unfixable issues
    const remaining = await checkExtensionQuality(tsFiles, denoPath);

    renderExtensionFmt(
      {
        fileCount: tsFiles.length,
        fmtOutput: fmtText,
        lintOutput: lintText,
        remainingIssues: remaining.issues,
      },
      ctx.outputMode,
    );

    if (!remaining.passed) {
      throw new UserError(
        "Some issues could not be auto-fixed. See above for details.",
      );
    }
  });
