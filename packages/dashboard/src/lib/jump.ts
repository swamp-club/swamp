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

/** How long a jump waits for its target to render before giving up. */
export const JUMP_FRAMES = 30;

export function prefersReducedMotion(): boolean {
  const media = (globalThis as {
    matchMedia?: (query: string) => { matches: boolean };
  }).matchMedia;
  return media?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function scrollBehavior(reduce: boolean): ScrollBehavior {
  return reduce ? "auto" : "smooth";
}

/**
 * The scrollTop that shows a row of a scroll box below its sticky header, or
 * null when the row is already in full view. Offsets are the row's and the
 * box's tops in the same coordinates.
 */
export function revealScrollTop(
  view: { top: number; height: number; scrollTop: number; header: number },
  row: { top: number; height: number },
): number | null {
  const above = row.top - (view.top + view.header);
  const below = row.top + row.height - (view.top + view.height);
  if (above < 0) return Math.max(0, view.scrollTop + above);
  if (below > 0) return view.scrollTop + Math.min(below, above);
  return null;
}

/**
 * The scrollTop that centres a row in the part of a scroll box below its
 * sticky header. `offset` is the row's top within the scrolled content.
 */
export function centerScrollTop(
  view: { clientHeight: number; header: number },
  row: { offset: number; height: number },
): number {
  const room = view.clientHeight - view.header;
  return Math.max(
    0,
    Math.round(row.offset - view.header - (room - row.height) / 2),
  );
}

interface FrameApi {
  requestAnimationFrame(cb: () => void): number;
  cancelAnimationFrame(id: number): void;
}

const frames = globalThis as unknown as Partial<FrameApi>;

/**
 * Scrolls the element with `id` to the top of every box that holds it and
 * moves focus to it, once it has rendered. Returns a cancel for effects.
 */
export function jumpToId(id: string, attempts = JUMP_FRAMES): () => void {
  if (!frames.requestAnimationFrame || !frames.cancelAnimationFrame) {
    return () => {};
  }
  let handle = 0;
  let left = attempts;
  const tick = () => {
    const el = globalThis.document?.getElementById(id);
    if (!el) {
      if (--left > 0) handle = frames.requestAnimationFrame!(tick);
      return;
    }
    el.scrollIntoView({
      block: "start",
      behavior: scrollBehavior(prefersReducedMotion()),
    });
    el.focus({ preventScroll: true });
  };
  handle = frames.requestAnimationFrame(tick);
  return () => frames.cancelAnimationFrame!(handle);
}

/** The nearest ancestor that scrolls vertically. */
export function scrollParent(el: Element | null): HTMLElement | null {
  for (let at = el?.parentElement ?? null; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/** Where a set of scroll boxes stood, to return to after a jump. */
export interface Place {
  readonly boxes: ReadonlyArray<{ el: HTMLElement; top: number }>;
  readonly focus: HTMLElement | null;
}

export function placeOf(
  boxes: ReadonlyArray<HTMLElement | null>,
): Place {
  const active = globalThis.document?.activeElement;
  return {
    boxes: boxes.filter((b): b is HTMLElement => b !== null).map((el) => ({
      el,
      top: el.scrollTop,
    })),
    focus: active instanceof HTMLElement ? active : null,
  };
}

export function returnTo(place: Place): void {
  for (const { el, top } of place.boxes) el.scrollTop = top;
  if (place.focus?.isConnected) place.focus.focus({ preventScroll: true });
}
