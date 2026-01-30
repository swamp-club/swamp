/**
 * HTTP handlers for model resources API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import type { ResourceRepository } from "../../../../src/domain/models/repositories.ts";
import { ModelType } from "../../../../src/domain/models/model_type.ts";
import { createModelResourceId } from "../../../../src/domain/models/model_resource.ts";

export function createResourcesHandlers(
  resourceRepository: ResourceRepository,
) {
  async function listResourcesByType(ctx: RouteContext): Promise<Response> {
    const typeParam = ctx.params.type;

    try {
      const modelType = ModelType.create(typeParam);
      const resources = await resourceRepository.findAll(modelType);

      const result = resources.map((resource) => ({
        id: resource.id,
        version: resource.version,
        createdAt: resource.createdAt.toISOString(),
        attributes: resource.attributes,
      }));

      return jsonResponse({ resources: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function getResource(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: idParam } = ctx.params;

    try {
      const modelType = ModelType.create(typeParam);
      const id = createModelResourceId(idParam);
      const resource = await resourceRepository.findById(modelType, id);

      if (!resource) {
        return errorResponse("Resource not found", 404);
      }

      return jsonResponse({
        id: resource.id,
        version: resource.version,
        createdAt: resource.createdAt.toISOString(),
        attributes: resource.attributes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function deleteResource(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: idParam } = ctx.params;

    try {
      const modelType = ModelType.create(typeParam);
      const id = createModelResourceId(idParam);

      const existing = await resourceRepository.findById(modelType, id);
      if (!existing) {
        return errorResponse("Resource not found", 404);
      }

      await resourceRepository.delete(modelType, id);

      return new Response(null, { status: 204 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  return {
    listResourcesByType,
    getResource,
    deleteResource,
  };
}
