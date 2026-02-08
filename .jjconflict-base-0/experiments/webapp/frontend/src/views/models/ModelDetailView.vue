<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getModel, deleteModel, type Model } from "../../api/client";

const route = useRoute();
const router = useRouter();
const model = ref<Model | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const deleting = ref(false);

const typeParam = route.params.type as string;
const idParam = route.params.id as string;

onMounted(async () => {
  try {
    model.value = await getModel(typeParam, idParam);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load model";
  } finally {
    loading.value = false;
  }
});

async function handleDelete() {
  if (!confirm("Are you sure you want to delete this model?")) return;

  deleting.value = true;
  try {
    await deleteModel(typeParam, idParam);
    router.push({ name: "models" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to delete model";
    deleting.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <RouterLink to="/models" class="text-blue-600 hover:text-blue-800 text-sm">
        &larr; Back to Models
      </RouterLink>
    </div>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <div v-else-if="model" class="bg-white rounded-lg shadow">
      <div class="px-6 py-4 border-b border-gray-200">
        <div class="flex items-center justify-between">
          <h1 class="text-2xl font-bold text-gray-900">{{ model.name }}</h1>
          <div class="space-x-2">
            <RouterLink
              :to="{ name: 'model-edit', params: { type: typeParam, id: idParam } }"
              class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Edit
            </RouterLink>
            <button
              @click="handleDelete"
              :disabled="deleting"
              class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {{ deleting ? "Deleting..." : "Delete" }}
            </button>
          </div>
        </div>
      </div>

      <div class="p-6 space-y-6">
        <div class="grid grid-cols-2 gap-6">
          <div>
            <div class="text-sm font-medium text-gray-500">ID</div>
            <div class="mt-1 text-sm text-gray-900 font-mono">{{ model.id }}</div>
          </div>
          <div>
            <div class="text-sm font-medium text-gray-500">Type</div>
            <div class="mt-1 text-sm text-gray-900">{{ model.type.normalized }}</div>
          </div>
          <div>
            <div class="text-sm font-medium text-gray-500">Version</div>
            <div class="mt-1 text-sm text-gray-900">{{ model.version }}</div>
          </div>
          <div>
            <div class="text-sm font-medium text-gray-500">Resource ID</div>
            <div class="mt-1 text-sm text-gray-900 font-mono">
              {{ model.resourceId || "-" }}
            </div>
          </div>
        </div>

        <div>
          <div class="text-sm font-medium text-gray-500 mb-2">Tags</div>
          <div v-if="Object.keys(model.tags).length === 0" class="text-sm text-gray-500">
            No tags
          </div>
          <div v-else class="flex flex-wrap gap-2">
            <span
              v-for="(value, key) in model.tags"
              :key="key"
              class="px-2 py-1 bg-gray-100 text-gray-700 rounded text-sm"
            >
              {{ key }}={{ value }}
            </span>
          </div>
        </div>

        <div>
          <div class="text-sm font-medium text-gray-500 mb-2">Attributes</div>
          <pre class="bg-gray-50 p-4 rounded text-sm overflow-auto">{{ JSON.stringify(model.attributes, null, 2) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
