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
 * Whether an identifier names a secret value. The push review rules, the
 * secret-docs detector and the registry's scorecard read argument names the
 * same way through this module.
 */

/**
 * Word stems that name a secret value, tested against a normalized identifier
 * (see {@link normalizeIdentifier}). A stem counts anywhere in the identifier,
 * so joined lowercase names such as `clientsecret` and `dbpassword` are caught
 * exactly as the substring rule caught them; what makes the match
 * whole-identifier is that only key and declaration identifiers are tested,
 * and that {@link REFERENCE_SUFFIX} and {@link REFERENCE_WORD} then exclude
 * references to secrets.
 */
const SECRET_STEM =
  /password|passwd|secret|token|api_?key|access_?key|credential|private_?key/;

/**
 * Trailing segments that turn a secret stem into a reference to a secret
 * rather than the secret itself. Each entry comes from an identifier in the
 * swamp-extensions corpus that the rule flagged before swamp-club#3019:
 * `secretName`, `credential_id`, `TokenReference`, `credentialRef`,
 * `SecretArn`, `gcpSecretManagerSecretUri`, `oauth_token_url`,
 * `tokenEndpoint`, `acsTokenLink`, `secretVersion`, `secretType`,
 * `credential_kind`, `tokenCount`, `tokenTtl`, `passwordExpirationTimeout`,
 * `accessTokenExpireTime`, `credentialRefSource`. None of them names a string
 * that holds a secret. The list is applied to the normalized identifier, so
 * camelCase and snake_case spellings share one entry.
 */
const REFERENCE_SUFFIX =
  /(?:^|_)(?:name|id|reference|ref|arn|uri|url|endpoint|link|version|type|kind|count|ttl|timeout|expire_time|source)$/;

/**
 * Whole identifiers that contain a secret stem but name a pagination or
 * idempotency token, never a credential. Corpus examples: `nextToken`,
 * `pageToken`, `nextPageToken`, `ClientToken`, `syncToken`.
 */
const REFERENCE_WORD =
  /^(?:next_token|page_token|next_page_token|client_token|sync_token)$/;

/**
 * The metadata entry that marks a field sensitive: `sensitive: true` (the key
 * may be quoted), as swamp reads it back from `z.globalRegistry`. Any way of
 * writing that entry on the field's line counts — `.meta({ sensitive: true })`,
 * a meta object with other keys before it, or
 * `.register(z.globalRegistry, { sensitive: true })`. The word `sensitive` in
 * a `describe()` string does not count, and neither does `sensitive: false`.
 *
 * Past the field's line, a source that parses is read as a syntax tree: the
 * entry counts anywhere in the field's own chain, however `deno fmt` wraps
 * the object, and text in a string or comment never counts (see
 * `carriesSensitiveMarker`). A source that does not parse is read line by
 * line, and the entry counts on `.`-prefixed continuation lines only.
 * Metadata passed as a variable (`.meta(SENSITIVE)`) is not recognised; write
 * the entry out on the chain.
 */
export const MARKED_SENSITIVE = /(?:^|[^\w$])["']?sensitive["']?\s*:\s*true\b/;

/**
 * Normalizes an identifier to lowercase snake_case so stems and suffixes can
 * be matched as whole segments: `s3AccessKeyId` → `s3_access_key_id`,
 * `APIKeyId` → `api_key_id`, `HANASecretName` → `hana_secret_name`,
 * `"api-key"` → `api_key`, `"auth.token"` → `auth_token`, `$token` → `token`.
 */
function normalizeIdentifier(identifier: string): string {
  return identifier
    .replace(/^[_$]+/, "")
    .replace(/[-$.\s]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * True when `identifier` names a secret value: it carries a secret stem and
 * is neither a reference to a secret nor a known pagination or idempotency
 * token.
 */
export function namesSecretValue(identifier: string): boolean {
  const normalized = normalizeIdentifier(identifier);
  if (!SECRET_STEM.test(normalized)) return false;
  if (REFERENCE_SUFFIX.test(normalized)) return false;
  if (REFERENCE_WORD.test(normalized)) return false;
  return true;
}
