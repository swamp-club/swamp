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
import { atomicWriteTextFile } from "./atomic_write.ts";
import { getSwampConfigDir } from "./paths.ts";
import type {
  CachedVerification,
  PublicKeyEntry,
} from "../../domain/auth/verification_proof.ts";
import type { ProofSource } from "../../domain/auth/auth_gate_policy.ts";
import { base64urlDecode } from "../../domain/auth/verification_proof.ts";

const VERIFICATION_FILE = "auth_verified.json";
const FAIL_OPEN_FILE = "auth_fail_open.json";
const TOKEN_CHECK_FILE = "auth_token_check.json";

/** A proof the gate may verify, and where it came from. */
export interface ProofCandidate {
  readonly source: ProofSource;
  readonly verification: CachedVerification;
}

export interface AuthVerificationRepositoryOptions {
  configDir?: string;
  getSigninToken?: () => string | undefined;
}

export class AuthVerificationRepository {
  private readonly configDirOverride: string | undefined;
  private readonly getSigninToken: () => string | undefined;

  constructor(options?: AuthVerificationRepositoryOptions) {
    this.configDirOverride = options?.configDir;
    this.getSigninToken = options?.getSigninToken ??
      (() => Deno.env.get("SWAMP_SIGNIN_TOKEN"));
  }

  /**
   * Resolved on use, not at construction, so a process with no config dir
   * (no HOME) can still verify a signin token: reads treat the failure as
   * nothing cached, and writes surface it to their best-effort callers.
   */
  private get configDir(): string {
    return this.configDirOverride ?? getSwampConfigDir();
  }

  /**
   * Every proof on hand: the SWAMP_SIGNIN_TOKEN proof first, then the
   * auth_verified.json proof. The gate verifies each against the active key
   * and uses the one that matches, so a stale exported token never hides a
   * valid file proof.
   */
  async loadCandidates(): Promise<ProofCandidate[]> {
    const candidates: ProofCandidate[] = [];
    const fromEnv = this.loadFromSigninToken();
    const fromFile = await this.loadFromFile();
    if (fromEnv) {
      // A signin token carries no public key. Lend it the keys cached from
      // the last whoami, which are trusted exactly as the file proof's are,
      // so a token signed after a key rotation still verifies; the embedded
      // key remains the fallback when none match.
      candidates.push({
        source: "signin_token",
        verification: { ...fromEnv, publicKeys: fromFile?.publicKeys ?? [] },
      });
    }
    if (fromFile) candidates.push({ source: "file", verification: fromFile });
    return candidates;
  }

  async load(): Promise<CachedVerification | null> {
    const fromEnv = this.loadFromSigninToken();
    if (fromEnv) return fromEnv;
    return await this.loadFromFile();
  }

  private loadFromSigninToken(): CachedVerification | null {
    const token = this.getSigninToken();
    if (!token) return null;

    const dotIndex = token.indexOf(".");
    if (dotIndex === -1) return null;

    try {
      const proofB64 = token.slice(0, dotIndex);
      const signatureB64 = token.slice(dotIndex + 1);

      const proofBytes = base64urlDecode(proofB64);
      const proof = new TextDecoder().decode(proofBytes);

      JSON.parse(proof);

      return {
        proof,
        signature: signatureB64,
        publicKeys: [],
        cachedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async loadFromFile(): Promise<CachedVerification | null> {
    try {
      const path = join(this.configDir, VERIFICATION_FILE);
      const text = await Deno.readTextFile(path);
      const data = JSON.parse(text);
      if (
        typeof data.proof !== "string" ||
        typeof data.signature !== "string" ||
        !Array.isArray(data.publicKeys)
      ) {
        return null;
      }
      return data as CachedVerification;
    } catch {
      return null;
    }
  }

  async save(
    proof: string,
    signature: string,
    publicKeys: PublicKeyEntry[],
  ): Promise<void> {
    const path = join(this.configDir, VERIFICATION_FILE);
    const data: CachedVerification = {
      proof,
      signature,
      publicKeys,
      cachedAt: new Date().toISOString(),
    };
    await atomicWriteTextFile(path, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
  }

  async delete(): Promise<void> {
    const path = join(this.configDir, VERIFICATION_FILE);
    try {
      await Deno.remove(path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  /**
   * When the current fail-open window began (Unix seconds), or undefined.
   * Only the shape is checked here; the gate's policy discards a future
   * time, so a hand-edited value can never widen the window.
   */
  async readFailOpenSince(): Promise<number | undefined> {
    const data = await this.readJson(FAIL_OPEN_FILE);
    return typeof data?.since === "number" && Number.isFinite(data.since)
      ? data.since
      : undefined;
  }

  /** Start a fail-open window at `now`, replacing any unusable stamp. */
  async markFailOpenSince(now: number): Promise<void> {
    await this.writeJson(FAIL_OPEN_FILE, { since: now });
  }

  async clearFailOpen(): Promise<void> {
    await this.remove(FAIL_OPEN_FILE);
  }

  /**
   * When the signin token with fingerprint `fpr` last verified live (Unix
   * seconds), or undefined when the remembered check is for another token.
   */
  async readTokenCheck(fpr: string): Promise<number | undefined> {
    const data = await this.readJson(TOKEN_CHECK_FILE);
    if (data?.fpr !== fpr) return undefined;
    return typeof data.checkedAt === "number" &&
        Number.isFinite(data.checkedAt)
      ? data.checkedAt
      : undefined;
  }

  async recordTokenCheck(fpr: string, now: number): Promise<void> {
    await this.writeJson(TOKEN_CHECK_FILE, { fpr, checkedAt: now });
  }

  async clearTokenCheck(): Promise<void> {
    await this.remove(TOKEN_CHECK_FILE);
  }

  /** Forget everything the gate keeps: the proof and both stamps. */
  async clearAll(): Promise<void> {
    await this.remove(VERIFICATION_FILE);
    await this.remove(FAIL_OPEN_FILE);
    await this.remove(TOKEN_CHECK_FILE);
  }

  private async readJson(
    file: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const data = JSON.parse(
        await Deno.readTextFile(join(this.configDir, file)),
      );
      return typeof data === "object" && data !== null ? data : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeJson(
    file: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await atomicWriteTextFile(
      join(this.configDir, file),
      JSON.stringify(data, null, 2),
      { mode: 0o600 },
    );
  }

  private async remove(file: string): Promise<void> {
    try {
      await Deno.remove(join(this.configDir, file));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}
