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
 * SPDX license expressions and the extension manifest's license policy.
 *
 * @module
 */

export {
  checkManifestLicense,
  isValidManifestLicense,
  type ManifestLicenseCheck,
  type ManifestLicenseViolation,
  type ManifestLicenseViolationReason,
  type ManifestLicenseWarning,
  manifestLicenseWarning,
} from "./manifest_license_policy.ts";
export {
  formatSpdxExpression,
  MAX_SPDX_EXPRESSION_LENGTH,
  parseSpdxExpression,
  type SpdxCompoundNode,
  type SpdxExpression,
  spdxLeaves,
  type SpdxLicenseNode,
  SpdxSyntaxError,
  type SpdxWithNode,
} from "./spdx_expression.ts";
export {
  SPDX_DEPRECATED_EXCEPTION_IDS,
  SPDX_DEPRECATED_LICENSE_IDS,
  SPDX_DEPRECATED_REPLACEMENTS,
  SPDX_EXCEPTION_IDS,
  SPDX_LICENSE_IDS,
  SPDX_LIST_VERSION,
} from "./spdx_lists.generated.ts";
