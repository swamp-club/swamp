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
  CodexSessionFinder,
  codexSessionsRoot,
  MAX_SESSION_FILES,
  parseCodexHeader,
  readFirstLine,
} from "./codex_session_finder.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-codex-" }),
  );
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const LAUNCH = new Date("2026-11-14T15:00:00Z");
const A = "01a1d2fd-c180-7601-b367-4298b76a0fb0";
const B = "01a1d2fe-0000-7601-b367-4298b76a0fb1";
const C = "01a1d2ff-0000-7601-b367-4298b76a0fb2";

function headerLine(
  id: string,
  at: Date,
  cwd: string,
  source: unknown = "cli",
): string {
  return JSON.stringify({
    timestamp: at.toISOString(),
    type: "session_meta",
    payload: {
      id,
      timestamp: at.toISOString(),
      cwd,
      originator: "codex-tui",
      source,
      base_instructions: { text: "x".repeat(20_000) },
    },
  });
}

/** written where Codex puts it: a local-time day folder, named by start time */
async function writeSession(
  root: string,
  id: string,
  at: Date,
  cwd: string,
  source?: unknown,
): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const dir = join(
    root,
    String(at.getFullYear()),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
  );
  await Deno.mkdir(dir, { recursive: true });
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${
    pad(at.getDate())
  }T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  await Deno.writeTextFile(
    join(dir, `rollout-${stamp}-${id}.jsonl`),
    `${headerLine(id, at, cwd, source)}\n{"type":"event"}\n`,
  );
}

function finder(
  root: string | undefined,
  now = new Date("2026-11-15T12:00:00Z"),
) {
  return new CodexSessionFinder({ sessionsRoot: root, now: () => now });
}

const after = (seconds: number) => new Date(LAUNCH.getTime() + seconds * 1000);

Deno.test("CodexSessionFinder.find: finds the session start launched in this folder", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "ws");
    await Deno.mkdir(ws);
    const root = join(dir, "sessions");
    await writeSession(root, C, after(-3600), ws);
    await writeSession(root, A, after(2), ws);
    await writeSession(root, B, after(600), ws);
    assertEquals(await finder(root).find("codex", ws, LAUNCH), A);
  });
});

Deno.test("CodexSessionFinder.find: a newer session in another folder, a subagent and an exec run are ignored", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "ws");
    const other = join(dir, "other");
    await Deno.mkdir(ws);
    await Deno.mkdir(other);
    const root = join(dir, "sessions");
    await writeSession(root, B, after(1), ws, {
      subagent: { thread_spawn: { depth: 1 } },
    });
    await writeSession(root, C, after(2), ws, "exec");
    await writeSession(root, A, after(5), ws);
    await writeSession(
      root,
      "01a1d300-0000-7601-b367-4298b76a0fb3",
      after(9),
      other,
    );
    assertEquals(await finder(root).find("codex", ws, LAUNCH), A);
  });
});

Deno.test("CodexSessionFinder.find: none found reads as null, so resume falls back to --last", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "ws");
    await Deno.mkdir(ws);
    const root = join(dir, "sessions");
    await writeSession(root, A, after(-60), ws);
    await writeSession(root, B, after(60), join(dir, "elsewhere"));
    assertEquals(await finder(root).find("codex", ws, LAUNCH), null);
    assertEquals(
      await finder(join(dir, "missing")).find("codex", ws, LAUNCH),
      null,
    );
    assertEquals(await finder(undefined).find("codex", ws, LAUNCH), null);
    assertEquals(await finder(root).find("claude", ws, LAUNCH), null);
  });
});

Deno.test({
  name:
    "CodexSessionFinder.find: matches the folder by real path, as on Fedora Atomic where /home links to /var/home",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, "var", "home", "ws");
      await Deno.mkdir(real, { recursive: true });
      const linked = join(dir, "home");
      await Deno.symlink(join(dir, "var", "home"), linked, { type: "dir" });
      const root = join(dir, "sessions");
      await writeSession(root, A, after(3), real);
      assertEquals(
        await finder(root).find("codex", join(linked, "ws"), LAUNCH),
        A,
      );
    });
  },
});

Deno.test("readFirstLine: reads only up to the first newline, within the cap", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "s.jsonl");
    await Deno.writeTextFile(path, `first\n${"y".repeat(100_000)}\n`);
    assertEquals(await readFirstLine(path), "first");
    await Deno.writeTextFile(path, "z".repeat(5000));
    assertEquals(await readFirstLine(path, 1024), null);
    assertEquals(await readFirstLine(join(dir, "missing")), null);
  });
});

Deno.test("parseCodexHeader: reads id, time, folder and whether it runs in the background", () => {
  const header = parseCodexHeader(headerLine(A, LAUNCH, "/w"));
  assertEquals(header, {
    id: A,
    startedAt: LAUNCH,
    cwd: "/w",
    background: false,
  });
  assertEquals(
    parseCodexHeader(headerLine(A, LAUNCH, "/w", "exec"))?.background,
    true,
  );
  for (
    const bad of [
      "not json",
      JSON.stringify({ type: "event", payload: {} }),
      headerLine("--last", LAUNCH, "/w"),
      JSON.stringify({ type: "session_meta", payload: { id: A, cwd: "/w" } }),
    ]
  ) {
    assertEquals(parseCodexHeader(bad), null, bad);
  }
});

Deno.test("codexSessionsRoot: CODEX_HOME wins, an empty one means unset", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(
    codexSessionsRoot("/home/u", env({ CODEX_HOME: "/c" })),
    join("/c", "sessions"),
  );
  assertEquals(
    codexSessionsRoot("/home/u", env({ CODEX_HOME: "" })),
    join("/home/u", ".codex", "sessions"),
  );
  assertEquals(codexSessionsRoot("", env({})), undefined);
});

Deno.test("CodexSessionFinder.find: reads at most MAX_SESSION_FILES files", async () => {
  await withTempDir(async (dir) => {
    const ws = join(dir, "ws");
    await Deno.mkdir(ws);
    const root = join(dir, "sessions");
    const day = join(root, "2026", "11", "14");
    await Deno.mkdir(day, { recursive: true });
    for (let i = 0; i < MAX_SESSION_FILES; i++) {
      await Deno.writeTextFile(
        join(day, `rollout-a-${String(i).padStart(4, "0")}.jsonl`),
        "{}\n",
      );
    }
    const now = new Date(2026, 10, 14, 23, 0, 0);
    const since = new Date(2026, 10, 14, 1, 0, 0);
    await Deno.writeTextFile(
      join(day, "rollout-b.jsonl"),
      `${headerLine(A, new Date(since.getTime() + 5000), ws)}\n`,
    );
    assertEquals(await finder(root, now).find("codex", ws, since), null);
    await Deno.remove(join(day, "rollout-a-0000.jsonl"));
    assertEquals(await finder(root, now).find("codex", ws, since), A);
  });
});
