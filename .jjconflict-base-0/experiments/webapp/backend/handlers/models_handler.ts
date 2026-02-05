/**
 * HTTP handlers for model definitions API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import { ModelType } from "../../../../src/domain/models/model_type.ts";
import {
  createDefinitionId,
  Definition,
} from "../../../../src/domain/definitions/definition.ts";
import type { DefinitionRepository } from "../../../../src/domain/definitions/repositories.ts";
import { findDefinitionByIdGlobal } from "../../../../src/domain/models/model_lookup.ts";
import type { YamlDefinitionRepository } from "../../../../src/infrastructure/persistence/yaml_definition_repository.ts";

export function createModelsHandlers(definitionRepository: DefinitionRepository) {
  async function listAllModels(_ctx: RouteContext): Promise<Response> {
    const allDefinitions = await definitionRepository.findAllGlobal();

    const models = allDefinitions.map(({ definition, type }) => ({
      id: definition.id,
      name: definition.name,
      type: { raw: type.raw, normalized: type.normalized },
      version: definition.version,
      tags: definition.tags,
      attributes: definition.attributes,
    }));

    return jsonResponse({ models });
  }

  async function listModelsByType(ctx: RouteContext): Promise<Response> {
    const typeParam = ctx.params.type;

    try {
      const modelType = ModelType.create(typeParam);
      const definitions = await definitionRepository.findAll(modelType);

      const models = definitions.map((definition) => ({
        id: definition.id,
        name: definition.name,
        type: { raw: modelType.raw, normalized: modelType.normalized },
        version: definition.version,
        tags: definition.tags,
        attributes: definition.attributes,
      }));

      return jsonResponse({ models });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function getModel(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: idParam } = ctx.params;

    try {
      const modelType = ModelType.create(typeParam);
      const id = createDefinitionId(idParam);
      const definition = await definitionRepository.findById(modelType, id);

      if (!definition) {
        return errorResponse("Model definition not found", 404);
      }

      return jsonResponse({
        id: definition.id,
        name: definition.name,
        type: { raw: modelType.raw, normalized: modelType.normalized },
        version: definition.version,
        tags: definition.tags,
        attributes: definition.attributes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function createModel(ctx: RouteContext): Promise<Response> {
    const typeParam = ctx.params.type;

    try {
      const modelType = ModelType.create(typeParam);
      const body = await ctx.request.json();

      if (body.name) {
        const existing = await definitionRepository.findByNameGlobal(body.name);
        if (existing) {
          return errorResponse(
            `Model with name '${body.name}' already exists`,
            409,
          );
        }
      }

      const definition = Definition.create({
        name: body.name,
        version: body.version,
        tags: body.tags,
        attributes: body.attributes,
      });

      await definitionRepository.save(modelType, definition);

      return jsonResponse(
        {
          id: definition.id,
          name: definition.name,
          type: { raw: modelType.raw, normalized: modelType.normalized },
          version: definition.version,
          tags: definition.tags,
          attributes: definition.attributes,
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function updateModel(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: idParam } = ctx.params;

    try {
      const modelType = ModelType.create(typeParam);
      const id = createDefinitionId(idParam);

      const existing = await definitionRepository.findById(modelType, id);
      if (!existing) {
        return errorResponse("Model definition not found", 404);
      }

      const body = await ctx.request.json();

      if (body.name && body.name !== existing.name) {
        const existingWithName = await definitionRepository.findByNameGlobal(
          body.name,
        );
        if (existingWithName) {
          return errorResponse(
            `Model with name '${body.name}' already exists`,
            409,
          );
        }
      }

      const updated = Definition.create({
        id: existing.id,
        name: body.name ?? existing.name,
        version: body.version ?? existing.version,
        tags: body.tags ?? existing.tags,
        attributes: body.attributes ?? existing.attributes,
      });

      await definitionRepository.save(modelType, updated);

      return jsonResponse({
        id: updated.id,
        name: updated.name,
        type: { raw: modelType.raw, normalized: modelType.normalized },
        version: updated.version,
        tags: updated.tags,
        attributes: updated.attributes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function deleteModel(ctx: RouteContext): Promise<Response> {
    const { type: typeParam, id: idParam } = ctx.params;

    try {
      const modelType = ModelType.create(typeParam);
      const id = createDefinitionId(idParam);

      const existing = await definitionRepository.findById(modelType, id);
      if (!existing) {
        return errorResponse("Model definition not found", 404);
      }

      await definitionRepository.delete(modelType, id);

      return new Response(null, { status: 204 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  async function lookupModelById(ctx: RouteContext): Promise<Response> {
    const { id: idParam } = ctx.params;

    try {
      // Try by name first (most common case in workflows)
      const byName = await definitionRepository.findByNameGlobal(idParam);
      if (byName) {
        return jsonResponse({
          id: byName.definition.id,
          type: byName.type.normalized,
          name: byName.definition.name,
        });
      }

      // Fall back to searching by ID
      const byId = await findDefinitionByIdGlobal(
        definitionRepository as YamlDefinitionRepository,
        idParam,
      );
      if (byId) {
        return jsonResponse({
          id: byId.definition.id,
          type: byId.type.normalized,
          name: byId.definition.name,
        });
      }

      return errorResponse("Model not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(message, 400);
    }
  }

  return {
    listAllModels,
    listModelsByType,
    getModel,
    createModel,
    updateModel,
    deleteModel,
    lookupModelById,
  };
}
