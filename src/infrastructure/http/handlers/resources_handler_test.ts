import { assertEquals } from "@std/assert";
import { createResourcesHandlers } from "./resources_handler.ts";
import type { ResourceRepository } from "../../../domain/models/repositories.ts";
import type { ModelType } from "../../../domain/models/model_type.ts";
import type {
  ModelResource,
  ModelResourceId,
} from "../../../domain/models/model_resource.ts";

// Mock repository for testing
function createMockRepository(
  resources: { resource: ModelResource; type: ModelType }[] = [],
): ResourceRepository {
  const storage = new Map<
    string,
    { resource: ModelResource; type: ModelType }
  >();

  for (const item of resources) {
    storage.set(item.resource.id, item);
  }

  return {
    findById(
      type: ModelType,
      id: ModelResourceId,
    ): Promise<ModelResource | null> {
      const item = storage.get(id);
      if (item && item.type.normalized === type.normalized) {
        return Promise.resolve(item.resource);
      }
      return Promise.resolve(null);
    },

    findAll(type: ModelType): Promise<ModelResource[]> {
      const result = Array.from(storage.values())
        .filter((item) => item.type.normalized === type.normalized)
        .map((item) => item.resource);
      return Promise.resolve(result);
    },

    save(type: ModelType, resource: ModelResource): Promise<void> {
      storage.set(resource.id, { resource, type });
      return Promise.resolve();
    },

    delete(_type: ModelType, id: ModelResourceId): Promise<void> {
      storage.delete(id);
      return Promise.resolve();
    },

    nextId(): ModelResourceId {
      return crypto.randomUUID() as ModelResourceId;
    },

    getPath(_type: ModelType, id: ModelResourceId): string {
      return `/test/resources/${id}.yaml`;
    },
  };
}

Deno.test("listResourcesByType returns empty array when no resources", async () => {
  const repo = createMockRepository();
  const handlers = createResourcesHandlers(repo);

  const request = new Request("http://localhost/api/v1/resources/echo");
  const response = await handlers.listResourcesByType({
    request,
    params: { type: "echo" },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.resources, []);
});

Deno.test("listResourcesByType returns 400 for empty type", async () => {
  const repo = createMockRepository();
  const handlers = createResourcesHandlers(repo);

  const request = new Request("http://localhost/api/v1/resources/");
  const response = await handlers.listResourcesByType({
    request,
    params: { type: "" },
  });

  assertEquals(response.status, 400);
});

Deno.test("getResource returns 404 when resource not found", async () => {
  const repo = createMockRepository();
  const handlers = createResourcesHandlers(repo);

  const request = new Request(
    "http://localhost/api/v1/resources/echo/nonexistent",
  );
  const response = await handlers.getResource({
    request,
    params: { type: "echo", id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});

Deno.test("deleteResource returns 404 for nonexistent resource", async () => {
  const repo = createMockRepository();
  const handlers = createResourcesHandlers(repo);

  const request = new Request(
    "http://localhost/api/v1/resources/echo/nonexistent",
    { method: "DELETE" },
  );
  const response = await handlers.deleteResource({
    request,
    params: { type: "echo", id: "nonexistent" },
  });

  assertEquals(response.status, 404);
});
