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

/**
 * The registries the dependency input vectors resolve against, offline: one
 * localhost server on a free port is the npm registry Deno reads
 * (`NPM_CONFIG_REGISTRY`), the JSR registry (`JSR_URL`) and the host of URL
 * imports, and {@link VectorRegistry.fetcher} answers swamp's own registry,
 * download and OSV lookups from the same packages, as the dependency audit
 * makes them. Every package is built in memory, so its integrity is known
 * and a vector's lockfile can name it through a placeholder
 * ({@link VectorRegistry.substitute}).
 */

import { TarStream } from "@std/tar/tar-stream";

/** An npm package version the registry serves. */
interface NpmVersion {
  name: string;
  version: string;
  code: string;
}

/** A JSR package version the registry serves: one `mod.ts`. */
interface JsrVersion {
  scope: string;
  name: string;
  version: string;
  code: string;
}

const NPM_PACKAGES: readonly NpmVersion[] = [
  {
    name: "vecpkg",
    version: "1.0.0",
    code: 'export default "vecpkg@1.0.0";\n',
  },
  {
    name: "vecpkg",
    version: "1.1.0",
    code: 'export default "vecpkg@1.1.0";\n',
  },
  { name: "zod", version: "3.23.0", code: "export const z = {};\n" },
  { name: "zod", version: "4.1.0", code: "export const z = {};\n" },
];

const NPM_LATEST: Record<string, string> = {
  vecpkg: "1.1.0",
  zod: "4.1.0",
};

const JSR_PACKAGES: readonly JsrVersion[] = [
  {
    scope: "vec",
    name: "lib",
    version: "1.0.0",
    code: 'export const lib = "@vec/lib@1.0.0";\n',
  },
  {
    scope: "vec",
    name: "lib",
    version: "1.1.0",
    code: 'export const lib = "@vec/lib@1.1.0";\n',
  },
];

const JSR_LATEST: Record<string, string> = { "@vec/lib": "1.1.0" };

/** The module a URL import fetches. */
const URL_MODULE = "export const remote = 1;\n";

/** The npm-style tarball of one package version, gzipped. */
async function npmTarball(
  pkg: NpmVersion,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  // A fixed mtime, so a tarball, and its integrity, is the same each run.
  const entry = (path: string, text: string) => {
    const bytes = encoder.encode(text);
    return {
      type: "file" as const,
      path,
      size: bytes.length,
      options: { mtime: 0 },
      readable: ReadableStream.from([bytes]),
    };
  };
  return new Uint8Array(
    await new Response(
      ReadableStream.from([
        entry(
          "package/package.json",
          JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            type: "module",
            main: "index.js",
          }),
        ),
        entry("package/index.js", pkg.code),
      ]).pipeThrough(new TarStream()).pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}

async function sha(
  algorithm: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * npm's metadata for `name`, as Deno reads it from the server (`forSwamp`
 * false: each version's tarball and integrity) or as the dependency audit
 * reads it from registry.npmjs.org; undefined for a package not served.
 */
function npmPackument(
  name: string,
  forSwamp: boolean,
  origin: string,
  integrity: ReadonlyMap<string, string>,
) {
  const versions = NPM_PACKAGES.filter((p) => p.name === name);
  if (versions.length === 0) return undefined;
  // Deno refuses a version younger than its minimum dependency age, and
  // the audit flags one older than two years: each reader gets a date it
  // accepts.
  const published = forSwamp
    ? new Date().toISOString()
    : "2020-01-01T00:00:00.000Z";
  return {
    name,
    "dist-tags": { latest: NPM_LATEST[name] },
    versions: Object.fromEntries(versions.map((p) => {
      const id = `${p.name}@${p.version}`;
      return [p.version, {
        name: p.name,
        version: p.version,
        license: "MIT",
        maintainers: [{ name: "vectors" }],
        ...(forSwamp ? {} : {
          dist: {
            tarball: `${origin}/${p.name}/-/${p.name}-${p.version}.tgz`,
            integrity: integrity.get(id),
          },
        }),
      }];
    })),
    time: Object.fromEntries(versions.map((p) => [p.version, published])),
  };
}

/** JSR's package metadata for `@scope/name`; undefined when not served. */
function jsrMeta(scopedName: string) {
  const versions = JSR_PACKAGES.filter((p) =>
    `@${p.scope}/${p.name}` === scopedName
  );
  if (versions.length === 0) return undefined;
  return {
    scope: versions[0].scope,
    name: versions[0].name,
    latest: JSR_LATEST[scopedName],
    versions: Object.fromEntries(
      versions.map((p) => [p.version, {
        createdAt: "2020-01-01T00:00:00.000Z",
      }]),
    ),
  };
}

/**
 * swamp's registry, download and OSV lookups, answered from the vectors'
 * packages: the fetcher the dependency audit is given.
 */
export function vectorFetcher(): (
  input: string | URL | Request,
) => Promise<Response> {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = decodeURIComponent(url.pathname);
    if (url.host === "registry.npmjs.org") {
      const packument = npmPackument(path.slice(1), true, "", new Map());
      return Promise.resolve(
        packument
          ? Response.json(packument)
          : new Response("not found", { status: 404 }),
      );
    }
    if (url.host === "api.npmjs.org") {
      return Promise.resolve(Response.json({ downloads: 1_000_000 }));
    }
    if (url.host === "api.osv.dev") {
      return Promise.resolve(Response.json({ vulns: [] }));
    }
    if (url.host === "jsr.io") {
      const meta = jsrMeta(path.slice(1).replace(/\/meta\.json$/, ""));
      return Promise.resolve(
        meta ? Response.json(meta) : new Response("not found", { status: 404 }),
      );
    }
    return Promise.reject(new Error(`unexpected lookup of ${url.href}`));
  };
}

/** The running registries and what a vector's files may name of them. */
export interface VectorRegistry {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  origin: string;
  /** The environment that points Deno at the registries. */
  env: Record<string, string>;
  /** swamp's registry lookups, answered from the same packages. */
  fetcher: ReturnType<typeof vectorFetcher>;
  /**
   * `text` with each placeholder replaced: `{{ORIGIN}}`, `{{INTEGRITY
   * <name>@<version>}}` (an npm tarball's sha512 integrity) and
   * `{{JSR_INTEGRITY @<scope>/<name>@<version>}}` (a JSR version
   * manifest's sha256, as deno.lock records it).
   */
  substitute(text: string): string;
  /** `text` with the origin written back as `{{ORIGIN}}`. */
  generalize(text: string): string;
  shutdown(): Promise<void>;
}

/** Starts the registries; `shutdown` stops them. */
export async function startVectorRegistry(): Promise<VectorRegistry> {
  const tarballs = new Map<string, Uint8Array<ArrayBuffer>>();
  const integrity = new Map<string, string>();
  for (const pkg of NPM_PACKAGES) {
    const id = `${pkg.name}@${pkg.version}`;
    const tarball = await npmTarball(pkg);
    tarballs.set(id, tarball);
    integrity.set(id, `sha512-${encodeBase64(await sha("SHA-512", tarball))}`);
  }

  // JSR's version manifest names each file with its sha256; deno.lock
  // records the sha256 of the manifest itself.
  const jsrVersionMeta = new Map<string, string>();
  const jsrIntegrity = new Map<string, string>();
  for (const pkg of JSR_PACKAGES) {
    const id = `@${pkg.scope}/${pkg.name}@${pkg.version}`;
    const code = new TextEncoder().encode(pkg.code);
    const meta = JSON.stringify({
      manifest: {
        "/mod.ts": {
          size: code.length,
          checksum: `sha256-${encodeHex(await sha("SHA-256", code))}`,
        },
      },
      exports: { ".": "./mod.ts" },
    });
    jsrVersionMeta.set(id, meta);
    jsrIntegrity.set(
      id,
      encodeHex(await sha("SHA-256", new TextEncoder().encode(meta))),
    );
  }

  let origin = "";
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const tgz = /^\/(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(path);
    if (tgz) {
      const tarball = tarballs.get(`${tgz[1]}@${tgz[2]}`);
      if (tarball) return new Response(tarball);
    }
    if (path === "/url/mod.ts") {
      return new Response(URL_MODULE, {
        headers: { "content-type": "application/typescript" },
      });
    }
    const jsr = /^\/(@[^/]+\/[^/]+)\/(.+)$/.exec(path);
    if (jsr) {
      const [, scopedName, rest] = jsr;
      if (rest === "meta.json") {
        const meta = jsrMeta(scopedName);
        if (meta) return Response.json(meta);
      }
      const versionMeta = /^(.+)_meta\.json$/.exec(rest);
      if (versionMeta) {
        const meta = jsrVersionMeta.get(`${scopedName}@${versionMeta[1]}`);
        if (meta) {
          return new Response(meta, {
            headers: { "content-type": "application/json" },
          });
        }
      }
      const file = /^([^/]+)\/mod\.ts$/.exec(rest);
      if (file) {
        const pkg = JSR_PACKAGES.find((p) =>
          `@${p.scope}/${p.name}` === scopedName && p.version === file[1]
        );
        if (pkg) {
          return new Response(pkg.code, {
            headers: { "content-type": "application/typescript" },
          });
        }
      }
    }
    const packument = npmPackument(path.slice(1), false, origin, integrity);
    if (packument) return Response.json(packument);
    return new Response("not found", { status: 404 });
  });
  origin = `http://127.0.0.1:${server.addr.port}`;

  return {
    origin,
    env: {
      NPM_CONFIG_REGISTRY: `${origin}/`,
      JSR_URL: `${origin}/`,
    },
    fetcher: vectorFetcher(),
    substitute: (text) =>
      text
        .replaceAll("{{ORIGIN}}", origin)
        .replace(
          /\{\{INTEGRITY ([^}]+)\}\}/g,
          (_, id: string) => integrity.get(id) ?? `<no package ${id}>`,
        )
        .replace(
          /\{\{JSR_INTEGRITY ([^}]+)\}\}/g,
          (_, id: string) => jsrIntegrity.get(id) ?? `<no package ${id}>`,
        ),
    generalize: (text) => text.replaceAll(origin, "{{ORIGIN}}"),
    shutdown: () => server.shutdown(),
  };
}
