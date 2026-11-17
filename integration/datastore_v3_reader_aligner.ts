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

// a read-only command of another process aligning its view of the same checkout

import { join } from "@std/path";
import {
  alignCheckoutView,
  type CheckoutView,
} from "../src/infrastructure/datastore_v3/checkout_view.ts";
import type { V3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { currentProcessRuntime } from "../src/infrastructure/runtime/process_runtime.ts";
import type { ProcessHost } from "./process_host.ts";

export interface AlignRequest {
  readonly repoDir: string;
  readonly datastorePath: string;
  readonly view: CheckoutView;
}

export type AlignMessage =
  | { readonly waiting: true }
  | { readonly aligned: number }
  | { readonly failed: string };

export const readerAlignerHost: ProcessHost<AlignRequest, AlignMessage> = (
  post,
  stopped,
) => {
  const runtime = currentProcessRuntime();
  return (request) => {
    align(request).catch((error) => post({ failed: String(error) }));
  };

  async function align(request: AlignRequest): Promise<void> {
    const restore = reportLeaseWait(request.datastorePath);
    // a terminated reader leaves Deno.readDir alone before its test removes the dir
    stopped.addEventListener("abort", restore, { once: true });
    try {
      let rebuilds = 0;
      const handle = {
        datastorePath: request.datastorePath,
        recoverInterruptedWriter() {
          rebuilds++;
          return Promise.resolve([]);
        },
      } as unknown as V3Datastore;
      await alignCheckoutView(request.repoDir, handle, request.view, {
        holdsWriterLock: false,
      });
      post({ aligned: rebuilds });
    } finally {
      stopped.removeEventListener("abort", restore);
      restore();
    }
  }

  // the second listing of the lease directory from this runtime means it waits
  function reportLeaseWait(datastorePath: string): () => void {
    const leaseDir = join(datastorePath, "_control", "writer");
    const original = Object.getOwnPropertyDescriptor(Deno, "readDir")!;
    const readDir = Deno.readDir.bind(Deno);
    let reads = 0;
    Object.defineProperty(Deno, "readDir", {
      configurable: true,
      value: (path: string | URL) => {
        if (
          currentProcessRuntime() === runtime && String(path) === leaseDir &&
          ++reads === 2
        ) {
          post({ waiting: true });
        }
        return readDir(path);
      },
    });
    return () => Object.defineProperty(Deno, "readDir", original);
  }
};
