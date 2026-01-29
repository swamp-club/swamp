import { assertEquals } from "@std/assert";
import { createModelsHandlers } from "./models_handler.ts";
import type { InputRepository } from "../../../domain/models/repositories.ts";
import type { ModelType } from "../../../domain/models/model_type.ts";
import type {
  ModelInput,
  ModelInputId,
} from "../../../domain/models/model_input.ts";

// Mock repository for testing
function createMockRepository(
  inputs: { input: ModelInput; type: ModelType }[] = [],
): InputRepository {
  const storage = new Map<string, { input: ModelInput; type: ModelType }>();

  for (const item of inputs) {
    storage.set(item.input.id, item);
  }

  return {
    findById(
      type: ModelType,
      id: ModelInputId,
    ): Promise<ModelInput | null> {
      const item = storage.get(id);
      if (item && item.type.normalized === type.normalized) {
        return Promise.resolve(item.input);
      }
      return Promise.resolve(null);
    },

    findAll(type: ModelType): Promise<ModelInput[]> {
      const result = Array.from(storage.values())
        .filter((item) => item.type.normalized === type.normalized)
        .map((item) => item.input);
      return Promise.resolve(result);
    },

    findByName(
      _type: ModelType,
      name: string,
    ): Promise<ModelInput | null> {
      const item = Array.from(storage.values()).find(
        (i) => i.input.name === name,
      );
      return Promise.resolve(item?.input ?? null);
    },

    findByNameGlobal(
      name: string,
    ): Promise<{ input: ModelInput; type: ModelType } | null> {
      const result = Array.from(storage.values()).find(
        (item) => item.input.name === name,
      ) ?? null;
      return Promise.resolve(result);
    },

    findAllGlobal(): Promise<{ input: ModelInput; type: ModelType }[]> {
      return Promise.resolve(Array.from(storage.values()));
    },

    save(type: ModelType, input: ModelInput): Promise<void> {
      storage.set(input.id, { input, type });
      return Promise.resolve();
    },

    delete(_type: ModelType, id: ModelInputId): Promise<void> {
      storage.delete(id);
      return Promise.resolve();
    },

    nextId(): ModelInputId {
      return crypto.randomUUID() as ModelInputId;
    },

    getPath(_type: ModelType, id: ModelInputId): string {
      return `/test/inputs/${id}.yaml`;
    },
  };
}

Deno.test("listAllModels returns empty array when no models", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  const request = new Request("http://localhost/api/v1/models");
  const response = await handlers.listAllModels({ request, params: {} });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.models, []);
});

Deno.test("listModelsByType returns empty array for type with no models", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  const request = new Request("http://localhost/api/v1/models/echo");
  const response = await handlers.listModelsByType({
    request,
    params: { type: "echo" },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.models, []);
});

Deno.test("listModelsByType returns 400 for empty type", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  const request = new Request("http://localhost/api/v1/models/");
  const response = await handlers.listModelsByType({
    request,
    params: { type: "" },
  });

  assertEquals(response.status, 400);
});

Deno.test("getModel returns 404 when model not found", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  const request = new Request(
    "http://localhost/api/v1/models/echo/nonexistent",
  );
  const response = await handlers.getModel({
    request,
    params: { type: "echo", id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});

Deno.test("createModel creates new model", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  const request = new Request("http://localhost/api/v1/models/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "test-model",
      attributes: { message: "hello" },
    }),
  });

  const response = await handlers.createModel({
    request,
    params: { type: "echo" },
  });

  assertEquals(response.status, 201);
  const body = await response.json();
  assertEquals(body.name, "test-model");
  assertEquals(body.type.normalized, "echo");
});

Deno.test("createModel returns 409 for duplicate name", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  // Create first model
  const firstRequest = new Request("http://localhost/api/v1/models/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "duplicate-name" }),
  });
  await handlers.createModel({
    request: firstRequest,
    params: { type: "echo" },
  });

  // Try to create another with same name
  const secondRequest = new Request("http://localhost/api/v1/models/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "duplicate-name" }),
  });
  const response = await handlers.createModel({
    request: secondRequest,
    params: { type: "echo" },
  });

  assertEquals(response.status, 409);
});

Deno.test("deleteModel returns 404 for nonexistent model", async () => {
  const repo = createMockRepository();
  const handlers = createModelsHandlers(repo);

  const request = new Request(
    "http://localhost/api/v1/models/echo/nonexistent",
    {
      method: "DELETE",
    },
  );
  const response = await handlers.deleteModel({
    request,
    params: { type: "echo", id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});
