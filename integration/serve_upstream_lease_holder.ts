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

// holds a v3 writer lease as another command of the same checkout does while it
// writes; run in its own ProcessRuntime, the test's commands contend with it
// instead of joining its hold

import { acquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import type { ProcessHost } from "./process_host.ts";

export type LeaseHolderRequest = { kind: "hold"; root: string } | "release";

export const leaseHolderHost: ProcessHost<LeaseHolderRequest, string> = (
  post,
) => {
  let release: (() => Promise<void>) | undefined;
  const handle = async (request: LeaseHolderRequest) => {
    if (request === "release") {
      await release?.();
      release = undefined;
      post("released");
    } else {
      release = await acquireV3WriterLock(request.root);
      post("held");
    }
  };
  return (request) => {
    handle(request).catch((error) =>
      post(`failed: ${error instanceof Error ? error.message : error}`)
    );
  };
};
