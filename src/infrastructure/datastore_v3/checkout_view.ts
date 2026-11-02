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

import { createHash } from "node:crypto";
import { join, resolve } from "@std/path";
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
import { acquireV3WriterLock } from "./v3_writer_lock.ts";

export const CHECKOUT_VIEW_FILE = "checkout_view.json";

export type CheckoutView =
  | {
    readonly kind: "serve";
    readonly root: string;
    /** a copy moved aside and started afresh at the same root is another view */
    readonly copy: string;
    readonly caller: string;
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

function isCurrent(
  recorded: RecordedView | "absent" | "unreadable",
  view: CheckoutView,
): boolean {
  return typeof recorded === "object" && recorded.rebuilding !== true &&
    sameView(recorded.view, view);
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
      await removeStaleOutputSummaries(repoDir);
    }
    await writeRecordedView(repoDir, { view });
  } finally {
    await release?.();
  }
}
