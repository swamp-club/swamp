/**
 * HTTP handlers for model inputs API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import { ModelType } from "../../../domain/models/model_type.ts";
import {
  createModelInputId,
  ModelInput,
} from "../../../domain/models/model_input.ts";
import type { InputRepository } from "../../../domain/models/repositories.ts";

export function createModelsHandlers(inputRepository: InputRepository) {
  async function listAllModels(_ctx: RouteContext): Promise<Response> {
    const allInputs = await inputRepository.findAllGlobal();

    const models = allInputs.map(({ input, type }) => ({
      id: input.id,
      name: input.name,
      type: { raw: type.raw, normalized: type.normalized },
      version: input.version,
      resourceId: input.resourceId,
      tags: input.tags,
      attributes: input.attributes,
    }));

    return jsonResponse({ models });
  }

  async function listModelsByType(ctx: RouteContext): Promise<Response> {
    const typeParam = ctx.params.type;

    try {
      const modelType = ModelType.create(typeParam);
      const inputs = await inputRepository.findAll(modelType);

      const models = inputs.map((input) => ({
        id: input.id,
        name: input.name,
        type: { raw: modelType.raw, normalized: modelType.normalized },
        version: input.version,
        resourceId: input.resourceId,
        tags: input.tags,
        attributes: input.attributes,
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
      const id = createModelInputId(idParam);
      const input = await inputRepository.findById(modelType, id);

      if (!input) {
        return errorResponse("Model input not found", 404);
      }

      return jsonResponse({
        id: input.id,
        name: input.name,
        type: { raw: modelType.raw, normalized: modelType.normalized },
        version: input.version,
        resourceId: input.resourceId,
        tags: input.tags,
        attributes: input.attributes,
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
        const existing = await inputRepository.findByNameGlobal(body.name);
        if (existing) {
          return errorResponse(
            `Model with name '${body.name}' already exists`,
            409,
          );
        }
      }

      const input = ModelInput.create({
        name: body.name,
        version: body.version,
        resourceId: body.resourceId,
        tags: body.tags,
        attributes: body.attributes,
      });

      await inputRepository.save(modelType, input);

      return jsonResponse(
        {
          id: input.id,
          name: input.name,
          type: { raw: modelType.raw, normalized: modelType.normalized },
          version: input.version,
          resourceId: input.resourceId,
          tags: input.tags,
          attributes: input.attributes,
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
      const id = createModelInputId(idParam);

      const existing = await inputRepository.findById(modelType, id);
      if (!existing) {
        return errorResponse("Model input not found", 404);
      }

      const body = await ctx.request.json();

      if (body.name && body.name !== existing.name) {
        const existingWithName = await inputRepository.findByNameGlobal(
          body.name,
        );
        if (existingWithName) {
          return errorResponse(
            `Model with name '${body.name}' already exists`,
            409,
          );
        }
      }

      const updated = ModelInput.create({
        id: existing.id,
        name: body.name ?? existing.name,
        version: body.version ?? existing.version,
        resourceId: body.resourceId ?? existing.resourceId,
        tags: body.tags ?? existing.tags,
        attributes: body.attributes ?? existing.attributes,
      });

      await inputRepository.save(modelType, updated);

      return jsonResponse({
        id: updated.id,
        name: updated.name,
        type: { raw: modelType.raw, normalized: modelType.normalized },
        version: updated.version,
        resourceId: updated.resourceId,
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
      const id = createModelInputId(idParam);

      const existing = await inputRepository.findById(modelType, id);
      if (!existing) {
        return errorResponse("Model input not found", 404);
      }

      await inputRepository.delete(modelType, id);

      return new Response(null, { status: 204 });
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
  };
}
