// Builds platform 1 into ../dist/1: a production build at the root and a
// development build under dev/, for `swamp app dev`.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const platform = JSON.parse(readFileSync(join(here, "platform.json"), "utf8"));
const out = join(here, "..", "dist", String(platform.major));
const entriesDir = join(here, ".entries");
const sdk = join(here, "..", "..", "app-sdk");

// React ships CommonJS, so each named export is listed for an ES module
const COMMONJS = {
  "react": "react",
  "jsx-runtime": "react/jsx-runtime",
  "jsx-dev-runtime": "react/jsx-dev-runtime",
  "react-dom": "react-dom",
  "react-dom-client": "react-dom/client",
};
const ESM = {
  "d3-array": `export * from "d3-array";`,
  "d3-scale": `export * from "d3-scale";`,
  "d3-shape": `export * from "d3-shape";`,
  "d3-hierarchy": `export * from "d3-hierarchy";`,
  "d3-selection": `export * from "d3-selection";`,
  "d3-zoom": `export * from "d3-zoom";`,
  "d3-brush": `export * from "d3-brush";`,
  "d3-drag": `export * from "d3-drag";`,
  "d3-format": `export * from "d3-format";`,
  "d3-time-format": `export * from "d3-time-format";`,
  "d3-interpolate": `export * from "d3-interpolate";`,
  "d3-force": `export * from "d3-force";`,
  "sdk": `export * from ${JSON.stringify(join(sdk, "mod.ts"))};`,
  "sdk-react": `export * from ${JSON.stringify(join(sdk, "react.tsx"))};`,
  "ui": `export * from ${JSON.stringify(join(here, "ui", "index.ts"))};`,
};
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function writeEntries() {
  rmSync(entriesDir, { recursive: true, force: true });
  mkdirSync(entriesDir, { recursive: true });
  const input = {};
  for (const [name, specifier] of Object.entries(COMMONJS)) {
    const names = Object.keys(require(specifier))
      .filter((key) => key !== "default" && IDENTIFIER.test(key));
    writeFileSync(
      join(entriesDir, `${name}.js`),
      `import * as m from ${JSON.stringify(specifier)};\n` +
        `export const { ${names.join(", ")} } = m;\n` +
        `export default m.default ?? m;\n`,
    );
    input[name] = join(entriesDir, `${name}.js`);
  }
  for (const [name, source] of Object.entries(ESM)) {
    writeFileSync(join(entriesDir, `${name}.js`), `${source}\n`);
    input[name] = join(entriesDir, `${name}.js`);
  }
  input["ui-css"] = join(here, "ui.css");
  return input;
}

async function bundle(input, mode, outDir) {
  await build({
    configFile: false,
    root: here,
    logLevel: "warn",
    mode,
    // ui.css is served at /app-platform/<major>/ui.css, so its font URLs must be
    // relative to it; a root-absolute /assets/ points outside the platform and
    // outside an app's font-src.
    base: "./",
    plugins: [tailwindcss()],
    esbuild: { jsx: "automatic" },
    define: { "process.env.NODE_ENV": JSON.stringify(mode) },
    resolve: {
      // the SDK sits outside this folder; React always comes from here, once
      dedupe: ["react", "react-dom"],
      alias: [
        { find: /^@\//, replacement: `${join(here, "ui")}/` },
        { find: "@swamp-club/app-sdk/react", replacement: join(sdk, "react.tsx") },
      ],
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: mode === "production",
      target: "es2022",
      // an app's CSP allows fonts from the platform path only, never data: URIs
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      rollupOptions: {
        input,
        preserveEntrySignatures: "strict",
        // shadcn marks components "use client", a server-rendering hint
        onwarn(warning, warn) {
          if (
            warning.code === "MODULE_LEVEL_DIRECTIVE" ||
            warning.code === "SOURCEMAP_ERROR"
          ) return;
          warn(warning);
        },
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: (asset) =>
            asset.names?.[0] === "ui-css.css"
              ? "ui.css"
              : "assets/[name]-[hash][extname]",
        },
      },
    },
  });
  // the CSS entry leaves an empty module behind
  rmSync(join(outDir, "ui-css.js"), { force: true });
  assertCssStaysInPlatform(join(outDir, "ui.css"));
}

/**
 * An app's CSP allows fonts and images only under its own files and the
 * platform path. A root-absolute or data: URL in ui.css is blocked in every app.
 */
function assertCssStaysInPlatform(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const bad = [...css.matchAll(/url\(\s*["']?(\/|data:)[^)]*\)/g)].map((m) =>
    m[0].slice(0, 80)
  );
  if (bad.length > 0) {
    throw new Error(
      `${cssPath} has ${bad.length} URL(s) an app's CSP would block, e.g. ${bad[0]}`,
    );
  }
}

// the app's own @types/react answers for React, so one copy of its types exists
const APP_SUPPLIED_TYPES = new Set(["react", "react-dom", "scheduler", "csstype"]);
const SPECIFIERS =
  /(?:from\s+|import\(\s*|<reference\s+types=)["']([^"']+)["']/g;

function packageOf(specifier) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return { name, subpath: specifier.slice(name.length) };
}

function typesCondition(value) {
  if (typeof value === "string") return /\.d\.(c|m)?ts$/.test(value) ? value : null;
  if (value === null || typeof value !== "object") return null;
  for (const key of ["types", "import", "default", "require"]) {
    const found = typesCondition(value[key]);
    if (found !== null) return found;
  }
  return null;
}

function firstFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

function declarationFor(base) {
  const stem = base.replace(/\.(c|m)?js$/, "");
  return firstFile([
    `${stem}.d.ts`,
    `${stem}.d.mts`,
    `${stem}.d.cts`,
    base.endsWith(".d.ts") ? base : null,
    join(base, "index.d.ts"),
  ].filter(Boolean));
}

function resolveBare(specifier) {
  const { name, subpath } = packageOf(specifier);
  const root = join(here, "node_modules", name);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const key = subpath === "" ? "." : `.${subpath}`;
  const exported = pkg.exports && typeof pkg.exports === "object" &&
      !Array.isArray(pkg.exports)
    ? typesCondition(key in pkg.exports ? pkg.exports[key] : (key === "." ? pkg.exports : undefined))
    : null;
  if (exported !== null) return { name, file: join(root, exported) };
  if (subpath === "") {
    const declared = pkg.types ?? pkg.typings;
    const file = declared ? join(root, declared) : declarationFor(join(root, "index"));
    return file === null ? null : { name, file };
  }
  const file = declarationFor(join(root, subpath.slice(1)));
  return file === null ? null : { name, file };
}

/**
 * The declarations the kit's types reach, and nothing else, so an app's
 * type-checker sees radix's props without radix installed.
 */
function copyLibraryTypes(kitTypes) {
  const target = join(out, "types", "node_modules");
  const seen = new Set();
  const packages = new Set();
  const queue = filesUnder(kitTypes).filter((f) => f.endsWith(".d.ts"));
  while (queue.length > 0) {
    const file = queue.pop();
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIERS)) {
      const specifier = match[1];
      let found = null;
      let owner = null;
      if (specifier.startsWith(".")) {
        found = declarationFor(join(dirname(file), specifier));
      } else if (!specifier.startsWith("@/")) {
        const { name } = packageOf(specifier);
        if (APP_SUPPLIED_TYPES.has(name) || name.startsWith("@types/react")) {
          continue;
        }
        const resolved = resolveBare(specifier);
        if (resolved !== null) {
          found = resolved.file;
          owner = resolved.name;
        }
      }
      if (owner !== null) packages.add(owner);
      if (found !== null && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  const modules = join(here, "node_modules");
  for (const file of seen) {
    if (!file.startsWith(modules)) continue;
    const dest = join(target, relative(modules, file));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(file));
  }
  for (const name of packages) {
    const dest = join(target, name, "package.json");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(modules, name, "package.json")));
  }
}

/** The kit's emitted types keep the build's `@/` alias; an app needs paths. */
function relativizeKitTypes(kitTypes) {
  for (const file of filesUnder(kitTypes)) {
    if (!file.endsWith(".d.ts")) continue;
    const source = readFileSync(file, "utf8");
    const rewritten = source.replace(/(["'])@\/([^"']+)\1/g, (_, quote, path) => {
      let rel = relative(dirname(file), join(kitTypes, path)).split("\\").join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${quote}${rel}${quote}`;
    });
    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function manifest() {
  const lock = JSON.parse(readFileSync(join(here, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  const versions = {};
  for (const name of Object.keys(pkg.dependencies)) {
    versions[name] = lock.packages[`node_modules/${name}`].version;
  }
  const files = {};
  for (const path of filesUnder(out).sort()) {
    const rel = relative(out, path).split("\\").join("/");
    if (rel === "platform.json") continue;
    files[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return {
    major: platform.major,
    minor: platform.minor,
    version: `${platform.major}.${platform.minor}`,
    libraries: versions,
    files,
  };
}

const input = writeEntries();
await bundle(input, "production", out);
await bundle(input, "development", join(out, "dev"));
// node_modules/.bin/tsc is a shell shim Windows cannot spawn; node runs tsc itself
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", join(here, "tsconfig.types.json")],
  { stdio: "inherit" },
);
relativizeKitTypes(join(out, "types", "ui"));
copyLibraryTypes(join(out, "types", "ui"));
writeFileSync(
  join(out, "platform.json"),
  `${JSON.stringify(manifest(), null, 2)}\n`,
);
rmSync(entriesDir, { recursive: true, force: true });
console.log(`Built app platform ${platform.major}.${platform.minor} into ${out}`);
