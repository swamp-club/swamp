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
import { base64urlDecode } from "../../domain/auth/verification_proof.ts";

const VERIFICATION_FILE = "auth_verified.json";

export interface AuthVerificationRepositoryOptions {
  configDir?: string;
  getSigninToken?: () => string | undefined;
}

export class AuthVerificationRepository {
  private readonly configDir: string;
  private readonly getSigninToken: () => string | undefined;

  constructor(options?: AuthVerificationRepositoryOptions) {
    this.configDir = options?.configDir ?? getSwampConfigDir();
    this.getSigninToken = options?.getSigninToken ??
      (() => Deno.env.get("SWAMP_SIGNIN_TOKEN"));
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
    const path = join(this.configDir, VERIFICATION_FILE);
    try {
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
}
