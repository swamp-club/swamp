// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import { CelEvaluator } from "./cel_evaluator.ts";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";
import { transformHyphenatedModelRefs } from "../../domain/expressions/expression_parser.ts";

Deno.test("CelEvaluator evaluates simple property access", () => {
  const evaluator = new CelEvaluator();
  const result = evaluator.evaluate("x", { x: 42 });
  assertEquals(result, 42);
});

Deno.test("CelEvaluator evaluates nested property access", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      foo: {
        input: {
          attributes: {
            message: "Hello",
          },
        },
      },
    },
  };
  const result = evaluator.evaluate(
    "model.foo.input.attributes.message",
    context,
  );
  assertEquals(result, "Hello");
});

Deno.test("CelEvaluator evaluates string concatenation", () => {
  const evaluator = new CelEvaluator();
  const context = {
    self: {
      name: "Test",
      version: 1,
    },
  };
  const result = evaluator.evaluate('self.name + " v1"', context);
  assertEquals(result, "Test v1");
});

Deno.test("CelEvaluator evaluates arithmetic expressions", () => {
  const evaluator = new CelEvaluator();
  const context = { a: 10, b: 5 };
  assertEquals(evaluator.evaluate("a + b", context), 15);
  assertEquals(evaluator.evaluate("a - b", context), 5);
  assertEquals(evaluator.evaluate("a * b", context), 50);
});

Deno.test("CelEvaluator evaluates comparison expressions", () => {
  const evaluator = new CelEvaluator();
  const context = { x: 10 };
  assertEquals(evaluator.evaluate("x > 5", context), true);
  assertEquals(evaluator.evaluate("x < 5", context), false);
  assertEquals(evaluator.evaluate("x == 10", context), true);
});

Deno.test("CelEvaluator evaluates conditional expressions", () => {
  const evaluator = new CelEvaluator();
  const context = { cond: true, a: "yes", b: "no" };
  assertEquals(evaluator.evaluate("cond ? a : b", context), "yes");
});

Deno.test("CelEvaluator throws InvalidExpressionError for invalid expressions", () => {
  const evaluator = new CelEvaluator();
  assertThrows(
    () => evaluator.evaluate("nonexistent.property", {}),
    InvalidExpressionError,
  );
});

Deno.test("CelEvaluator validate returns valid for correct syntax", () => {
  const evaluator = new CelEvaluator();
  const result = evaluator.validate("x + y");
  assertEquals(result.valid, true);
  assertEquals(result.error, undefined);
});

Deno.test("CelEvaluator validate returns invalid for syntax errors", () => {
  const evaluator = new CelEvaluator();
  const result = evaluator.validate("x + + y");
  assertEquals(result.valid, false);
  assertEquals(typeof result.error, "string");
});

Deno.test("CelEvaluator handles model.name.input.attributes pattern", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      source: {
        input: {
          id: "abc-123",
          name: "source",
          version: 1,
          tags: { env: "prod" },
          attributes: {
            text: "Hello World",
            count: 42,
          },
        },
      },
    },
  };

  assertEquals(
    evaluator.evaluate("model.source.input.attributes.text", context),
    "Hello World",
  );
  assertEquals(
    evaluator.evaluate("model.source.input.attributes.count", context),
    42,
  );
  assertEquals(
    evaluator.evaluate("model.source.input.name", context),
    "source",
  );
});

Deno.test("CelEvaluator handles model.name.resource.attributes pattern", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      vpc: {
        input: {
          id: "input-123",
          name: "vpc",
          version: 1,
          tags: {},
          attributes: {},
        },
        resource: {
          id: "resource-456",
          version: 1,
          createdAt: "2024-01-01T00:00:00Z",
          attributes: {
            vpcId: "vpc-abc123",
            cidrBlock: "10.0.0.0/16",
          },
        },
      },
    },
  };

  assertEquals(
    evaluator.evaluate("model.vpc.resource.attributes.vpcId", context),
    "vpc-abc123",
  );
  assertEquals(
    evaluator.evaluate("model.vpc.resource.attributes.cidrBlock", context),
    "10.0.0.0/16",
  );
});

Deno.test("CelEvaluator handles self references", () => {
  const evaluator = new CelEvaluator();
  const context = {
    self: {
      id: "self-123",
      name: "my-model",
      version: 2,
      tags: { type: "test" },
      attributes: {
        enabled: true,
      },
    },
  };

  assertEquals(evaluator.evaluate("self.name", context), "my-model");
  assertEquals(evaluator.evaluate("self.version", context), 2);
  assertEquals(evaluator.evaluate("self.tags.type", context), "test");
  assertEquals(evaluator.evaluate("self.attributes.enabled", context), true);
});

Deno.test("CelEvaluator handles hyphenated model names in resource access", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      "deploy-vpc": {
        resource: {
          attributes: {
            VpcId: "vpc-123",
          },
        },
      },
    },
  };

  assertEquals(
    evaluator.evaluate(
      "model.deploy-vpc.resource.attributes.VpcId",
      context,
    ),
    "vpc-123",
  );
});

Deno.test("CelEvaluator handles hyphenated model names in input access", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      "my-hyphenated-model": {
        input: {
          attributes: {
            name: "test-value",
          },
        },
      },
    },
  };

  assertEquals(
    evaluator.evaluate(
      "model.my-hyphenated-model.input.attributes.name",
      context,
    ),
    "test-value",
  );
});

Deno.test("CelEvaluator handles multiple hyphens in model name", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      "my-very-long-hyphenated-name": {
        resource: {
          id: "resource-id",
        },
      },
    },
  };

  assertEquals(
    evaluator.evaluate(
      "model.my-very-long-hyphenated-name.resource.id",
      context,
    ),
    "resource-id",
  );
});

Deno.test("transformHyphenatedModelRefs transforms hyphenated names", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.deploy-vpc.resource.attributes.VpcId"),
    'model["deploy-vpc"].resource.attributes.VpcId',
  );
});

Deno.test("transformHyphenatedModelRefs leaves non-hyphenated names unchanged", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.vpc.resource.attributes.VpcId"),
    "model.vpc.resource.attributes.VpcId",
  );
});

Deno.test("transformHyphenatedModelRefs handles input references", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.my-model.input.attributes.name"),
    'model["my-model"].input.attributes.name',
  );
});

Deno.test("transformHyphenatedModelRefs handles multiple hyphens", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.a-b-c-d.resource.id"),
    'model["a-b-c-d"].resource.id',
  );
});

Deno.test("transformHyphenatedModelRefs handles resource references", () => {
  assertEquals(
    transformHyphenatedModelRefs(
      "model.proxmox-auth.resource.auth.attributes.ticket",
    ),
    'model["proxmox-auth"].resource.auth.attributes.ticket',
  );
});

Deno.test("transformHyphenatedModelRefs handles file references", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.my-config.file.path"),
    'model["my-config"].file.path',
  );
});

Deno.test("transformHyphenatedModelRefs handles file references with different names", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.my-service.file.entries"),
    'model["my-service"].file.entries',
  );
});

Deno.test("transformHyphenatedModelRefs handles execution references", () => {
  assertEquals(
    transformHyphenatedModelRefs("model.my-task.execution.status"),
    'model["my-task"].execution.status',
  );
});

Deno.test("CelEvaluator handles hyphenated model names in resource access", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      "proxmox-auth": {
        resource: {
          auth: {
            attributes: {
              ticket: "PVE:user@pve:123456789::abc123",
              csrfToken: "12345678:abcdef",
            },
          },
        },
      },
    },
  };

  assertEquals(
    evaluator.evaluate(
      "model.proxmox-auth.resource.auth.attributes.ticket",
      context,
    ),
    "PVE:user@pve:123456789::abc123",
  );
  assertEquals(
    evaluator.evaluate(
      "model.proxmox-auth.resource.auth.attributes.csrfToken",
      context,
    ),
    "12345678:abcdef",
  );
});

Deno.test("CelEvaluator evaluates env variable access", () => {
  const evaluator = new CelEvaluator();
  const context = {
    env: { HOME: "/home/user", USER: "testuser" },
  };
  assertEquals(evaluator.evaluate("env.HOME", context), "/home/user");
  assertEquals(evaluator.evaluate("env.USER", context), "testuser");
});

Deno.test("CelEvaluator evaluates env in string concatenation", () => {
  const evaluator = new CelEvaluator();
  const context = {
    env: { PREFIX: "prod" },
    model: {
      vpc: {
        input: {
          attributes: {
            name: "main",
          },
        },
      },
    },
  };
  const result = evaluator.evaluate(
    'env.PREFIX + "-" + model.vpc.input.attributes.name',
    context,
  );
  assertEquals(result, "prod-main");
});

// Tests for data versioning (Issue #128)

Deno.test("CelEvaluator handles model.foo.data.bar.attributes.x pattern", () => {
  const evaluator = new CelEvaluator();
  const context = {
    model: {
      "my-vpc": {
        input: {
          id: "input-123",
          name: "my-vpc",
          version: 1,
          tags: {},
          attributes: {},
        },
        data: {
          id: "data-123",
          name: "vpc-info",
          version: 2,
          createdAt: "2024-01-01T00:00:00Z",
          attributes: {
            vpcId: "vpc-abc123",
            cidrBlock: "10.0.0.0/16",
          },
          tags: { type: "resource" },
        },
      },
    },
  };

  // Access data directly (single artifact is unwrapped)
  assertEquals(
    evaluator.evaluate(
      'model["my-vpc"].data.attributes.vpcId',
      context,
    ),
    "vpc-abc123",
  );
  assertEquals(
    evaluator.evaluate(
      'model["my-vpc"].data.version',
      context,
    ),
    2,
  );
});

// file.contents() and data.*() functions via Environment-registered receiver methods

Deno.test("CelEvaluator evaluates file.contents() with mock file context", () => {
  const evaluator = new CelEvaluator();
  const context = {
    file: {
      contents: (modelName: string, specName: string): string | null => {
        if (modelName === "my-model" && specName === "config") {
          return '{"key": "value"}';
        }
        return null;
      },
    },
  };

  const result = evaluator.evaluate(
    'file.contents("my-model", "config")',
    context,
  );
  assertEquals(result, '{"key": "value"}');
});

Deno.test("CelEvaluator file.contents() returns null for missing file", () => {
  const evaluator = new CelEvaluator();
  const context = {
    file: {
      contents: (_modelName: string, _specName: string): string | null => {
        return null;
      },
    },
  };

  const result = evaluator.evaluate(
    'file.contents("missing", "file")',
    context,
  );
  assertEquals(result, null);
});

Deno.test("CelEvaluator file.contents() in string concatenation", () => {
  const evaluator = new CelEvaluator();
  const context = {
    file: {
      contents: (_modelName: string, _specName: string): string | null => {
        return "hello world";
      },
    },
  };

  const result = evaluator.evaluate(
    '"content: " + file.contents("m", "s")',
    context,
  );
  assertEquals(result, "content: hello world");
});

Deno.test("CelEvaluator evaluates data.latest() with mock data context", () => {
  const evaluator = new CelEvaluator();
  const context = {
    data: {
      latest: (modelName: string, dataName: string) => {
        if (modelName === "vpc" && dataName === "info") {
          return {
            id: "data-1",
            name: "info",
            version: 3,
            attributes: { vpcId: "vpc-123" },
          };
        }
        return null;
      },
    },
  };

  const result = evaluator.evaluate(
    'data.latest("vpc", "info").attributes.vpcId',
    context,
  );
  assertEquals(result, "vpc-123");
});

Deno.test("CelEvaluator evaluates data.version() with mock data context", () => {
  const evaluator = new CelEvaluator();
  const context = {
    data: {
      version: (
        modelName: string,
        dataName: string,
        version: unknown,
      ) => {
        // cel-js passes int literals as bigint
        if (modelName === "vpc" && dataName === "info" && version == 1) {
          return {
            id: "data-1",
            name: "info",
            version: 1,
            attributes: { cidr: "10.0.0.0/16" },
          };
        }
        return null;
      },
    },
  };

  const result = evaluator.evaluate(
    'data.version("vpc", "info", 1).attributes.cidr',
    context,
  );
  assertEquals(result, "10.0.0.0/16");
});

Deno.test("CelEvaluator evaluates data.listVersions() with mock data context", () => {
  const evaluator = new CelEvaluator();
  const context = {
    data: {
      listVersions: (modelName: string, dataName: string) => {
        if (modelName === "vpc" && dataName === "info") {
          return [1, 2, 3];
        }
        return [];
      },
    },
  };

  const result = evaluator.evaluate(
    'data.listVersions("vpc", "info")',
    context,
  );
  assertEquals(result, [1, 2, 3]);
});

Deno.test("CelEvaluator evaluates data.findByTag() with mock data context", () => {
  const evaluator = new CelEvaluator();
  const context = {
    data: {
      findByTag: (tagKey: string, tagValue: string) => {
        if (tagKey === "env" && tagValue === "prod") {
          return [{ id: "d1", name: "info", version: 1, attributes: {} }];
        }
        return [];
      },
    },
  };

  const result = evaluator.evaluate(
    'data.findByTag("env", "prod")',
    context,
  );
  assertEquals(result, [{
    id: "d1",
    name: "info",
    version: 1,
    attributes: {},
  }]);
});

Deno.test("CelEvaluator evaluates data.findBySpec() with mock data context", () => {
  const evaluator = new CelEvaluator();
  const context = {
    data: {
      findBySpec: (modelName: string, specName: string) => {
        if (modelName === "factory" && specName === "subnet") {
          return [
            {
              id: "d1",
              name: "subnet-a",
              version: 1,
              attributes: { cidr: "10.0.1.0/24" },
              tags: { specName: "subnet" },
            },
            {
              id: "d2",
              name: "subnet-b",
              version: 1,
              attributes: { cidr: "10.0.2.0/24" },
              tags: { specName: "subnet" },
            },
          ];
        }
        return [];
      },
    },
  };

  const result = evaluator.evaluate(
    'data.findBySpec("factory", "subnet")',
    context,
  );
  assertEquals(Array.isArray(result), true);
  assertEquals((result as unknown[]).length, 2);
});

Deno.test("CelEvaluator data.findBySpec() returns empty array for no matches", () => {
  const evaluator = new CelEvaluator();
  const context = {
    data: {
      findBySpec: (_modelName: string, _specName: string) => {
        return [];
      },
    },
  };

  const result = evaluator.evaluate(
    'data.findBySpec("missing", "spec")',
    context,
  );
  assertEquals(result, []);
});

Deno.test("CelEvaluator receiver method returns null when receiver lacks method", () => {
  const evaluator = new CelEvaluator();
  // Provide a file object that has no contents method
  const context = {
    file: { path: "/some/path" },
  };

  const result = evaluator.evaluate(
    'file.contents("m", "s")',
    context,
  );
  assertEquals(result, null);
});
