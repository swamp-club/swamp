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

import type {
  QualityCheckResult,
  QualityIssue,
} from "../../domain/extensions/extension_quality_checker.ts";
import {
  checkExtensionQuality,
  denoToolConfigArgs,
  extensionLintArgs,
} from "../../domain/extensions/extension_quality_checker.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Data for a check-only run. */
export interface ExtensionFmtCheckData {
  mode: "check";
  passed: boolean;
  issues: QualityIssue[];
}

/** Data for an auto-fix run. */
export interface ExtensionFmtFixData {
  mode: "fix";
  fileCount: number;
  fmtOutput: string;
  lintOutput: string;
  remainingIssues: QualityIssue[];
  passed: boolean;
}

export type ExtensionFmtData = ExtensionFmtCheckData | ExtensionFmtFixData;

export type ExtensionFmtEvent =
  | { kind: "no_files" }
  | { kind: "completed"; data: ExtensionFmtData }
  | { kind: "error"; error: SwampError };

/** Input for the extension fmt generator. */
export interface ExtensionFmtInput {
  tsFiles: string[];
  check: boolean;
  /**
   * The project `deno.json`, found as push finds it, so fmt formats and
   * lints under the same rules push checks with.
   */
  denoConfigPath?: string;
}

/** Dependencies for the extension fmt operation. */
export interface ExtensionFmtDeps {
  checkQuality: (
    files: string[],
    denoConfigPath?: string,
  ) => Promise<QualityCheckResult>;
  runFmt: (files: string[], denoConfigPath?: string) => Promise<string>;
  runLint: (files: string[], denoConfigPath?: string) => Promise<string>;
}

/** Wires real infrastructure into ExtensionFmtDeps. */
export async function createExtensionFmtDeps(): Promise<ExtensionFmtDeps> {
  const denoRuntime = new EmbeddedDenoRuntime();
  const denoPath = await denoRuntime.ensureDeno();

  return {
    checkQuality: (files: string[], denoConfigPath?: string) =>
      checkExtensionQuality(
        files,
        denoPath,
        denoConfigPath,
        denoRuntime.getDenoEnv(),
      ),
    runFmt: async (files: string[], denoConfigPath?: string) => {
      const command = new Deno.Command(denoPath, {
        args: ["fmt", ...denoToolConfigArgs(denoConfigPath), ...files],
        stdout: "piped",
        stderr: "piped",
        env: { ...denoRuntime.getDenoEnv(), NO_COLOR: "1" },
      });
      const output = await command.output();
      return (
        new TextDecoder().decode(output.stderr) +
        new TextDecoder().decode(output.stdout)
      ).trim();
    },
    runLint: async (files: string[], denoConfigPath?: string) => {
      const command = new Deno.Command(denoPath, {
        args: [...extensionLintArgs(denoConfigPath), "--fix", ...files],
        stdout: "piped",
        stderr: "piped",
        env: { ...denoRuntime.getDenoEnv(), NO_COLOR: "1" },
      });
      const output = await command.output();
      return (
        new TextDecoder().decode(output.stderr) +
        new TextDecoder().decode(output.stdout)
      ).trim();
    },
  };
}

/** Formats and lints extension TypeScript files. */
export async function* extensionFmt(
  ctx: LibSwampContext,
  deps: ExtensionFmtDeps,
  input: ExtensionFmtInput,
): AsyncIterable<ExtensionFmtEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.fmt",
    {},
    (async function* () {
      ctx.logger.debug`Executing extension fmt`;

      if (input.tsFiles.length === 0) {
        yield { kind: "no_files" };
        return;
      }

      if (input.check) {
        const result = await deps.checkQuality(
          input.tsFiles,
          input.denoConfigPath,
        );
        yield {
          kind: "completed",
          data: {
            mode: "check",
            passed: result.passed,
            issues: result.issues,
          },
        };
        return;
      }

      // Auto-fix mode
      const fmtOutput = await deps.runFmt(input.tsFiles, input.denoConfigPath);
      const lintOutput = await deps.runLint(
        input.tsFiles,
        input.denoConfigPath,
      );
      const remaining = await deps.checkQuality(
        input.tsFiles,
        input.denoConfigPath,
      );

      yield {
        kind: "completed",
        data: {
          mode: "fix",
          fileCount: input.tsFiles.length,
          fmtOutput,
          lintOutput,
          remainingIssues: remaining.issues,
          passed: remaining.passed,
        },
      };
    })(),
  );
}
