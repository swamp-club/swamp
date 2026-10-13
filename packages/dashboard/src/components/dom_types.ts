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

// The few DOM APIs the run graph uses, typed structurally. Deno type-checks
// the dashboard's tests without the DOM library (adding it would change
// the server's global types in the same check), so components under test
// reach these through `asDom` instead of the DOM's own types.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

/** The element methods the graph calls. */
export interface DomElement {
  getBoundingClientRect(): Rect;
  addEventListener(
    type: "wheel",
    listener: (e: WheelLike) => void,
    options?: { passive?: boolean },
  ): void;
  removeEventListener(type: "wheel", listener: (e: WheelLike) => void): void;
  setPointerCapture?(pointerId: number): void;
  focus(options?: { preventScroll?: boolean }): void;
  closest(selector: string): unknown;
}

/** Views a React element ref or event target as a `DomElement`. */
export function asDom(el: unknown): DomElement {
  return el as DomElement;
}

interface ResizeObserverLike {
  observe(target: unknown): void;
  disconnect(): void;
}

type ResizeObserverCtor = new (
  callback: (
    entries: ReadonlyArray<{ contentRect: { width: number } }>,
  ) => void,
) => ResizeObserverLike;

/** The browser's ResizeObserver, when there is one. */
export function resizeObserverClass(): ResizeObserverCtor | undefined {
  return (globalThis as { ResizeObserver?: ResizeObserverCtor })
    .ResizeObserver;
}

interface HistoryLike {
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
}

/** The browser's History, when there is one. */
export function browserHistory(): HistoryLike | undefined {
  return (globalThis as { history?: HistoryLike }).history;
}
