/**
 * HTTP handlers for model data API endpoints.
 *
 * Note: The legacy resource functionality has been deprecated.
 * Data is now handled through the unified data repository.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import { ModelType } from "../../../../src/domain/models/model_type.ts";
import type { UnifiedDataRepository } from "../../../../src/infrastructure/persistence/unified_data_repository.ts";

export function createResourcesHandlers(
  dataRepository: UnifiedDataRepository,
) {
  async function listResourcesByType(ctx: RouteContext): Promise<Response> {
    const typeParam = ctx.params.type;

    try {
      const _modelType = ModelType.create(typeParam);
      // The unified data repository doesn't support listing all data by type alone
      // It requires a model ID. This endpoint will return an empty list for now.
      return jsonResponse({ resources: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function getResource(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: _idParam } = ctx.params;

    try {
      const _modelType = ModelType.create(typeParam);
      // The unified data repository requires model ID and data name.
      // This endpoint would need to be redesigned to work with the new architecture.
      return errorResponse(
        "Resource lookup by ID is deprecated. Use the data API with model ID and data name.",
        410,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function deleteResource(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: _idParam } = ctx.params;

    try {
      const _modelType = ModelType.create(typeParam);
      // The unified data repository requires model ID and data name for deletion.
      return errorResponse(
        "Resource deletion by ID is deprecated. Use the data API with model ID and data name.",
        410,
      );
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
