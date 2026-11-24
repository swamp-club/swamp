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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  DASHBOARD_THEME_DIR,
  DASHBOARD_THEMES_DIR,
  type DashboardTheme,
  DashboardThemeStore,
  serveDashboardTheme as serveTheme,
  THEME_SCAN_MAX_AGE_MS,
  themeCssProblem,
} from "./dashboard_theme.ts";

function tempRepo(): { path: string } & Disposable {
  const path = Deno.makeTempDirSync();
  return {
    path,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(path, { recursive: true });
      } catch (e) {
        if (Deno.build.os !== "windows") throw e;
      }
    },
  };
}

async function withThemeRepo(
  files: Record<string, string>,
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir();
  try {
    const dir = join(repoDir, DASHBOARD_THEME_DIR);
    await Deno.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, name), content);
    }
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(
      Deno.build.os === "windows" ? () => {} : (e) => {
        throw e;
      },
    );
  }
}

// the legacy single folder, read as one theme or its error
function loadDashboardThemes(repoDir: string) {
  return new DashboardThemeStore(repoDir).index();
}

function serveDashboardTheme(req: Request, repoDir: string) {
  return serveTheme(req, new DashboardThemeStore(repoDir));
}

async function loadOne(
  repoDir: string,
): Promise<{ theme: DashboardTheme | null } | { error: string }> {
  const store = new DashboardThemeStore(repoDir);
  const index = await store.index();
  if (index.errors.length > 0) return { error: index.errors[0].error };
  const id = index.themes[0]?.id;
  return { theme: id === undefined ? null : (await store.theme(id))!.theme };
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"/>`;

Deno.test("loadDashboardTheme: a repo without a theme has none", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    assertEquals(await loadOne(repoDir), { theme: null });
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("loadDashboardTheme: inlines the logo and keeps valid colours", async () => {
  await withThemeRepo({
    "theme.yaml":
      `name: Acme Ops\nlogo: logo.svg\ncolors:\n  light: { accent: "#4f46e5", sidebar-bg: "rgb(30 27 75)" }\n`,
    "logo.svg": SVG,
  }, async (repoDir) => {
    const result = await loadOne(repoDir);
    assert(!("error" in result));
    assertEquals(result.theme?.name, "Acme Ops");
    assert(result.theme?.logo?.startsWith("/dashboard-theme/assets/"));
    assertEquals(result.theme?.colors?.light, {
      accent: "#4f46e5",
      "sidebar-bg": "rgb(30 27 75)",
    });
  });
});

Deno.test("loadDashboardTheme: refuses a colour that would escape its declaration", async () => {
  await withThemeRepo({
    "theme.yaml":
      `colors:\n  light: { accent: "red; } body { background: url(https://x) }" }\n`,
  }, async (repoDir) => {
    const result = await loadOne(repoDir);
    assert("error" in result);
    assertStringIncludes(result.error, "colors.light.accent");
  });
});

Deno.test("loadDashboardTheme: refuses an unknown token and a file outside the folder", async () => {
  await withThemeRepo(
    { "theme.yaml": `colors:\n  light: { evil: "#fff" }\n` },
    async (repoDir) => {
      assert("error" in await loadOne(repoDir));
    },
  );
  await withThemeRepo(
    { "theme.yaml": `logo: ../../serve.yaml\n` },
    async (repoDir) => {
      const result = await loadOne(repoDir);
      assert("error" in result);
      assertStringIncludes(result.error, "inside the theme folder");
    },
  );
});

Deno.test("serveDashboardTheme: answers 304 to a matching etag and ignores other paths", async () => {
  await withThemeRepo({ "theme.yaml": "name: Acme\n" }, async (repoDir) => {
    const first = await serveDashboardTheme(
      new Request("http://x/dashboard-theme"),
      repoDir,
    );
    assertEquals(first?.status, 200);
    await first?.body?.cancel();
    const etag = first?.headers.get("etag") ?? "";
    const again = await serveDashboardTheme(
      new Request("http://x/dashboard-theme", {
        headers: { "if-none-match": etag },
      }),
      repoDir,
    );
    assertEquals(again?.status, 304);
    assertEquals(
      await serveDashboardTheme(new Request("http://x/other"), repoDir),
      null,
    );
  });
});

Deno.test("loadDashboardTheme: accepts on-accent and sidebar-text-muted", async () => {
  await withThemeRepo({
    "theme.yaml":
      `colors:\n  light: { on-accent: "#ffffff", sidebar-text-muted: "rgb(255 255 255 / 45%)" }\n`,
  }, async (repoDir) => {
    const result = await loadOne(repoDir);
    assert(!("error" in result));
    assertEquals(result.theme?.colors?.light?.["on-accent"], "#ffffff");
  });
});

Deno.test("themeCssProblem: allows restyling, refuses anything that fetches or scripts", () => {
  assertEquals(themeCssProblem(".card { border-width: 3px; }"), null);
  assertEquals(
    themeCssProblem('.app { background: url("data:image/png;base64,AAAA"); }'),
    null,
  );
  assert(themeCssProblem('@import "https://x/y.css";') !== null);
  assert(themeCssProblem(".a { background: url(https://x/p.png); }") !== null);
  assert(themeCssProblem(".a { background: url( '//x/p.png' ); }") !== null);
  assert(themeCssProblem(".a { width: expression(alert(1)); }") !== null);
});

Deno.test("loadDashboardTheme: serves theme.css and refuses one that fetches", async () => {
  await withThemeRepo({
    "theme.yaml": "name: Acme\nshape: { radius: 2 }\n",
    "theme.css": ".card { border-width: 2px; }",
  }, async (repoDir) => {
    const result = await loadOne(repoDir);
    assert(!("error" in result));
    assertEquals(result.theme?.css, ".card { border-width: 2px; }");
    assertEquals(result.theme?.shape, { radius: 2 });
  });
  await withThemeRepo({
    "theme.yaml": "name: Acme\n",
    "theme.css": ".a { background: url(https://evil.example/x) }",
  }, async (repoDir) => {
    const result = await loadOne(repoDir);
    assert("error" in result);
    assertStringIncludes(result.error, "theme.css");
  });
});

async function writeThemes(
  repoDir: string,
  themes: Record<string, string>,
): Promise<void> {
  for (const [id, yaml] of Object.entries(themes)) {
    const dir = join(repoDir, DASHBOARD_THEMES_DIR, id);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "theme.yaml"), yaml);
  }
}

Deno.test("loadDashboardThemes: lists named themes by label with no default unless one says so", async () => {
  using dir = tempRepo();
  await writeThemes(dir.path, {
    night: "label: Night game\nname: Derby\n",
    day: "label: Day game\nname: Derby\n",
  });
  const result = await loadDashboardThemes(dir.path);
  assertEquals(result.themes.map((t) => [t.id, t.label]), [
    ["day", "Day game"],
    ["night", "Night game"],
  ]);
  assertEquals(result.default, null);
  assertEquals(result.locked, false);
});

Deno.test("loadDashboardThemes: default and locked come from the theme marked default", async () => {
  using dir = tempRepo();
  await writeThemes(dir.path, {
    acme: "label: Acme\ndefault: true\nlocked: true\n",
    other: "label: Other\n",
  });
  const result = await loadDashboardThemes(dir.path);
  assertEquals(result.default, "acme");
  assertEquals(result.locked, true);
});

Deno.test("loadDashboardThemes: a lone theme is the default; a broken one is reported by id", async () => {
  using dir = tempRepo();
  await writeThemes(dir.path, { only: "label: Only\n" });
  assertEquals((await loadDashboardThemes(dir.path)).default, "only");
  await writeThemes(dir.path, {
    broken: "colors: { light: { accent: 'red; }' } }\n",
  });
  const result = await loadDashboardThemes(dir.path);
  assertEquals(result.themes.map((t) => t.id), ["only"]);
  assertEquals(result.errors.map((e) => e.id), ["broken"]);
  assertStringIncludes(result.errors[0].error, "dashboard-themes/broken");
});

Deno.test("DashboardThemeStore: unchanged themes are never rebuilt, and one edit rebuilds only that theme", async () => {
  using dir = tempRepo();
  await writeThemes(dir.path, {
    day: "label: Day\n",
    night: "label: Night\n",
  });
  let now = 0;
  const store = new DashboardThemeStore(dir.path, () => now);
  const first = await store.index();
  assertEquals(store.builds, 2);
  await store.version();
  await store.index();
  now += THEME_SCAN_MAX_AGE_MS;
  assertEquals(await store.version(), first.version);
  assertEquals(store.builds, 2);

  const nightYaml = join(dir.path, DASHBOARD_THEMES_DIR, "night", "theme.yaml");
  await Deno.writeTextFile(nightYaml, "label: Night game\n");
  await Deno.utime(nightYaml, 2_000_000_000, 2_000_000_000);
  now += THEME_SCAN_MAX_AGE_MS;
  const second = await store.index();
  assertEquals(store.builds, 3);
  const versions = (i: typeof first) =>
    Object.fromEntries(i.themes.map((t) => [t.id, t.version]));
  assertEquals(versions(second).day, versions(first).day);
  assert(versions(second).night !== versions(first).night);
  assert(second.version !== first.version);
});

Deno.test("DashboardThemeStore: within the scan age every caller shares one look at the folders", async () => {
  using dir = tempRepo();
  await writeThemes(dir.path, { day: "label: Day\n" });
  const store = new DashboardThemeStore(dir.path, () => 0);
  await Promise.all([store.version(), store.index(), store.version()]);
  await writeThemes(dir.path, { night: "label: Night\n" });
  assertEquals((await store.index()).themes.map((t) => t.id), ["day"]);
});

Deno.test("serveDashboardTheme: the index carries no theme bodies; a theme links its logo as an immutable asset", async () => {
  using dir = tempRepo();
  await writeThemes(dir.path, { acme: "name: Acme\nlogo: logo.svg\n" });
  await Deno.writeTextFile(
    join(dir.path, DASHBOARD_THEMES_DIR, "acme", "logo.svg"),
    SVG,
  );
  const store = new DashboardThemeStore(dir.path);
  const index = await (await serveTheme(
    new Request("http://x/dashboard-theme"),
    store,
  ))!.json();
  assertEquals(Object.keys(index.themes[0]).sort(), ["id", "label", "version"]);
  const theme = await (await serveTheme(
    new Request("http://x/dashboard-theme/acme"),
    store,
  ))!.json();
  assert(theme.logo.startsWith("/dashboard-theme/assets/"));
  const asset =
    (await serveTheme(new Request(`http://x${theme.logo}`), store))!;
  assertEquals(asset.headers.get("content-type"), "image/svg+xml");
  assertStringIncludes(asset.headers.get("cache-control") ?? "", "immutable");
  assertEquals(await asset.text(), SVG);
  const missing = await serveTheme(
    new Request("http://x/dashboard-theme/assets/" + "0".repeat(32) + ".svg"),
    store,
  );
  assertEquals(missing?.status, 404);
  await missing?.body?.cancel();
});

Deno.test("DashboardThemeStore: identical theme files on two instances give identical versions, whatever their modification times", async () => {
  using a = tempRepo();
  using b = tempRepo();
  const files = {
    night: "label: Night\nname: Derby\nlogo: logo.svg\n",
    day: "label: Day\n",
  };
  for (
    const [repo, when] of [[a.path, 1_700_000_000], [
      b.path,
      1_800_000_000,
    ]] as const
  ) {
    await writeThemes(repo, files);
    const logo = join(repo, DASHBOARD_THEMES_DIR, "night", "logo.svg");
    await Deno.writeTextFile(logo, SVG);
    for (const f of ["night/theme.yaml", "night/logo.svg", "day/theme.yaml"]) {
      await Deno.utime(join(repo, DASHBOARD_THEMES_DIR, f), when, when);
    }
  }
  const storeA = new DashboardThemeStore(a.path);
  const storeB = new DashboardThemeStore(b.path);
  assertEquals(await storeA.index(), await storeB.index());

  const etag = async (store: DashboardThemeStore, path: string) => {
    const res = (await serveTheme(new Request(`http://x${path}`), store))!;
    await res.body?.cancel();
    return res.headers.get("etag");
  };
  assertEquals(
    await etag(storeA, "/dashboard-theme/night"),
    await etag(storeB, "/dashboard-theme/night"),
  );

  let now = 0;
  const later = new DashboardThemeStore(b.path, () => now);
  const before = await later.index();
  await Deno.writeTextFile(
    join(b.path, DASHBOARD_THEMES_DIR, "day", "theme.yaml"),
    "label: Day game\n",
  );
  now += THEME_SCAN_MAX_AGE_MS;
  const after = await later.index();
  assert(after.version !== before.version);
  assertEquals(after.themes[1].version, before.themes[1].version);
});
