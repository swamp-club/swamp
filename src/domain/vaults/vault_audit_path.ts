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

import { join } from "@std/path";

const VAULT_AUDIT_FILENAME_PREFIX = "vault-reads-";
const VAULT_AUDIT_FILENAME_SUFFIX = ".jsonl";

export const VAULT_AUDIT_FILENAME_PATTERN =
  /^vault-reads-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function vaultAuditFilename(date: string): string {
  return `${VAULT_AUDIT_FILENAME_PREFIX}${date}${VAULT_AUDIT_FILENAME_SUFFIX}`;
}

function datePartOfIsoTimestamp(iso: string): string {
  return iso.split("T")[0];
}

export function vaultAuditFilenameForTimestamp(isoTimestamp: string): string {
  return vaultAuditFilename(datePartOfIsoTimestamp(isoTimestamp));
}

export function vaultAuditFilePathForTimestamp(
  auditDir: string,
  isoTimestamp: string,
): string {
  return join(auditDir, vaultAuditFilenameForTimestamp(isoTimestamp));
}
