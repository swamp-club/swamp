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
import { type SwampColor, swampColor } from "../swamp_colors.ts";

/** How often a progress line is written when stderr is not a terminal. */
const PROGRESS_LINE_INTERVAL_MS = 10_000;
/** The span the download speed is averaged over. */
const SPEED_WINDOW_MS = 5_000;
/** The widest the progress bar is drawn. */
const BAR_MAX_COLUMNS = 30;
/** Below this the bar is left out rather than drawn too short to read. */
const BAR_MIN_COLUMNS = 10;

/** The live spinner, as the renderer drives it. */
export interface ProgressSpinner {
  update(message: string): void;
  /** Clears the spinner's row. */
  stop(): void;
  /** Leaves `line` in place of the spinner and moves to a fresh row. */
  finish(line: string): void;
}

/** Where the log renderer shows download progress. */
export interface UpdateCheckRendererOptions {
  /** The live spinner on a terminal; its message becomes the progress. */
  spinner?: ProgressSpinner | null;
  /** True when stderr is a terminal, so the spinner shows progress. */
  stderrIsTerminal?: boolean;
  /** Writes one line to stderr; used when there is no terminal. */
  writeStderr?: (line: string) => void;
  /**
   * `-q`: no progress or retry lines on stderr. The spinner, which only
   * draws on a terminal and leaves nothing behind, is unaffected.
   */
  quiet?: boolean;
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

/** A run of text drawn in one swamp color, or plain. */
interface Segment {
  readonly text: string;
  readonly color?: SwampColor;
}

/**
 * Draws `segments` in at most `width` columns, cutting the text with an
 * ellipsis when it is too long. The spinner redraws by clearing only its
 * current row, so a wrapped line would leave copies of itself behind. The
 * width is measured on the plain text and colors are added after, so an
 * escape sequence is never counted or cut.
 */
function fitSegments(segments: readonly Segment[], width: number): string {
  const paint = (s: Segment, text: string) =>
    s.color && text ? swampColor(s.color, text) : text;
  const length = segments.reduce((n, s) => n + s.text.length, 0);
  if (length <= width) return segments.map((s) => paint(s, s.text)).join("");
  if (width < 1) return "";
  let room = width - 1;
  let out = "";
  for (const s of segments) {
    if (room <= 0) break;
    const text = s.text.slice(0, room);
    out += paint(s, text);
    room -= text.length;
  }
  return `${out}\u2026`;
}

/**
 * A progress bar `columns` wide, filled to `fraction`, with a half cell at
 * the head so it moves in half steps.
 */
function barSegments(fraction: number, columns: number): Segment[] {
  const halves = Math.floor(Math.min(1, Math.max(0, fraction)) * columns * 2);
  const full = Math.floor(halves / 2);
  const head = halves % 2 === 1 ? "\u2578" : "";
  const empty = columns - full - head.length;
  return [
    { text: "\u2501".repeat(full) + head, color: "magenta" },
    { text: "\u2500".repeat(empty), color: "muted" },
  ];
}

/**
 * Puts a bar of `fraction` in front of `tail`, as wide as fits in `width`
 * up to BAR_MAX_COLUMNS, or leaves it out when fewer than BAR_MIN_COLUMNS
 * are free.
 */
function withBar(
  fraction: number,
  tail: readonly Segment[],
  width: number,
): Segment[] {
  const tailLength = tail.reduce((n, s) => n + s.text.length, 0);
  const columns = Math.min(BAR_MAX_COLUMNS, width - tailLength - 1);
  if (columns < BAR_MIN_COLUMNS) return [...tail];
  return [...barSegments(fraction, columns), { text: " " }, ...tail];
}

/**
 * Formats seconds at a fixed width (`m:ss`, or `h:mm:ss` from an hour), so a
 * live line does not jitter as the value counts down.
 */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export interface UpdateCheckRenderer extends Renderer<UpdateCheckEvent> {
  readonly updated: boolean;
  /** The version installed by this run, when it updated. */
  readonly newVersion: string | null;
  /** True when the user cancelled the update; the binary is unchanged. */
  readonly cancelled: boolean;
}

/**
 * Turns download progress into a line, with a speed averaged over the last
 * few seconds: plain text for logs, or a colored bar for the terminal.
 */
class DownloadProgressFormatter {
  private samples: { at: number; bytes: number }[] = [];
  private startedAt: number | null = null;
  private lastAt: number | null = null;
  private last: DownloadProgress | null = null;

  constructor(private readonly now: () => number) {}

  /** Records `progress`; returns bytes per second, or null until known. */
  private record(progress: DownloadProgress): number | null {
    const at = this.now();
    this.startedAt ??= at;
    this.lastAt = at;
    this.last = progress;
    const last = this.samples.at(-1);
    // A download restarted from zero makes the old samples meaningless.
    if (last && progress.receivedBytes < last.bytes) this.samples = [];
    this.samples.push({ at, bytes: progress.receivedBytes });
    while (
      this.samples.length > 2 && at - this.samples[1].at >= SPEED_WINDOW_MS
    ) {
      this.samples.shift();
    }
    const first = this.samples[0];
    const elapsedMs = at - first.at;
    if (elapsedMs < 1000) return null;
    return ((progress.receivedBytes - first.bytes) * 1000) / elapsedMs;
  }

  /** One plain line, for stderr when it is not a terminal. */
  format(progress: DownloadProgress): string {
    const perSecond = this.record(progress);
    const received = formatBytes(progress.receivedBytes);
    const parts = progress.totalBytes
      ? [
        `Downloading update ${received} / ${formatBytes(progress.totalBytes)}`,
        `(${
          Math.floor((progress.receivedBytes / progress.totalBytes) * 100)
        }%)`,
      ]
      : [`Downloading update ${received}`];
    if (perSecond !== null) {
      parts.push(`\u00b7 ${formatBytes(Math.round(perSecond))}/s`);
    }
    return parts.join(" ");
  }

  /**
   * The live line for the spinner, at most `width` columns: a bar with the
   * percentage, bytes, speed and time left when the size is known, or the
   * bytes received and speed when it is not.
   */
  formatLive(progress: DownloadProgress, width: number): string {
    const perSecond = this.record(progress);
    const received = formatBytes(progress.receivedBytes);
    const speed: Segment[] = perSecond === null ? [] : [{
      text: ` \u00b7 ${formatBytes(Math.round(perSecond))}/s`,
      color: "muted",
    }];
    const total = progress.totalBytes;
    if (!total) {
      return fitSegments([
        { text: `Downloading update ${received}` },
        ...speed,
      ], width);
    }
    const fraction = progress.receivedBytes / total;
    const eta: Segment[] = perSecond === null || perSecond <= 0 ? [] : [{
      text: ` \u00b7 ETA ${
        formatClock(Math.max(0, total - progress.receivedBytes) / perSecond)
      }`,
      color: "muted",
    }];
    const tail: Segment[] = [
      { text: `${Math.floor(Math.min(1, fraction) * 100)}%`, color: "cyan" },
      { text: ` ${received} / ${formatBytes(total)}` },
      ...speed,
      ...eta,
    ];
    return fitSegments(withBar(fraction, tail, width), width);
  }

  /**
   * The line left on the terminal once `newVersion` is installed: a check,
   * the new version, and the full bar, size and download time as far as the
   * download reported them. The time ends at the last progress event, so the
   * checksum and install that follow are not counted.
   */
  formatFinished(newVersion: string, width: number): string {
    const check: Segment = { text: "\u2713 ", color: "green" };
    const version: Segment = { text: `swamp ${newVersion}`, color: "green" };
    const last = this.last;
    if (!last || this.startedAt === null || this.lastAt === null) {
      return fitSegments([check, version], width);
    }
    const size = last.totalBytes ?? last.receivedBytes;
    const summary: Segment = {
      text: ` \u00b7 ${formatBytes(size)} in ${
        formatClock((this.lastAt - this.startedAt) / 1000)
      }`,
      color: "muted",
    };
    if (!last.totalBytes) return fitSegments([check, version, summary], width);
    const tail = [version, summary];
    const rest = width - check.text.length;
    return fitSegments([check, ...withBar(1, tail, rest)], width);
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
  private readonly spinner: ProgressSpinner | null;
  private readonly stderrIsTerminal: boolean;
  private readonly quiet: boolean;
  private readonly writeStderr: (line: string) => void;
  private readonly now: () => number;
  private readonly columns: () => number;
  private readonly progress: DownloadProgressFormatter;
  private lastLineAt = Number.NEGATIVE_INFINITY;

  constructor(options: UpdateCheckRendererOptions) {
    this.spinner = options.spinner ?? null;
    this.stderrIsTerminal = options.stderrIsTerminal ??
      Deno.stderr.isTerminal();
    this.quiet = options.quiet ?? false;
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
   * `force` is set, so a long download is visibly alive — unless `-q` asked
   * for no commentary on stderr (see postCommandNoticesAllowed).
   */
  private show(message: string, force: boolean): void {
    if (this.stderrIsTerminal) {
      this.spinner?.update(fitSegments([{ text: message }], this.liveWidth()));
      return;
    }
    if (this.quiet) return;
    const at = this.now();
    if (!force && at - this.lastLineAt < PROGRESS_LINE_INTERVAL_MS) return;
    this.lastLineAt = at;
    this.writeStderr(message);
  }

  /** Two columns go to the spinner frame and the space after it. */
  private liveWidth(): number {
    return this.columns() - 2;
  }

  /**
   * Ends the live progress before anything else is written, so the next
   * output starts on its own row: an installed update leaves a final line
   * with the new version, anything else clears the row. Under `-q` the row
   * is always cleared, so the spinner leaves nothing behind.
   */
  private settleSpinner(newVersion: string | null): void {
    if (newVersion !== null && this.stderrIsTerminal && !this.quiet) {
      this.spinner?.finish(
        this.progress.formatFinished(newVersion, this.liveWidth()),
      );
    } else {
      this.spinner?.stop();
    }
  }

  handlers(): EventHandlers<UpdateCheckEvent> {
    const logger = getSwampLogger(["update"]);
    return {
      checking: () => {},
      download_progress: (e) => {
        if (this.stderrIsTerminal) {
          this.spinner?.update(
            this.progress.formatLive(e.data, this.liveWidth()),
          );
          return;
        }
        this.show(this.progress.format(e.data), false);
      },
      download_retrying: (e) => {
        this.show(formatRetry(e.data), true);
      },
      completed: (e) => {
        const data = e.data;
        this.settleSpinner(
          data.status === "updated" ? data.newVersion : null,
        );
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
