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

import { quoteShellWord } from "../shell_word.ts";

/**
 * a run is either pinned by its id or followed as the workflow's latest run
 * with latestRunWorkflow, never both
 */
export type DataQueryTarget =
  & {
    dataName: string;
    version?: number;
    modelType?: string;
    modelId?: string;
    modelName?: string;
    jobName?: string;
    stepName?: string;
  }
  & (
    | { workflowRunId?: string; latestRunWorkflow?: never }
    | { latestRunWorkflow: string; workflowRunId?: never }
  );

export function celString(value: string): string {
  return JSON.stringify(value);
}

/**
 * naming the version opts into history so a non-latest version is found; a
 * latest-run target without a version opts in with version >= 0, since a later
 * write elsewhere can demote the run's item from latest
 */
export function dataQueryPredicate(target: DataQueryTarget): string {
  const clauses: string[] = [];
  if (target.latestRunWorkflow !== undefined) {
    clauses.push(
      `workflowRunId == latestRun(${celString(target.latestRunWorkflow)})`,
    );
  } else if (target.workflowRunId !== undefined) {
    clauses.push(`workflowRunId == ${celString(target.workflowRunId)}`);
  }
  if (target.jobName !== undefined) {
    clauses.push(`jobName == ${celString(target.jobName)}`);
  }
  if (target.stepName !== undefined) {
    clauses.push(`stepName == ${celString(target.stepName)}`);
  }
  if (target.modelType !== undefined) {
    clauses.push(`modelType == ${celString(target.modelType)}`);
  }
  if (target.modelId !== undefined) {
    clauses.push(`modelId == ${celString(target.modelId)}`);
  }
  if (target.modelName !== undefined) {
    clauses.push(`modelName == ${celString(target.modelName)}`);
  }
  clauses.push(`name == ${celString(target.dataName)}`);
  if (target.version !== undefined) {
    clauses.push(`version == ${target.version}`);
  } else if (target.latestRunWorkflow !== undefined) {
    clauses.push("version >= 0");
  }
  return clauses.join(" && ");
}

const ENCODED_CONTENT_SELECT =
  '{"content": content, "contentEncoding": contentEncoding}';

/**
 * withEncoding asks for --json, since base64 is read from the JSON result where
 * log output would render it as one huge table cell
 */
export function dataQueryCommand(
  target: DataQueryTarget,
  options: { includeContent: boolean; withEncoding?: boolean },
): string {
  const command = `swamp data query ${
    quoteShellWord(dataQueryPredicate(target))
  }`;
  if (!options.includeContent) return command;
  return options.withEncoding
    ? `${command} --select ${quoteShellWord(ENCODED_CONTENT_SELECT)} --json`
    : `${command} --select content`;
}
