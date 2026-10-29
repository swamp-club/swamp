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
 * Moves what a v3 datastore's serve kept in its checkout's control plane
 * into the datastore's shared one (swamp-club#4096), once per checkout:
 * before team mode, serve kept its control plane in `.swamp/_control/`, and
 * an upgrade must not sign every dashboard user out or lose server tokens.
 *
 * Only records that outlive one serve process move: token secrets, pending
 * runs, cron fire records, schedule pauses, dashboard sessions and audit
 * events kept in the control plane. Heartbeats, active runs
 * and claims name one process and are left behind. Every record is created
 * only where absent, so two nodes upgrading at once, or a node whose
 * records another already moved, change nothing that is there. Token
 * secrets move as a set: the checkout claims the key slot atomically, and
 * its values move only when the store keeps its key, since values
 * encrypted under another key could never be read.
 *
 * @module
 */

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { AtomicControlPlaneStore } from "./control_plane_signal_wait_store.ts";

const logger = getSwampLogger(["serve", "control-plane"]);

/** The prefixes whose records outlive one serve process. */
export const CHECKOUT_CONTROL_PLANE_IMPORT_PREFIXES: readonly string[] = [
  "pending-runs/",
  "fire-records/",
  "schedule-pauses/",
  "dashboard-sessions/",
  "_audit/",
];

const TOKEN_SECRETS_PREFIX = "token-secrets/";
const TOKEN_SECRETS_KEY = "token-secrets/encryption-key";

/** Written to the checkout's store once its records are moved. */
export const CHECKOUT_IMPORT_SENTINEL = "migration/imported-to-datastore";

/**
 * Copies the checkout's lasting control-plane records into `shared`, once:
 * a checkout whose sentinel is set is skipped. Returns how many records were
 * created.
 */
export async function importCheckoutControlPlane(
  checkout: ControlPlaneStore,
  shared: AtomicControlPlaneStore,
): Promise<number> {
  if (await checkout.get(CHECKOUT_IMPORT_SENTINEL) !== null) return 0;
  let created = 0;
  for (const prefix of CHECKOUT_CONTROL_PLANE_IMPORT_PREFIXES) {
    created += await copyAbsent(checkout, shared, await checkout.list(prefix));
  }
  const secrets = await checkout.list(TOKEN_SECRETS_PREFIX);
  const key = secrets.includes(TOKEN_SECRETS_KEY)
    ? await checkout.get(TOKEN_SECRETS_KEY)
    : null;
  if (key !== null) {
    // The key slot is claimed first, atomically: of two checkouts moving
    // their secrets at once, only the one whose key the store holds moves
    // its values, so no value lands under a key the store does not keep.
    // A key equal to the stored one (a checkout that moved before, or the
    // same external key's marker) moves its values too.
    const claimed = await shared.putIfAbsent(TOKEN_SECRETS_KEY, key);
    if (claimed) created++;
    const stored = claimed ? key : await shared.get(TOKEN_SECRETS_KEY);
    if (stored !== null && sameBytes(stored, key)) {
      created += await copyAbsent(
        checkout,
        shared,
        secrets.filter((name) => name !== TOKEN_SECRETS_KEY),
      );
    } else {
      logger
        .warn`The datastore's serve control plane already has another token secrets key, so this checkout's ${
        secrets.length - 1
      } token secret(s) were not moved: tokens minted by this checkout's serve before team mode must be minted again`;
    }
  }
  await checkout.put(
    CHECKOUT_IMPORT_SENTINEL,
    new TextEncoder().encode(new Date().toISOString()),
  );
  if (created > 0) {
    logger
      .info`Moved ${created} control-plane record(s) from this checkout into the datastore's serve control plane`;
  }
  return created;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function copyAbsent(
  from: ControlPlaneStore,
  to: AtomicControlPlaneStore,
  keys: readonly string[],
): Promise<number> {
  let created = 0;
  for (const key of keys) {
    const data = await from.get(key);
    if (data === null) continue;
    if (await to.putIfAbsent(key, data)) created++;
  }
  return created;
}
