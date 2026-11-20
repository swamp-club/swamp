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

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { APP_PLATFORM_PREFIX, appResponseHeaders } from "./headers.ts";

/** The part of a Vite plugin used here; Vite is the app's dependency, not ours. */
interface SwampAppPlugin {
  name: string;
  enforce: "pre";
  config(
    config: { root?: string },
    env: { command: string },
  ): Record<string, unknown>;
  configResolved(
    config: { optimizeDeps: { include?: string[]; exclude?: string[] } },
  ): void;
  resolveId(id: string): { id: string; external: true } | null;
  transformIndexHtml(): {
    tag: string;
    attrs: Record<string, string>;
    injectTo: "head-prepend";
  }[];
  configureServer(server: {
    resolvedUrls?: { local: string[] } | null;
    middlewares: {
      use(
        handler: (
          req: IncomingMessage,
          res: ServerResponse,
          next: () => void,
        ) => void,
      ): void;
    };
  }): void;
}

const here = dirname(fileURLToPath(import.meta.url));

/** the frame's origin is opaque, so it is all Vite can be told to allow */
const SANDBOXED_ORIGIN = "null";

/** Each module swamp serves, by the specifier an app imports it as. */
export const PLATFORM_MODULES: Readonly<Record<string, string>> = {
  "react": "react.js",
  "react/jsx-runtime": "jsx-runtime.js",
  "react/jsx-dev-runtime": "jsx-dev-runtime.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  "@swamp-club/app-sdk": "sdk.js",
  "@swamp-club/app-sdk/react": "sdk-react.js",
  "@swamp-club/ui": "ui.js",
  "d3-array": "d3-array.js",
  "d3-scale": "d3-scale.js",
  "d3-shape": "d3-shape.js",
  "d3-hierarchy": "d3-hierarchy.js",
  "d3-selection": "d3-selection.js",
  "d3-zoom": "d3-zoom.js",
  "d3-brush": "d3-brush.js",
  "d3-drag": "d3-drag.js",
  "d3-format": "d3-format.js",
  "d3-time-format": "d3-time-format.js",
  "d3-interpolate": "d3-interpolate.js",
  "d3-force": "d3-force.js",
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

function contentTypeOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return CONTENT_TYPES[file.slice(dot)] ?? "application/octet-stream";
}

/** A dev build file `swamp app dev` copied in, for a `/app-platform/` request. */
function platformFile(root: string, url: string): string | null {
  const path = url.split("?")[0];
  if (!path.startsWith(APP_PLATFORM_PREFIX) || path.includes("..")) {
    return null;
  }
  const file = join(
    root,
    ".swamp-platform",
    "platform",
    ...path.slice(APP_PLATFORM_PREFIX.length).split("/"),
  );
  return existsSync(file) ? file : null;
}

/** The major in `app.yaml`'s `platform:`; 1 when it names none. */
export function platformMajor(appYaml: string): number {
  const match = /^platform:\s*["']?([1-9][0-9]*)/m.exec(appYaml);
  return match ? Number(match[1]) : 1;
}

function readMajor(root: string): number {
  try {
    return platformMajor(readFileSync(join(root, "app.yaml"), "utf8"));
  } catch {
    return 1;
  }
}

/** Platform modules load from swamp and the dev server sends serve's headers, so a save behaves like production. */
export function swampApp(): SwampAppPlugin {
  let major = 1;
  let dev = false;
  let root = process.cwd();
  let devServer: { resolvedUrls?: { local: string[] } | null } | null = null;
  // in dev the platform's development build is the copy `swamp app dev` wrote into the app
  const moduleUrl = (file: string) =>
    `${APP_PLATFORM_PREFIX}${major}/${dev ? "dev/" : ""}${file}`;

  return {
    name: "swamp-app",
    // ahead of Vite's resolver, which would bundle React from node_modules
    enforce: "pre",
    config(config, env) {
      root = config.root ?? process.cwd();
      major = readMajor(root);
      dev = env.command === "serve";
      const external = Object.keys(PLATFORM_MODULES);
      return {
        base: "./",
        build: {
          outDir: "dist",
          emptyOutDir: true,
          // font-src is the app's own path, so nothing may become a data: URI
          assetsInlineLimit: 0,
          // a platform module's id is already its URL on swamp
          rollupOptions: { makeAbsoluteExternalsRelative: false },
        },
        optimizeDeps: { exclude: external },
        resolve: {
          alias: {
            "@swamp-club/app-sdk/theme.css": join(here, "theme.css"),
            "@": join(root, "src"),
          },
        },
        server: {
          host: "127.0.0.1",
          cors: { origin: SANDBOXED_ORIGIN },
        },
      };
    },
    // the React plugin asks Vite to pre-bundle React, which the platform serves
    configResolved(config) {
      const deps = config.optimizeDeps;
      deps.include = (deps.include ?? []).filter((id) =>
        PLATFORM_MODULES[id] === undefined
      );
    },
    resolveId(id) {
      const file = PLATFORM_MODULES[id];
      if (file === undefined) return null;
      // Vite would look on disk for any import that is not a full URL; this server answers them instead
      const origin = devServer?.resolvedUrls?.local[0]?.replace(/\/$/, "") ??
        "";
      return { id: `${origin}${moduleUrl(file)}`, external: true };
    },
    transformIndexHtml() {
      return [{
        tag: "link",
        attrs: { rel: "stylesheet", href: moduleUrl("ui.css") },
        injectTo: "head-prepend",
      }];
    },
    configureServer(server) {
      devServer = server;
      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const host = req.headers.host ?? "127.0.0.1";
          const headers = appResponseHeaders({
            appBase: `${host}/`,
            contentType: "",
            dev: {
              hmrSocket: `ws://${host}`,
              platformBase: `${host}${APP_PLATFORM_PREFIX}`,
            },
          });
          for (const [name, value] of Object.entries(headers)) {
            if (name === "content-type") continue;
            res.setHeader(name, value);
          }
          const file = platformFile(root, req.url ?? "");
          if (file === null) {
            next();
            return;
          }
          res.setHeader("content-type", contentTypeOf(file));
          res.end(readFileSync(file));
        },
      );
    },
  };
}
