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
 * Binds a checkout's v3 datastore to serve as its upstream
 * (swamp-club#3985). The datastore's own storage is never resolved, so its
 * credentials are never read: the checkout gets a local root under its
 * `.swamp/`, keyed by serve's address and the datastore's namespace, which
 * holds its follower copy of serve's commit log, its serve-mode state and
 * its chunk cache. The v3 helpers open that root as they open a filesystem
 * datastore; the registry tells them its upstream is serve.
 *
 * Serve filters what each caller may read, so the copy is one caller's
 * view. The copy records a fingerprint of the token it was built with; a
 * command with another token resets it before anything reads it
 * ({@link resetCopyForCaller}), and the checkout's projection is rebuilt
 * from the new view when its context opens (`checkout_view.ts`). It also
 * records the fingerprint of the caller's read access serve sends
 * (swamp-club#4089): when serve sends another, the next command resets the
 * copy the same way, so a widened or narrowed grant refreshes it.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { join, resolve } from "@std/path";
import {
  type DatastoreConfig,
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import type { ServeUpstreamTarget } from "../../domain/datastore_v3/serve_upstream.ts";
import { setV3BucketLockRoot } from "../persistence/datastore_lock_target.ts";
import { swampPath } from "../persistence/paths.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  assertServeCopySettled,
  serveCallerFingerprint,
  ServeCopyHoldsUnlandedCommitsError,
} from "./checkout_view.ts";
import { ServeDatastoreClient } from "./serve_datastore_client.ts";
import {
  registerServeUpstream,
  serveUpstreamAt,
} from "./serve_upstream_registry.ts";
import {
  type ExplicitLease,
  type ExplicitLeaseRenewal,
  readExplicitLeases,
  renewExplicitLeases,
} from "./explicit_model_leases.ts";
import { holdServeLease } from "./serve_lease_registry.ts";
import {
  ACCESS_RESET_COOLDOWN_MS,
  accessResetDue,
  SERVE_UPSTREAM_STATE_FILE,
  ServeUpstreamState,
} from "./serve_upstream_state.ts";
import {
  V3_LOCAL_COPIES_DIR,
  type V3DatastoreLocation,
} from "./v3_datastore_binding.ts";
import {
  initializeV3Datastore,
  v3CommitsDbPath,
  v3MarkerState,
  v3OutboxPath,
} from "./v3_datastore.ts";
import { acquireV3WriterLock, V3WriterBusyError } from "./v3_writer_lock.ts";

const logger = getSwampLogger(["datastore", "v3", "serve"]);

/**
 * The local root of the datastore that serve at `serverUrl` writes, for the
 * checkout at `repoDir`: keyed by the address and namespace, so a checkout
 * that moves to another serve or another namespace starts a new copy. One
 * copy serves every token; a change of token resets it
 * ({@link resetCopyForCaller}).
 */
export function serveUpstreamLocalRoot(
  repoDir: string,
  serverUrl: string,
  namespace: string,
): string {
  const key = createHash("sha256")
    .update(`serve\0${serverUrl}\0${namespace}`)
    .digest("hex").slice(0, 16);
  return swampPath(resolve(repoDir), V3_LOCAL_COPIES_DIR, `serve-${key}`);
}

/**
 * Binds the v3 datastore `config` names for the checkout at `repoDir` to
 * serve at `target`, creating its local root on first use, and returns the
 * location the v3 helpers open. `writtenBy` names this swamp in the root's
 * format marker.
 */
export async function bindV3ServeUpstream(
  repoDir: string,
  config: DatastoreConfig,
  target: ServeUpstreamTarget,
  writtenBy: string,
): Promise<V3DatastoreLocation> {
  const namespace = config.namespace ?? "";
  const root = resolve(
    serveUpstreamLocalRoot(repoDir, target.serverUrl, namespace),
  );
  const caCerts = target.caCerts;
  registerServeUpstream({
    root,
    target,
    namespace,
    client: () =>
      new ServeDatastoreClient({
        baseUrl: target.serverUrl,
        namespace,
        ...(target.token !== undefined ? { token: target.token } : {}),
        extraHeaders: target.extraHeaders,
        ...(caCerts !== undefined && caCerts.length > 0
          ? {
            httpClient: () => Deno.createHttpClient({ caCerts: [...caCerts] }),
          }
          : {}),
      }),
  });
  // Registered first: the copy it creates is then never a replicated one.
  if (await v3MarkerState(root) !== "v3") {
    await initializeV3Datastore(root, writtenBy);
  }
  // Its locks are file locks under the local root, filesystem or bucket
  // datastore alike: the checkout never touches the datastore's storage,
  // so it never locks it either.
  setV3BucketLockRoot(config, root);
  // Before any catch-up or read: the copy must be this caller's view of
  // serve. The projection follows when the context opens.
  await resetCopyForCaller(repoDir, root, target);
  await renewCheckoutLeases(root);
  return {
    path: root,
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
    ...(config.directories !== undefined
      ? { directories: config.directories }
      : {}),
    ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
  };
}

/** The checkout roots whose explicit leases this process renewed. */
const renewedLeaseRoots = new Set<string>();

/** Test seam: renews each checkout's explicit leases again, as a new process. */
export function resetLeaseRenewalsForTesting(): void {
  renewedLeaseRoots.clear();
}

/**
 * Renews the explicit model leases recorded for `root` (swamp-club#4121),
 * once per process: every swamp command in the checkout keeps them alive
 * while they live. A failure is a warning, never the command's: a lease
 * not renewed lapses at serve once its hold passes.
 */
async function renewCheckoutLeases(root: string): Promise<void> {
  if (renewedLeaseRoots.has(root)) return;
  renewedLeaseRoots.add(root);
  const binding = serveUpstreamAt(root);
  if (binding === undefined) return;
  const recorded = await readExplicitLeases(root);
  if (recorded.length === 0) return;
  const client = binding.client();
  let renewal: ExplicitLeaseRenewal | undefined;
  try {
    renewal = await renewExplicitLeases(
      root,
      client,
      AbortSignal.timeout(client.timeoutMs),
    );
  } catch (error) {
    logger.warn`Could not renew this checkout's model leases: ${error}`;
  } finally {
    client.close();
  }
  registerCheckoutLeases(root, recorded, renewal);
}

/**
 * Registers the explicit leases `recorded` for `root` in this process, so
 * every commit it makes to a behavior the checkout holds names the lease,
 * whether or not the command takes the behavior's lock: a read-kind method
 * saves data without one. A lease `renewal` renewed is registered as
 * serve vouched for it. One it could not renew, or every one when the
 * renewal failed as a whole, is registered from the record, unconfirmed
 * (swamp-club#4167): serve, not the record, decides whether it is live, and
 * a commit serve refuses under it is sent again under no lease. A lease
 * serve said has ended is never registered.
 */
export function registerCheckoutLeases(
  root: string,
  recorded: readonly ExplicitLease[],
  renewal: ExplicitLeaseRenewal | undefined,
): void {
  const renewed = new Set(
    renewal?.renewed.map((lease) => lease.leaseId) ?? [],
  );
  const ended = new Set(renewal?.ended.map((lease) => lease.leaseId) ?? []);
  for (const lease of recorded) {
    if (ended.has(lease.leaseId)) continue;
    holdServeLease(root, lease.lockKey, {
      leaseId: lease.leaseId,
      fence: lease.fence,
      floor: lease.floor,
      ...(renewed.has(lease.leaseId) ? {} : { unconfirmed: true as const }),
    });
  }
}

/** The copy's files a reset removes: the commit log and the outbox. */
const COPY_DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Makes the copy at `root` hold the view of serve that `target`'s token is
 * given (swamp-club#3985), under the caller's current read access
 * (swamp-club#4089). A copy with no caller recorded is stamped with this
 * one. A copy built with another token, or whose reset was cut short, is
 * reset under the copy's writer lease, which every writer of this checkout
 * holds for its whole command, so no writer uses the copy while it is
 * removed; a read-only command takes it too, waiting up to the lock
 * timeout:
 *
 * 1. A copy whose outbox holds entries is refused: they are the previous
 *    caller's writes, not yet settled with serve
 *    ({@link ServeCopyHoldsUnlandedCommitsError}).
 * 2. The serve-mode state forgets its feed cursor and serve's heads, takes
 *    a new copy id and is marked resetting, so a reset cut short from here
 *    runs again.
 * 3. `commits.db` and the outbox are removed.
 * 4. The new fingerprint is recorded and the reset marked done.
 *
 * A copy built with this token whose read access serve last reported as
 * different from the access it was built under is reset the same way
 * ({@link accessResetDue}), with two differences: an outbox holding
 * entries defers the reset with a warning instead of refusing, since the
 * caller cannot return to the old access to settle them: a writing
 * command lands them, as it would without the change, and the next
 * command resets; and a reset within the cooldown of the last one only
 * warns.
 *
 * The checkout's projection, built from the old copy, is rebuilt when its
 * context opens: the checkout recorded the old copy id and token
 * (`alignCheckoutView`). The command then catches the copy up from serve
 * as a fresh checkout does. The chunk cache (`_blobs/`) stays: it is
 * content-addressed, and the read model reads from it only the chunks the
 * new copy's commits name, which are chunks serve let this caller
 * reference.
 *
 * @throws ServeCopyHoldsUnlandedCommitsError
 * @throws V3WriterBusyError when another process writes the checkout past
 *   the lock timeout
 */
async function resetCopyForCaller(
  repoDir: string,
  root: string,
  target: ServeUpstreamTarget,
): Promise<void> {
  const fingerprint = serveCallerFingerprint(target.token);
  const statePath = join(root, SERVE_UPSTREAM_STATE_FILE);
  const due = copyResetDue(
    statePath,
    fingerprint,
    target.serverUrl,
    Date.now(),
  );
  if (due === "current") return;
  let release: () => Promise<void>;
  try {
    // A copy built for another caller is never read: wait for the lease.
    // A change of access is freshness, not safety: a writer of this
    // checkout holding the lease must not hold up, or fail, a command that
    // would only read the copy as it is.
    release = await acquireV3WriterLock(root, {
      maxWaitMs: due === "access" ? 0 : resolveLockTimeoutMs(),
    });
  } catch (error) {
    if (!(due === "access" && error instanceof V3WriterBusyError)) throw error;
    logger
      .warn`Your access to the datastore at serve ${target.serverUrl} changed, but another command in this checkout is writing to it. This command reads the copy as it is; a command run once that one has finished rebuilds the copy to match your access.`;
    return;
  }
  try {
    const state = ServeUpstreamState.open(statePath);
    try {
      // Looked at again under the lease: another process may have reset
      // the copy for this caller meanwhile.
      const caller = state.caller();
      let accessResetAt: number | undefined;
      if (
        caller !== undefined && !caller.resetting &&
        caller.fingerprint === fingerprint
      ) {
        accessResetAt = Date.now();
        if (accessResetDue(state.access(), accessResetAt) !== "reset") return;
        try {
          await assertServeCopySettled(root, target.serverUrl);
        } catch (error) {
          if (!(error instanceof ServeCopyHoldsUnlandedCommitsError)) {
            throw error;
          }
          logger
            .warn`Your access to the datastore at serve ${target.serverUrl} changed, but this checkout's copy of it still holds writes that have not finished landing there. Run a command that writes in this checkout (a method run, a data save) to land them; the next command after that rebuilds the copy to match your access.`;
          return;
        }
      } else {
        await assertServeCopySettled(root, target.serverUrl);
      }
      state.beginCallerReset();
      const commitsDb = v3CommitsDbPath(root, repoDir);
      for (const file of [commitsDb, v3OutboxPath(commitsDb)]) {
        for (const suffix of COPY_DATABASE_SUFFIXES) {
          await Deno.remove(`${file}${suffix}`).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          });
        }
      }
      state.finishCallerReset(fingerprint, accessResetAt);
    } finally {
      state.close();
    }
  } finally {
    await release();
  }
}

/**
 * What the copy whose serve-mode state is at `statePath` needs, stamping a
 * copy that records no caller: nothing (`"current"`), a reset because serve
 * reported another read access for the caller `fingerprint` names
 * (`"access"`), or a reset because it was built for another caller or its
 * reset was cut short (`"caller"`). A change of access within the cooldown
 * counts as current, with a warning.
 */
function copyResetDue(
  statePath: string,
  fingerprint: string,
  serverUrl: string,
  now: number,
): "current" | "access" | "caller" {
  const state = ServeUpstreamState.open(statePath);
  try {
    const caller = state.stampCaller(fingerprint);
    if (caller.resetting || caller.fingerprint !== fingerprint) {
      return "caller";
    }
    const due = accessResetDue(state.access(), now);
    if (due === "cooling") {
      logger
        .warn`Your access to the datastore at serve ${serverUrl} changed again within ${
        ACCESS_RESET_COOLDOWN_MS / 60_000
      } minutes of this checkout's copy being rebuilt for the last change. Serve's replicas may disagree on your access, so the copy is not rebuilt again yet; a command after that rebuilds it if your access still differs.`;
    }
    return due === "reset" ? "access" : "current";
  } finally {
    state.close();
  }
}
