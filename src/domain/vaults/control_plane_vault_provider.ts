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

import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import type {
  VaultDeleteProvider,
  VaultProvider,
  VaultPutOptions,
} from "./vault_provider.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type EncryptedBlob,
  exportAesKey,
  generateAesKey,
  importAesKey,
} from "../crypto/aes_gcm.ts";
import { getLogger } from "@logtape/logtape";
import { UserError } from "../errors.ts";
import {
  classifyTokenKeyRecord,
  serializeTokenKeyMarker,
  tokenKeyFingerprint,
  type TokenKeyMarker,
  type TokenKeyRecord,
  type TokenSecretsKeyRef,
} from "./token_secrets_key.ts";

const logger = getLogger(["vaults", "control-plane"]);

export const TOKEN_SECRETS_VAULT_NAME = "_token-secrets";

const ENCRYPTION_KEY_PATH = "token-secrets/encryption-key";
const SECRET_PREFIX = "token-secrets/values/";

/**
 * Whether a set of control-plane records (keyed by path) still holds a
 * co-located token encryption key. Used to warn about root-level records a
 * namespace move copied but left behind: they still decrypt every token
 * secret that existed before the move.
 */
export function hasCoLocatedTokenKey(
  records: ReadonlyMap<string, Uint8Array>,
): boolean {
  const data = records.get(ENCRYPTION_KEY_PATH);
  if (!data) return false;
  try {
    return classifyTokenKeyRecord(data).kind === "legacy";
  } catch {
    return false;
  }
}

/**
 * An operator-supplied key that replaces the co-located one, with the vault
 * reference it was read from (recorded in the control-plane marker).
 */
export interface ExternalTokenKey {
  readonly ref: TokenSecretsKeyRef;
  readonly key: Uint8Array;
}

export interface ControlPlaneVaultProviderOptions {
  /**
   * Opt in to an external key. The provider then never generates or stores
   * key bytes in the control plane, and migrates secrets encrypted under a
   * co-located key the first time it starts.
   */
  readonly externalKey?: ExternalTokenKey;
}

export class ControlPlaneVaultProvider
  implements VaultProvider, VaultDeleteProvider {
  readonly #store: ControlPlaneStore;
  readonly #externalKey: ExternalTokenKey | undefined;
  #key: CryptoKey | undefined;

  constructor(
    store: ControlPlaneStore,
    options?: ControlPlaneVaultProviderOptions,
  ) {
    this.#store = store;
    this.#externalKey = options?.externalKey;
  }

  async initialize(): Promise<void> {
    this.#key = this.#externalKey
      ? await this.#bootstrapExternalKey(this.#externalKey)
      : await this.#bootstrapKey();
  }

  getName(): string {
    return TOKEN_SECRETS_VAULT_NAME;
  }

  async get(secretKey: string): Promise<string> {
    const key = this.#requireKey();
    const data = await this.#store.get(`${SECRET_PREFIX}${secretKey}`);
    if (data === null) {
      throw new Error(
        `Secret '${secretKey}' not found in ${TOKEN_SECRETS_VAULT_NAME}`,
      );
    }
    const blob: EncryptedBlob = JSON.parse(new TextDecoder().decode(data));
    return await aesGcmDecrypt(blob, key);
  }

  async put(
    secretKey: string,
    secretValue: string,
    _options?: VaultPutOptions,
  ): Promise<void> {
    const key = this.#requireKey();
    const blob = await aesGcmEncrypt(secretValue, key);
    const encoded = new TextEncoder().encode(JSON.stringify(blob));
    await this.#store.put(`${SECRET_PREFIX}${secretKey}`, encoded);
  }

  async delete(secretKey: string): Promise<void> {
    await this.#store.delete(`${SECRET_PREFIX}${secretKey}`);
  }

  async list(): Promise<string[]> {
    const keys = await this.#store.list(SECRET_PREFIX);
    return keys.map((k) => k.slice(SECRET_PREFIX.length));
  }

  #requireKey(): CryptoKey {
    if (!this.#key) {
      throw new Error(
        "ControlPlaneVaultProvider not initialized — call initialize() first",
      );
    }
    return this.#key;
  }

  async #bootstrapKey(): Promise<CryptoKey> {
    const existing = await this.#store.get(ENCRYPTION_KEY_PATH);
    if (existing) {
      logger.debug`Loaded existing token encryption key`;
      return await this.#importCoLocatedKey(existing);
    }

    const newKey = await generateAesKey();
    const exported = await exportAesKey(newKey);

    if (this.#store.putIfAbsent) {
      const won = await this.#store.putIfAbsent(ENCRYPTION_KEY_PATH, exported);
      if (won) {
        logger.info`Generated new token encryption key`;
        return newKey;
      }
      const theirs = await this.#store.get(ENCRYPTION_KEY_PATH);
      if (!theirs) {
        throw new Error(
          "Token encryption key disappeared after putIfAbsent race",
        );
      }
      logger.debug`Using token encryption key from another instance`;
      return await this.#importCoLocatedKey(theirs);
    }

    // Fallback for stores without putIfAbsent. Safe for single-instance
    // deployments. Multi-instance deployments MUST use a store that
    // implements putIfAbsent (FileSystemControlPlaneStore and S3 both do).
    await this.#store.put(ENCRYPTION_KEY_PATH, exported);
    const readBack = await this.#store.get(ENCRYPTION_KEY_PATH);
    if (!readBack) {
      throw new Error("Token encryption key missing after write");
    }
    const readBackBytes = new Uint8Array(readBack);
    if (readBackBytes.length !== exported.length) {
      logger
        .warn`Token encryption key was overwritten by another instance, using theirs`;
      return await this.#importCoLocatedKey(readBackBytes);
    }
    let same = true;
    for (let i = 0; i < exported.length; i++) {
      if (readBackBytes[i] !== exported[i]) {
        same = false;
        break;
      }
    }
    if (!same) {
      logger
        .warn`Token encryption key was overwritten by another instance, using theirs`;
      return await this.#importCoLocatedKey(readBackBytes);
    }

    logger.info`Generated new token encryption key (no putIfAbsent support)`;
    return newKey;
  }

  /**
   * Imports the co-located key record. A marker means the control plane was
   * moved to an external key, so running without one fails closed rather
   * than falling back to a key in the datastore.
   */
  async #importCoLocatedKey(data: Uint8Array): Promise<CryptoKey> {
    const bytes = new Uint8Array(data);
    let record: TokenKeyRecord | undefined;
    try {
      record = classifyTokenKeyRecord(bytes);
    } catch {
      // Unrecognized bytes: import as before, which reports the bad length.
    }
    if (record?.kind === "marker") {
      throw externalKeyRequiredError(record.marker);
    }
    return await importAesKey(bytes);
  }

  async #bootstrapExternalKey(external: ExternalTokenKey): Promise<CryptoKey> {
    const key = await importAesKey(external.key);
    const fingerprint = await tokenKeyFingerprint(external.key);
    const marker: TokenKeyMarker = {
      vault: external.ref.vault,
      key: external.ref.key,
      fingerprint,
      migratedAt: new Date().toISOString(),
    };

    let record = classifyTokenKeyRecord(
      await this.#store.get(ENCRYPTION_KEY_PATH),
    );
    if (record.kind === "absent") {
      const encoded = serializeTokenKeyMarker(marker);
      if (this.#store.putIfAbsent) {
        if (await this.#store.putIfAbsent(ENCRYPTION_KEY_PATH, encoded)) {
          logger
            .info`Token secrets use the external key from vault ${external.ref.vault}`;
          return key;
        }
        // Another instance wrote first: a marker (checked below) or, from an
        // instance without the opt-in, a co-located key to migrate.
        record = classifyTokenKeyRecord(
          await this.#store.get(ENCRYPTION_KEY_PATH),
        );
      } else {
        await this.#store.put(ENCRYPTION_KEY_PATH, encoded);
        logger
          .info`Token secrets use the external key from vault ${external.ref.vault}`;
        return key;
      }
    }

    if (record.kind === "marker") {
      if (record.marker.fingerprint !== fingerprint) {
        throw new UserError(
          `The token secrets key in vault '${external.ref.vault}' (key ` +
            `'${external.ref.key}') is not the key the ` +
            `${TOKEN_SECRETS_VAULT_NAME} control plane is encrypted with ` +
            `(recorded from vault '${record.marker.vault}', key ` +
            `'${record.marker.key}'). Every serve instance and every host ` +
            "that runs access token commands needs the same key.",
        );
      }
      logger
        .debug`Token secrets use the external key from vault ${external.ref.vault}`;
      return key;
    }

    if (record.kind === "legacy") {
      await this.#migrateFromCoLocatedKey(
        await importAesKey(record.key),
        key,
        marker,
      );
      return key;
    }

    throw new Error("Token encryption key record disappeared during startup");
  }

  /**
   * Re-encrypts every secret under the external key, then overwrites the
   * co-located key with the marker. The marker is written last so a crash
   * leaves the co-located key in place and the next start resumes; entries
   * already under the external key are skipped. Overwriting rather than
   * deleting matters: a swamp version without external-key support that
   * finds no key would generate a new co-located one.
   */
  async #migrateFromCoLocatedKey(
    legacyKey: CryptoKey,
    externalKey: CryptoKey,
    marker: TokenKeyMarker,
  ): Promise<void> {
    logger
      .info`Moving token secrets from the co-located key to the external key from vault ${marker.vault}`;
    let reencrypted = 0;
    const undecryptable: string[] = [];
    for (const path of await this.#store.list(SECRET_PREFIX)) {
      const name = path.slice(SECRET_PREFIX.length);
      const data = await this.#store.get(path);
      if (data === null) continue;

      let blob: EncryptedBlob;
      try {
        blob = JSON.parse(new TextDecoder().decode(data));
      } catch {
        undecryptable.push(name);
        continue;
      }
      if (await canDecrypt(blob, externalKey)) continue;

      let plaintext: string;
      try {
        plaintext = await aesGcmDecrypt(blob, legacyKey);
      } catch {
        undecryptable.push(name);
        continue;
      }
      const reencryptedBlob = await aesGcmEncrypt(plaintext, externalKey);
      await this.#store.put(
        path,
        new TextEncoder().encode(JSON.stringify(reencryptedBlob)),
      );
      reencrypted++;
    }

    await this.#store.put(ENCRYPTION_KEY_PATH, serializeTokenKeyMarker(marker));

    for (const name of undecryptable) {
      logger
        .error`Token secret ${name} could not be decrypted with the co-located or the external key and was left as is. Re-mint the token that uses it.`;
    }
    logger
      .info`Re-encrypted ${reencrypted} token secret(s) with the external key and removed the co-located key`;
    logger
      .warn`Datastore backups and earlier object versions from before this migration still contain the old key and can decrypt the token secrets that existed then. Rotate those tokens, and purge noncurrent object versions under _control/token-secrets/ if the bucket keeps versions.`;
  }
}

async function canDecrypt(
  blob: EncryptedBlob,
  key: CryptoKey,
): Promise<boolean> {
  try {
    await aesGcmDecrypt(blob, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Raised when the control plane holds an external-key marker but this process
 * has no key configured. Names the recorded vault reference so the operator
 * knows what to configure; the reference is never used to fetch a key.
 */
export function externalKeyRequiredError(marker: TokenKeyMarker): UserError {
  return new UserError(
    `The ${TOKEN_SECRETS_VAULT_NAME} control plane is encrypted with an ` +
      `external key (configured from vault '${marker.vault}', key ` +
      `'${marker.key}'), but no token secrets key is configured here. Add a ` +
      "token-secrets block with that vault and key to .swamp/serve.yaml " +
      "(or the serve --config file).",
  );
}
