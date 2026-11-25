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

import {
  PAGE_WORKSPACE,
  serverPath,
  withLocalToken,
} from "../client/workspace_path.ts";
import { safeThemeCss } from "./theme_css.ts";
import {
  mergeThemes,
  pickerOptions,
  shownThemeId,
  STOCK_THEME,
  type ThemeList,
} from "./theme_choice.ts";

/** What `GET /dashboard-theme` answers; files arrive as data: URLs. */
export interface CustomTheme {
  readonly name?: string;
  readonly logo?: string;
  readonly favicon?: string;
  readonly colors?: {
    readonly light?: Readonly<Record<string, string>>;
    readonly dark?: Readonly<Record<string, string>>;
  };
  readonly shape?: { readonly radius?: number };
  readonly css?: string;
  readonly fonts?: {
    readonly body?: string;
    readonly display?: string;
    readonly mono?: string;
    readonly faces?: readonly {
      family: string;
      src: string;
      weight?: string;
      style?: string;
    }[];
  };
}

export const DEFAULT_BRAND_NAME = "Swamp";

// The server validates too; this page writes the stylesheet, so it checks again.
const TOKEN = /^[a-z0-9-]+$/;
const COLOR =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\([0-9a-zA-Z.,%\s/+-]*\)|var\(--[a-z0-9-]+\)|[a-zA-Z]+)$/;
const FONT_STACK = /^[A-Za-z0-9 ,"'_-]+$/;
const FONT_FAMILY = /^[A-Za-z0-9 _-]+$/;
// assets arrive as blob: URLs this page made from fetched theme files
const FONT_DATA = /^blob:[^\s"'()]+$/;
// an SVG arrives as a data: URL, which no browser opens as a page of this origin
const IMAGE_DATA =
  /^(?:blob:[^\s"'()]+|data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)$/;

function declarations(palette: Readonly<Record<string, string>> = {}): string {
  return Object.entries(palette)
    .filter(([k, v]) => TOKEN.test(k) && COLOR.test(v))
    .map(([k, v]) => `--${k}: ${v};`)
    .join(" ");
}

/** The stylesheet that lays a theme over the dashboard's own tokens. */
export function customThemeCss(theme: CustomTheme): string {
  const rules: string[] = [];
  for (const face of theme.fonts?.faces ?? []) {
    if (!FONT_FAMILY.test(face.family) || !FONT_DATA.test(face.src)) continue;
    const weight = face.weight && /^\d{3}(?: \d{3})?$/.test(face.weight)
      ? ` font-weight: ${face.weight};`
      : "";
    const style = face.style === "italic" ? " font-style: italic;" : "";
    rules.push(
      `@font-face { font-family: "${face.family}"; src: url("${face.src}");${weight}${style} font-display: swap; }`,
    );
  }
  const root: string[] = [declarations(theme.colors?.light)];
  const body = theme.fonts?.body;
  if (body && FONT_STACK.test(body)) root.push(`--font-body: ${body};`);
  const display = theme.fonts?.display;
  if (display && FONT_STACK.test(display)) {
    root.push(`--font-display: ${display};`);
  }
  const radius = theme.shape?.radius;
  if (typeof radius === "number" && radius >= 0 && radius <= 3) {
    root.push(`--radius-scale: ${radius};`);
  }
  const mono = theme.fonts?.mono;
  if (mono && FONT_STACK.test(mono)) root.push(`--font-mono: ${mono};`);
  const rootDecls = root.filter(Boolean).join(" ");
  if (rootDecls) rules.push(`:root { ${rootDecls} }`);
  const dark = declarations(theme.colors?.dark);
  if (dark) {
    // the same selectors as styles.css, so this sheet (inserted later) wins
    rules.push(
      `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }`,
      `[data-theme="dark"] { ${dark} }`,
    );
  }
  // last, so it can restyle anything the tokens cannot reach
  if (theme.css && safeThemeCss(theme.css)) rules.push(theme.css);
  return rules.join("\n");
}

let current: CustomTheme | null = null;
let list: ThemeList<string> | null = null;
let indexVersion: string | null = null;
let picker: ThemePicker = { options: [], value: STOCK_THEME };
const loaded = new Map<string, { version: string; theme: CustomTheme }>();
const listeners = new Set<() => void>();

/** What the sidebar's theme picker shows; no options hides it. */
export interface ThemePicker {
  readonly options: readonly { value: string; label: string }[];
  readonly value: string;
}

export function currentThemePicker(): ThemePicker {
  return picker;
}

export function currentCustomTheme(): CustomTheme | null {
  return current;
}

export function subscribeCustomTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The product name the page shows: the theme's, or Swamp. */
export function brandName(): string {
  return current?.name ?? DEFAULT_BRAND_NAME;
}

/** A theme image the page may show, or undefined. */
export function safeImage(src: string | undefined): string | undefined {
  return src !== undefined && IMAGE_DATA.test(src) ? src : undefined;
}

const STYLE_ID = "swamp-custom-theme";
let defaultFavicon: string | null = null;

function applyCustomTheme(theme: CustomTheme | null): void {
  current = theme;
  let style = document.getElementById(STYLE_ID);
  if (style === null) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  } else {
    // stays last in <head>, after any sheet loaded since
    document.head.appendChild(style);
  }
  style.textContent = theme === null ? "" : customThemeCss(theme);
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon !== null) {
    defaultFavicon ??= icon.href;
    icon.href = safeImage(theme?.favicon) ?? defaultFavicon;
  }
  if (document.title.includes(DEFAULT_BRAND_NAME) && theme?.name) {
    document.title = document.title.replaceAll(DEFAULT_BRAND_NAME, theme.name);
  }
  for (const listener of listeners) listener();
}

// per workspace: each local workspace serves its own repo's themes
const CHOICE_KEY = PAGE_WORKSPACE === null
  ? "swamp-dashboard-theme-choice"
  : `swamp-dashboard-theme-choice/w/${encodeURIComponent(PAGE_WORKSPACE)}`;

function readChoice(): string | null {
  try {
    return localStorage.getItem(CHOICE_KEY);
  } catch {
    return null;
  }
}

const ASSET_PATH = /^\/dashboard-theme\/assets\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/;
const assetUrls = new Map<string, Promise<string | undefined>>();

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * An asset as a blob: URL (an SVG as a data: URL). Fetched rather than linked so the local token can
 * go with it; the server marks assets immutable, so the browser caches them.
 */
function assetUrl(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || !ASSET_PATH.test(path)) {
    return Promise.resolve(undefined);
  }
  let url = assetUrls.get(path);
  if (url === undefined) {
    url = fetch(serverPath(path), {
      headers: withLocalToken(),
      signal: AbortSignal.timeout(10_000),
    }).then(async (res) => {
      if (!res.ok) return undefined;
      const blob = await res.blob();
      return path.endsWith(".svg")
        ? `data:image/svg+xml;base64,${await base64Of(blob)}`
        : URL.createObjectURL(blob);
    }).catch(() => undefined).then((made) => {
      // a failed fetch is tried again the next time the theme is shown
      if (made === undefined) assetUrls.delete(path);
      return made;
    });
    assetUrls.set(path, url);
  }
  return url;
}

/** The theme with its assets resolved, and whether every one of them loaded. */
async function withAssetUrls(
  theme: CustomTheme,
): Promise<{ theme: CustomTheme; complete: boolean }> {
  const [logo, favicon, faces] = await Promise.all([
    assetUrl(theme.logo),
    assetUrl(theme.favicon),
    Promise.all(
      (theme.fonts?.faces ?? []).map(async (face) => ({
        ...face,
        src: await assetUrl(face.src) ?? "",
      })),
    ),
  ]);
  const complete = (theme.logo === undefined || logo !== undefined) &&
    (theme.favicon === undefined || favicon !== undefined) &&
    faces.every((face) => face.src !== "");
  return {
    theme: {
      ...theme,
      logo,
      favicon,
      ...(theme.fonts ? { fonts: { ...theme.fonts, faces } } : {}),
    },
    complete,
  };
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(serverPath(path), {
    headers: withLocalToken(),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok ? await res.json() as T : null;
}

let showing = 0;
let shownId: string | null = null;

/** Shows the chosen theme, fetching it only when its version is new. */
async function show(): Promise<void> {
  if (list === null) return;
  const turn = ++showing;
  const id = shownThemeId(list, readChoice());
  picker = { options: pickerOptions(list), value: id ?? STOCK_THEME };
  if (id === null) {
    shownId = null;
    applyCustomTheme(null);
    return;
  }
  const wanted = list.themes.find((t) => t.id === id)?.theme;
  const have = loaded.get(id);
  if (have !== undefined) {
    shownId = id;
    applyCustomTheme(have.theme);
  }
  if (have !== undefined && have.version === wanted) return;
  const body = await fetchJson<CustomTheme>(
    `/dashboard-theme/${encodeURIComponent(id)}`,
  ).catch(() => null);
  // a newer pick or index arrived while this one loaded
  if (turn !== showing) return;
  if (body === null || wanted === undefined) {
    // the picker names the theme on screen, not the one that failed to load
    picker = { ...picker, value: shownId ?? STOCK_THEME };
    for (const listener of listeners) listener();
    return;
  }
  const { theme, complete } = await withAssetUrls(body);
  if (complete) loaded.set(id, { version: wanted, theme });
  if (turn !== showing) return;
  shownId = id;
  applyCustomTheme(theme);
}

interface ThemeIndex {
  readonly version: string;
  readonly themes: readonly { id: string; label: string; version: string }[];
  readonly default: string | null;
  readonly locked: boolean;
  readonly errors: readonly { id: string; error: string }[];
}

let indexing: Promise<void> | null = null;

function loadIndex(): Promise<void> {
  indexing ??= (async () => {
    try {
      const index = await fetchJson<ThemeIndex>("/dashboard-theme");
      if (index === null) return;
      indexVersion = index.version;
      for (const e of index.errors) console.warn(`[swamp theme] ${e.error}`);
      list = mergeThemes(list, {
        themes: index.themes.map((t) => ({
          id: t.id,
          label: t.label,
          theme: t.version,
        })),
        default: index.default,
        locked: index.locked,
        errors: index.errors,
      });
      await show();
    } catch {
      // no theme route (an older serve) or offline: keep what is shown
    } finally {
      indexing = null;
    }
  })();
  return indexing;
}

/** The viewer's pick, kept in this browser only. */
export function chooseTheme(id: string): void {
  try {
    localStorage.setItem(CHOICE_KEY, id);
  } catch {
    // storage blocked: the pick lasts for this page load only
  }
  show().catch(() => {});
}

/** Called with each health snapshot; refetches the index only when themes changed. */
export function noteThemeVersion(version: string | undefined): void {
  if (version === undefined || version === indexVersion) return;
  loadIndex().catch(() => {});
}

/**
 * Loads the theme index once, then again only when the health stream reports
 * a new theme version or the tab comes back into view.
 */
export function startCustomTheme(): () => void {
  loadIndex().catch(() => {});
  const onVisible = () => {
    if (document.visibilityState === "visible") loadIndex().catch(() => {});
  };
  document.addEventListener("visibilitychange", onVisible);
  const onStorage = (e: StorageEvent) => {
    if (e.key === CHOICE_KEY) show().catch(() => {});
  };
  globalThis.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    globalThis.removeEventListener("storage", onStorage);
  };
}
