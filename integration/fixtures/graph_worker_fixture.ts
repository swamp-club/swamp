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

// the mode rides on the module URL, so one script plays every start
declare const self: Worker;

const params = new URL(import.meta.url).searchParams;
const mode = params.get("mode");
const flag = params.get("flag");

function post(message: unknown): void {
  self.postMessage(message);
}

if (mode === "stall-once" && flag !== null) {
  // records each start; only a start after the first loads
  const starts = Number(Deno.readTextFileSync(flag)) + 1;
  Deno.writeTextFileSync(flag, String(starts));
  if (starts > 1) post({ kind: "loaded" });
} else if (mode === "throw") {
  throw new Error("fixture refused to load");
} else if (mode !== "never") {
  post({ kind: "loaded" });
  if (mode === "chatty") post({ kind: "hello" });
}

self.onmessage = (event: MessageEvent<string>) =>
  post({ kind: "echo", value: event.data });
