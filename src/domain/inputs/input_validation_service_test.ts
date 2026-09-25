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

import { assertEquals } from "@std/assert";
import { InputValidationService } from "./input_validation_service.ts";
import type { InputsSchema } from "../definitions/definition.ts";

const validationService = new InputValidationService();

// Basic type validation tests

Deno.test("InputValidationService.validate passes for valid string input", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
    },
  };
  const result = validationService.validate({ name: "test" }, schema);
  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("InputValidationService.validate fails for wrong type", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
    },
  };
  const result = validationService.validate({ name: 123 }, schema);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].path, "name");
  assertEquals(result.errors[0].message, "name must be a string");
});

Deno.test("InputValidationService.validate validates number type", () => {
  const schema: InputsSchema = {
    properties: {
      count: { type: "number" },
    },
  };

  const validResult = validationService.validate({ count: 42.5 }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate({ count: "42" }, schema);
  assertEquals(invalidResult.valid, false);
});

Deno.test("InputValidationService.validate validates integer type", () => {
  const schema: InputsSchema = {
    properties: {
      count: { type: "integer" },
    },
  };

  const validResult = validationService.validate({ count: 42 }, schema);
  assertEquals(validResult.valid, true);

  const floatResult = validationService.validate({ count: 42.5 }, schema);
  assertEquals(floatResult.valid, false);
  assertEquals(floatResult.errors[0].message, "count must be an integer");
});

Deno.test("InputValidationService.validate validates boolean type", () => {
  const schema: InputsSchema = {
    properties: {
      enabled: { type: "boolean" },
    },
  };

  const validResult = validationService.validate({ enabled: true }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate({ enabled: "true" }, schema);
  assertEquals(invalidResult.valid, false);
});

// Required field tests

Deno.test("InputValidationService.validate fails for missing required field", () => {
  const schema: InputsSchema = {
    properties: {
      environment: { type: "string" },
    },
    required: ["environment"],
  };

  const result = validationService.validate({}, schema);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].message, "environment is required");
});

Deno.test("InputValidationService.validate passes when required field present", () => {
  const schema: InputsSchema = {
    properties: {
      environment: { type: "string" },
    },
    required: ["environment"],
  };

  const result = validationService.validate({ environment: "dev" }, schema);
  assertEquals(result.valid, true);
});

// Enum validation tests

Deno.test("InputValidationService.validate passes for valid enum value", () => {
  const schema: InputsSchema = {
    properties: {
      environment: {
        type: "string",
        enum: ["dev", "staging", "production"],
      },
    },
  };

  const result = validationService.validate({ environment: "dev" }, schema);
  assertEquals(result.valid, true);
});

Deno.test("InputValidationService.validate fails for invalid enum value", () => {
  const schema: InputsSchema = {
    properties: {
      environment: {
        type: "string",
        enum: ["dev", "staging", "production"],
      },
    },
  };

  const result = validationService.validate({ environment: "invalid" }, schema);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0].message,
    'environment must be one of: "dev", "staging", "production"',
  );
});

// Array validation tests

Deno.test("InputValidationService.validate validates array type", () => {
  const schema: InputsSchema = {
    properties: {
      items: { type: "array" },
    },
  };

  const validResult = validationService.validate({ items: [1, 2, 3] }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    { items: "not-array" },
    schema,
  );
  assertEquals(invalidResult.valid, false);
});

Deno.test("InputValidationService.validate validates array items", () => {
  const schema: InputsSchema = {
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
      },
    },
  };

  const validResult = validationService.validate(
    { names: ["alice", "bob"] },
    schema,
  );
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    { names: ["alice", 123] },
    schema,
  );
  assertEquals(invalidResult.valid, false);
  assertEquals(invalidResult.errors[0].path, "names[1]");
});

Deno.test("InputValidationService.validate validates minItems", () => {
  const schema: InputsSchema = {
    properties: {
      items: {
        type: "array",
        minItems: 2,
      },
    },
  };

  const validResult = validationService.validate({ items: [1, 2] }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate({ items: [1] }, schema);
  assertEquals(invalidResult.valid, false);
  assertEquals(
    invalidResult.errors[0].message,
    "items must have at least 2 items",
  );
});

Deno.test("InputValidationService.validate validates maxItems", () => {
  const schema: InputsSchema = {
    properties: {
      items: {
        type: "array",
        maxItems: 3,
      },
    },
  };

  const validResult = validationService.validate({ items: [1, 2, 3] }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    { items: [1, 2, 3, 4] },
    schema,
  );
  assertEquals(invalidResult.valid, false);
});

Deno.test("InputValidationService.validate validates uniqueItems", () => {
  const schema: InputsSchema = {
    properties: {
      items: {
        type: "array",
        uniqueItems: true,
      },
    },
  };

  const validResult = validationService.validate({ items: [1, 2, 3] }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    { items: [1, 2, 2] },
    schema,
  );
  assertEquals(invalidResult.valid, false);
  assertEquals(invalidResult.errors[0].message, "items must have unique items");
});

// Object validation tests

Deno.test("InputValidationService.validate validates object type", () => {
  const schema: InputsSchema = {
    properties: {
      config: { type: "object" },
    },
  };

  const validResult = validationService.validate(
    { config: { key: "value" } },
    schema,
  );
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    { config: "string" },
    schema,
  );
  assertEquals(invalidResult.valid, false);
});

Deno.test("InputValidationService.validate validates nested object properties", () => {
  const schema: InputsSchema = {
    properties: {
      config: {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "integer" },
        },
        required: ["host"],
      },
    },
  };

  const validResult = validationService.validate(
    { config: { host: "localhost", port: 8080 } },
    schema,
  );
  assertEquals(validResult.valid, true);

  const missingRequired = validationService.validate(
    { config: { port: 8080 } },
    schema,
  );
  assertEquals(missingRequired.valid, false);
  assertEquals(missingRequired.errors[0].message, "config.host is required");
});

Deno.test("InputValidationService.validate validates additionalProperties false", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
    },
    additionalProperties: false,
  };

  const validResult = validationService.validate({ name: "test" }, schema);
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    { name: "test", extra: "not-allowed" },
    schema,
  );
  assertEquals(invalidResult.valid, false);
  assertEquals(
    invalidResult.errors[0].message,
    "extra is not a valid input property",
  );
});

// Default value tests

Deno.test("InputValidationService.applyDefaults applies default values", () => {
  const schema: InputsSchema = {
    properties: {
      environment: { type: "string", default: "dev" },
      count: { type: "integer", default: 1 },
    },
  };

  const result = validationService.applyDefaults({}, schema);
  assertEquals(result.environment, "dev");
  assertEquals(result.count, 1);
});

Deno.test("InputValidationService.applyDefaults preserves provided values", () => {
  const schema: InputsSchema = {
    properties: {
      environment: { type: "string", default: "dev" },
    },
  };

  const result = validationService.applyDefaults(
    { environment: "production" },
    schema,
  );
  assertEquals(result.environment, "production");
});

// getMissingRequiredInputs tests

Deno.test("InputValidationService.getMissingRequiredInputs returns missing fields", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
      environment: { type: "string" },
    },
    required: ["name", "environment"],
  };

  const missing = validationService.getMissingRequiredInputs({}, schema);
  assertEquals(missing.sort(), ["environment", "name"]);
});

Deno.test("InputValidationService.getMissingRequiredInputs excludes fields with defaults", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
      environment: { type: "string", default: "dev" },
    },
    required: ["name", "environment"],
  };

  const missing = validationService.getMissingRequiredInputs({}, schema);
  assertEquals(missing, ["name"]);
});

Deno.test("InputValidationService.getMissingRequiredInputs returns empty when all provided", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  };

  const missing = validationService.getMissingRequiredInputs(
    { name: "test" },
    schema,
  );
  assertEquals(missing.length, 0);
});

// Multiple error tests

Deno.test("InputValidationService.validate reports multiple errors", () => {
  const schema: InputsSchema = {
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      environment: {
        type: "string",
        enum: ["dev", "staging", "production"],
      },
    },
    required: ["name", "count", "environment"],
  };

  const result = validationService.validate(
    { name: 123, count: "not-a-number", environment: "invalid" },
    schema,
  );
  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 3);
});

// Complex nested validation

Deno.test("InputValidationService.validate handles complex nested structures", () => {
  const schema: InputsSchema = {
    properties: {
      deployment: {
        type: "object",
        properties: {
          environments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                replicas: { type: "integer" },
              },
              required: ["name"],
            },
            minItems: 1,
          },
        },
        required: ["environments"],
      },
    },
  };

  const validResult = validationService.validate(
    {
      deployment: {
        environments: [
          { name: "dev", replicas: 1 },
          { name: "staging", replicas: 2 },
        ],
      },
    },
    schema,
  );
  assertEquals(validResult.valid, true);

  const invalidResult = validationService.validate(
    {
      deployment: {
        environments: [{ replicas: 1 }],
      },
    },
    schema,
  );
  assertEquals(invalidResult.valid, false);
});

// validateProvided tests

Deno.test("InputValidationService.validateProvided skips the required check", () => {
  const schema: InputsSchema = {
    properties: {
      environment: { type: "string" },
      replicas: { type: "integer" },
    },
    required: ["environment", "replicas"],
  };

  const result = validationService.validateProvided({ replicas: 3 }, schema);
  assertEquals(result, { valid: true, errors: [] });
  // validate() still reports the missing required input.
  assertEquals(validationService.validate({ replicas: 3 }, schema).errors, [
    { path: "environment", message: "environment is required" },
  ]);
});

Deno.test("InputValidationService.validateProvided reports a wrong type", () => {
  const schema: InputsSchema = {
    properties: { envs: { type: "array", items: { type: "string" } } },
    required: ["envs"],
  };

  const result = validationService.validateProvided({ envs: "a" }, schema);
  assertEquals(result.valid, false);
  assertEquals(result.errors, [{
    path: "envs",
    message: "envs must be a array",
  }]);
});

Deno.test("InputValidationService.validateProvided checks enum values and array items", () => {
  const schema: InputsSchema = {
    properties: {
      environment: { type: "string", enum: ["dev", "prod"] },
      ports: { type: "array", items: { type: "integer" } },
    },
  };

  const result = validationService.validateProvided(
    { environment: "qa", ports: [80, "443"] },
    schema,
  );
  assertEquals(result.errors, [
    {
      path: "environment",
      message: 'environment must be one of: "dev", "prod"',
    },
    { path: "ports[1]", message: "ports[1] must be an integer" },
  ]);
});

Deno.test("InputValidationService.validateProvided refuses an undeclared key only under additionalProperties false", () => {
  const properties: InputsSchema["properties"] = {
    environment: { type: "string" },
  };

  assertEquals(
    validationService.validateProvided({ authKey: "tskey-abc123" }, {
      properties,
    }).valid,
    true,
  );
  assertEquals(
    validationService.validateProvided({ authKey: "tskey-abc123" }, {
      properties,
      additionalProperties: false,
    }).errors,
    [{ path: "authKey", message: "authKey is not a valid input property" }],
  );
});

Deno.test("InputValidationService.validateProvided does not treat Object.prototype names as declared inputs", () => {
  const schema: InputsSchema = {
    properties: { environment: { type: "string" } },
    additionalProperties: false,
  };
  // JSON.parse makes __proto__ an own key, as a parsed --input or WebSocket
  // payload would.
  const inputs = JSON.parse('{"constructor": "x", "__proto__": "y"}');

  const result = validationService.validateProvided(inputs, schema);
  assertEquals(result.errors, [
    {
      path: "constructor",
      message: "constructor is not a valid input property",
    },
    { path: "__proto__", message: "__proto__ is not a valid input property" },
  ]);
  assertEquals(
    validationService.validate(inputs, schema).errors,
    result.errors,
  );
});

Deno.test("InputValidationService.validateProvided supports the flat schema form", () => {
  const schema = {
    replicas: { type: "integer" },
  } as unknown as InputsSchema;

  assertEquals(
    validationService.validateProvided({ replicas: 2 }, schema).valid,
    true,
  );
  assertEquals(
    validationService.validateProvided({ replicas: "2" }, schema).errors,
    [{ path: "replicas", message: "replicas must be an integer" }],
  );
});
