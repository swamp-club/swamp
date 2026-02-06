<script setup lang="ts">
import { ref, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { listAllModels, listWorkflows, listTypes } from "../api/client";

const modelCount = ref(0);
const workflowCount = ref(0);
const typeCount = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const [models, workflows, types] = await Promise.all([
      listAllModels(),
      listWorkflows(),
      listTypes(),
    ]);
    modelCount.value = models.length;
    workflowCount.value = workflows.length;
    typeCount.value = types.length;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load data";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <h1 class="text-3xl font-bold text-gray-900 mb-8">Dashboard</h1>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-8">
      {{ error }}
    </div>

    <div v-else-if="loading" class="text-gray-500">Loading...</div>

    <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <RouterLink
        to="/models"
        class="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow"
      >
        <div class="text-sm font-medium text-gray-500 uppercase tracking-wider">
          Models
        </div>
        <div class="mt-2 text-3xl font-bold text-gray-900">
          {{ modelCount }}
        </div>
        <div class="mt-2 text-sm text-gray-600">
          Model inputs in repository
        </div>
      </RouterLink>

      <RouterLink
        to="/workflows"
        class="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow"
      >
        <div class="text-sm font-medium text-gray-500 uppercase tracking-wider">
          Workflows
        </div>
        <div class="mt-2 text-3xl font-bold text-gray-900">
          {{ workflowCount }}
        </div>
        <div class="mt-2 text-sm text-gray-600">
          Workflow definitions
        </div>
      </RouterLink>

      <div class="bg-white rounded-lg shadow-md p-6">
        <div class="text-sm font-medium text-gray-500 uppercase tracking-wider">
          Types
        </div>
        <div class="mt-2 text-3xl font-bold text-gray-900">
          {{ typeCount }}
        </div>
        <div class="mt-2 text-sm text-gray-600">
          Registered model types
        </div>
      </div>
    </div>
  </div>
</template>
