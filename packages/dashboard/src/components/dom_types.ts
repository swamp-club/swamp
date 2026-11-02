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

// typed structurally because Deno type-checks dashboard tests without the DOM
// library; adding it would change the server's global types in the same check

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

export function resizeObserverClass(): ResizeObserverCtor | undefined {
  return (globalThis as { ResizeObserver?: ResizeObserverCtor })
    .ResizeObserver;
}

interface HistoryLike {
  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
}

export function browserHistory(): HistoryLike | undefined {
  return (globalThis as { history?: HistoryLike }).history;
}
