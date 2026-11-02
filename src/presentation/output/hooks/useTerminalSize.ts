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
 * a pty can report 0 columns and rows and Deno.consoleSize() returns that zero
 * rather than throwing; zero survives ??, so it is rejected explicitly.
 */
function usable(dimension: number | undefined): number | undefined {
  return typeof dimension === "number" && dimension > 0 ? dimension : undefined;
}

export type ConsoleSizeProbe = () => { columns: number; rows: number };

/**
 * prefers Deno.consoleSize(), which reports the real pane size in multiplexers,
 * then Ink's stdout, then defaults. consoleSize is injectable so callers do not
 * depend on whether a console is attached.
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
