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
 * The extension dependency trust audit: which `npm:` and `jsr:` imports an
 * extension ships, the version each ships, and what npm, OSV and JSR say
 * about it. The caller fetches; these decide.
 *
 * @module
 */

export {
  auditRecordEntryUsable,
  buildDependencyAuditRecord,
  buildDependencyAuditRecordV2,
  DEFAULT_BUNDLE_FORMAT,
  DEPENDENCY_AUDIT_RECORD_FILENAME,
  DEPENDENCY_AUDIT_RECORD_VERSION,
  DEPENDENCY_AUDIT_RECORD_VERSION_2,
  type DependencyAuditRecord,
  type DependencyAuditRecordEntry,
  type DependencyAuditRecordV2,
  type DependencyAuditRecordV2Entry,
  isPlainSemver,
  MAX_DEPENDENCY_AUDIT_RECORD_BYTES,
  parseDependencyAuditRecord,
  parseDependencyAuditRecordV2,
  serializeDependencyAuditRecord,
  serializeDependencyAuditRecordV2,
  type ShippedDependency,
  type ShippedImport,
  type UnauditedDependency,
  type UnauditedDependencyKind,
} from "./audit_record.ts";
export {
  canonicalRecordedVersions,
  canonicalShippedSpecifierIssue,
} from "./canonical.ts";
export {
  DEFAULT_TRUST_THRESHOLDS,
  type DependencyAuditSummary,
  dependencyTrustBlockerCount,
  type DependencyTrustCause,
  type DependencyTrustIssue,
  type DependencyTrustResult,
  evaluateJsrPackage,
  evaluateNpmPackage,
  failedPackageAudits,
  groupForAudit,
  type JsrLookup,
  jsrNameValid,
  LICENSE_ALLOWLIST,
  licenseAllowed,
  type Lookup,
  looseSpecifierCount,
  MAX_AUDITED_DEPENDENCIES,
  notAuditedCount,
  notAuditedFixes,
  type NpmLookup,
  npmNameValid,
  type NpmPlan,
  onlyOutagesNotAudited,
  overLimitAudits,
  planNpmPackage,
  pushResult,
  type ScorecardDependencyAudited,
  type ScorecardDependencyFinding,
  type ScorecardDependencyTrust,
  scorecardResult,
  type SpecifierAudit,
  type TrustThresholds,
  unpublishedSpecifiers,
  UNREADABLE_MODULE_REASON,
  withUnauditedCode,
} from "./evaluate.ts";
export { MAX_LOCKFILE_BYTES, parseDenoLockfile } from "./lockfile.ts";
export {
  deprecationOf,
  factsFor,
  type JsrPackageMeta,
  licenseOf,
  monthsSince,
  type NpmPackageFacts,
  type NpmPackument,
  parseJsrMeta,
  parseNpmPackument,
  sanitiseDeprecationNotice,
} from "./npm.ts";
export {
  extractSeverity,
  MalformedOsvResponseError,
  type OsvSeverity,
  type OsvVulnerability,
  parseCvssV3BaseScore,
  parseOsvResponse,
} from "./osv.ts";
export {
  DEPENDENCY_TRUST_MAX_POINTS,
  dependencyTrustEarnedPoints,
  NOT_AUDITED_FIX,
  type NotAuditedFix,
} from "./points.ts";
export {
  exactVersion,
  type LockedDependencyVersions,
  type PublishedPackage,
  type RecordedDependencyVersions,
  resolveAuditVersion,
  resolveShippedVersion,
  type ShippedVersion,
  type ShippedVersionSource,
  type SpecifierKind,
  specifierKind,
  suggestVersion,
} from "./resolution.ts";
export {
  CODE_FILE_EXTENSIONS,
  compareSpecifiers,
  type DependencyRegistry,
  type DependencySpecifier,
  isAuditedCodeFile,
  JSR_NAME_RE,
  NPM_NAME_RE,
  parseSpecifier,
  specifierKey,
  specifierText,
  writtenSpecifiers,
} from "./specifiers.ts";
