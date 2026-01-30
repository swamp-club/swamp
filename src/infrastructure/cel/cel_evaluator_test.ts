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
