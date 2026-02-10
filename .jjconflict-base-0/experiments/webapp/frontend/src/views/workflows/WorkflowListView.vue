<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import DataTable from "../../components/DataTable.vue";
import { listWorkflows, type WorkflowSummary } from "../../api/client";

const router = useRouter();
const workflows = ref<WorkflowSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const columns = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "version", label: "Version" },
  { key: "jobCount", label: "Jobs" },
];

onMounted(async () => {
  try {
    workflows.value = await listWorkflows();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load workflows";
  } finally {
    loading.value = false;
  }
});

function handleRowClick(workflow: WorkflowSummary) {
  router.push({
    name: "workflow-detail",
    params: { id: workflow.id },
  });
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-3xl font-bold text-gray-900">Workflows</h1>
      <RouterLink
        to="/workflows/new"
        class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
      >
        Create Workflow
      </RouterLink>
    </div>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
      {{ error }}
    </div>

    <div class="bg-white rounded-lg shadow">
      <DataTable
        :columns="columns"
        :data="workflows"
        :loading="loading"
        empty-message="No workflows found"
        @row-click="handleRowClick"
      />
    </div>
  </div>
</template>
