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
import { writeOutput } from "../../infrastructure/logging/logger.ts";

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
    return this.line(
      name,
      `${red("failed")} ${stepPath} ${dim(`in ${duration} · ${timestamp}`)}`,
    );
  }

  failedJobLine(name: string, timestamp: string): string {
    return this.line(name, `${red("failed")} ${dim(`· ${timestamp}`)}`);
  }

  skippedLine(name: string, reason?: string): string {
    const extra = reason ? ` (${reason})` : "";
    return this.line(name, `${dim(`skipped${extra}`)}`);
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
  source?: string;
}

export interface DataBoxOptions {
  globalArguments?: Record<string, unknown>;
  methodArguments?: Record<string, unknown>;
  modelName?: string;
}

export function renderDataBox(
  artifacts: DataArtifact[],
  options?: DataBoxOptions,
): string[] {
  const hasArgs = options?.globalArguments &&
    Object.keys(options.globalArguments).length > 0;
  if (artifacts.length === 0 && !hasArgs) return [];

  const lines: string[] = [];
  const sections: string[][] = [];

  if (hasArgs) {
    const argEntries: string[] = [];
    const allArgs = {
      ...options?.globalArguments,
      ...options?.methodArguments,
    };
    const keys = Object.keys(allArgs);
    const maxKeyLen = Math.max(...keys.map((k) => k.length), 1);
    for (const key of keys) {
      const val = allArgs[key];
      let formatted: string;
      if (val === null || val === undefined) {
        formatted = dim("null");
      } else if (typeof val === "string") {
        formatted = truncateString(val, MAX_VALUE_WIDTH);
      } else if (typeof val === "number" || typeof val === "boolean") {
        formatted = String(val);
      } else {
        formatted = truncateString(JSON.stringify(val), MAX_VALUE_WIDTH);
      }
      argEntries.push(`    ${dim(key.padEnd(maxKeyLen))}   ${formatted}`);
    }
    sections.push([` ${bold("Arguments")}`, ...argEntries]);
  }

  if (artifacts.length > 0) {
    const dataEntries: string[] = [];
    const complexArtifactNames: string[] = [];

    for (const artifact of artifacts) {
      const sourceSuffix = artifact.source
        ? dim(`    from ${artifact.source}`)
        : "";
      dataEntries.push(`  ${bold(artifact.name)}${sourceSuffix}`);

      if (artifact.attributes) {
        const keys = Object.keys(artifact.attributes);
        const displayKeys = keys.slice(0, 10);
        const maxKeyLen = Math.max(...displayKeys.map((k) => k.length), 1);

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
          dataEntries.push(
            ...formatAttributeEntries(
              key,
              val,
              maxKeyLen,
              "    ",
            ),
          );
        }

        if (keys.length > 10) {
          dataEntries.push(dim(`    +${keys.length - 10} more`));
          if (!complexArtifactNames.includes(artifact.name)) {
            complexArtifactNames.push(artifact.name);
          }
        }
      }
    }

    if (complexArtifactNames.length > 0 && options?.modelName) {
      dataEntries.push("");
      for (const name of complexArtifactNames) {
        dataEntries.push(
          dim(`  → swamp data get ${options.modelName} ${name}`),
        );
      }
    }

    sections.push([` ${bold("Data produced")}`, ...dataEntries]);
  }

  const allEntries = sections.flatMap((s, i) => i > 0 ? ["", ...s] : s);

  const maxWidth = Math.min(
    Math.max(...allEntries.map((e) => stripAnsi(e).length), 20),
    80,
  );
  const boxWidth = maxWidth + 2;
  const top = dim(`  ┌${"─".repeat(boxWidth)}┐`);
  const bottom = dim(`  └${"─".repeat(boxWidth)}┘`);
  const side = dim("  │");
  const sideEnd = dim("│");

  lines.push("");
  lines.push(top);
  for (const entry of allEntries) {
    const visLen = stripAnsi(entry).length;
    const pad = Math.max(0, boxWidth - visLen);
    lines.push(`${side}${entry}${" ".repeat(pad)}${sideEnd}`);
  }
  lines.push(`${side}${" ".repeat(boxWidth)}${sideEnd}`);
  lines.push(bottom);

  return lines;
}

const MAX_VALUE_WIDTH = 60;

function truncateString(s: string, max: number): string {
  const firstLine = s.split("\n")[0];
  if (firstLine.length <= max) {
    return s.includes("\n") ? `${firstLine}${dim("...")}` : firstLine;
  }
  return `${firstLine.slice(0, max)}${dim("...")}`;
}

function formatAttributeEntries(
  key: string,
  value: unknown,
  keyPad: number,
  indent: string,
): string[] {
  if (value === null || value === undefined) {
    return [`${indent}${dim(key.padEnd(keyPad))}   ${dim("null")}`];
  }
  if (typeof value === "string") {
    return [
      `${indent}${dim(key.padEnd(keyPad))}   ${
        truncateString(value, MAX_VALUE_WIDTH)
      }`,
    ];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [`${indent}${dim(key.padEnd(keyPad))}   ${String(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}${dim(key.padEnd(keyPad))}   ${dim("[]")}`];
    }
    return [
      `${indent}${dim(key.padEnd(keyPad))}   ${dim(`${value.length} items`)}`,
    ];
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return [`${indent}${dim(key.padEnd(keyPad))}   ${dim("{}")}`];
    }
    return [
      `${indent}${dim(key.padEnd(keyPad))}   ${dim("object")}`,
    ];
  }
  return [
    `${indent}${dim(key.padEnd(keyPad))}   ${
      truncateString(String(value), MAX_VALUE_WIDTH)
    }`,
  ];
}

function stripAnsi(str: string): string {
  // deno-lint-ignore no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
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
