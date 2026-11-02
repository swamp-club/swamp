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
 * a stem counts anywhere in the identifier, so joined lowercase names like
 * clientsecret are caught; only key and declaration identifiers are tested, and
 * REFERENCE_SUFFIX and REFERENCE_WORD exclude references to secrets
 */
const SECRET_STEM =
  /password|passwd|secret|token|api_?key|access_?key|credential|private_?key/;

/**
 * trailing segments that make a secret stem a reference to a secret rather than
 * the secret itself (secretName, credential_id, tokenCount); applied to the
 * normalized identifier so camelCase and snake_case share one entry
 */
const REFERENCE_SUFFIX =
  /(?:^|_)(?:name|id|reference|ref|arn|uri|url|endpoint|link|version|type|kind|count|ttl|timeout|expire_time|source)$/;

/**
 * whole identifiers with a secret stem that name a pagination or idempotency
 * token, never a credential (nextToken, pageToken, ClientToken)
 */
const REFERENCE_WORD =
  /^(?:next_token|page_token|next_page_token|client_token|sync_token)$/;

/**
 * the entry may sit anywhere in the field's own chain; text in a string or
 * comment never counts; a source that does not parse counts it on dot-prefixed
 * continuation lines only
 */
export const MARKED_SENSITIVE = /(?:^|[^\w$])["']?sensitive["']?\s*:\s*true\b/;

function normalizeIdentifier(identifier: string): string {
  return identifier
    .replace(/^[_$]+/, "")
    .replace(/[-$.\s]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function namesSecretValue(identifier: string): boolean {
  const normalized = normalizeIdentifier(identifier);
  if (!SECRET_STEM.test(normalized)) return false;
  if (REFERENCE_SUFFIX.test(normalized)) return false;
  if (REFERENCE_WORD.test(normalized)) return false;
  return true;
}
