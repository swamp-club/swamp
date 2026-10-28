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
 * Holds a v3 datastore's writer lease from a Worker, as another command of
 * the same checkout does while it writes (swamp-club#4089). The Worker has
 * its own module state, so the test's process does not join its hold.
 *
 * Send `{ kind: "hold", root }`; it answers `"held"`. Send `"release"`; it
 * answers `"released"`.
 */

import { acquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";

declare const self: Worker;

let release: (() => Promise<void>) | undefined;

self.onmessage = async (
  event: MessageEvent<{ kind: "hold"; root: string } | "release">,
) => {
  try {
    if (event.data === "release") {
      await release?.();
      release = undefined;
      self.postMessage("released");
    } else {
      release = await acquireV3WriterLock(event.data.root);
      self.postMessage("held");
    }
  } catch (error) {
    self.postMessage(
      `failed: ${error instanceof Error ? error.message : error}`,
    );
  }
};

self.postMessage("loaded");
