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

// Finding and reading a step's log. A model method that captures output
// (a shell command, say) writes it as a `file` data item — `log` for the
// built-in shell model — with `[stdout]` and `[stderr]` sections. Pure, so
// the panel and its tests agree on what "the log" is.

import type { ArtifactRefLike } from "./run_graph_model.ts";

/** The step's log artifact: a `file` item named `log`, else any file. */
export function pickLogArtifact(
  refs: readonly ArtifactRefLike[] | undefined,
): ArtifactRefLike | null {
  const files = (refs ?? []).filter((r) =>
    r.tags?.type === "file" && !!r.tags.modelName
  );
  return files.find((r) => r.name === "log" || r.tags?.specName === "log") ??
    files[0] ?? null;
}

export type LogStream = "stdout" | "stderr" | null;

export interface LogLine {
  text: string;
  stream: LogStream;
}

const MARKER = /^\[(stdout|stderr)\]\s*$/;

/**
 * Splits log text into lines tagged with the stream they came from. The
 * `[stdout]` / `[stderr]` markers are dropped; text before any marker has
 * no stream. Keeps only the last `limit` lines.
 */
export function parseLog(text: string, limit = 500): {
  lines: LogLine[];
  truncated: number;
} {
  const lines: LogLine[] = [];
  let stream: LogStream = null;
  const raw = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  for (const line of raw) {
    const marker = MARKER.exec(line);
    if (marker) {
      stream = marker[1] as LogStream;
      continue;
    }
    lines.push({ text: line, stream });
  }
  const truncated = Math.max(0, lines.length - limit);
  return { lines: truncated > 0 ? lines.slice(truncated) : lines, truncated };
}

/** A log built from a step's `stdout`/`stderr` outputs, when it has them. */
export function logFromOutputs(
  outputs: Record<string, unknown> | undefined,
): string | null {
  if (!outputs) return null;
  const parts: string[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const value = outputs[stream];
    if (typeof value === "string" && value.length > 0) {
      parts.push(`[${stream}]`, value);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
