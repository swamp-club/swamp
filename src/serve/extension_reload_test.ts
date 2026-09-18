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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isReloading,
  performServeReload,
  resolveLockfilePath,
} from "./extension_reload.ts";

Deno.test("isReloading: returns false when no reload is in progress", () => {
  assertEquals(isReloading(), false);
});

Deno.test("resolveLockfilePath: returns path ending in upstream_extensions.json", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp.yaml"),
      "version: 1\n",
    );
    const result = await resolveLockfilePath(tmpDir);
    assertStringIncludes(result, "upstream_extensions.json");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: succeeds with no-op for missing lockfile", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
    );
    assertEquals(result.success, true);
    assertEquals(result.reloadedCount, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: returns zero count for empty lockfile", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const catalogDbPath = join(tmpDir, ".swamp", "_extension_catalog.db");
    await Deno.writeTextFile(catalogDbPath, "");
    const result = await performServeReload(tmpDir, lockfilePath);
    assertEquals(result.success, true);
    assertEquals(result.reloadedCount, 0);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: resets isReloading flag after failure", async () => {
  assertEquals(isReloading(), false);
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await performServeReload(tmpDir, join(tmpDir, "missing.json"));
    assertEquals(isReloading(), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls triggerOverrideUpdater with overrides from serve.yaml", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `triggers:\n  my-workflow:\n    schedule: "0 3 * * *"\n`,
    );

    let receivedOverrides: ReadonlyMap<string, unknown> | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: (overrides) => {
          receivedOverrides = overrides;
          return Promise.resolve(overrides.size);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.triggerOverridesChanged, 1);
    assertEquals(receivedOverrides?.size, 1);
    const entry = receivedOverrides?.get("my-workflow") as
      | { schedule?: string }
      | undefined;
    assertEquals(entry?.schedule, "0 3 * * *");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: passes empty map when serve.yaml has no triggers", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `port: 8080\n`,
    );

    let receivedOverrides: ReadonlyMap<string, unknown> | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: (overrides) => {
          receivedOverrides = overrides;
          return Promise.resolve(overrides.size);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.triggerOverridesChanged, 0);
    assertEquals(receivedOverrides?.size, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls workflowReloader and includes count in response", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    let reloaderCalled = false;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        workflowReloader: () => {
          reloaderCalled = true;
          return Promise.resolve(4);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(reloaderCalled, true);
    assertEquals(result.workflowsReloaded, 4);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: workflowReloader error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        workflowReloader: () =>
          Promise.reject(new Error("workflow scan failed")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(result.errors[0], "Failed to reload workflows");
    assertStringIncludes(result.errors[0], "workflow scan failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: trigger override updater error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `triggers:\n  my-wf:\n    schedule: "0 3 * * *"\n`,
    );

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: () =>
          Promise.reject(new Error("scheduler broke")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(
      result.errors[0],
      "Failed to reload trigger overrides",
    );
    assertStringIncludes(result.errors[0], "scheduler broke");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls extensionDiscoverer and adds count to reloadedCount", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    let discovererCalled = false;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        extensionDiscoverer: () => {
          discovererCalled = true;
          return Promise.resolve(3);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(discovererCalled, true);
    assertEquals(result.reloadedCount, 3);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: extensionDiscoverer error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        extensionDiscoverer: () =>
          Promise.reject(new Error("discovery failed")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(
      result.errors[0],
      "Failed to discover new extensions",
    );
    assertStringIncludes(result.errors[0], "discovery failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls webhookUpdater with configs from serve.yaml", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `webhooks:\n  - route: /hooks/gh\n    workflow: deploy\n    secret: s3cret\n`,
    );

    let receivedConfigs:
      | readonly import("./serve_config.ts").WebhookConfigEntry[]
      | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        webhookUpdater: (configs) => {
          receivedConfigs = configs;
          return Promise.resolve(configs.length);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.webhooksReloaded, 1);
    assertEquals(receivedConfigs?.length, 1);
    assertEquals(receivedConfigs?.[0].route, "/hooks/gh");
    assertEquals(receivedConfigs?.[0].workflow, "deploy");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: passes empty array when serve.yaml has no webhooks", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `port: 8080\n`,
    );

    let receivedConfigs:
      | readonly import("./serve_config.ts").WebhookConfigEntry[]
      | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        webhookUpdater: (configs) => {
          receivedConfigs = configs;
          return Promise.resolve(configs.length);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.webhooksReloaded, 0);
    assertEquals(receivedConfigs?.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: webhookUpdater error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `webhooks:\n  - route: /hooks/gh\n    workflow: deploy\n    secret: s\n`,
    );

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        webhookUpdater: () => Promise.reject(new Error("parse failed")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(
      result.errors[0],
      "Failed to reload webhook config",
    );
    assertStringIncludes(result.errors[0], "parse failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: shares config read between triggers and webhooks", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `triggers:\n  my-wf:\n    schedule: "0 3 * * *"\nwebhooks:\n  - route: /hooks/a\n    workflow: wf\n    secret: s\n`,
    );

    let triggersCalled = false;
    let webhooksCalled = false;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: (overrides) => {
          triggersCalled = true;
          return Promise.resolve(overrides.size);
        },
        webhookUpdater: (configs) => {
          webhooksCalled = true;
          return Promise.resolve(configs.length);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(triggersCalled, true);
    assertEquals(webhooksCalled, true);
    assertEquals(result.triggerOverridesChanged, 1);
    assertEquals(result.webhooksReloaded, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
