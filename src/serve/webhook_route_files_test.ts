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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { WebhookEndpoint } from "./webhook.ts";
import {
  checkRouteFiles,
  checkWebhookRoutesDir,
  loadWebhookRouteFiles,
  mergeWebhookRoutes,
  parseRouteFiles,
  shadowedRouteFileMessage,
  webhookRouteSourceLabel,
} from "./webhook_route_files.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

const VALID =
  'route: /hooks/push\nworkflow: deploy\nsecret: "@vault=hooks:push"\n';

function endpoint(
  route: string,
  extra: Partial<WebhookEndpoint> = {},
): WebhookEndpoint {
  return {
    route,
    workflowIdOrName: "deploy",
    secret: "s",
    verifier: { scheme: "github" },
    ...extra,
  };
}

Deno.test("loadWebhookRouteFiles: a missing directory is zero routes", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await loadWebhookRouteFiles(join(dir, "absent")), {
      files: [],
      refused: [],
    });
  });
});

Deno.test("loadWebhookRouteFiles: loads one route per yaml file in name order", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "b.yml"), VALID.replace("push", "b"));
    await Deno.writeTextFile(join(dir, "a.yaml"), VALID);

    const load = await loadWebhookRouteFiles(dir);

    assertEquals(load.refused, []);
    assertEquals(load.files.map((f) => [f.file, f.entry.route]), [
      ["a.yaml", "/hooks/push"],
      ["b.yml", "/hooks/b"],
    ]);
  });
});

Deno.test("loadWebhookRouteFiles: ignores dotfiles, other extensions and subdirectories", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, ".hidden.yaml"), VALID);
    await Deno.writeTextFile(join(dir, "README.md"), "# routes");
    await Deno.mkdir(join(dir, "nested.yaml"));
    await Deno.writeTextFile(join(dir, "nested.yaml", "x.yaml"), VALID);

    assertEquals(await loadWebhookRouteFiles(dir), { files: [], refused: [] });
  });
});

Deno.test("loadWebhookRouteFiles: refuses literal, env and file secrets naming the file and route", async () => {
  await withTempDir(async (dir) => {
    const secrets = {
      "lit.yaml": "s3cret",
      "env.yaml": "@env=X",
      "file.yaml": "@file=/etc/x",
    };
    for (const [name, secret] of Object.entries(secrets)) {
      await Deno.writeTextFile(
        join(dir, name),
        `route: /hooks/${
          name.split(".")[0]
        }\nworkflow: deploy\nsecret: "${secret}"\n`,
      );
    }

    const load = await loadWebhookRouteFiles(dir);

    assertEquals(load.files, []);
    assertEquals(load.refused.map((r) => [r.file, r.route]), [
      ["env.yaml", "/hooks/env"],
      ["file.yaml", "/hooks/file"],
      ["lit.yaml", "/hooks/lit"],
    ]);
    for (const refused of load.refused) {
      assertStringIncludes(
        refused.message,
        `webhook route file ${refused.file}`,
      );
      assertStringIncludes(refused.message, `(route ${refused.route})`);
      assertStringIncludes(refused.message, "vault reference");
    }
  });
});

Deno.test("loadWebhookRouteFiles: refuses a route outside the stricter file-route rule", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "legacy.yaml"),
      VALID.replace("/hooks/push", "/deploy"),
    );

    const [refused] = (await loadWebhookRouteFiles(dir)).refused;

    assertStringIncludes(refused.message, "not under /hooks/");
  });
});

Deno.test("loadWebhookRouteFiles: refuses unknown keys, bad fields and non-mappings", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "extra.yaml"), VALID + "inputs: {}\n");
    await Deno.writeTextFile(
      join(dir, "noworkflow.yaml"),
      'route: /hooks/a\nsecret: "@vault=v:k"\n',
    );
    await Deno.writeTextFile(
      join(dir, "list.yaml"),
      "- /hooks/a\n- /hooks/b\n",
    );
    await Deno.writeTextFile(join(dir, "broken.yaml"), "route: [\n");

    const messages = Object.fromEntries(
      (await loadWebhookRouteFiles(dir)).refused.map((
        r,
      ) => [r.file, r.message]),
    );

    assertStringIncludes(messages["extra.yaml"], "unknown key 'inputs'");
    assertStringIncludes(
      messages["noworkflow.yaml"],
      "Refused webhook route file noworkflow.yaml (route /hooks/a): workflow is required",
    );
    assertStringIncludes(messages["list.yaml"], "one YAML mapping");
    assertStringIncludes(messages["broken.yaml"], "not readable YAML");
  });
});

Deno.test("loadWebhookRouteFiles: two files claiming one route are both refused, each naming the other", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.yaml"), VALID);
    await Deno.writeTextFile(join(dir, "b.yaml"), VALID);
    await Deno.writeTextFile(join(dir, "c.yaml"), VALID.replace("push", "c"));

    const load = await loadWebhookRouteFiles(dir);

    assertEquals(load.files.map((f) => f.file), ["c.yaml"]);
    assertEquals(load.refused.map((r) => r.file), ["a.yaml", "b.yaml"]);
    assertStringIncludes(
      load.refused[0].message,
      "b.yaml also claims this route",
    );
    assertStringIncludes(
      load.refused[1].message,
      "a.yaml also claims this route",
    );
  });
});

Deno.test({
  name:
    "loadWebhookRouteFiles: refuses a symlink whose target leaves the directory",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const dir = join(root, "routes");
      await Deno.mkdir(dir);
      await Deno.writeTextFile(join(root, "outside.yaml"), VALID);
      await Deno.writeTextFile(join(dir, "inside-target.yaml.txt"), VALID);
      await Deno.symlink(join(root, "outside.yaml"), join(dir, "out.yaml"), {
        type: "file",
      });
      await Deno.symlink(
        join(dir, "inside-target.yaml.txt"),
        join(dir, "in.yaml"),
        { type: "file" },
      );

      const load = await loadWebhookRouteFiles(dir);

      assertEquals(load.files.map((f) => f.file), ["in.yaml"]);
      assertEquals(load.refused.map((r) => r.file), ["out.yaml"]);
      assertStringIncludes(
        load.refused[0].message,
        "outside the routes directory",
      );
    });
  },
});

Deno.test({
  name: "loadWebhookRouteFiles: an unreadable directory throws",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const notADir = join(root, "routes");
      await Deno.writeTextFile(notADir, "");
      await assertRejects(
        () => loadWebhookRouteFiles(notADir),
        Error,
        "Failed to read webhook routes directory",
      );
    });
  },
});

Deno.test("parseRouteFiles: tags file routes and refuses only the file that fails to parse", async () => {
  const files = [
    {
      file: "a.yaml",
      entry: { route: "/hooks/a", workflow: "w", secret: "@vault=v:a" },
    },
    {
      file: "b.yaml",
      entry: { route: "/hooks/b", workflow: "w", secret: "@vault=v:b" },
    },
  ];

  const result = await parseRouteFiles(
    files,
    (configs) =>
      configs[0].route === "/hooks/a"
        ? Promise.reject(
          new Error("Vault 'v' returned an empty value for key 'a'"),
        )
        : Promise.resolve([endpoint(configs[0].route)]),
  );

  assertEquals(
    result.endpoints.map((e) => [e.route, e.source, e.file]),
    [["/hooks/b", "file", "b.yaml"]],
  );
  assertEquals(result.refused.map((r) => r.message), [
    "Refused webhook route file a.yaml (route /hooks/a): Vault 'v' returned an empty value for key 'a'",
  ]);
});

Deno.test("mergeWebhookRoutes: an operator route wins and the file route is shadowed", () => {
  const { endpoints, shadowed } = mergeWebhookRoutes(
    [
      endpoint("/hooks/a", { source: "flag" }),
      endpoint("/hooks/b", { source: "config" }),
    ],
    [
      endpoint("/hooks/a", { source: "file", file: "a.yaml" }),
      endpoint("/hooks/b", { source: "file", file: "b.yaml" }),
      endpoint("/hooks/c", { source: "file", file: "c.yaml" }),
    ],
  );

  assertEquals(endpoints.map((e) => [e.route, e.source]), [
    ["/hooks/a", "flag"],
    ["/hooks/b", "config"],
    ["/hooks/c", "file"],
  ]);
  assertEquals(shadowed, [
    { file: "a.yaml", route: "/hooks/a", by: "flag" },
    { file: "b.yaml", route: "/hooks/b", by: "config" },
  ]);
  assertStringIncludes(
    shadowedRouteFileMessage(shadowed[0]),
    "a --webhook flag",
  );
});

Deno.test("webhookRouteSourceLabel: renders a file route as file:<name>", () => {
  assertEquals(
    webhookRouteSourceLabel({ source: "file", file: "a.yaml" }),
    "file:a.yaml",
  );
  assertEquals(webhookRouteSourceLabel({ source: "flag" }), "flag");
  assertEquals(webhookRouteSourceLabel({}), "config");
});

Deno.test("checkWebhookRoutesDir: refuses a directory that is or sits inside an extension directory", async () => {
  await withTempDir(async (root) => {
    const extensions = join(root, "extensions");
    await Deno.mkdir(join(extensions, "webhooks"), { recursive: true });

    for (
      const dir of [
        extensions,
        join(extensions, "webhooks"),
        join(extensions, "webhooks", "routes"),
      ]
    ) {
      await assertRejects(
        () => checkWebhookRoutesDir(dir, [extensions]),
        Error,
        "holds extension code",
      );
    }
    await checkWebhookRoutesDir(join(root, "webhook-routes"), [extensions]);
    await checkWebhookRoutesDir(join(root, "extensions-routes"), [extensions]);
  });
});

Deno.test({
  name: "checkWebhookRoutesDir: a symlink cannot alias an extension directory",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (root) => {
      const extensions = join(root, "extensions");
      await Deno.mkdir(extensions);
      await Deno.symlink(extensions, join(root, "webhook-routes"), {
        type: "dir",
      });

      await assertRejects(
        () => checkWebhookRoutesDir(join(root, "webhook-routes"), [extensions]),
        Error,
        "holds extension code",
      );
    });
  },
});

Deno.test("loadWebhookRouteFiles: refuses a file over the size cap", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "big.yaml"),
      VALID + `# ${"x".repeat(70 * 1024)}\n`,
    );

    const [refused] = (await loadWebhookRouteFiles(dir)).refused;

    assertStringIncludes(refused.message, "a route file may hold at most");
  });
});

Deno.test({
  name:
    "loadWebhookRouteFiles: refuses a yaml-named symlink to a directory as not a regular file",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      await Deno.mkdir(join(dir, "sub"));
      await Deno.symlink(join(dir, "sub"), join(dir, "dir.yaml"), {
        type: "dir",
      });

      const [refused] = (await loadWebhookRouteFiles(dir)).refused;

      assertStringIncludes(refused.message, "not a regular file");
    });
  },
});

Deno.test("checkRouteFiles: reports refused files and shadowed routes with the file's workflow", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "webhook-routes");
    await Deno.mkdir(dir);
    await Deno.writeTextFile(join(dir, "gh.yaml"), VALID.replace("push", "gh"));
    await Deno.writeTextFile(join(dir, "bad.yaml"), "route: /hooks/bad\n");

    const check = await checkRouteFiles(dir, [join(root, "extensions")], [
      { route: "/hooks/gh", source: "config" },
    ]);

    assertEquals(check.refused.map((r) => r.file), ["bad.yaml"]);
    assertEquals(check.shadowed, [
      { file: "gh.yaml", route: "/hooks/gh", by: "config", workflow: "deploy" },
    ]);
  });
});

Deno.test("checkRouteFiles: a routes directory inside extension code is reported, not thrown", async () => {
  await withTempDir(async (root) => {
    const extensions = join(root, "extensions");
    await Deno.mkdir(extensions);

    const check = await checkRouteFiles(join(extensions, "routes"), [
      extensions,
    ], []);

    assertEquals(check.refused, []);
    assertStringIncludes(check.directoryError ?? "", "holds extension code");
  });
});
