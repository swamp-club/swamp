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

import { join } from "@std/path";
import {
  type AgentSessionFinder,
  type CodexSessionHeader,
  isAgentSessionId,
  pickCodexSession,
} from "../../../domain/start/agent_session.ts";

export const MAX_SESSION_FILES = 500;
export const MAX_HEADER_BYTES = 256 * 1024;
export const MAX_DAY_FOLDERS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/** CODEX_HOME's sessions folder, else ~/.codex/sessions; an empty override means unset */
export function codexSessionsRoot(
  home: string,
  env: (name: string) => string | undefined,
): string | undefined {
  const codexHome = env("CODEX_HOME") || undefined;
  if (codexHome !== undefined) return join(codexHome, "sessions");
  return home !== "" ? join(home, ".codex", "sessions") : undefined;
}

/** reads up to the first newline, never past the cap */
export async function readFirstLine(
  path: string,
  maxBytes = MAX_HEADER_BYTES,
): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buffer = new Uint8Array(16 * 1024);
    while (total < maxBytes) {
      const n = await file.read(buffer);
      if (n === null) break;
      const chunk = buffer.slice(0, Math.min(n, maxBytes - total));
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.slice(0, newline));
        return new TextDecoder().decode(concat(chunks));
      }
      chunks.push(chunk);
      total += chunk.length;
    }
    return null;
  } catch {
    return null;
  } finally {
    file.close();
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

interface RawHeader {
  readonly id: string;
  readonly startedAt: Date;
  readonly cwd: string;
  readonly background: boolean;
}

/** a `session_meta` first line; anything else is not read as a session */
export function parseCodexHeader(line: string): RawHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "session_meta") return null;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (typeof payload !== "object" || payload === null) return null;
  const { id, timestamp, cwd, source, originator } = payload;
  if (
    !isAgentSessionId(id) || typeof timestamp !== "string" ||
    typeof cwd !== "string"
  ) {
    return null;
  }
  const startedAt = new Date(timestamp);
  if (Number.isNaN(startedAt.getTime())) return null;
  const background = (typeof source === "object" && source !== null) ||
    source === "exec" || originator === "codex_exec";
  return { id, startedAt, cwd, background };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Codex names its day folders in local time, so a day either side is read */
function dayFolders(root: string, since: Date, now: Date): string[] {
  const folders: string[] = [];
  const first = new Date(since.getTime() - DAY_MS);
  first.setHours(0, 0, 0, 0);
  for (
    let day = first;
    day.getTime() <= now.getTime() + DAY_MS &&
    folders.length < MAX_DAY_FOLDERS;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    folders.push(
      join(
        root,
        String(day.getFullYear()),
        pad(day.getMonth() + 1),
        pad(day.getDate()),
      ),
    );
  }
  return folders;
}

async function sessionFiles(folder: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(folder)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) names.push(entry.name);
    }
  } catch {
    return [];
  }
  return names.sort().map((name) => join(folder, name));
}

async function realPathOr(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

export interface CodexSessionFinderDeps {
  readonly sessionsRoot: string | undefined;
  readonly now: () => Date;
}

export class CodexSessionFinder implements AgentSessionFinder {
  constructor(private readonly deps: CodexSessionFinderDeps) {}

  async find(
    harness: string,
    workspacePath: string,
    since: Date,
  ): Promise<string | null> {
    const root = this.deps.sessionsRoot;
    if (harness !== "codex" || root === undefined) return null;
    const workspace = await realPathOr(workspacePath);
    const realPaths = new Map<string, string>();
    const headers: CodexSessionHeader[] = [];
    let read = 0;
    // Oldest first, so the read cap keeps the sessions nearest the launch.
    for (const folder of dayFolders(root, since, this.deps.now())) {
      for (const file of await sessionFiles(folder)) {
        if (read++ >= MAX_SESSION_FILES) {
          return pickCodexSession(headers, workspace, since);
        }
        const line = await readFirstLine(file);
        const header = line === null ? null : parseCodexHeader(line);
        if (header === null || header.background) continue;
        if (header.startedAt.getTime() < since.getTime()) continue;
        let cwd = realPaths.get(header.cwd);
        if (cwd === undefined) {
          cwd = await realPathOr(header.cwd);
          realPaths.set(header.cwd, cwd);
        }
        headers.push({ ...header, cwd });
        // Files sort by start time, so the first match is the earliest.
        if (cwd === workspace) {
          return pickCodexSession(headers, workspace, since);
        }
      }
    }
    return pickCodexSession(headers, workspace, since);
  }
}
