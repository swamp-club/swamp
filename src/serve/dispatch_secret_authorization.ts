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

import { computeChecksum } from "../domain/models/checksum.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import {
  parseSensitiveFieldsTag,
  SENSITIVE_FIELDS_VERSION,
  SENSITIVE_FIELDS_VERSION_TAG,
  sensitiveVaultReferences,
} from "../domain/models/data_writer.ts";
import { SERVER_TOKEN_SECRET_KEY_PREFIX } from "../domain/models/access/server_token_model.ts";
import { WORKER_TOKEN_SECRET_KEY_PREFIX } from "../domain/models/worker/enrollment_token_model.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import type { ActiveDispatch } from "./dispatch_registry.ts";

const DENIED_VAULT_NAMES: ReadonlySet<string> = new Set([
  TOKEN_SECRETS_VAULT_NAME,
]);

const DENIED_SECRET_KEY_PREFIXES: readonly string[] = [
  SERVER_TOKEN_SECRET_KEY_PREFIX,
  WORKER_TOKEN_SECRET_KEY_PREFIX,
  "oauth-client-secret",
  "oauth-access-token-",
  "oauth-bootstrap-access-token",
  "oauth-resolved-admins",
  "oauth-resolved-grant-usernames",
];

const CLAIM_CACHE_LIMIT = 256;

export function assertVaultNotDenied(vaultName: string, verb: string): void {
  if (DENIED_VAULT_NAMES.has(vaultName)) {
    throw new Error(
      `${verb}: access denied — reserved vault '${vaultName}' is not accessible from dispatched methods`,
    );
  }
}

export function assertSecretKeyNotDenied(
  secretKey: string,
  verb: string,
): void {
  const normalized = secretKey.toLowerCase();
  if (DENIED_SECRET_KEY_PREFIXES.some((p) => normalized.startsWith(p))) {
    throw new Error(
      `${verb}: access denied — infrastructure secrets are not accessible from dispatched methods`,
    );
  }
}

export class ResourceClaimRefusedError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "ResourceClaimRefusedError";
  }
}

export interface ResourceClaimVerifierOptions {
  verb: string;
  repoFor: (dispatch: ActiveDispatch) => UnifiedDataRepository;
}

/**
 * a verified claim supplements the argument allowlist; denylists run before it,
 * vault scope after; own-namespace records are trusted state, and the version
 * tag is no defense against storage tampering
 */
export class ResourceClaimVerifier {
  readonly #options: ResourceClaimVerifierOptions;
  /**
   * references a verified claim admits, by dispatch, resource and version, so
   * repeated reads parse the record once; a version never changes and the key
   * holds the dispatch; bounded, oldest goes first
   */
  readonly #admitted = new Map<string, ReadonlySet<string>>();

  constructor(options: ResourceClaimVerifierOptions) {
    this.#options = options;
  }

  async verify(
    dispatch: ActiveDispatch,
    claim: { name: string; version: number },
    vaultName: string,
    secretKey: string,
  ): Promise<void> {
    const refused = (reason: string) =>
      new ResourceClaimRefusedError(
        `${this.#options.verb}: secret '${secretKey}' is not a tagged sensitive field of resource '${claim.name}' (${reason})`,
        reason,
      );
    const cacheKey =
      `${dispatch.dispatchId}\u0000${claim.name}\u0000${claim.version}`;
    let admitted = this.#admitted.get(cacheKey);
    if (admitted === undefined) {
      const repo = this.#options.repoFor(dispatch);
      const record = await repo.findByName(
        dispatch.modelType,
        dispatch.modelId,
        claim.name,
        claim.version,
      );
      if (record === null) {
        throw refused("no such resource of the dispatched behavior");
      }
      if (
        record.name !== claim.name || record.version !== claim.version ||
        record.ownerDefinition.ownerType !== "model-method" ||
        record.ownerDefinition.ownerRef !== dispatch.modelId
      ) {
        throw refused(
          "the record identity does not match the dispatched behavior",
        );
      }
      const sensitiveFields = parseSensitiveFieldsTag(record.tags);
      if (sensitiveFields === null) {
        throw refused("the record has no sensitive fields");
      }
      if (
        record.tags[SENSITIVE_FIELDS_VERSION_TAG] !== SENSITIVE_FIELDS_VERSION
      ) {
        throw refused("the record predates verified sensitive-field writes");
      }
      if (record.checksum === undefined) {
        throw refused("the record has no content checksum");
      }
      const content = await repo.getContent(
        dispatch.modelType,
        dispatch.modelId,
        claim.name,
        claim.version,
      );
      if (content === null) throw refused("the record has no content");
      // A concurrent ephemeral write can change which backing store supplies
      // getContent after findByName returned persistent metadata. Only bytes
      // matching that metadata may authorize references or enter the cache.
      if (await computeChecksum(content) !== record.checksum) {
        throw refused("the record content does not match its checksum");
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder().decode(content));
      } catch {
        throw refused("the record is not JSON");
      }
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw refused("the record is not an object");
      }
      admitted = new Set(
        sensitiveVaultReferences(
          data as Record<string, unknown>,
          sensitiveFields,
        ).map((ref) => `${ref.vaultName}\u0000${ref.key}`),
      );
      if (this.#admitted.size >= CLAIM_CACHE_LIMIT) {
        const oldest = this.#admitted.keys().next().value;
        if (oldest !== undefined) this.#admitted.delete(oldest);
      }
      this.#admitted.set(cacheKey, admitted);
    }
    if (!admitted.has(`${vaultName}\u0000${secretKey}`)) {
      throw refused("its sensitive fields do not reference it");
    }
  }
}
