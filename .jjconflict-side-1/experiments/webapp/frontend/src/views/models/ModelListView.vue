<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import DataTable from "../../components/DataTable.vue";
import { listAllModels, type Model } from "../../api/client";

const router = useRouter();
const models = ref<Model[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const columns = [
  { key: "name", label: "Name" },
  { key: "type.normalized", label: "Type" },
  { key: "version", label: "Version" },
  {
    key: "tags",
    label: "Tags",
    format: (value: unknown) => {
      const tags = value as Record<string, string>;
      return Object.keys(tags).length > 0
        ? Object.entries(tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "-";
    },
  },
];

onMounted(async () => {
  try {
    models.value = await listAllModels();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load models";
  } finally {
    loading.value = false;
  }
});

function handleRowClick(model: Model) {
  router.push({
    name: "model-detail",
    params: { type: model.type.normalized, id: model.id },
  });
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-3xl font-bold text-gray-900">Models</h1>
    </div>

    <div
      v-if="error"
      class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6"
    >
      {{ error }}
    </div>

    <div class="bg-white rounded-lg shadow">
      <DataTable
        :columns="columns"
        :data="models"
        :loading="loading"
        empty-message="No models found"
        @row-click="handleRowClick"
      />
    </div>
  </div>
</template>
