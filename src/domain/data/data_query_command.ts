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
import { isTextContentType } from "./content_type.ts";

/**
 * The coordinates of one stored data item, as a `swamp data query` predicate
 * selects it. Set the fields that identify the item for the read being
 * replaced: a model-scoped read names the model, a workflow-scoped read names
 * the run, job and step that produced it.
 */
export interface DataQueryTarget {
  dataName: string;
  version?: number;
  modelType?: string;
  modelName?: string;
  workflowRunId?: string;
  jobName?: string;
  stepName?: string;
}

/** Writes a value as a CEL string literal; JSON escapes are valid CEL. */
function celString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Builds the CEL predicate that selects `target`. Naming the version also
 * opts the query into history, so a version that is no longer the latest is
 * still found.
 */
export function dataQueryPredicate(target: DataQueryTarget): string {
  const clauses: string[] = [];
  if (target.workflowRunId !== undefined) {
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
  if (target.modelName !== undefined) {
    clauses.push(`modelName == ${celString(target.modelName)}`);
  }
  clauses.push(`name == ${celString(target.dataName)}`);
  if (target.version !== undefined) {
    clauses.push(`version == ${target.version}`);
  }
  return clauses.join(" && ");
}

/**
 * Builds the `swamp data query` command a user can paste into a POSIX shell
 * to read `target`. With `includeContent`, the command selects the content,
 * as `swamp data get` prints it; without, it lists the item's metadata.
 */
export function dataQueryCommand(
  target: DataQueryTarget,
  options: { includeContent: boolean },
): string {
  const command = `swamp data query ${
    quoteShellWord(dataQueryPredicate(target))
  }`;
  return options.includeContent ? `${command} --select content` : command;
}

/** One version of a data item a retrieval hint points at. */
export interface RetrievalData {
  name: string;
  version: number;
  contentType: string;
}

/**
 * The command that reads `data` back. `swamp data query` cannot return
 * binary content yet (swamp-club#2959), so a binary item keeps the
 * deprecated `swamp data get`, the one command that returns its bytes.
 */
function retrievalCommand(
  modelName: string,
  data: RetrievalData,
  target: DataQueryTarget,
): string {
  if (!isTextContentType(data.contentType)) {
    return `swamp data get ${quoteShellWord(modelName)} ${
      quoteShellWord(data.name)
    } --version ${data.version}`;
  }
  return dataQueryCommand(target, { includeContent: true });
}

/** The command that reads one version of a model's data. */
export function modelRetrievalCommand(
  modelName: string,
  data: RetrievalData,
): string {
  return retrievalCommand(modelName, data, {
    modelName,
    dataName: data.name,
    version: data.version,
  });
}

/**
 * The command that reads one item a workflow step wrote, named by its run,
 * job and step so it cannot pick up another step's data of the same name.
 */
export function stepRetrievalCommand(
  workflowRunId: string,
  step: { jobName: string; stepName: string; modelName: string },
  data: RetrievalData,
): string {
  return retrievalCommand(step.modelName, data, {
    workflowRunId,
    jobName: step.jobName,
    stepName: step.stepName,
    dataName: data.name,
    version: data.version,
  });
}
