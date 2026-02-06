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
