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

import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  width: number;
  height: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * A dimension is usable only when it is a positive number. A pty can report
 * `0` columns and rows — `script` with no attached window does, as do some CI
 * runners — and `Deno.consoleSize()` returns that zero rather than throwing,
 * so "did not throw" is not on its own evidence of a usable size. Zero also
 * survives `??`, so it has to be rejected explicitly rather than defaulted.
 */
function usable(dimension: number | undefined): number | undefined {
  return typeof dimension === "number" && dimension > 0 ? dimension : undefined;
}

/** Reads the console size, throwing when no console is attached. */
export type ConsoleSizeProbe = () => { columns: number; rows: number };

/**
 * Reads current terminal dimensions. Prefers Deno.consoleSize() (TIOCGWINSZ
 * ioctl) which reliably reports the actual pane size in tmux, multiplexers,
 * and non-standard emulators. Falls back to Ink's stdout properties, then
 * to safe defaults.
 *
 * `consoleSize` is injectable so each branch can be selected explicitly.
 * Which branch runs otherwise depends on whether the process happens to have
 * a console attached, which makes a caller — a test above all — behave
 * differently in a terminal than under a pipe.
 */
export function getTerminalDimensions(
  stdout: NodeJS.WriteStream | undefined,
  consoleSize: ConsoleSizeProbe = () => Deno.consoleSize(),
): TerminalSize {
  try {
    const { columns, rows } = consoleSize();
    const width = usable(columns);
    const height = usable(rows);
    if (width !== undefined && height !== undefined) return { width, height };
  } catch {
    // No console attached — fall through to stdout, then to the defaults.
  }
  return {
    width: usable(stdout?.columns) ?? DEFAULT_COLUMNS,
    height: usable(stdout?.rows) ?? DEFAULT_ROWS,
  };
}

/**
 * Hook that returns current terminal dimensions and updates on resize.
 * Uses both event-based and polling approaches for reliability.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const [size, setSize] = useState<TerminalSize>(() =>
    getTerminalDimensions(stdout)
  );

  useEffect(() => {
    if (!stdout) return;

    const updateSize = () => {
      const newSize = getTerminalDimensions(stdout);
      setSize((prev) => {
        if (prev.width !== newSize.width || prev.height !== newSize.height) {
          return newSize;
        }
        return prev;
      });
    };

    stdout.on("resize", updateSize);
    const interval = setInterval(updateSize, 500);

    return () => {
      stdout.off("resize", updateSize);
      clearInterval(interval);
    };
  }, [stdout]);

  return size;
}
