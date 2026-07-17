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

/**
 * Reads current terminal dimensions. Prefers Deno.consoleSize() (TIOCGWINSZ
 * ioctl) which reliably reports the actual pane size in tmux, multiplexers,
 * and non-standard emulators. Falls back to Ink's stdout properties, then
 * to safe defaults.
 */
export function getTerminalDimensions(
  stdout: NodeJS.WriteStream | undefined,
): TerminalSize {
  try {
    const { columns, rows } = Deno.consoleSize();
    return { width: columns, height: rows };
  } catch {
    return {
      width: stdout?.columns ?? 80,
      height: stdout?.rows ?? 24,
    };
  }
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
