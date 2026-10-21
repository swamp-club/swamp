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
import { join } from "@std/path";
import {
  type BarrierLibc,
  type BarrierLibcLoader,
  barrierSync,
} from "./barrier_sync.ts";

/** A fake libc recording its calls; `fcntl` answers `result`. */
function fakeLibc(
  options: { fd?: number; fcntl?: () => Promise<number> } = {},
) {
  const calls: string[] = [];
  const libc: BarrierLibc = {
    open: (path, flags) => {
      const text = new TextDecoder().decode(path);
      calls.push(`open ${text} ${flags.toString(16)}`);
      return options.fd ?? 7;
    },
    fcntl: (fd, cmd) => {
      calls.push(`fcntl ${fd} ${cmd}`);
      return options.fcntl?.() ?? Promise.resolve(0);
    },
    close: (fd) => {
      calls.push(`close ${fd}`);
      return 0;
    },
  };
  const load: BarrierLibcLoader = () => libc;
  return { calls, load };
}

Deno.test("barrierSync: opens the path read-only, runs F_BARRIERFSYNC on it, and closes it", async () => {
  const libc = fakeLibc();
  assertEquals(await barrierSync("/data/chunk", libc.load), "synced");
  assertEquals(libc.calls, [
    "open /data/chunk\0 1000000",
    "fcntl 7 85",
    "close 7",
  ]);
});

Deno.test("barrierSync: a volume that refuses the barrier answers unsupported, and the fd is still closed", async () => {
  const libc = fakeLibc({ fcntl: () => Promise.resolve(-1) });
  assertEquals(await barrierSync("/nfs/chunk", libc.load), "unsupported");
  assertEquals(libc.calls.at(-1), "close 7");
});

Deno.test("barrierSync: a path that cannot be opened answers unsupported without fcntl", async () => {
  const libc = fakeLibc({ fd: -1 });
  assertEquals(await barrierSync("/gone", libc.load), "unsupported");
  assertEquals(libc.calls, ["open /gone\0 1000000"]);
});

Deno.test("barrierSync: a thrown fcntl answers unsupported, closing the fd", async () => {
  const libc = fakeLibc({ fcntl: () => Promise.reject(new Error("ffi")) });
  assertEquals(await barrierSync("/data/chunk", libc.load), "unsupported");
  assertEquals(libc.calls.at(-1), "close 7");
});

Deno.test("barrierSync: libc that cannot be loaded answers unsupported", async () => {
  assertEquals(
    await barrierSync("/data/chunk", () => undefined),
    "unsupported",
  );
});

Deno.test({
  name: "barrierSync: runs the real barrier on a file and a directory (macOS)",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-barrier-sync-" });
    try {
      const file = join(dir, "chunk");
      await Deno.writeFile(file, new Uint8Array([1, 2, 3]));
      assertEquals(await barrierSync(file), "synced");
      assertEquals(await barrierSync(dir), "synced");
      assertEquals(await barrierSync(join(dir, "missing")), "unsupported");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
