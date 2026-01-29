<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getWorkflow, deleteWorkflow, type Workflow } from "../../api/client";

const route = useRoute();
const router = useRouter();
const workflow = ref<Workflow | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const deleting = ref(false);

const idParam = route.params.id as string;

onMounted(async () => {
  try {
    workflow.value = await getWorkflow(idParam);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load workflow";
  } finally {
    loading.value = false;
  }
});

async function handleDelete() {
  if (!confirm("Are you sure you want to delete this workflow?")) return;

  deleting.value = true;
  try {
    await deleteWorkflow(idParam);
    router.push({ name: "workflows" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to delete workflow";
    deleting.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <RouterLink to="/workflows" class="text-blue-600 hover:text-blue-800 text-sm">
        &larr; Back to Workflows
      </RouterLink>
    </div>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <div v-else-if="workflow" class="space-y-6">
      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <div class="flex items-center justify-between">
            <h1 class="text-2xl font-bold text-gray-900">{{ workflow.name }}</h1>
            <div class="space-x-2">
              <RouterLink
                :to="{ name: 'workflow-edit', params: { id: idParam } }"
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
              <div class="mt-1 text-sm text-gray-900 font-mono">{{ workflow.id }}</div>
            </div>
            <div>
              <div class="text-sm font-medium text-gray-500">Version</div>
              <div class="mt-1 text-sm text-gray-900">{{ workflow.version }}</div>
            </div>
          </div>

          <div v-if="workflow.description">
            <div class="text-sm font-medium text-gray-500">Description</div>
            <div class="mt-1 text-sm text-gray-900">{{ workflow.description }}</div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-semibold text-gray-900">Jobs ({{ workflow.jobs.length }})</h2>
        </div>
        <div class="divide-y divide-gray-200">
          <div v-for="job in workflow.jobs" :key="job.name" class="p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-md font-medium text-gray-900">{{ job.name }}</h3>
              <span class="text-sm text-gray-500">{{ job.steps.length }} step(s)</span>
            </div>
            <p v-if="job.description" class="text-sm text-gray-600 mb-4">{{ job.description }}</p>

            <div class="space-y-3">
              <div v-for="step in job.steps" :key="step.name" class="bg-gray-50 rounded p-3">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium text-gray-800">{{ step.name }}</span>
                  <span class="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
                    {{ step.task.type }}
                  </span>
                </div>
                <div v-if="step.task.type === 'model_method'" class="text-xs text-gray-600 mt-1">
                  {{ step.task.modelIdOrName }}.{{ step.task.methodName }}()
                </div>
                <div v-else-if="step.task.type === 'shell'" class="text-xs text-gray-600 mt-1 font-mono">
                  {{ step.task.command }} {{ (step.task.args || []).join(' ') }}
                </div>
              </div>
            </div>
          </div>

          <div v-if="workflow.jobs.length === 0" class="p-6 text-center text-gray-500">
            No jobs defined
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
