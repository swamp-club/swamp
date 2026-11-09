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

import { isRetentionExempt } from "./retention_exemptions.ts";

/** what the retention pass knows about one auto-definition when it judges it */
export interface AutoDefinitionFacts {
  modelType: string;
  /** the file's mtime; null when it could not be read */
  modifiedAt: Date | null;
  hasData: boolean;
  hasOutputs: boolean;
  referencedByWorkflow: boolean;
}

export type AutoDefinitionKeepReason =
  | "exempt"
  | "has_data"
  | "has_outputs"
  | "referenced_by_workflow"
  | "recently_modified";

export type AutoDefinitionVerdict =
  | { removable: true }
  | { removable: false; reason: AutoDefinitionKeepReason };

/**
 * Runs rarely rewrite the file, so data and outputs carry the idle signal; the
 * mtime only guards a definition created too recently to have written either.
 */
export function judgeAutoDefinition(
  facts: AutoDefinitionFacts,
  cutoff: Date,
): AutoDefinitionVerdict {
  if (isRetentionExempt(facts.modelType)) {
    return { removable: false, reason: "exempt" };
  }
  if (facts.hasData) return { removable: false, reason: "has_data" };
  if (facts.hasOutputs) return { removable: false, reason: "has_outputs" };
  if (facts.referencedByWorkflow) {
    return { removable: false, reason: "referenced_by_workflow" };
  }
  if (
    facts.modifiedAt === null ||
    !(facts.modifiedAt.getTime() < cutoff.getTime())
  ) {
    return { removable: false, reason: "recently_modified" };
  }
  return { removable: true };
}
