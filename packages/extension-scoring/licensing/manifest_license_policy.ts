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

import {
  parseSpdxExpression,
  type SpdxExpression,
  spdxLeaves,
  SpdxSyntaxError,
} from "./spdx_expression.ts";
import {
  SPDX_DEPRECATED_EXCEPTION_IDS,
  SPDX_DEPRECATED_LICENSE_IDS,
  SPDX_DEPRECATED_REPLACEMENTS,
  SPDX_EXCEPTION_IDS,
  SPDX_LICENSE_IDS,
} from "./spdx_lists.generated.ts";

export type ManifestLicenseViolationReason =
  | "invalid-syntax"
  | "unknown-license"
  | "deprecated-license"
  | "unknown-exception"
  | "custom-ref";

export interface ManifestLicenseViolation {
  reason: ManifestLicenseViolationReason;
  term?: string;
  message: string;
}

export type ManifestLicenseCheck =
  | { valid: true; expression: SpdxExpression }
  | { valid: false; violations: ManifestLicenseViolation[] };

const LICENSES = new Set(SPDX_LICENSE_IDS);
const DEPRECATED_LICENSES = new Set(SPDX_DEPRECATED_LICENSE_IDS);
const DEPRECATED_EXCEPTIONS = new Set(SPDX_DEPRECATED_EXCEPTION_IDS);

function caseIndex(ids: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const id of ids) index.set(id.toLowerCase(), id);
  return index;
}

const LICENSES_BY_CASE = caseIndex([
  ...SPDX_LICENSE_IDS,
  ...SPDX_DEPRECATED_LICENSE_IDS,
]);
const EXCEPTIONS_BY_CASE = caseIndex([
  ...SPDX_EXCEPTION_IDS,
  ...SPDX_DEPRECATED_EXCEPTION_IDS,
]);

const CUSTOM_REF = /^(LicenseRef-|AdditionRef-|DocumentRef-)/i;

function customRef(term: string): ManifestLicenseViolation {
  return {
    reason: "custom-ref",
    term,
    message:
      `"${term}" is a custom reference, not an SPDX identifier; only SPDX ids count.`,
  };
}

function checkLicenseId(
  id: string,
  orLater: boolean,
): ManifestLicenseViolation | undefined {
  if (CUSTOM_REF.test(id)) return customRef(id);
  const canonical = LICENSES_BY_CASE.get(id.toLowerCase());
  if (canonical === undefined) {
    return {
      reason: "unknown-license",
      term: id,
      message:
        `"${id}" is not on the SPDX License List (https://spdx.org/licenses/).`,
    };
  }
  if (orLater) {
    const deprecated = SPDX_DEPRECATED_REPLACEMENTS[`${canonical}+`];
    const later = `${canonical.replace(/-only$/, "")}-or-later`;
    const suggestion = deprecated ??
      (LICENSES.has(later) ? later : undefined);
    return {
      reason: "deprecated-license",
      term: `${id}+`,
      message: `"${id}+" uses the deprecated "+" form${
        suggestion ? `; did you mean ${suggestion}?` : "."
      }`,
    };
  }
  if (DEPRECATED_LICENSES.has(canonical)) {
    const suggestion = SPDX_DEPRECATED_REPLACEMENTS[canonical];
    return {
      reason: "deprecated-license",
      term: id,
      message: `"${id}" is a deprecated SPDX id${
        suggestion ? `; did you mean ${suggestion}?` : "."
      }`,
    };
  }
  if (canonical !== id) {
    return {
      reason: "unknown-license",
      term: id,
      message: `"${id}" is not an SPDX id; did you mean ${canonical}?`,
    };
  }
  return undefined;
}

function checkException(
  exception: string,
): ManifestLicenseViolation | undefined {
  if (CUSTOM_REF.test(exception)) return customRef(exception);
  const canonical = EXCEPTIONS_BY_CASE.get(exception.toLowerCase());
  if (canonical === undefined) {
    return {
      reason: "unknown-exception",
      term: exception,
      message:
        `"${exception}" is not on the SPDX License Exceptions List (https://spdx.org/licenses/exceptions-index.html).`,
    };
  }
  if (DEPRECATED_EXCEPTIONS.has(canonical)) {
    return {
      reason: "deprecated-license",
      term: exception,
      message: `"${exception}" is a deprecated SPDX exception id.`,
    };
  }
  if (canonical !== exception) {
    return {
      reason: "unknown-exception",
      term: exception,
      message:
        `"${exception}" is not an SPDX exception id; did you mean ${canonical}?`,
    };
  }
  return undefined;
}

export function checkManifestLicense(license: string): ManifestLicenseCheck {
  let expression: SpdxExpression;
  try {
    expression = parseSpdxExpression(license);
  } catch (error) {
    if (!(error instanceof SpdxSyntaxError)) throw error;
    return {
      valid: false,
      violations: [{
        reason: "invalid-syntax",
        ...(error.term !== undefined ? { term: error.term } : {}),
        message: `not a valid SPDX expression: ${error.message}.`,
      }],
    };
  }
  const violations: ManifestLicenseViolation[] = [];
  for (const leaf of spdxLeaves(expression)) {
    const license = leaf.kind === "with" ? leaf.license : leaf;
    const idProblem = checkLicenseId(license.id, license.orLater);
    if (idProblem) violations.push(idProblem);
    if (leaf.kind === "with") {
      const exceptionProblem = checkException(leaf.exception);
      if (exceptionProblem) violations.push(exceptionProblem);
    }
  }
  return violations.length === 0
    ? { valid: true, expression }
    : { valid: false, violations };
}

export function isValidManifestLicense(license: string | undefined): boolean {
  return license !== undefined && checkManifestLicense(license).valid;
}

export interface ManifestLicenseWarning {
  license: string;
  reason: ManifestLicenseViolationReason;
  term?: string;
  message: string;
  violations: ManifestLicenseViolation[];
}

/**
 * a license is optional: an invalid one never blocks, it only earns no quality
 * points
 */
export function manifestLicenseWarning(
  license: string | undefined,
): ManifestLicenseWarning | undefined {
  if (license === undefined) return undefined;
  const check = checkManifestLicense(license);
  if (check.valid) return undefined;
  const [first] = check.violations;
  return {
    license,
    reason: first.reason,
    ...(first.term !== undefined ? { term: first.term } : {}),
    message:
      `License "${license}" in manifest.yaml is not a valid SPDX expression, so it earns no quality points: ${
        check.violations.map((v) => v.message).join(" ")
      }`,
    violations: check.violations,
  };
}
