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

import { getLogger } from "@logtape/logtape";
import { dirname, isAbsolute, join, relative } from "@std/path";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import type {
  VaultDeleteProvider,
  VaultExistenceProvider,
  VaultProvider,
  VaultPutOptions,
} from "./vault_provider.ts";
import type { VaultAnnotationProvider } from "./vault_annotation.ts";
import { VaultAnnotation } from "./vault_annotation.ts";
import type { VaultRefreshHookProvider } from "./refresh_hook.ts";
import { RefreshHook } from "./refresh_hook.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import {
  assertSafePath,
  isSinglePathSegment,
  PathTraversalError,
} from "../../infrastructure/persistence/safe_path.ts";
import {
  checkFileNotBroadlyReadable,
  type SecurityCheckResult,
} from "../../infrastructure/security/file_security_check.ts";
import { errorPaths, markErrorPaths } from "../errors.ts";

const logger = getLogger(["vaults", "local-encryption"]);

export interface LocalEncryptionConfig {
  ssh_key_path?: string;
  auto_generate?: boolean;
  key_file?: string;
  base_dir?: string;
}

interface EncryptedData {
  iv: string;
  data: string;
  salt: string;
  version: number;
}

/** storage is keyed on the vault name, so a rename must move this directory */
export function localEncryptionSecretsDir(
  baseDir: string,
  vaultName: string,
): string {
  return swampPath(
    baseDir,
    SWAMP_SUBDIRS.secrets,
    "local_encryption",
    vaultName,
  );
}

/**
 * the whole directory moves in one rename so the generated key moves with its
 * secrets; a non-empty target is refused as it holds another vault's secrets
 * under a different key
 */
export async function moveLocalEncryptionSecrets(
  baseDir: string,
  fromName: string,
  toName: string,
): Promise<boolean> {
  const boundary = swampPath(baseDir);
  const fromDir = localEncryptionSecretsDir(baseDir, fromName);
  const toDir = localEncryptionSecretsDir(baseDir, toName);
  await assertSafePath(fromDir, boundary);
  await assertSafePath(toDir, boundary);

  try {
    await Deno.lstat(fromDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }

  if (!(await isAbsentOrEmptyDir(toDir))) {
    throw new Error(
      `Secrets are already stored under vault name '${toName}'. ` +
        `Remove them before renaming vault '${fromName}' to '${toName}'.`,
    );
  }
  try {
    await Deno.remove(toDir);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  await Deno.rename(fromDir, toDir);
  return true;
}

/**
 * storage is keyed on the vault name, so leftovers from an earlier vault of
 * that name would be adopted, key and secrets included, by a new vault
 */
export async function findLocalEncryptionLeftovers(
  baseDir: string,
  vaultName: string,
): Promise<string | undefined> {
  const directory = localEncryptionSecretsDirFor(baseDir, vaultName);
  return (await isAbsentOrEmptyDir(directory)) ? undefined : directory;
}

/**
 * relative to repoDir when inside, so a refusal sent to a serve client carries
 * no host path
 */
export function secretsDirForDisplay(
  directory: string,
  repoDir: string,
): string {
  const rel = relative(repoDir, directory);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel)
    ? directory
    : rel;
}

export interface RemovedLocalEncryptionSecrets {
  directory: string;
  removed: boolean;
  secretCount: number;
}

/**
 * name and base dir come from committed config, so the name must be one path
 * segment and the parent must resolve inside boundary; a symlinked directory is
 * unlinked, never followed
 */
export async function removeLocalEncryptionSecrets(
  baseDir: string,
  vaultName: string,
  boundary: string,
): Promise<RemovedLocalEncryptionSecrets> {
  const directory = localEncryptionSecretsDirFor(baseDir, vaultName);
  await assertSafePath(dirname(directory), boundary);
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(directory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { directory, removed: false, secretCount: 0 };
    }
    throw error;
  }
  if (!info.isDirectory) {
    await Deno.remove(directory);
    return { directory, removed: true, secretCount: 0 };
  }
  await assertSafePath(directory, boundary);
  const secretCount = await countLocalEncryptionSecrets(directory);
  await Deno.remove(directory, { recursive: true });
  return { directory, removed: true, secretCount };
}

export async function localEncryptionSecretsWithin(
  baseDir: string,
  vaultName: string,
  boundary: string,
): Promise<boolean> {
  const directory = localEncryptionSecretsDirFor(baseDir, vaultName);
  try {
    await assertSafePath(dirname(directory), boundary);
    return true;
  } catch (error) {
    if (error instanceof PathTraversalError) return false;
    throw error;
  }
}

export async function countLocalEncryptionSecrets(
  directory: string,
): Promise<number> {
  try {
    if (!(await Deno.lstat(directory)).isDirectory) return 0;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  let count = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".enc")) count++;
  }
  return count;
}

/**
 * refuses a vault name that is not one path segment, so the directory can only
 * be a child of the secrets root
 */
export function localEncryptionSecretsDirFor(
  baseDir: string,
  vaultName: string,
): string {
  if (!isSinglePathSegment(vaultName)) {
    throw new Error(
      `Vault name '${vaultName}' is not a single path segment, so its ` +
        `local_encryption secrets directory cannot be located safely.`,
    );
  }
  return localEncryptionSecretsDir(baseDir, vaultName);
}

async function isAbsentOrEmptyDir(path: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  if (!info.isDirectory) return false;
  for await (const _entry of Deno.readDir(path)) return false;
  return true;
}

export class LocalEncryptionVaultProvider
  implements
    VaultProvider,
    VaultAnnotationProvider,
    VaultRefreshHookProvider,
    VaultDeleteProvider,
    VaultExistenceProvider {
  private readonly name: string;
  private readonly config: LocalEncryptionConfig;
  private readonly vaultDir: string;
  private readonly secretsBoundary: string;
  /**
   * caches key material, not the derived key, since each secret has a unique
   * salt
   */
  private keyMaterialCache?: CryptoKey;

  constructor(name: string, config: LocalEncryptionConfig = {}) {
    this.name = name;
    this.config = config;
    const baseDir = config.base_dir ?? Deno.cwd();
    this.secretsBoundary = swampPath(baseDir);
    this.vaultDir = localEncryptionSecretsDir(baseDir, name);
  }

  async get(secretKey: string): Promise<string> {
    this.validateSecretKey(secretKey);
    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);

    try {
      const encryptedContent = await Deno.readTextFile(encryptedFilePath);
      const encryptedData: EncryptedData = JSON.parse(encryptedContent);

      const masterKey = await this.getMasterKey(encryptedData.salt);
      const decryptedValue = await this.decrypt(encryptedData, masterKey);

      return decryptedValue;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `Secret '${secretKey}' not found in local vault '${this.name}'`,
        );
      }
      throw this.retrieveError(secretKey, error);
    }
  }

  /**
   * opens the file read-only without reading it, so a corrupt file still
   * answers true; unlike get it asserts the path inside the secrets boundary,
   * so a symlinked vault dir fails safe
   */
  async has(secretKey: string): Promise<boolean> {
    this.validateSecretKey(secretKey);
    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);
    await assertSafePath(encryptedFilePath, this.secretsBoundary);

    // Open read-only and stat the handle, then close it without reading a
    // byte. A bare stat needs only search permission on the directory and
    // would say yes to a file the process cannot read, where `get` fails.
    let info: Deno.FileInfo;
    try {
      const file = await Deno.open(encryptedFilePath, { read: true });
      try {
        info = await file.stat();
      } finally {
        file.close();
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw this.retrieveError(secretKey, error);
    }
    if (!info.isFile) {
      throw this.retrieveError(secretKey, new Error("not a regular file"));
    }
    try {
      await this.getKeyMaterial();
    } catch (error) {
      throw this.retrieveError(secretKey, error);
    }
    return true;
  }

  private retrieveError(secretKey: string, error: unknown): Error {
    return new Error(
      `Failed to retrieve secret '${secretKey}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  async put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void> {
    this.validateSecretKey(secretKey);
    await this.ensureVaultDirectory();

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const masterKey = await this.getMasterKey(this.arrayBufferToBase64(salt));
    const encryptedData = await this.encrypt(secretValue, masterKey, salt);

    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);
    await assertSafePath(encryptedFilePath, this.secretsBoundary);
    await atomicWriteTextFile(
      encryptedFilePath,
      JSON.stringify(encryptedData, null, 2),
      { mode: 0o600 },
    );

    if (options?.tags && Object.keys(options.tags).length > 0) {
      const existing = await this.getAnnotation(secretKey);
      const annotation = existing
        ? existing.merge({ labels: options.tags })
        : VaultAnnotation.create({ labels: options.tags });
      await this.putAnnotation(secretKey, annotation);
    }
  }

  getName(): string {
    return this.name;
  }

  async list(): Promise<string[]> {
    const secretKeys: string[] = [];

    try {
      for await (const entry of Deno.readDir(this.vaultDir)) {
        if (entry.isFile && entry.name.endsWith(".enc")) {
          const keyName = entry.name.slice(0, -4);
          secretKeys.push(keyName);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw new Error(
        `Failed to list secrets in local vault '${this.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return secretKeys.sort();
  }

  async delete(secretKey: string): Promise<void> {
    this.validateSecretKey(secretKey);
    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);
    await assertSafePath(encryptedFilePath, this.secretsBoundary);

    try {
      await Deno.remove(encryptedFilePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `Secret '${secretKey}' not found in local vault '${this.name}'`,
        );
      }
      throw new Error(
        `Failed to delete secret '${secretKey}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Best-effort cleanup of associated annotation and refresh hook.
    // The primary secret is already gone — don't throw if cleanup fails.
    try {
      const annotationPath = this.annotationPath(secretKey);
      await assertSafePath(annotationPath, this.secretsBoundary);
      await Deno.remove(annotationPath);
    } catch {
      // NotFound or permission error — either way, best-effort
    }

    try {
      const hookPath = this.refreshPath(secretKey);
      await assertSafePath(hookPath, this.secretsBoundary);
      await Deno.remove(hookPath);
    } catch {
      // NotFound or permission error — either way, best-effort
    }
  }

  private get annotationsDir(): string {
    return join(this.vaultDir, ".annotations");
  }

  private annotationPath(secretKey: string): string {
    return join(this.annotationsDir, `${secretKey}.enc`);
  }

  async getAnnotation(secretKey: string): Promise<VaultAnnotation | null> {
    this.validateSecretKey(secretKey);
    const metaPath = this.annotationPath(secretKey);

    try {
      const encryptedContent = await Deno.readTextFile(metaPath);
      const encryptedData: EncryptedData = JSON.parse(encryptedContent);
      const masterKey = await this.getMasterKey(encryptedData.salt);
      const json = await this.decrypt(encryptedData, masterKey);
      return VaultAnnotation.fromData(JSON.parse(json));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw new Error(
        `Failed to read annotation for '${secretKey}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async putAnnotation(
    secretKey: string,
    annotation: VaultAnnotation,
  ): Promise<void> {
    this.validateSecretKey(secretKey);
    await this.ensureAnnotationsDirectory();

    const json = JSON.stringify(annotation.toData());
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const masterKey = await this.getMasterKey(this.arrayBufferToBase64(salt));
    const encryptedData = await this.encrypt(json, masterKey, salt);

    const metaPath = this.annotationPath(secretKey);
    await assertSafePath(metaPath, this.secretsBoundary);
    await atomicWriteTextFile(
      metaPath,
      JSON.stringify(encryptedData, null, 2),
      { mode: 0o600 },
    );
  }

  async deleteAnnotation(secretKey: string): Promise<void> {
    this.validateSecretKey(secretKey);
    const metaPath = this.annotationPath(secretKey);
    await assertSafePath(metaPath, this.secretsBoundary);
    try {
      await Deno.remove(metaPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(
          `Failed to delete annotation for '${secretKey}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async listAnnotations(): Promise<Map<string, VaultAnnotation>> {
    const annotations = new Map<string, VaultAnnotation>();
    try {
      for await (const entry of Deno.readDir(this.annotationsDir)) {
        if (entry.isFile && entry.name.endsWith(".enc")) {
          const keyName = entry.name.slice(0, -4);
          const annotation = await this.getAnnotation(keyName);
          if (annotation) {
            annotations.set(keyName, annotation);
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return annotations;
      }
      throw new Error(
        `Failed to list annotations in vault '${this.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return annotations;
  }

  private get refreshDir(): string {
    return join(this.vaultDir, ".refresh");
  }

  private refreshPath(secretKey: string): string {
    return join(this.refreshDir, `${secretKey}.enc`);
  }

  async getRefreshHook(secretKey: string): Promise<RefreshHook | null> {
    this.validateSecretKey(secretKey);
    const hookPath = this.refreshPath(secretKey);

    try {
      const encryptedContent = await Deno.readTextFile(hookPath);
      const encryptedData: EncryptedData = JSON.parse(encryptedContent);
      const masterKey = await this.getMasterKey(encryptedData.salt);
      const json = await this.decrypt(encryptedData, masterKey);
      return RefreshHook.fromData(JSON.parse(json));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw new Error(
        `Failed to read refresh hook for '${secretKey}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async putRefreshHook(
    secretKey: string,
    hook: RefreshHook,
  ): Promise<void> {
    this.validateSecretKey(secretKey);
    await this.ensureRefreshDirectory();

    const json = JSON.stringify(hook.toData());
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const masterKey = await this.getMasterKey(this.arrayBufferToBase64(salt));
    const encryptedData = await this.encrypt(json, masterKey, salt);

    const hookPath = this.refreshPath(secretKey);
    await assertSafePath(hookPath, this.secretsBoundary);
    await atomicWriteTextFile(
      hookPath,
      JSON.stringify(encryptedData, null, 2),
      { mode: 0o600 },
    );
  }

  async deleteRefreshHook(secretKey: string): Promise<void> {
    this.validateSecretKey(secretKey);
    const hookPath = this.refreshPath(secretKey);
    await assertSafePath(hookPath, this.secretsBoundary);
    try {
      await Deno.remove(hookPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(
          `Failed to delete refresh hook for '${secretKey}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async ensureRefreshDirectory(): Promise<void> {
    const dir = this.refreshDir;
    await assertSafePath(dir, this.secretsBoundary);
    try {
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw markErrorPaths(
          new Error(
            `Failed to create refresh directory '${dir}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          [dir, ...errorPaths(error)],
        );
      }
    }
  }

  private async ensureAnnotationsDirectory(): Promise<void> {
    const dir = this.annotationsDir;
    await assertSafePath(dir, this.secretsBoundary);
    try {
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw markErrorPaths(
          new Error(
            `Failed to create annotations directory '${dir}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          [dir, ...errorPaths(error)],
        );
      }
    }
  }

  /**
   * each secret has a unique salt so the derived key cannot be cached; the key
   * material is cached instead
   */
  private async getMasterKey(saltBase64: string): Promise<CryptoKey> {
    const keyMaterial = await this.getKeyMaterial();
    const salt = this.base64ToArrayBuffer(saltBase64);

    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    return key;
  }

  private async getKeyMaterial(): Promise<CryptoKey> {
    if (this.keyMaterialCache) {
      return this.keyMaterialCache;
    }

    const keyMaterial = await this.loadKeyMaterial();
    this.keyMaterialCache = keyMaterial;
    return keyMaterial;
  }

  private async loadKeyMaterial(): Promise<CryptoKey> {
    if (this.config.ssh_key_path) {
      try {
        return await this.readAndValidateSshKey(this.config.ssh_key_path);
      } catch (error) {
        if (!this.config.auto_generate) {
          throw markErrorPaths(
            new Error(
              `Failed to read SSH key from '${this.config.ssh_key_path}' for local vault '${this.name}': ${
                error instanceof Error ? error.message : String(error)
              }. Set 'ssh_key_path' to a valid SSH private key or enable 'auto_generate'.`,
            ),
            [this.config.ssh_key_path, ...errorPaths(error)],
          );
        }
      }
    }

    if (!this.config.ssh_key_path && !this.config.auto_generate) {
      const defaultSshKeyPath = "~/.ssh/id_rsa";
      try {
        return await this.readAndValidateSshKey(defaultSshKeyPath);
      } catch (error) {
        throw markErrorPaths(
          new Error(
            `Failed to read default SSH key from '${defaultSshKeyPath}' for local vault '${this.name}': ${
              error instanceof Error ? error.message : String(error)
            }. Set 'ssh_key_path' to a valid SSH private key or enable 'auto_generate'.`,
          ),
          [defaultSshKeyPath, ...errorPaths(error)],
        );
      }
    }

    if (this.config.auto_generate) {
      const keyFile = this.config.key_file || join(this.vaultDir, ".key");

      try {
        // Try to read existing key. The file may exist but be empty if
        // another process just created it with O_CREAT|O_EXCL but hasn't
        // written the key content yet — treat empty the same as NotFound
        // so we fall through to the createNew path and its retry loop.
        const existingKey = await Deno.readTextFile(keyFile);
        if (existingKey.length === 0) {
          throw new Deno.errors.NotFound("Key file is empty");
        }
        await this.warnIfKeyFileBroadlyReadable(keyFile);
        return await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(existingKey),
          { name: "PBKDF2" },
          false,
          ["deriveKey"],
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
        await this.ensureVaultDirectory();
        const generatedKey = crypto.randomUUID() + crypto.randomUUID();

        try {
          // createNew: true uses O_CREAT | O_EXCL — atomic exclusive creation
          // prevents TOCTOU race where two processes both generate different keys.
          // Use open + write + close so we control when the handle is released.
          const file = await Deno.open(keyFile, {
            write: true,
            createNew: true,
            mode: 0o600,
          });
          try {
            await file.write(new TextEncoder().encode(generatedKey));
          } finally {
            file.close();
          }
          return await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(generatedKey),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
          );
        } catch (writeError) {
          if (!(writeError instanceof Deno.errors.AlreadyExists)) {
            throw writeError;
          }
          // Another process won the race — read back their key.
          // The winner may still be writing (file created but content not
          // flushed), so retry until content is available.
          let winnerKey = "";
          for (let attempt = 0; attempt < 20; attempt++) {
            winnerKey = await Deno.readTextFile(keyFile);
            if (winnerKey.length > 0) break;
            await new Promise<void>((r) => setTimeout(r, 5));
          }
          if (!winnerKey) {
            throw markErrorPaths(
              new Error(
                `Key file '${keyFile}' exists but is empty — ` +
                  `concurrent key generation may have failed`,
              ),
              [keyFile],
            );
          }
          return await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(winnerKey),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
          );
        }
      }
    }

    throw new Error(
      `No SSH key or auto-generated key configured for local vault '${this.name}'. ` +
        `Set 'ssh_key_path' to point to an SSH private key file or enable 'auto_generate' in vault configuration.`,
    );
  }

  /**
   * only warns, unlike SSH keys, so a vault that works today keeps working;
   * skipped on Windows, where Deno ignores the creation mode
   */
  private async warnIfKeyFileBroadlyReadable(keyFile: string): Promise<void> {
    if (Deno.build.os === "windows") return;
    let result: SecurityCheckResult;
    try {
      result = await checkFileNotBroadlyReadable(keyFile);
    } catch {
      // The key has already been read; a failed check must not stop it
      // being used.
      return;
    }
    if (!result.ok) {
      logger.warn`Key file for local vault ${this.name}: ${result.reason}`;
    }
  }

  private async readAndValidateSshKey(
    sshKeyPath: string,
  ): Promise<CryptoKey> {
    const expandedPath = sshKeyPath.startsWith("~/")
      ? sshKeyPath.replace("~/", `${Deno.env.get("HOME")}/`)
      : sshKeyPath;

    await this.validateSshKeyPermissions(expandedPath);
    const content = await Deno.readTextFile(expandedPath);

    // Detect PEM encryption before extraction (text-based check avoids
    // base64 decode failures on header lines like Proc-Type)
    this.detectEncryptedPemKey(content);

    const decodedBytes = this.extractPemKeyMaterial(content);

    // Detect OpenSSH encryption after extraction (needs decoded bytes
    // to read the binary cipher name field)
    this.detectEncryptedOpenSshKey(decodedBytes);

    return await crypto.subtle.importKey(
      "raw",
      decodedBytes.buffer as ArrayBuffer,
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
  }

  private extractPemKeyMaterial(content: string): Uint8Array {
    const lines = content.split(/\r?\n/);
    const base64Lines = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("-----");
    });
    const base64String = base64Lines.join("");
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * POSIX enforces 0o600; Windows shells out to icacls and rejects any ACE
   * granting Read or higher to broad principals
   */
  private async validateSshKeyPermissions(path: string): Promise<void> {
    const result = await checkFileNotBroadlyReadable(path);
    if (!result.ok) {
      // Prefix the reason with "SSH key " so the message remains compatible
      // with the historical `SSH key '<path>' has insecure permissions ...`
      // format that other code and tests expect.
      throw new Error(`SSH key ${result.reason}`);
    }
  }

  private detectEncryptedPemKey(content: string): void {
    if (content.includes("Proc-Type: 4,ENCRYPTED")) {
      throw new Error(
        `SSH key is encrypted (legacy PEM format). ` +
          `Swamp cannot use passphrase-protected SSH keys for vault encryption. ` +
          `Use an unencrypted SSH key or enable 'auto_generate' in vault configuration.`,
      );
    }
  }

  /**
   * only rejects confirmed encrypted keys; parsing failures are silently
   * allowed through
   */
  private detectEncryptedOpenSshKey(decodedBytes: Uint8Array): void {
    const magic = new TextEncoder().encode("openssh-key-v1\0");

    if (decodedBytes.length < magic.length + 4) return;
    for (let i = 0; i < magic.length; i++) {
      if (decodedBytes[i] !== magic[i]) return;
    }

    const offset = magic.length;
    const cipherNameLen = (decodedBytes[offset] << 24) |
      (decodedBytes[offset + 1] << 16) |
      (decodedBytes[offset + 2] << 8) |
      decodedBytes[offset + 3];

    if (offset + 4 + cipherNameLen > decodedBytes.length) return;
    const cipherName = new TextDecoder().decode(
      decodedBytes.slice(offset + 4, offset + 4 + cipherNameLen),
    );

    if (cipherName !== "none") {
      throw new Error(
        `SSH key is encrypted (cipher: ${cipherName}). ` +
          `Swamp cannot use passphrase-protected SSH keys for vault encryption. ` +
          `Use an unencrypted SSH key or enable 'auto_generate' in vault configuration.`,
      );
    }
  }

  private async encrypt(
    value: string,
    key: CryptoKey,
    salt: Uint8Array,
  ): Promise<EncryptedData> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encodedValue = new TextEncoder().encode(value);

    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      encodedValue,
    );

    return {
      iv: this.arrayBufferToBase64(iv),
      data: this.arrayBufferToBase64(encrypted),
      salt: this.arrayBufferToBase64(salt),
      version: 2,
    };
  }

  private async decrypt(
    encryptedData: EncryptedData,
    key: CryptoKey,
  ): Promise<string> {
    const iv = this.base64ToArrayBuffer(encryptedData.iv);
    const data = this.base64ToArrayBuffer(encryptedData.data);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      data,
    );

    return new TextDecoder().decode(decrypted);
  }

  private validateSecretKey(secretKey: string): void {
    if (
      secretKey.includes("..") ||
      secretKey.includes("/") ||
      secretKey.includes("\\") ||
      secretKey.includes("\0")
    ) {
      throw new Error(
        `Invalid secret key '${secretKey}': must not contain '..', '/', '\\', or null bytes`,
      );
    }
  }

  private async ensureVaultDirectory(): Promise<void> {
    await assertSafePath(this.vaultDir, this.secretsBoundary);
    try {
      await Deno.mkdir(this.vaultDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw markErrorPaths(
          new Error(
            `Failed to create vault directory '${this.vaultDir}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          [this.vaultDir, ...errorPaths(error)],
        );
      }
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
