<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  getModel,
  createModel,
  updateModel,
  listTypes,
  type Model,
  type ModelType,
} from "../../api/client";

const route = useRoute();
const router = useRouter();

const isNew = computed(() => route.name === "model-new");
const typeParam = computed(() => route.params.type as string | undefined);
const idParam = computed(() => route.params.id as string | undefined);

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const types = ref<ModelType[]>([]);

const form = ref({
  name: "",
  type: "",
  version: 1,
  tags: "",
  attributes: "{}",
});

onMounted(async () => {
  try {
    types.value = await listTypes();

    if (isNew.value) {
      form.value.type = typeParam.value || (types.value[0]?.normalized ?? "");
    } else if (typeParam.value && idParam.value) {
      const model = await getModel(typeParam.value, idParam.value);
      form.value = {
        name: model.name,
        type: model.type.normalized,
        version: model.version,
        tags: Object.entries(model.tags)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
        attributes: JSON.stringify(model.attributes, null, 2),
      };
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load data";
  } finally {
    loading.value = false;
  }
});

function parseTags(tagsStr: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const line of tagsStr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key) {
        tags[key.trim()] = valueParts.join("=").trim();
      }
    }
  }
  return tags;
}

async function handleSubmit() {
  saving.value = true;
  error.value = null;

  try {
    let attributes: Record<string, unknown>;
    try {
      attributes = JSON.parse(form.value.attributes);
    } catch {
      throw new Error("Invalid JSON in attributes");
    }

    const input = {
      name: form.value.name,
      version: form.value.version,
      tags: parseTags(form.value.tags),
      attributes,
    };

    let savedModel: Model;
    if (isNew.value) {
      savedModel = await createModel(form.value.type, input);
    } else {
      savedModel = await updateModel(typeParam.value!, idParam.value!, input);
    }

    router.push({
      name: "model-detail",
      params: { type: savedModel.type.normalized, id: savedModel.id },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to save model";
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <RouterLink
        :to="isNew ? '/models' : { name: 'model-detail', params: { type: typeParam, id: idParam } }"
        class="text-blue-600 hover:text-blue-800 text-sm"
      >
        &larr; Back
      </RouterLink>
    </div>

    <h1 class="text-3xl font-bold text-gray-900 mb-6">
      {{ isNew ? "Create Model" : "Edit Model" }}
    </h1>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <form v-else @submit.prevent="handleSubmit" class="bg-white rounded-lg shadow p-6 space-y-6">
      <div v-if="isNew">
        <label class="block text-sm font-medium text-gray-700 mb-1">Type</label>
        <select
          v-model="form.type"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        >
          <option v-for="t in types" :key="t.normalized" :value="t.normalized">
            {{ t.normalized }}
          </option>
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Name</label>
        <input
          v-model="form.name"
          type="text"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Version</label>
        <input
          v-model.number="form.version"
          type="number"
          min="1"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          Tags (one per line, key=value format)
        </label>
        <textarea
          v-model="form.tags"
          rows="3"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
          placeholder="env=prod&#10;team=platform"
        ></textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          Attributes (JSON)
        </label>
        <textarea
          v-model="form.attributes"
          rows="10"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
        ></textarea>
      </div>

      <div class="flex justify-end space-x-4">
        <RouterLink
          :to="isNew ? '/models' : { name: 'model-detail', params: { type: typeParam, id: idParam } }"
          class="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </RouterLink>
        <button
          type="submit"
          :disabled="saving"
          class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {{ saving ? "Saving..." : "Save" }}
        </button>
      </div>
    </form>
  </div>
</template>
