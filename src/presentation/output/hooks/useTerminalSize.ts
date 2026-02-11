// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

interface TerminalSize {
  width: number;
  height: number;
}

/**
 * Hook that returns current terminal dimensions and updates on resize.
 * Uses both event-based and polling approaches for reliability.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const getSize = (): TerminalSize => ({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  });

  const [size, setSize] = useState<TerminalSize>(getSize);

  useEffect(() => {
    if (!stdout) return;

    const updateSize = () => {
      const newSize = getSize();
      setSize((prev) => {
        // Only update if dimensions actually changed
        if (prev.width !== newSize.width || prev.height !== newSize.height) {
          return newSize;
        }
        return prev;
      });
    };

    // Listen to resize events
    stdout.on("resize", updateSize);

    // Poll as fallback (every 100ms)
    const interval = setInterval(updateSize, 100);

    return () => {
      stdout.off("resize", updateSize);
      clearInterval(interval);
    };
  }, [stdout]);

  return size;
}
