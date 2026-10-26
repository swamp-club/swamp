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

/**
 * The extension quality rubric: factor table, per-version analysis, and the
 * score both the CLI and the registry compose.
 *
 * @module
 */

export {
  type AnalysisFactors,
  computeAnalysisFactors,
  countExports,
  countFencedCodeBlocks,
  countSlowTypeDiagnostics,
  type DocNode,
  type DocOutput,
  hasFencedCodeBlock,
  hasModuleDoc,
  SLOW_TYPE_CODES,
} from "./analysis.ts";
export {
  type ParsedVcsUrl,
  parseVcsUrl,
  type PrivateSourceStanding,
  type RepositoryEvidence,
  type VcsHost,
} from "./repository.ts";
export {
  composeScore,
  type DependencyTrustInput,
  type FactorCategory,
  type FactorStatus,
  gradeForPercentage,
  RUBRIC_VERSION,
  type RubricFactor,
  type RubricInputs,
  type RubricScore,
  type ScoreGrade,
  SECRET_SAFE_DOCS_REMEDIATION,
  type VersionAnalysis,
} from "./score.ts";
export {
  DEPENDENCY_TRUST_MAX_POINTS,
  dependencyTrustEarnedPoints,
  NOT_AUDITED_FIX,
  type NotAuditedFix,
} from "../dependency_audit/points.ts";
export { redactPaths, stripAnsi } from "../text.ts";
