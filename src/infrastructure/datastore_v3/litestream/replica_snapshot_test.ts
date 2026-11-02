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

import { assertEquals } from "@std/assert";
import { parseNewestSnapshotTxid } from "./replica_snapshot.ts";

/**
 * `litestream ltx -level 9 -json` from the pinned Litestream 0.5.17 against a
 * file replica (swamp-club#4261). A pin bump that changes this shape must
 * update this fixture, or the snapshot trigger silently stops firing.
 */
const PINNED_OUTPUT = `[
  {
    "level": 9,
    "min_txid": "0000000000000001",
    "max_txid": "0000000000000001",
    "size": 1032054,
    "timestamp": "2026-11-02T00:22:24Z"
  }
]`;

Deno.test("parseNewestSnapshotTxid: reads the pinned Litestream's snapshot listing", () => {
  assertEquals(parseNewestSnapshotTxid(PINNED_OUTPUT), "0000000000000001");
});

Deno.test("parseNewestSnapshotTxid: the newest snapshot wins, by TXID", () => {
  const files = [
    { level: 9, min_txid: "1", max_txid: "00000000000000a0" },
    { level: 9, min_txid: "1", max_txid: "00000000000000ff" },
    { level: 9, min_txid: "1", max_txid: "000000000000001f" },
  ];
  assertEquals(
    parseNewestSnapshotTxid(JSON.stringify(files)),
    "00000000000000ff",
  );
});

Deno.test("parseNewestSnapshotTxid: anything it does not recognise is unknown", () => {
  for (
    const output of [
      "",
      "level  min_txid  max_txid",
      "null",
      "{}",
      "[]",
      JSON.stringify([null]),
      JSON.stringify([{ level: 3, max_txid: "0000000000000001" }]),
      JSON.stringify([{ level: 9, maxTXID: "0000000000000001" }]),
      JSON.stringify([{ level: 9, max_txid: "xyz" }]),
    ]
  ) {
    assertEquals(parseNewestSnapshotTxid(output), undefined, output);
  }
});
