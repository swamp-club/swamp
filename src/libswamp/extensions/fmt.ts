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

import type {
  QualityCheckResult,
  QualityIssue,
} from "../../domain/extensions/extension_quality_checker.ts";
import { checkExtensionQuality } from "../../domain/extensions/extension_quality_checker.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

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
}

/** Dependencies for the extension fmt operation. */
export interface ExtensionFmtDeps {
  checkQuality: (files: string[]) => Promise<QualityCheckResult>;
  runFmt: (files: string[]) => Promise<string>;
  runLint: (files: string[]) => Promise<string>;
}

/** Wires real infrastructure into ExtensionFmtDeps. */
export async function createExtensionFmtDeps(): Promise<ExtensionFmtDeps> {
  const denoRuntime = new EmbeddedDenoRuntime();
  const denoPath = await denoRuntime.ensureDeno();

  return {
    checkQuality: (files: string[]) => checkExtensionQuality(files, denoPath),
    runFmt: async (files: string[]) => {
      const command = new Deno.Command(denoPath, {
        args: ["fmt", "--no-config", ...files],
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      return (
        new TextDecoder().decode(output.stderr) +
        new TextDecoder().decode(output.stdout)
      ).trim();
    },
    runLint: async (files: string[]) => {
      const command = new Deno.Command(denoPath, {
        args: ["lint", "--fix", "--no-config", ...files],
        stdout: "piped",
        stderr: "piped",
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
  ctx.logger.debug`Executing extension fmt`;

  if (input.tsFiles.length === 0) {
    yield { kind: "no_files" };
    return;
  }

  if (input.check) {
    const result = await deps.checkQuality(input.tsFiles);
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
  const fmtOutput = await deps.runFmt(input.tsFiles);
  const lintOutput = await deps.runLint(input.tsFiles);
  const remaining = await deps.checkQuality(input.tsFiles);

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
}
