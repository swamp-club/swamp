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

import { processRuntimeSlot } from "../runtime/process_runtime.ts";

const liveHere = new Set<string>();

const instance = processRuntimeSlot(() => {
  const token = crypto.randomUUID();
  liveHere.add(token);
  return token;
});

/** this process's writer token; a restarted process reusing a pid gets a new one */
export function writerInstance(): string {
  return instance();
}

/**
 * true for the token of a process runtime of this OS process, which shares its
 * pid with every other one and so cannot be judged by it
 */
export function isWriterInstanceLiveHere(token: string): boolean {
  return liveHere.has(token);
}
