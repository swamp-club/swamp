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
 * a projection built from one commit-log view and caught up from another shows
 * records the new view does not hold and has another log's cursor, so a context
 * opened with another view rebuilds the projection first
 */

import { getLogger } from "@logtape/logtape";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { resolveLockTimeoutMs } from "../../domain/datastore/datastore_config.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { removeStaleOutputSummaries } from "../persistence/output_summary_index.ts";
import { removeStaleRunIndexes } from "../persistence/workflow_run_index.ts";
import { writeFileDurably } from "./atomic_stream_write.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { serveUpstreamAt } from "./serve_upstream_registry.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import {
  type V3Datastore,
  v3OutboxPath,
  v3SharedCommitsDbPath,
} from "./v3_datastore.ts";
import { acquireV3WriterLock, V3WriterBusyError } from "./v3_writer_lock.ts";

const logger = getLogger(["swamp", "datastore", "checkout-view"]);

export const CHECKOUT_VIEW_FILE = "checkout_view.json";

export type CheckoutView =
  | {
    readonly kind: "serve";
    readonly root: string;
    /** a copy moved aside and started afresh at the same root is another view */
    readonly copy: string;
    readonly caller: string;
    /**
     * the principal serve said the token acts as, when known: a rotated token
     * of the same principal keeps the view
     */
    readonly principal?: string;
    readonly serverUrl: string;
  }
  | {
    readonly kind: "solo";
    readonly datastore: string;
    readonly namespace: string;
    /**
     * with `location`, what the view is keyed on, so moving the checkout keeps
     * it; absent for a repo whose marker has no repoId, keyed on `datastore`
     */
    readonly repoId?: string;
    /** the datastore's path relative to the checkout, or absolute outside it */
    readonly location?: string;
  };

/**
 * The fingerprint of a serve token that a copy or a checkout records: its
 * SHA-256, or that of "" when no token is sent. Never the token itself.
 */
export function serveCallerFingerprint(token: string | undefined): string {
  return createHash("sha256").update(token ?? "").digest("hex");
}

export function checkoutViewOf(
  datastorePath: string,
  namespace: string,
  copyId: string | undefined,
  principal?: string,
  checkout?: { readonly repoDir: string; readonly repoId?: string },
): CheckoutView {
  const serve = serveUpstreamAt(datastorePath);
  if (serve !== undefined) {
    return {
      kind: "serve",
      root: resolve(datastorePath),
      copy: copyId ?? "",
      caller: serveCallerFingerprint(serve.target.token),
      ...(principal !== undefined ? { principal } : {}),
      serverUrl: serve.target.serverUrl,
    };
  }
  const datastore = resolve(datastorePath);
  const repoId = checkout?.repoId;
  return repoId === undefined || repoId === ""
    ? { kind: "solo", datastore, namespace }
    : {
      kind: "solo",
      datastore,
      namespace,
      repoId,
      location: locationIn(checkout!.repoDir, datastore),
    };
}

function locationIn(repoDir: string, datastore: string): string {
  const rel = relative(resolve(repoDir), datastore);
  const inside = rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${SEPARATOR}`));
  return inside ? rel.split(SEPARATOR).join("/") : datastore;
}

function atLocation(datastore: string, location: string): boolean {
  if (location === "" || isAbsolute(location)) return false;
  const tail = location.split("/");
  const segments = resolve(datastore).split(SEPARATOR);
  if (segments.length <= tail.length) return false;
  return tail.every((segment, i) =>
    segments[segments.length - tail.length + i] === segment
  );
}

// a view is flat: its sorted keys make the comparison independent of order
function flatJson(view: CheckoutView): string {
  return JSON.stringify(view, Object.keys(view).sort());
}

/**
 * "legacy": a solo record from before repoIds were kept, at the view's place
 * inside the checkout, which is the same view only if it moved here
 */
function sameView(a: CheckoutView, b: CheckoutView): boolean | "legacy" {
  if (a.kind === "serve" && b.kind === "serve") {
    const sameCaller = a.principal !== undefined && b.principal !== undefined
      ? a.principal === b.principal
      : a.caller === b.caller;
    // a copy's random id moves with it; only a copy without one is its root
    const sameCopy = a.copy !== "" && b.copy !== ""
      ? a.copy === b.copy
      : a.root === b.root && a.copy === b.copy;
    return sameCopy && sameCaller;
  }
  if (a.kind === "solo" && b.kind === "solo") {
    if (a.namespace !== b.namespace) return false;
    if (a.repoId !== undefined && b.repoId !== undefined) {
      return a.repoId === b.repoId && a.location === b.location;
    }
    if (a.datastore === b.datastore) return true;
    const keyed = a.repoId !== undefined ? a : b;
    const older = keyed === a ? b : a;
    return keyed.location !== undefined &&
        atLocation(older.datastore, keyed.location)
      ? "legacy"
      : false;
  }
  return false;
}

/**
 * the recorded path is gone, as a move leaves it, or names this very
 * directory, as a bind mount does; a path still holding another datastore is
 * another view
 */
async function movedHere(recorded: string, current: string): Promise<boolean> {
  let before: Deno.FileInfo;
  try {
    before = await Deno.stat(recorded);
  } catch (error) {
    // a path that cannot be read is not shown to be this one: rebuild
    return error instanceof Deno.errors.NotFound;
  }
  let now: Deno.FileInfo;
  try {
    now = await Deno.stat(current);
  } catch {
    return false;
  }
  return before.ino !== null && before.ino === now.ino &&
    before.dev === now.dev;
}

/**
 * the record to keep for a current view: its paths as they are now, and the
 * principal once serve has named it
 */
function refreshedView(recorded: CheckoutView, view: CheckoutView) {
  if (recorded.kind === "serve" && view.kind === "serve") {
    const principal = view.principal ?? recorded.principal;
    return { ...view, ...(principal !== undefined ? { principal } : {}) };
  }
  return view;
}

interface RecordedView {
  readonly view: CheckoutView;
  /**
   * A rebuild started and has not finished; `view` is then the view the
   * projection was built from before it, whose copy it checks again.
   */
  readonly rebuilding?: true;
}

export const SERVE_COPY_HOLDS_UNLANDED_CODE =
  "datastore_v3_serve_copy_holds_unlanded";

export class ServeCopyHoldsUnlandedCommitsError extends UserError {
  constructor(readonly serveUrl: string) {
    super(
      `This checkout's copy of the datastore at serve ${serveUrl} still ` +
        `holds writes that have not finished landing there, made with the ` +
        `serve token, address or namespace this checkout last used. A ` +
        `checkout rebuilds its records when the token, serve address or ` +
        `namespace changes, so it cannot switch until those writes settle. ` +
        `Run a command that writes (a method run, a data save) in this ` +
        `checkout with the previous token, address and namespace first, ` +
        `which lands or settles them, then switch. Nothing was changed.`,
      SERVE_COPY_HOLDS_UNLANDED_CODE,
    );
    this.name = "ServeCopyHoldsUnlandedCommitsError";
  }
}

/** rejected and quarantined entries never land, so they do not hold the copy */
export async function assertServeCopySettled(
  root: string,
  serverUrl: string,
): Promise<void> {
  const outbox = new SqliteCommitOutbox(
    v3OutboxPath(v3SharedCommitsDbPath(root)),
  );
  let unlanded: boolean;
  try {
    unlanded = await outbox.hasUnsettledEntries();
  } finally {
    await outbox.close();
  }
  if (unlanded) {
    throw markErrorPaths(new ServeCopyHoldsUnlandedCommitsError(serverUrl), [
      root,
    ]);
  }
}

function viewPath(repoDir: string): string {
  return join(readModelStateDir(repoDir), CHECKOUT_VIEW_FILE);
}

async function readRecordedView(
  repoDir: string,
): Promise<RecordedView | "absent" | "unreadable"> {
  let text: string;
  try {
    text = await Deno.readTextFile(viewPath(repoDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as RecordedView;
    const view = parsed?.view;
    if (
      (view?.kind === "serve" && typeof view.root === "string" &&
        typeof view.copy === "string" && typeof view.caller === "string" &&
        typeof view.serverUrl === "string" &&
        (view.principal === undefined ||
          typeof view.principal === "string")) ||
      (view?.kind === "solo" && typeof view.datastore === "string" &&
        typeof view.namespace === "string" &&
        (view.repoId === undefined ||
          (typeof view.repoId === "string" &&
            typeof view.location === "string")))
    ) {
      return parsed.rebuilding === true ? { view, rebuilding: true } : { view };
    }
  } catch {
    // Unreadable: rebuilt below.
  }
  return "unreadable";
}

async function writeRecordedView(
  repoDir: string,
  recorded: RecordedView,
): Promise<void> {
  await Deno.mkdir(readModelStateDir(repoDir), { recursive: true });
  await writeFileDurably(
    viewPath(repoDir),
    new TextEncoder().encode(JSON.stringify(recorded) + "\n"),
    new AbortController().signal,
  );
}

async function isCurrent(
  recorded: RecordedView | "absent" | "unreadable",
  view: CheckoutView,
): Promise<boolean> {
  if (typeof recorded !== "object" || recorded.rebuilding === true) {
    return false;
  }
  const same = sameView(recorded.view, view);
  if (same !== "legacy") return same;
  return recorded.view.kind === "solo" && view.kind === "solo" &&
    await movedHere(recorded.view.datastore, view.datastore);
}

/**
 * the writer holding the lease aligns the view as its command starts and holds
 * the lease to the command's end, so a reader stops waiting once the view is
 * current
 */
async function leaseUnlessAligned(
  repoDir: string,
  datastorePath: string,
  view: CheckoutView,
): Promise<(() => Promise<void>) | "aligned"> {
  const deadline = Date.now() + resolveLockTimeoutMs();
  let retryMs = 250;
  for (;;) {
    try {
      return await acquireV3WriterLock(datastorePath, { maxWaitMs: 0 });
    } catch (error) {
      if (!(error instanceof V3WriterBusyError) || Date.now() >= deadline) {
        throw error;
      }
    }
    if (await isCurrent(await readRecordedView(repoDir), view)) {
      return "aligned";
    }
    await new Promise((done) =>
      setTimeout(done, Math.min(retryMs, Math.max(0, deadline - Date.now())))
    );
    retryMs = Math.min(retryMs * 2, 1_000);
  }
}

/**
 * the rebuild runs under the writer lease, which every writer of the checkout
 * holds, so no writer materialises files meanwhile; a read-only command waits
 * too, since it must never read another view's projection
 */
export async function alignCheckoutView(
  repoDir: string,
  handle: V3Datastore,
  view: CheckoutView,
  options: { readonly holdsWriterLock: boolean },
): Promise<void> {
  const quick = await readRecordedView(repoDir);
  if (await isCurrent(quick, view)) {
    // a moved checkout, an upgraded record or a newly named principal keeps
    // the view: the record is brought up to date, never rebuilt
    const recorded = (quick as RecordedView).view;
    const refreshed = refreshedView(recorded, view);
    if (flatJson(refreshed) !== flatJson(recorded)) {
      // the record still names this view, so a checkout it cannot be
      // written in (mounted read-only) reads on
      try {
        await writeRecordedView(repoDir, { view: refreshed });
      } catch (error) {
        logger
          .debug`Could not bring ${repoDir}'s checkout view record up to date; it still names this view: ${error}`;
      }
    }
    return;
  }
  if (quick === "absent" && view.kind === "solo") {
    await writeRecordedView(repoDir, { view });
    return;
  }
  const release = options.holdsWriterLock
    ? undefined
    : await leaseUnlessAligned(repoDir, handle.datastorePath, view);
  if (release === "aligned") return;
  try {
    // Looked at again under the lease: another process may have rebuilt.
    const recorded = await readRecordedView(repoDir);
    if (await isCurrent(recorded, view)) return;
    if (recorded === "absent" && view.kind === "solo") {
      await writeRecordedView(repoDir, { view });
      return;
    }
    const previous = typeof recorded === "object" ? recorded.view : undefined;
    // Another root's unsettled writes would be left behind: refused. The
    // same root's belong to this caller (the binding reset a copy built
    // with another token), and a solo datastore's outbox is landed by any
    // writer of it.
    if (
      previous?.kind === "serve" &&
      !(view.kind === "serve" && view.root === previous.root)
    ) {
      await assertServeCopySettled(previous.root, previous.serverUrl);
    }
    await writeRecordedView(repoDir, {
      view: previous ?? view,
      rebuilding: true,
    });
    try {
      await handle.recoverInterruptedWriter(0, undefined, {
        entry: "view_change",
      });
    } finally {
      // The replay may have rewritten run records before any failure.
      await removeStaleRunIndexes(repoDir);
      await removeStaleOutputSummaries(repoDir);
    }
    await writeRecordedView(repoDir, { view });
  } finally {
    await release?.();
  }
}
