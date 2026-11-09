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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { performServeReload } from "../src/serve/extension_reload.ts";
import { parseWebhookConfig } from "../src/serve/serve_config.ts";
import { WebhookService } from "../src/serve/webhook.ts";
import { createWebhookUpdater } from "../src/serve/webhook_reload.ts";

await initializeLogging({});

Deno.test("serve reload: a refused webhook list keeps the previous route table", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configFile = join(dir, ".swamp", "serve.yaml");
    await Deno.mkdir(join(dir, ".swamp"), { recursive: true });

    const service = new WebhookService({
      repoDir: dir,
      repoContext: {} as unknown as RepositoryContext,
      datastoreConfig: {} as unknown as DatastoreConfig,
      endpoints: [
        await parseWebhookConfig({
          route: "/hooks/boot",
          workflow: "deploy",
          secret: "s3cret",
        }),
      ],
      syncGate: undefined,
    });
    const webhookUpdater = createWebhookUpdater({
      source: "config",
      service,
      parse: (configs) =>
        Promise.all(configs.map((entry) => parseWebhookConfig(entry))),
    });
    const reload = () =>
      performServeReload(dir, join(dir, "nonexistent_lockfile.json"), {
        webhookUpdater,
      });
    const routes = () => service.listEndpoints().map((e) => e.route);

    await Deno.writeTextFile(
      configFile,
      `webhooks:\n  - route: /hooks/edited\n    workflow: deploy\n    secret: s3cret\n`,
    );
    const accepted = await reload();
    assertEquals(accepted.errors, []);
    assertEquals(routes(), ["/hooks/edited"]);

    await Deno.writeTextFile(
      configFile,
      `webhooks:\n` +
        `  - route: hooks/no-slash\n    workflow: deploy\n    secret: s3cret\n` +
        `  - route: /hooks/bad-scheme\n    workflow: deploy\n    secret: s3cret\n    scheme: nonsense\n`,
    );
    const refused = await reload();
    assertEquals(refused.webhooksReloaded, 0);
    assertEquals(refused.errors.length, 1);
    assertStringIncludes(refused.errors[0], "route must start with '/'");
    assertEquals(routes(), ["/hooks/edited"]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
