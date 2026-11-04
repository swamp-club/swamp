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

import type { AuditStore } from "../domain/serve_audit/audit_store.ts";
import { AuditChainState } from "../domain/serve_audit/audit_chain.ts";
import type { AuditWal } from "../domain/serve_audit/audit_wal.ts";

const CHAIN_RECONSTRUCT_LOOKBACK_DAYS = 14;

export async function reconstructChainStateFromStore(
  store: AuditStore,
): Promise<{ sequence: number; previousDigest: string } | null> {
  try {
    let latestSeq = -1;
    let latestDigest = "";
    let found = false;
    for (let d = 0; d < CHAIN_RECONSTRUCT_LOOKBACK_DAYS; d++) {
      const date = new Date(Date.now() - d * 86_400_000).toISOString().slice(
        0,
        10,
      );
      const keys = await store.list(`events/${date}/`);
      for (const key of keys) {
        const data = await store.get(key);
        if (!data) continue;
        const text = new TextDecoder().decode(data);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const seq = event.sequence;
            const digest = event.digest;
            if (
              event.version === 1 &&
              typeof seq === "number" &&
              typeof digest === "string"
            ) {
              if (seq > latestSeq) {
                latestSeq = seq;
                latestDigest = digest;
                found = true;
              }
            }
          } catch {
            // skip malformed
          }
        }
      }
      if (found) break;
    }
    if (found) {
      return {
        sequence: latestSeq,
        previousDigest: latestDigest,
      };
    }
  } catch {
    // best-effort reconstruction
  }
  return null;
}

/** Restores the newest durable chain position before replay can remove WAL segments. */
export async function recoverAuditChainState(
  wal: AuditWal,
  store: AuditStore,
): Promise<AuditChainState | undefined> {
  const saved = await wal.loadChainState();
  let state = saved
    ? new AuditChainState(saved.sequence, saved.previousDigest)
    : undefined;
  for (const segment of wal.listSegments()) {
    for (const event of await wal.readSegment(segment)) {
      if (
        typeof event.sequence === "number" &&
        typeof event.digest === "string" &&
        event.sequence > (state?.sequence ?? -1)
      ) {
        state = new AuditChainState(event.sequence, event.digest);
      }
    }
  }
  if (!state) {
    const recovered = await reconstructChainStateFromStore(store);
    if (recovered) {
      state = new AuditChainState(recovered.sequence, recovered.previousDigest);
    }
  }
  return state;
}
