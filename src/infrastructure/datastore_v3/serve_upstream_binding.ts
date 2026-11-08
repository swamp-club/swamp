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
 * the copy is one caller's view of serve, so a command with another token
 * resets it before anything reads it; a changed read-access fingerprint does
 * the same. The datastore's own storage is untouched
 */

import { createHash } from "node:crypto";
import { join, resolve } from "@std/path";
import {
  type DatastoreConfig,
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import type {
  ServeInitiatorMode,
  ServeUpstreamTarget,
} from "../../domain/datastore_v3/serve_upstream.ts";
import { setV3BucketLockRoot } from "../persistence/datastore_lock_target.ts";
import { swampPath } from "../persistence/paths.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  assertServeCopySettled,
  serveCallerFingerprint,
  ServeCopyHoldsUnlandedCommitsError,
} from "./checkout_view.ts";
import {
  serveDatastoreClientFor,
  serveRequestTimeoutMs,
} from "./serve_datastore_client.ts";
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
  type ServeCopyCaller,
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
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";

const logger = getSwampLogger(["datastore", "v3", "serve"]);

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
  registerServeUpstream({
    root,
    target,
    namespace,
    client: () => serveDatastoreClientFor(target, namespace),
  });
  // Registered first: the copy it creates is then never a replicated one.
  const markerSeen = await v3MarkerState(root);
  if (markerSeen !== "v3") {
    // two commands may create the copy at once; the one that loses the marker
    // race uses the marker the other wrote, decided from this look
    await initializeV3Datastore(root, writtenBy, {
      adoptConcurrentMarker: { markerSeen },
    });
  }
  // Its locks are file locks under the local root, filesystem or bucket
  // datastore alike: the checkout never touches the datastore's storage,
  // so it never locks it either.
  setV3BucketLockRoot(config, root);
  // Before any catch-up or read: the copy must be this caller's view of
  // serve. The projection follows when the context opens.
  await resetCopyForCaller(repoDir, root, target, namespace);
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

const renewedLeaseRoots = new Set<string>();

export function resetLeaseRenewalsForTesting(): void {
  renewedLeaseRoots.clear();
}

/**
 * renews the explicit model leases recorded for root, once per process; a
 * failure is a warning, never the command's, and an unrenewed lease lapses at
 * serve once its hold passes
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
 * registers recorded leases so every commit to a held behavior names one, even
 * from a read-kind method taking no lock; a lease that could not be renewed is
 * registered unconfirmed, and one serve ended never
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

const COPY_DATABASE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * resets the outbox in place when it keeps rejected or quarantined entries,
 * which are never discarded: true if it kept any, so the reset leaves the file
 */
async function outboxKeepsEntries(path: string): Promise<boolean> {
  const outbox = new SqliteCommitOutbox(path);
  try {
    return await outbox.resetKeepingKept() > 0;
  } finally {
    await outbox.close();
  }
}

/**
 * a copy built for another caller or with a cut-short reset is reset under the
 * writer lease; one whose outbox holds the previous caller's entries is
 * refused. An access change defers with a warning instead
 */
async function resetCopyForCaller(
  repoDir: string,
  root: string,
  target: ServeUpstreamTarget,
  namespace: string,
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
  // a rotated token of the principal the copy was built for reads what it
  // read: only serve's answer for the new token counts, never the old cache
  const samePrincipal = due === "caller"
    ? await tokenActsAsCachedPrincipal(statePath, target, namespace)
    : undefined;
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
      // only the copy the probe judged: another caller may have reset it for
      // another principal while this one waited for the lease
      if (keepsProbedCopy(samePrincipal, caller, state.checkedPrincipal())) {
        state.restampCaller(fingerprint);
        logger
          .debug`The serve token changed but acts as the same principal, so this checkout's copy is kept`;
        return;
      }
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
      // rejected and quarantined entries are never discarded, so an outbox
      // holding any is reset in place rather than removed with the copy
      const files = await outboxKeepsEntries(v3OutboxPath(commitsDb))
        ? [commitsDb]
        : [commitsDb, v3OutboxPath(commitsDb)];
      for (const file of files) {
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
 * the copy's caller fingerprint and principal when serve says the new token
 * acts as that principal with the read access the copy was built under;
 * undefined, so the copy is reset, whenever serve cannot say so
 */
async function tokenActsAsCachedPrincipal(
  statePath: string,
  target: ServeUpstreamTarget,
  namespace: string,
): Promise<
  { readonly principal: string; readonly fingerprint: string } | undefined
> {
  let cached: string | undefined;
  let built: string | undefined;
  let fingerprint: string | undefined;
  let cursor: number;
  const state = ServeUpstreamState.open(statePath);
  try {
    const caller = state.caller();
    if (caller === undefined || caller.resetting) return undefined;
    fingerprint = caller.fingerprint;
    cached = state.checkedPrincipal();
    built = state.access().built;
    cursor = state.feedCursor();
  } finally {
    state.close();
  }
  if (cached === undefined) return undefined;
  const client = serveDatastoreClientFor(target, namespace);
  let access: string | undefined;
  client.checkAccess((seen) => {
    access = seen;
  });
  try {
    await client.changes(
      cursor,
      AbortSignal.timeout(serveRequestTimeoutMs()),
      1,
    );
  } catch (error) {
    // a refused page (a compacted cursor) still carries serve's principal
    // header; only an answer with none rebuilds
    logger
      .debug`Serve answered the principal check with an error: ${error}`;
  } finally {
    client.close();
  }
  return probeVouches({
      cached,
      mode: client.initiatorMode(),
      built,
      access,
    })
    ? { principal: cached, fingerprint }
    : undefined;
}

/**
 * serve named the cached principal for the new token, and any read access it
 * sent is the one the copy was built under: two tokens of one principal can
 * read differently (another client)
 */
export function probeVouches(seen: {
  readonly cached: string;
  readonly mode: ServeInitiatorMode | undefined;
  readonly built: string | undefined;
  readonly access: string | undefined;
}): boolean {
  if (seen.mode?.kind !== "checked" || seen.mode.principal !== seen.cached) {
    return false;
  }
  return seen.built === undefined || seen.access === seen.built;
}

/**
 * under the lease, the copy is still the one the probe judged: another caller
 * may have reset it for another principal while this one waited
 */
export function keepsProbedCopy(
  probe:
    | { readonly principal: string; readonly fingerprint: string }
    | undefined,
  caller: ServeCopyCaller | undefined,
  checkedPrincipal: string | undefined,
): boolean {
  return probe !== undefined && caller !== undefined && !caller.resetting &&
    caller.fingerprint === probe.fingerprint &&
    checkedPrincipal === probe.principal;
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
