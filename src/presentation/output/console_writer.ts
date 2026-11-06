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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { unicodeWidth } from "@std/cli/unicode-width";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import { mapControlCharacters } from "../../domain/control_characters.ts";
import { dataQueryCommand } from "../../domain/data/data_query_command.ts";
import {
  SUMMARY_DISPLAY_HIDDEN,
  SUMMARY_DISPLAY_TAG,
} from "../../domain/data/data.ts";

export type ColorFn = (str: string) => string;

const GUTTER_WIDTH = 12;
const PIPE_CHAR = "│";

export const STATUS_COLORS = {
  info: (s: string) => bold(cyan(s)),
  success: (s: string) => bold(green(s)),
  error: (s: string) => bold(red(s)),
  warn: (s: string) => bold(yellow(s)),
  dim: (s: string) => bold(dim(s)),
} as const;

export function formatTimestamp(date?: Date): string {
  const d = date ?? new Date();
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s} UTC`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds.toFixed(0)}s`;
}

export function gutterLine(
  status: string,
  color: ColorFn,
  content: string,
  timestamp?: string,
): string {
  const padded = status.padStart(GUTTER_WIDTH - 1);
  const ts = timestamp ? dim(` · ${timestamp}`) : "";
  return `${color(padded)}   ${content}${ts}`;
}

export function contentLine(content: string): string {
  const pad = " ".repeat(GUTTER_WIDTH + 2);
  return `${pad}${content}`;
}

export function blankLine(): string {
  return "";
}

export class PipeWriter {
  private maxNameWidth: number;

  constructor(names: string[]) {
    this.maxNameWidth = Math.max(...names.map((n) => n.length), 1);
  }

  updateWidth(names: string[]): void {
    const newMax = Math.max(...names.map((n) => n.length), 1);
    if (newMax > this.maxNameWidth) {
      this.maxNameWidth = newMax;
    }
  }

  get maxWidth(): number {
    return this.maxNameWidth;
  }

  get contentColumnWidth(): number {
    return this.maxNameWidth + 4;
  }

  line(name: string, content: string): string {
    const padded = name.padStart(this.maxNameWidth + 1);
    return `${dim(padded)} ${dim(PIPE_CHAR)} ${content}`;
  }

  statusLine(
    name: string,
    status: string,
    color: ColorFn,
    content: string,
    timestamp?: string,
  ): string {
    const ts = timestamp ? dim(` · ${timestamp}`) : "";
    return this.line(name, `${color(status)} ${content}${ts}`);
  }

  startLine(name: string, timestamp: string, suffix?: string): string {
    const extra = suffix ? ` ${dim(suffix)}` : "";
    return this.line(name, `${cyan("start")} ${dim(timestamp)}${extra}`);
  }

  doneLine(
    name: string,
    stepPath: string,
    duration: string,
    timestamp: string,
  ): string {
    return this.line(
      name,
      `${green("done")} ${stepPath} ${dim(`in ${duration} · ${timestamp}`)}`,
    );
  }

  completedLine(
    name: string,
    duration: string,
    timestamp: string,
  ): string {
    return this.line(
      name,
      `${green("completed")} ${dim(`in ${duration} · ${timestamp}`)}`,
    );
  }

  failedStepLine(
    name: string,
    stepPath: string,
    duration: string,
    timestamp: string,
  ): string {
    // A step that never started, such as one stranded by a workflow change,
    // has no duration.
    const when = duration ? `in ${duration} · ${timestamp}` : `· ${timestamp}`;
    return this.line(name, `${red("failed")} ${stepPath} ${dim(when)}`);
  }

  failedJobLine(name: string, timestamp: string): string {
    return this.line(name, `${red("failed")} ${dim(`· ${timestamp}`)}`);
  }

  skippedLine(
    name: string,
    reason?: string,
    guardExpression?: string,
  ): string {
    const extra = reason ? ` (${reason})` : "";
    const guard = guardExpression
      ? ` ${dim(`· guard: ${guardExpression}`)}`
      : "";
    return this.line(name, `${dim(`skipped${extra}`)}${guard}`);
  }

  skippedStepLine(
    name: string,
    stepPath: string,
    reason?: string,
    guardExpression?: string,
  ): string {
    const extra = reason ? ` (${reason})` : "";
    const guard = guardExpression
      ? ` ${dim(`· guard: ${guardExpression}`)}`
      : "";
    return this.line(name, `${dim(`skipped ${stepPath}${extra}`)}${guard}`);
  }

  stepLine(
    name: string,
    stepPath: string,
    model: string,
    method: string,
    timestamp: string,
  ): string {
    return this.line(
      name,
      `step ${stepPath} ${dim("·")} ${model} ${dim("·")} ${method} ${
        dim(`· start ${timestamp}`)
      }`,
    );
  }

  waitingLine(name: string, prompt: string): string {
    return this.line(name, `${yellow("waiting")} ${prompt}`);
  }
}

export interface DataArtifact {
  name: string;
  attributes?: Record<string, unknown>;
  attributesOmitted?: true;
  source?: string;
}

export interface DataBoxOptions {
  globalArguments?: Record<string, unknown>;
  methodArguments?: Record<string, unknown>;
  modelName?: string;
}

export function isUserFacingArtifact(
  artifact: { name: string; tags?: Record<string, string> },
): boolean {
  if (artifact.name.startsWith("report-")) return false;
  if (artifact.name === "log") return false;
  if (artifact.tags?.[SUMMARY_DISPLAY_TAG] === SUMMARY_DISPLAY_HIDDEN) {
    return false;
  }
  return true;
}

export function renderDataBox(
  artifacts: DataArtifact[],
  options?: DataBoxOptions,
): string[] {
  const hasArgs = options?.globalArguments &&
    Object.keys(options.globalArguments).length > 0;
  if (artifacts.length === 0 && !hasArgs) return [];

  const lines: string[] = [];
  const sections: BoxRow[][] = [];
  const retrievalHints: string[] = [];

  if (hasArgs) {
    const argRows: BoxRow[] = [];
    const allArgs = {
      ...options?.globalArguments,
      ...options?.methodArguments,
    };
    const keys = Object.keys(allArgs);
    const keyWidth = keyColumnWidth(keys);
    for (const key of keys) {
      argRows.push([
        { text: "    " },
        ...keyColumn(key, keyWidth),
        ...argumentValue(allArgs[key]),
      ]);
    }
    sections.push([
      [{ text: " " }, { text: "Arguments", style: bold }],
      ...argRows,
    ]);
  }

  if (artifacts.length > 0) {
    const dataRows: BoxRow[] = [];
    const complexArtifactNames: string[] = [];

    for (const artifact of artifacts) {
      dataRows.push([
        { text: "  " },
        ...firstLine(artifact.name, bold),
        ...(artifact.source
          ? [
            { text: "    from ", style: dim },
            ...firstLine(artifact.source, dim),
          ]
          : []),
      ]);

      if (artifact.attributesOmitted) {
        dataEntries.push(
          dim("    content not shown: run output limit reached"),
        );
        if (!complexArtifactNames.includes(artifact.name)) {
          complexArtifactNames.push(artifact.name);
        }
      }

      if (artifact.attributes) {
        const keys = Object.keys(artifact.attributes);
        const displayKeys = keys.slice(0, 10);
        const keyWidth = keyColumnWidth(displayKeys);

        for (const key of displayKeys) {
          const val = artifact.attributes[key];
          if (
            (Array.isArray(val) && val.length > 0) ||
            (typeof val === "object" && val !== null && !Array.isArray(val) &&
              Object.keys(val).length > 0)
          ) {
            if (!complexArtifactNames.includes(artifact.name)) {
              complexArtifactNames.push(artifact.name);
            }
          }
          dataRows.push([
            { text: "    " },
            ...keyColumn(key, keyWidth),
            ...attributeValue(val),
          ]);
        }

        if (keys.length > 10) {
          dataRows.push([{
            text: `    +${keys.length - 10} more`,
            style: dim,
          }]);
          if (!complexArtifactNames.includes(artifact.name)) {
            complexArtifactNames.push(artifact.name);
          }
        }
      }
    }

    // Printed below the box: a query is wider than the box's 80 columns.
    if (complexArtifactNames.length > 0 && options?.modelName) {
      const modelName = options.modelName;
      for (const name of complexArtifactNames) {
        retrievalHints.push(
          dim(`  → ${
            dataQueryCommand({ modelName, dataName: name }, {
              includeContent: true,
            })
          }`),
        );
      }
    }

    sections.push([
      [{ text: " " }, { text: "Data produced", style: bold }],
      ...dataRows,
    ]);
  }

  const rows = sections.flatMap((s, i) => i > 0 ? [[], ...s] : s);
  const fitted = rows.map((row) => fitRow(row, BOX_CONTENT_WIDTH));

  const maxWidth = Math.max(maxOf(fitted.map((f) => f.width)) ?? 0, 20);
  const boxWidth = maxWidth + 2;
  const top = dim(`  ┌${"─".repeat(boxWidth)}┐`);
  const bottom = dim(`  └${"─".repeat(boxWidth)}┘`);
  const side = dim("  │");
  const sideEnd = dim("│");

  lines.push("");
  lines.push(top);
  for (const { line, width } of fitted) {
    lines.push(`${side}${line}${" ".repeat(boxWidth - width)}${sideEnd}`);
  }
  lines.push(`${side}${" ".repeat(boxWidth)}${sideEnd}`);
  lines.push(bottom);
  for (const hint of retrievalHints) lines.push(hint);

  return lines;
}

const BOX_CONTENT_WIDTH = 80;
const ELLIPSIS = "...";

interface BoxSegment {
  readonly text: string;
  readonly style?: (s: string) => string;
}

type BoxRow = readonly BoxSegment[];

function paint(segment: BoxSegment, text: string): string {
  return segment.style && text ? segment.style(text) : text;
}

// Measures and cuts plain text, painting afterwards, so a color escape is never split.
function fitRow(
  row: BoxRow,
  width: number,
): { line: string; width: number } {
  const total = segmentsWidth(row);
  if (total <= width) {
    return { line: row.map((s) => paint(s, s.text)).join(""), width: total };
  }
  const room = width - ELLIPSIS.length;
  let used = 0;
  let line = "";
  for (const segment of row) {
    let kept = "";
    for (const char of segment.text) {
      const charWidth = unicodeWidth(char);
      if (used + charWidth > room) break;
      kept += char;
      used += charWidth;
    }
    line += paint(segment, kept);
    if (kept.length < segment.text.length) break;
  }
  return { line: `${line}${dim(ELLIPSIS)}`, width: used + ELLIPSIS.length };
}

function segmentsWidth(segments: readonly BoxSegment[]): number {
  return segments.reduce((n, s) => n + unicodeWidth(s.text), 0);
}

function keyColumnWidth(keys: string[]): number {
  return Math.max(
    maxOf(keys.map((k) => segmentsWidth(firstLine(k, dim)))) ?? 0,
    1,
  );
}

function keyColumn(key: string, keyWidth: number): BoxSegment[] {
  const segments = firstLine(key, dim);
  return [
    ...segments,
    { text: `${" ".repeat(keyWidth - segmentsWidth(segments))}   ` },
  ];
}

// deno-lint-ignore no-control-regex
const STRING_SEQUENCE = /\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// deno-lint-ignore no-control-regex
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// Box text comes from model output, so anything a terminal would act on instead
// of print is dropped; a lone CR ends the line because the terminal returns there.
function firstLine(s: string, style?: ColorFn): BoxSegment[] {
  const end = s.search(/[\r\n]/);
  const line = end === -1 ? s : s.slice(0, end);
  const text = mapControlCharacters(
    line.replace(STRING_SEQUENCE, "").replace(CSI_SEQUENCE, "").replaceAll(
      "\t",
      " ",
    ),
    () => "",
  );
  return end === -1
    ? [{ text, style }]
    : [{ text, style }, { text: ELLIPSIS, style: dim }];
}

function argumentValue(value: unknown): BoxSegment[] {
  if (value === null || value === undefined) {
    return [{ text: "null", style: dim }];
  }
  if (typeof value === "string") return firstLine(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return [{ text: String(value) }];
  }
  return firstLine(JSON.stringify(value));
}

function attributeValue(value: unknown): BoxSegment[] {
  if (value === null || value === undefined) {
    return [{ text: "null", style: dim }];
  }
  if (typeof value === "string") return firstLine(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return [{ text: String(value) }];
  }
  if (Array.isArray(value)) {
    return [{
      text: value.length === 0 ? "[]" : `${value.length} items`,
      style: dim,
    }];
  }
  if (typeof value === "object") {
    return [{
      text: Object.keys(value).length === 0 ? "{}" : "object",
      style: dim,
    }];
  }
  return firstLine(String(value));
}

export function writeGutterLine(
  status: string,
  color: ColorFn,
  content: string,
  timestamp?: string,
): void {
  writeOutput(gutterLine(status, color, content, timestamp));
}

export function writeContentLine(content: string): void {
  writeOutput(contentLine(content));
}

export function writeBlankLine(): void {
  writeOutput("");
}

export function writePipeLine(
  pipe: PipeWriter,
  name: string,
  content: string,
): void {
  writeOutput(pipe.line(name, content));
}
