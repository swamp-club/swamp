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

import { parse as parseYaml } from "@std/yaml";
import { extname, isAbsolute, join, resolve, SEPARATOR } from "@std/path";
import { z } from "zod";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

/** Answered before sign-in, so the login page wears the theme too. */
export const DASHBOARD_THEME_PATH = "/dashboard-theme";

/** Relative to the repo, outside the ignored `.swamp/`: one folder per theme. */
export const DASHBOARD_THEMES_DIR = "dashboard-themes";

/** One unnamed theme, read as the theme `default`. */
export const DASHBOARD_THEME_DIR = "dashboard-theme";

const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_THEMES = 12;

/** The dashboard's colour tokens a theme may set (`--<name>` in styles.css). */
export const THEME_COLOR_TOKENS = [
  "bg",
  "surface",
  "surface-hover",
  "surface-inset",
  "sidebar-bg",
  "sidebar-text",
  "sidebar-text-active",
  "sidebar-hover",
  "sidebar-active",
  "sidebar-accent",
  "sidebar-text-muted",
  "text-1",
  "text-2",
  "text-3",
  "border",
  "border-subtle",
  "border-strong",
  "accent",
  "accent-hover",
  "accent-subtle",
  "on-accent",
  "success",
  "success-bg",
  "warning",
  "warning-bg",
  "danger",
  "danger-bg",
  "info",
  "info-bg",
  "running",
  "running-bg",
  "skel-shine",
  "cancelled",
  "cancelled-bg",
  "tile-idle",
  "chart-bar-1",
  "chart-bar-2",
  "chart-bar-3",
  "chart-bar-4",
  "chart-bar-5",
  "chart-grid",
  "chart-label",
] as const;

// A value lands in a generated stylesheet: no `;`, `{`, `}`, quotes or url().
const COLOR =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\([0-9a-zA-Z.,%\s/+-]*\)|var\(--[a-z0-9-]+\)|[a-zA-Z]+)$/;
const FONT_STACK = /^[A-Za-z0-9 ,"'_-]+$/;
const FONT_FAMILY = /^[A-Za-z0-9 _-]+$/;
const FONT_WEIGHT = /^\d{3}(?: \d{3})?$/;

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_FONT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_CSS_BYTES = 256 * 1024;

/**
 * Why a theme stylesheet is refused, or null. It may restyle the page but never
 * make it fetch anything: no @import, and url() only for data: URLs.
 */
export function themeCssProblem(css: string): string | null {
  // an escape can spell url( or @import past every check below
  if (css.includes("\\")) return "backslash escapes are not allowed";
  if (/@(import|namespace)/i.test(css)) {
    return "@import and @namespace are not allowed";
  }
  const fetching =
    /(?<![\w-])(-webkit-image-set|image-set|image|cross-fade|src|element)\s*\(/i
      .exec(css);
  if (fetching !== null) return `${fetching[1]}() is not allowed`;
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")\s]*)/gi)) {
    if (!/^data:/i.test(m[2])) return `url(${m[2]}) must be a data: URL`;
  }
  if (/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(css)) {
    return "scriptable CSS is not allowed";
  }
  return null;
}

const IMAGE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const FONT_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const Palette = z.partialRecord(
  z.enum(THEME_COLOR_TOKENS),
  z.string().max(120).regex(COLOR, "not a CSS colour"),
);

export const DashboardThemeFileSchema = z.strictObject({
  label: z.string().trim().min(1).max(40).optional(),
  default: z.boolean().optional(),
  locked: z.boolean().optional(),
  name: z.string().trim().min(1).max(40).optional(),
  logo: z.string().optional(),
  favicon: z.string().optional(),
  colors: z.strictObject({
    light: Palette.optional(),
    dark: Palette.optional(),
  }).optional(),
  shape: z.strictObject({
    radius: z.number().min(0).max(3).optional(),
  }).optional(),
  fonts: z.strictObject({
    body: z.string().max(200).regex(FONT_STACK).optional(),
    display: z.string().max(200).regex(FONT_STACK).optional(),
    mono: z.string().max(200).regex(FONT_STACK).optional(),
    files: z.array(z.strictObject({
      family: z.string().max(60).regex(FONT_FAMILY),
      src: z.string(),
      weight: z.string().regex(FONT_WEIGHT).optional(),
      style: z.enum(["normal", "italic"]).optional(),
    })).max(8).optional(),
  }).optional(),
});

export type DashboardThemeFile = z.infer<typeof DashboardThemeFileSchema>;

/** Logos and fonts are asset paths, not file contents. */
export interface DashboardTheme {
  readonly name?: string;
  readonly logo?: string;
  readonly favicon?: string;
  readonly colors?: DashboardThemeFile["colors"];
  readonly shape?: DashboardThemeFile["shape"];
  /** `theme.css` from the theme folder, laid over everything else */
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

/** No theme bodies: enough for the picker and for deciding what to fetch. */
export interface DashboardThemeIndex {
  /** changes whenever any theme file changes; the health stream carries it */
  readonly version: string;
  readonly themes: readonly {
    readonly id: string;
    readonly label: string;
    readonly version: string;
  }[];
  /** null shows swamp's own look until the viewer picks a theme */
  readonly default: string | null;
  /** the default theme forbids switching, so the picker is hidden */
  readonly locked: boolean;
  /** themes not served, by id; the page keeps any copy it already has */
  readonly errors: readonly { readonly id: string; readonly error: string }[];
}

export interface ThemeAsset {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly type: string;
}

const ASSET_PREFIX = `${DASHBOARD_THEME_PATH}/assets/`;
const ASSET_NAME = /^[0-9a-f]{32}\.[a-z0-9]{2,5}$/;

class ThemeError extends Error {}

const logger = getSwampLogger(["serve", "dashboard-theme"]);

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16);
}

async function storeFile(
  dir: string,
  path: string,
  types: Record<string, string>,
  maxBytes: number,
  budget: { left: number },
  assets: Map<string, ThemeAsset>,
): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new ThemeError(`${path}: must be a path inside the theme folder`);
  }
  const ext = extname(path).toLowerCase();
  const type = types[ext];
  if (type === undefined) {
    throw new ThemeError(
      `${path}: expected one of ${Object.keys(types).join(", ")}`,
    );
  }
  // a symlink must not reach outside the theme folder
  const root = await Deno.realPath(dir);
  let real: string;
  try {
    real = await Deno.realPath(resolve(dir, path));
  } catch {
    throw new ThemeError(`${path}: file not found`);
  }
  if (!real.startsWith(root + SEPARATOR)) {
    throw new ThemeError(`${path}: must be a path inside the theme folder`);
  }
  if (!(await Deno.stat(real)).isFile) {
    throw new ThemeError(`${path}: must be a file`);
  }
  const bytes = await Deno.readFile(real);
  if (bytes.length > maxBytes) {
    throw new ThemeError(`${path}: larger than ${maxBytes / 1024} KiB`);
  }
  budget.left -= bytes.length;
  if (budget.left < 0) {
    throw new ThemeError(
      `theme files total more than ${MAX_TOTAL_BYTES / 1024 / 1024} MiB`,
    );
  }
  const name = `${(await sha256Hex(bytes)).slice(0, 32)}${ext}`;
  assets.set(name, { bytes, type });
  return `${ASSET_PREFIX}${name}`;
}

/** A file of the theme folder that resolves inside it, so a link cannot serve another file. */
async function readContainedText(dir: string, name: string): Promise<string> {
  const root = await Deno.realPath(dir);
  const real = await Deno.realPath(join(dir, name));
  if (!real.startsWith(root + SEPARATOR)) {
    throw new ThemeError(`${name}: must be a file inside the theme folder`);
  }
  if (!(await Deno.stat(real)).isFile) {
    throw new ThemeError(`${name}: must be a file`);
  }
  return await Deno.readTextFile(real);
}

async function readThemeCss(dir: string): Promise<string | undefined> {
  let css: string;
  try {
    css = await readContainedText(dir, "theme.css");
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
  if (new TextEncoder().encode(css).length > MAX_CSS_BYTES) {
    throw new ThemeError(`theme.css: larger than ${MAX_CSS_BYTES / 1024} KiB`);
  }
  const problem = themeCssProblem(css);
  if (problem !== null) throw new ThemeError(`theme.css: ${problem}`);
  return css;
}

interface BuiltTheme {
  readonly label: string;
  readonly theme: DashboardTheme;
  readonly isDefault: boolean;
  readonly locked: boolean;
  readonly assets: Map<string, ThemeAsset>;
}

async function buildTheme(dir: string, id: string): Promise<BuiltTheme> {
  const text = await readContainedText(dir, "theme.yaml");
  const parsed = DashboardThemeFileSchema.safeParse(parseYaml(text) ?? {});
  if (!parsed.success) {
    throw new ThemeError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  const file = parsed.data;
  const css = await readThemeCss(dir);
  const budget = { left: MAX_TOTAL_BYTES };
  const assets = new Map<string, ThemeAsset>();
  const image = (p: string) =>
    storeFile(dir, p, IMAGE_TYPES, MAX_IMAGE_BYTES, budget, assets);
  const faces = file.fonts?.files === undefined ? undefined : await Promise
    .all(file.fonts.files.map(async (f) => ({
      family: f.family,
      src: await storeFile(
        dir,
        f.src,
        FONT_TYPES,
        MAX_FONT_BYTES,
        budget,
        assets,
      ),
      ...(f.weight ? { weight: f.weight } : {}),
      ...(f.style ? { style: f.style } : {}),
    })));
  const theme: DashboardTheme = {
    ...(file.name ? { name: file.name } : {}),
    ...(file.logo ? { logo: await image(file.logo) } : {}),
    ...(file.favicon ? { favicon: await image(file.favicon) } : {}),
    ...(file.colors ? { colors: file.colors } : {}),
    ...(file.shape ? { shape: file.shape } : {}),
    ...(css !== undefined ? { css } : {}),
    ...(file.fonts
      ? {
        fonts: {
          ...(file.fonts.body ? { body: file.fonts.body } : {}),
          ...(file.fonts.display ? { display: file.fonts.display } : {}),
          ...(file.fonts.mono ? { mono: file.fonts.mono } : {}),
          ...(faces ? { faces } : {}),
        },
      }
      : {}),
  };
  return {
    label: file.label ?? file.name ?? id,
    theme,
    isDefault: file.default === true,
    locked: file.locked === true,
    assets,
  };
}

// served before sign-in: no file snippets and no server paths
function themeErrorMessage(e: unknown): string {
  if (e instanceof ThemeError) return e.message;
  if (
    e instanceof SyntaxError || (e instanceof Error && e.name === "YAMLError")
  ) {
    return `theme.yaml: ${e.message.split("\n")[0]}`;
  }
  if (e instanceof Deno.errors.NotFound) return "a file it names is missing";
  return `could not be read (${e instanceof Error ? e.name : "error"})`;
}

/**
 * Every file's path, size and modification time, four folders deep; links are
 * not followed, so a broken one fails the build rather than hiding the theme.
 * Empty when the folder has no theme.yaml.
 */
async function folderFingerprint(dir: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (sub: string, depth: number) => {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(join(dir, sub))) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory) {
        if (depth < 4) await walk(rel, depth + 1);
        continue;
      }
      const info = await Deno.lstat(join(dir, rel));
      lines.push(`${rel}:${info.size}:${info.mtime?.getTime() ?? 0}`);
    }
  };
  try {
    await walk("", 0);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
  return lines.some((l) => l.startsWith("theme.yaml:")) ? lines.join("\n") : "";
}

/**
 * Named by what the page receives, never by file times: instances that check
 * out the same files at different moments must agree on every version.
 */
async function contentVersion(
  id: string,
  built: BuiltTheme | { readonly error: string },
): Promise<string> {
  if ("error" in built) return await shortHash(`${id}\nerror\n${built.error}`);
  return await shortHash(JSON.stringify([
    id,
    built.label,
    built.isDefault,
    built.locked,
    built.theme,
  ]));
}

interface CachedTheme {
  /** file paths, sizes and times: decides when to rebuild, on this instance only */
  readonly fingerprint: string;
  readonly version: string;
  readonly built: BuiltTheme | { readonly error: string };
}

interface Snapshot {
  readonly index: DashboardThemeIndex;
  readonly themes: ReadonlyMap<string, CachedTheme>;
  readonly assets: ReadonlyMap<string, ThemeAsset>;
}

export const THEME_SCAN_MAX_AGE_MS = 1000;

/**
 * A repo's themes, rebuilt only when a file in a theme folder changes. One
 * scan of the folders serves every caller for THEME_SCAN_MAX_AGE_MS.
 */
export class DashboardThemeStore {
  readonly #repoDir: string;
  readonly #now: () => number;
  #cache = new Map<string, CachedTheme>();
  #snapshot: Snapshot | null = null;
  #scannedAt = -Infinity;
  #scanning: Promise<Snapshot> | null = null;
  /** counted so a test can prove an unchanged theme is never rebuilt */
  builds = 0;

  constructor(repoDir: string, now: () => number = Date.now) {
    this.#repoDir = repoDir;
    this.#now = now;
  }

  async #isRealDir(path: string): Promise<boolean> {
    try {
      const info = await Deno.lstat(path);
      return info.isDirectory && !info.isSymlink;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return false;
      throw e;
    }
  }

  async #folders(): Promise<{ id: string; dir: string; where: string }[]> {
    const folders: { id: string; dir: string; where: string }[] = [];
    const root = join(this.#repoDir, DASHBOARD_THEMES_DIR);
    if (await this.#isRealDir(root)) {
      for await (const entry of Deno.readDir(root)) {
        if (entry.isDirectory && THEME_ID.test(entry.name)) {
          folders.push({
            id: entry.name,
            dir: join(root, entry.name),
            where: `${DASHBOARD_THEMES_DIR}/${entry.name}`,
          });
        }
      }
    }
    folders.sort((a, b) => a.id.localeCompare(b.id));
    const legacy = join(this.#repoDir, DASHBOARD_THEME_DIR);
    if (
      !folders.some((f) => f.id === "default") &&
      await this.#isRealDir(legacy)
    ) {
      folders.unshift({
        id: "default",
        dir: legacy,
        where: DASHBOARD_THEME_DIR,
      });
    }
    return folders;
  }

  async #scan(): Promise<Snapshot> {
    const next = new Map<string, CachedTheme>();
    let folders: { id: string; dir: string; where: string }[] = [];
    try {
      folders = await this.#folders();
    } catch (e) {
      logger.warn`Dashboard themes could not be listed: ${
        themeErrorMessage(e)
      }`;
    }
    for (const [n, { id, dir, where }] of folders.entries()) {
      if (n >= MAX_THEMES) {
        const error =
          `${where}: not served, a repo serves at most ${MAX_THEMES} themes`;
        next.set(id, {
          fingerprint: "",
          version: await contentVersion(id, { error }),
          built: { error },
        });
        continue;
      }
      const cached = this.#cache.get(id);
      let fingerprint = "";
      let built: CachedTheme["built"];
      try {
        fingerprint = await folderFingerprint(dir);
        if (fingerprint === "") continue;
        if (cached !== undefined && cached.fingerprint === fingerprint) {
          next.set(id, cached);
          continue;
        }
        built = await buildTheme(dir, id);
        this.builds++;
      } catch (e) {
        built = { error: `${where}: ${themeErrorMessage(e)}` };
      }
      if (
        "error" in built &&
        !(cached !== undefined && "error" in cached.built &&
          cached.built.error === built.error)
      ) {
        logger.warn`Dashboard theme ${id} not served: ${built.error}`;
      }
      next.set(id, {
        fingerprint,
        version: await contentVersion(id, built),
        built,
      });
    }
    this.#cache = next;
    return await this.#snapshotOf(next);
  }

  async #snapshotOf(themes: Map<string, CachedTheme>): Promise<Snapshot> {
    const good: [string, CachedTheme, BuiltTheme][] = [];
    const errors: { id: string; error: string }[] = [];
    const assets = new Map<string, ThemeAsset>();
    for (const [id, cached] of themes) {
      if ("error" in cached.built) {
        errors.push({ id, error: cached.built.error });
        continue;
      }
      good.push([id, cached, cached.built]);
      for (const [name, asset] of cached.built.assets) assets.set(name, asset);
    }
    const marked = good.filter(([, , b]) => b.isDefault);
    if (marked.length > 1) {
      errors.push({
        id: marked[1][0],
        error: `more than one theme says default: true (${
          marked.map(([id]) => id).join(", ")
        }); using ${marked[0][0]}`,
      });
    }
    const chosen = marked[0] ??
      (good.length === 1 && errors.length === 0 ? good[0] : undefined);
    const version = await shortHash(
      [...themes.values()].map((t) => t.version).join(","),
    );
    return {
      index: {
        version,
        themes: good.map(([id, cached, b]) => ({
          id,
          label: b.label,
          version: cached.version,
        })),
        default: chosen?.[0] ?? null,
        locked: chosen?.[2].locked === true,
        errors,
      },
      themes,
      assets,
    };
  }

  async #current(): Promise<Snapshot> {
    if (
      this.#snapshot !== null &&
      this.#now() - this.#scannedAt < THEME_SCAN_MAX_AGE_MS
    ) {
      return this.#snapshot;
    }
    this.#scanning ??= this.#scan().then((snapshot) => {
      this.#snapshot = snapshot;
      this.#scannedAt = this.#now();
      return snapshot;
    }).finally(() => {
      this.#scanning = null;
    });
    return await this.#scanning;
  }

  /** Undefined when the themes cannot be read, so a health snapshot never fails on them. */
  async version(): Promise<string | undefined> {
    try {
      return (await this.#current()).index.version;
    } catch (e) {
      logger.warn`Dashboard themes could not be read: ${themeErrorMessage(e)}`;
      return undefined;
    }
  }

  async index(): Promise<DashboardThemeIndex> {
    return (await this.#current()).index;
  }

  async theme(
    id: string,
  ): Promise<{ theme: DashboardTheme; version: string } | null> {
    const cached = (await this.#current()).themes.get(id);
    if (cached === undefined || "error" in cached.built) return null;
    return { theme: cached.built.theme, version: cached.version };
  }

  async asset(name: string): Promise<ThemeAsset | null> {
    return (await this.#current()).assets.get(name) ?? null;
  }
}

function jsonWithEtag(req: Request, body: unknown, version: string): Response {
  const etag = `"${version}"`;
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-cache",
    etag,
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(JSON.stringify(body), { headers });
}

export async function serveDashboardTheme(
  req: Request,
  store: DashboardThemeStore,
): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const path = new URL(req.url).pathname;
  if (path === DASHBOARD_THEME_PATH) {
    const index = await store.index();
    return jsonWithEtag(req, index, index.version);
  }
  if (!path.startsWith(`${DASHBOARD_THEME_PATH}/`)) return null;
  if (path.startsWith(ASSET_PREFIX)) {
    const name = path.slice(ASSET_PREFIX.length);
    const asset = ASSET_NAME.test(name) ? await store.asset(name) : null;
    if (asset === null) return new Response("Not found", { status: 404 });
    // the name is the content's hash, so it never changes
    return new Response(asset.bytes, {
      headers: {
        "content-type": asset.type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  const id = path.slice(DASHBOARD_THEME_PATH.length + 1);
  const found = THEME_ID.test(id) ? await store.theme(id) : null;
  if (found === null) return new Response("Not found", { status: 404 });
  return jsonWithEtag(req, found.theme, found.version);
}
