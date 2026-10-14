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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type { UpdateCheckEvent } from "../../libswamp/update/check.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { renderError } from "../output/error_output.ts";
import {
  type DownloadProgress,
  type DownloadRetry,
  formatBytes,
} from "../../domain/update/download_progress.ts";

/** How often a progress line is written when stderr is not a terminal. */
const PROGRESS_LINE_INTERVAL_MS = 10_000;
/** The span the download speed is averaged over. */
const SPEED_WINDOW_MS = 5_000;

/** Where the log renderer shows download progress. */
export interface UpdateCheckRendererOptions {
  /** The live spinner on a terminal; its message becomes the progress. */
  spinner?: { update(message: string): void } | null;
  /** True when stderr is a terminal, so the spinner shows progress. */
  stderrIsTerminal?: boolean;
  /** Writes one line to stderr; used when there is no terminal. */
  writeStderr?: (line: string) => void;
  now?: () => number;
  /** The terminal's width; replaced in tests. */
  columns?: () => number;
}

/** The terminal's width, or 80 when it cannot be read. */
function terminalColumns(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 80;
  }
}

/**
 * Shortens `message` to fit in `width` columns. The spinner redraws by
 * clearing only its current row, so a wrapped line would leave copies of
 * itself behind.
 */
function fitTo(message: string, width: number): string {
  if (message.length <= width) return message;
  return `${message.slice(0, Math.max(0, width - 1))}\u2026`;
}

export interface UpdateCheckRenderer extends Renderer<UpdateCheckEvent> {
  readonly updated: boolean;
  /** The version installed by this run, when it updated. */
  readonly newVersion: string | null;
  /** True when the user cancelled the update; the binary is unchanged. */
  readonly cancelled: boolean;
}

/**
 * Turns download progress into one line of text, with a speed averaged over
 * the last few seconds.
 */
class DownloadProgressFormatter {
  private samples: { at: number; bytes: number }[] = [];

  constructor(private readonly now: () => number) {}

  format(progress: DownloadProgress): string {
    const at = this.now();
    const last = this.samples.at(-1);
    // A download restarted from zero makes the old samples meaningless.
    if (last && progress.receivedBytes < last.bytes) this.samples = [];
    this.samples.push({ at, bytes: progress.receivedBytes });
    while (
      this.samples.length > 2 && at - this.samples[1].at >= SPEED_WINDOW_MS
    ) {
      this.samples.shift();
    }

    const received = formatBytes(progress.receivedBytes);
    const parts = progress.totalBytes
      ? [
        `Downloading update ${received} / ${formatBytes(progress.totalBytes)}`,
        `(${
          Math.floor((progress.receivedBytes / progress.totalBytes) * 100)
        }%)`,
      ]
      : [`Downloading update ${received}`];
    const first = this.samples[0];
    const elapsedMs = at - first.at;
    if (elapsedMs >= 1000) {
      const perSecond = ((progress.receivedBytes - first.bytes) * 1000) /
        elapsedMs;
      parts.push(`\u00b7 ${formatBytes(Math.round(perSecond))}/s`);
    }
    return parts.join(" ");
  }
}

function formatRetry(retry: DownloadRetry): string {
  const from = retry.resumeFromBytes > 0
    ? ` from ${formatBytes(retry.resumeFromBytes)}`
    : "";
  return `Retrying download${from} (attempt ${
    retry.attempt + 1
  }/${retry.maxAttempts}): ${retry.reason}`;
}

class LogUpdateCheckRenderer implements UpdateCheckRenderer {
  updated = false;
  newVersion: string | null = null;
  cancelled = false;
  private readonly spinner: { update(message: string): void } | null;
  private readonly stderrIsTerminal: boolean;
  private readonly writeStderr: (line: string) => void;
  private readonly now: () => number;
  private readonly columns: () => number;
  private readonly progress: DownloadProgressFormatter;
  private lastLineAt = Number.NEGATIVE_INFINITY;

  constructor(options: UpdateCheckRendererOptions) {
    this.spinner = options.spinner ?? null;
    this.stderrIsTerminal = options.stderrIsTerminal ??
      Deno.stderr.isTerminal();
    this.writeStderr = options.writeStderr ??
      // deno-lint-ignore no-console
      ((line) => console.error(line));
    this.now = options.now ?? Date.now;
    this.columns = options.columns ?? terminalColumns;
    this.progress = new DownloadProgressFormatter(this.now);
  }

  /**
   * On a terminal the spinner shows `message` live. Elsewhere (agents, CI,
   * pipes) a line goes to stderr at most every few seconds, or at once when
   * `force` is set, so a long download is visibly alive.
   */
  private show(message: string, force: boolean): void {
    if (this.stderrIsTerminal) {
      // Two columns go to the spinner frame and the space after it.
      this.spinner?.update(fitTo(message, this.columns() - 2));
      return;
    }
    const at = this.now();
    if (!force && at - this.lastLineAt < PROGRESS_LINE_INTERVAL_MS) return;
    this.lastLineAt = at;
    this.writeStderr(message);
  }

  handlers(): EventHandlers<UpdateCheckEvent> {
    const logger = getSwampLogger(["update"]);
    return {
      checking: () => {},
      download_progress: (e) => {
        this.show(this.progress.format(e.data), false);
      },
      download_retrying: (e) => {
        this.show(formatRetry(e.data), true);
      },
      completed: (e) => {
        const data = e.data;
        switch (data.status) {
          case "up_to_date":
            writeOutput(`swamp is up to date (${data.currentVersion})`);
            break;
          case "update_available":
            writeOutput(
              `Update available: ${data.currentVersion} \u2192 ${data.latestVersion}`,
            );
            writeOutput("Run `swamp update` to install");
            break;
          case "updated":
            this.updated = true;
            this.newVersion = data.newVersion;
            writeOutput("swamp updated successfully!");
            writeOutput(
              `${data.previousVersion} \u2192 ${data.newVersion}`,
            );
            writeOutput("SHA-256 integrity check passed");
            writeOutput("The swamp binary has been updated globally.");
            writeOutput(
              "Run `swamp repo upgrade` in your repositories to update settings and instructions.",
            );
            break;
        }
        if (data.warning) {
          logger.warn`${data.warning}`;
        }
      },
      error: (e) => {
        if (e.error.code === "cancelled") {
          this.cancelled = true;
          return;
        }
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonUpdateCheckRenderer implements UpdateCheckRenderer {
  updated = false;
  newVersion: string | null = null;
  cancelled = false;

  handlers(): EventHandlers<UpdateCheckEvent> {
    return {
      checking: () => {},
      // stdout carries one JSON document, so progress is not shown.
      download_progress: () => {},
      download_retrying: () => {},
      completed: (e) => {
        if (e.data.status === "updated") {
          this.updated = true;
          this.newVersion = e.data.newVersion;
        }
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        if (e.error.code === "cancelled") {
          this.cancelled = true;
          return;
        }
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createUpdateCheckRenderer(
  mode: OutputMode,
  options: UpdateCheckRendererOptions = {},
): UpdateCheckRenderer {
  switch (mode) {
    case "json":
      return new JsonUpdateCheckRenderer();
    case "log":
      return new LogUpdateCheckRenderer(options);
  }
}

/**
 * Renders a cancelled update (the user pressed Ctrl+C). Log mode prints a
 * plain line, as other commands do for a cancel the user chose. JSON mode
 * writes the error document to stderr with `code: "cancelled"`, so a script
 * can tell a cancel from a failure without relying on the exit code alone.
 */
export function renderUpdateCancelled(
  mode: OutputMode,
  checkOnly: boolean,
): void {
  const message = checkOnly
    ? "Update check cancelled."
    : "Update cancelled. The installed swamp binary was not changed.";
  if (mode === "json") {
    renderError(new UserError(message, "cancelled"), mode);
  } else {
    getSwampLogger(["update"]).info(message);
  }
}
