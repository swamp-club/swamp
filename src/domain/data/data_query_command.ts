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
  modelId?: string;
  modelName?: string;
  workflowRunId?: string;
  jobName?: string;
  stepName?: string;
}

/** Writes a value as a CEL string literal; JSON escapes are valid CEL. */
export function celString(value: string): string {
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
  if (target.modelId !== undefined) {
    clauses.push(`modelId == ${celString(target.modelId)}`);
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
 * The projection that reads an item's content together with how it is
 * represented: UTF-8 text, or base64 when the bytes are not valid UTF-8.
 */
const ENCODED_CONTENT_SELECT =
  '{"content": content, "contentEncoding": contentEncoding}';

/**
 * Builds the `swamp data query` command a user can paste into a POSIX shell
 * to read `target`. With `includeContent`, the command selects the content,
 * as `swamp data get` prints it; without, it lists the item's metadata.
 * `withEncoding` also selects `contentEncoding`, for content that may come
 * back base64-encoded, and asks for `--json`: base64 is read from the JSON
 * result, where log output would render it as one huge table cell.
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

/** One version of a data item a retrieval hint points at. */
export interface RetrievalData {
  name: string;
  version: number;
  contentType: string;
}

/**
 * The command that reads `data` back. Content that may not be UTF-8 text —
 * any non-text content type — is selected with its `contentEncoding`, so a
 * base64-encoded body can be told apart from text.
 */
function retrievalCommand(
  data: RetrievalData,
  target: DataQueryTarget,
): string {
  return dataQueryCommand(target, {
    includeContent: true,
    withEncoding: !isTextContentType(data.contentType),
  });
}

/** The command that reads one version of a model's data. */
export function modelRetrievalCommand(
  modelName: string,
  data: RetrievalData,
): string {
  return retrievalCommand(data, {
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
  step: { jobName: string; stepName: string },
  data: RetrievalData,
): string {
  return retrievalCommand(data, {
    workflowRunId,
    jobName: step.jobName,
    stepName: step.stepName,
    dataName: data.name,
    version: data.version,
  });
}
