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
import { type RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import {
  RotateTokenParamsSchema,
  type RotateTokenResult,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { atomicWriteTextFile } from "../infrastructure/persistence/atomic_write.ts";

const logger = getLogger(["swamp", "worker", "token"]);

/** the enrollment credential a reconnect presents; a rotation replaces it */
export interface WorkerCredential {
  token: string;
  /** createdAt of the newest successor applied, and whether it reached disk */
  mintMs?: number;
  persisted?: boolean;
  /** rotations apply one at a time, so file writes never interleave */
  applying?: Promise<unknown>;
}

export interface TokenRotationHandlerOptions {
  channel: RpcChannel;
  credential: WorkerCredential;
  /** absent when the token came inline, so a rotation lives in memory only */
  tokenFile?: string;
  writeTokenFile?: (path: string, token: string) => Promise<void>;
}

function tokenName(credential: string): string | null {
  const dot = credential.indexOf(".");
  if (dot <= 0 || dot === credential.length - 1) return null;
  return credential.slice(0, dot);
}

async function writeTokenFileAtomically(
  path: string,
  token: string,
): Promise<void> {
  // a symlinked token file keeps its link; the write lands on the target
  const target = await Deno.realPath(path);
  const mode = (await Deno.stat(target)).mode;
  await atomicWriteTextFile(target, `${token}\n`, {
    mode: mode === null ? 0o600 : mode & 0o777,
    sync: {},
  });
}

export function registerTokenRotationHandler(
  options: TokenRotationHandlerOptions,
): void {
  const write = options.writeTokenFile ?? writeTokenFileAtomically;
  options.channel.register(WorkerMethod.rotateToken, async (rawParams) => {
    const parsed = RotateTokenParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      throw new RpcError({
        code: "invalid_params",
        message: "Malformed token rotation",
      });
    }
    const next = parsed.data.token;
    const nextName = tokenName(next);
    if (nextName === null) {
      throw new RpcError({
        code: "invalid_token",
        message: "The rotated token is malformed",
      });
    }
    if (nextName !== tokenName(options.credential.token)) {
      throw new RpcError({
        code: "token_rename_refused",
        message: "A rotation keeps the token's name; this worker refuses " +
          "a token issued under another name",
      });
    }
    const credential = options.credential;
    const apply = async (): Promise<RotateTokenResult> => {
      // overlapping rotations can arrive out of mint order; an older one late
      // must not replace the newer token serve has recorded
      if (
        credential.mintMs !== undefined &&
        parsed.data.mintMs <= credential.mintMs
      ) {
        return { persisted: credential.persisted === true };
      }
      const applied = await applySuccessor(next, parsed.data.expiresAtMs);
      credential.mintMs = parsed.data.mintMs;
      return applied;
    };
    const result = (credential.applying ?? Promise.resolve()).then(
      apply,
      apply,
    );
    credential.applying = result;
    return await result;
  });

  async function applySuccessor(
    next: string,
    expiresAtMs: number,
  ): Promise<RotateTokenResult> {
    let persisted = false;
    if (options.tokenFile !== undefined) {
      // a read-only file (a Kubernetes Secret mount) still takes the successor
      // in memory, so this process outlives the old token
      try {
        await write(options.tokenFile, next);
        persisted = true;
      } catch (error) {
        logger.warn(
          "Could not write the rotated token to {path}: {error}",
          {
            path: options.tokenFile,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    options.credential.token = next;
    options.credential.persisted = persisted;
    const expiresAt = new Date(expiresAtMs).toISOString();
    if (persisted) {
      logger.info("Enrollment token rotated; it now expires at {expiresAt}", {
        expiresAt,
      });
    } else {
      logger.warn(
        "Enrollment token rotated in memory only; it expires at {expiresAt}, " +
          "and a restart presents the token this worker started with",
        { expiresAt },
      );
    }
    return { persisted };
  }
}
