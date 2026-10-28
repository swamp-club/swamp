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
 * Which view of a v3 datastore built a checkout's projection
 * (swamp-club#3985). The projection (the record files under `.swamp/`), the
 * v3 catalog and the read model's state are one per checkout, but the commit
 * log they are built from is not: a solo checkout reads the datastore's own
 * log (or its copy of it), and a serve-mode checkout reads its follower copy
 * of serve's log under a root keyed by serve's address and namespace, which
 * holds only what its token may read. A projection built from one of these
 * and caught up from another shows records the new view does not hold, and
 * its cursor is another log's, so the new log's commits may never apply.
 *
 * So the checkout records the view its projection was built from, in its
 * read-model state directory, and a context opened with another view
 * rebuilds the projection from the new one first ({@link alignCheckoutView}).
 *
 * @module
 */

import { createHash } from "node:crypto";
import { join, resolve } from "@std/path";
import { resolveLockTimeoutMs } from "../../domain/datastore/datastore_config.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
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
import { acquireV3WriterLock } from "./v3_writer_lock.ts";

/** The file, in the checkout's read-model state directory. */
export const CHECKOUT_VIEW_FILE = "checkout_view.json";

/**
 * A view of a v3 datastore a checkout's projection is built from: serve's,
 * through the local root of a serve address and namespace, for the caller
 * a token fingerprint names; or the datastore's own, at its path, for a
 * namespace.
 */
export type CheckoutView =
  | {
    readonly kind: "serve";
    readonly root: string;
    /**
     * The copy's id (swamp-club#4049): a copy moved aside and started
     * afresh at the same root is another view.
     */
    readonly copy: string;
    readonly caller: string;
    /** Serve's address, for messages only: the root is keyed by it. */
    readonly serverUrl: string;
  }
  | {
    readonly kind: "solo";
    readonly datastore: string;
    readonly namespace: string;
  };

/**
 * The fingerprint of a serve token that a copy or a checkout records: its
 * SHA-256, or that of "" when no token is sent. Never the token itself.
 */
export function serveCallerFingerprint(token: string | undefined): string {
  return createHash("sha256").update(token ?? "").digest("hex");
}

/**
 * The view a context over the v3 datastore at `datastorePath` reads;
 * `copyId` is the serve copy's, which a serve view records.
 */
export function checkoutViewOf(
  datastorePath: string,
  namespace: string,
  copyId: string | undefined,
): CheckoutView {
  const serve = serveUpstreamAt(datastorePath);
  return serve !== undefined
    ? {
      kind: "serve",
      root: resolve(datastorePath),
      copy: copyId ?? "",
      caller: serveCallerFingerprint(serve.target.token),
      serverUrl: serve.target.serverUrl,
    }
    : { kind: "solo", datastore: resolve(datastorePath), namespace };
}

function sameView(a: CheckoutView, b: CheckoutView): boolean {
  if (a.kind === "serve" && b.kind === "serve") {
    return a.root === b.root && a.copy === b.copy && a.caller === b.caller;
  }
  if (a.kind === "solo" && b.kind === "solo") {
    return a.datastore === b.datastore && a.namespace === b.namespace;
  }
  return false;
}

/** What the file records: a view, and whether a rebuild from it is unfinished. */
interface RecordedView {
  readonly view: CheckoutView;
  /**
   * A rebuild started and has not finished; `view` is then the view the
   * projection was built from before it, whose copy it checks again.
   */
  readonly rebuilding?: true;
}

/** Error code for {@link ServeCopyHoldsUnlandedCommitsError}. */
export const SERVE_COPY_HOLDS_UNLANDED_CODE =
  "datastore_v3_serve_copy_holds_unlanded";

/**
 * Thrown when switching a checkout's view would leave a serve copy's
 * unsettled writes behind: the copy was built with another token, or the
 * checkout last read the datastore through another serve address or
 * namespace, and that copy's outbox still holds commits that have not
 * settled with serve.
 */
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

/**
 * Refuses when the outbox beside the serve copy at `root` holds entries.
 *
 * @throws ServeCopyHoldsUnlandedCommitsError
 */
export async function assertServeCopySettled(
  root: string,
  serverUrl: string,
): Promise<void> {
  const outbox = new SqliteCommitOutbox(
    v3OutboxPath(v3SharedCommitsDbPath(root)),
  );
  let unlanded: boolean;
  try {
    unlanded = await outbox.hasEntries();
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

/**
 * The view recorded for the checkout at `repoDir`, or undefined when none
 * is (or the file cannot be read as one: it is then rebuilt like a change).
 */
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
        typeof view.serverUrl === "string") ||
      (view?.kind === "solo" && typeof view.datastore === "string" &&
        typeof view.namespace === "string")
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

/** Whether `recorded` says the projection is `view`'s, finished. */
function isCurrent(
  recorded: RecordedView | "absent" | "unreadable",
  view: CheckoutView,
): boolean {
  return typeof recorded === "object" && recorded.rebuilding !== true &&
    sameView(recorded.view, view);
}

/**
 * Makes the projection of the checkout at `repoDir` the one `handle`'s view
 * builds, before the context reads or catches up: when the checkout
 * recorded another view, or a rebuild that did not finish, it is rebuilt
 * from `handle`'s commit log as after an interrupted writer
 * (`recoverInterruptedWriter(0)`: the catalog cleared, the read model's
 * state reset, every commit replayed and every projected file no commit
 * owns removed), then the run indexes are removed, and the view recorded.
 *
 * A checkout with no view recorded is stamped with a solo view as it is:
 * before swamp-club#3985 only a solo view could build a projection. With a
 * serve view it is rebuilt, since it may hold a solo projection.
 *
 * The rebuild runs under the writer lease of `handle`'s datastore, which
 * every writer of the checkout holds for its whole command, so no writer
 * materialises files meanwhile: `holdsWriterLock` when this process holds
 * it already, else it is taken, waiting up to the lock timeout. A read-only
 * command waits too: it must never read another view's projection. It
 * touches only this checkout's files, catalog and read-model state; the
 * commit log is only read, so a solo datastore other checkouts share is
 * unchanged.
 *
 * @throws ServeCopyHoldsUnlandedCommitsError when the view recorded was a
 *   serve copy at another root whose outbox still holds entries
 * @throws V3WriterBusyError when another process holds the lease past the
 *   lock timeout
 */
export async function alignCheckoutView(
  repoDir: string,
  handle: V3Datastore,
  view: CheckoutView,
  options: { readonly holdsWriterLock: boolean },
): Promise<void> {
  const quick = await readRecordedView(repoDir);
  if (isCurrent(quick, view)) return;
  if (quick === "absent" && view.kind === "solo") {
    await writeRecordedView(repoDir, { view });
    return;
  }
  const release = options.holdsWriterLock
    ? undefined
    : await acquireV3WriterLock(handle.datastorePath, {
      maxWaitMs: resolveLockTimeoutMs(),
    });
  try {
    // Looked at again under the lease: another process may have rebuilt.
    const recorded = await readRecordedView(repoDir);
    if (isCurrent(recorded, view)) return;
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
      await handle.recoverInterruptedWriter(0);
    } finally {
      // The replay may have rewritten run records before any failure.
      await removeStaleRunIndexes(repoDir);
    }
    await writeRecordedView(repoDir, { view });
  } finally {
    await release?.();
  }
}
