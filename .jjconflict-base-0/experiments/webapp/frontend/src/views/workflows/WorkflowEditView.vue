<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  type Workflow,
} from "../../api/client";

const route = useRoute();
const router = useRouter();

const isNew = computed(() => route.name === "workflow-new");
const idParam = computed(() => route.params.id as string | undefined);

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

const form = ref({
  name: "",
  description: "",
  version: 1,
  jobsYaml: "[]",
});

onMounted(async () => {
  try {
    if (!isNew.value && idParam.value) {
      const workflow = await getWorkflow(idParam.value);
      form.value = {
        name: workflow.name,
        description: workflow.description || "",
        version: workflow.version,
        jobsYaml: JSON.stringify(workflow.jobs, null, 2),
      };
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load workflow";
  } finally {
    loading.value = false;
  }
});

async function handleSubmit() {
  saving.value = true;
  error.value = null;

  try {
    let jobs;
    try {
      jobs = JSON.parse(form.value.jobsYaml);
    } catch {
      throw new Error("Invalid JSON in jobs definition");
    }

    const input = {
      name: form.value.name,
      description: form.value.description || undefined,
      version: form.value.version,
      jobs,
    };

    let savedWorkflow: Workflow;
    if (isNew.value) {
      savedWorkflow = await createWorkflow(input);
    } else {
      savedWorkflow = await updateWorkflow(idParam.value!, input);
    }

    router.push({
      name: "workflow-detail",
      params: { id: savedWorkflow.id },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to save workflow";
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <RouterLink
        :to="isNew ? '/workflows' : { name: 'workflow-detail', params: { id: idParam } }"
        class="text-blue-600 hover:text-blue-800 text-sm"
      >
        &larr; Back
      </RouterLink>
    </div>

    <h1 class="text-3xl font-bold text-gray-900 mb-6">
      {{ isNew ? "Create Workflow" : "Edit Workflow" }}
    </h1>

    <div v-if="error" class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
      {{ error }}
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>

    <form v-else @submit.prevent="handleSubmit" class="bg-white rounded-lg shadow p-6 space-y-6">
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
        <label class="block text-sm font-medium text-gray-700 mb-1">Description</label>
        <textarea
          v-model="form.description"
          rows="2"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        ></textarea>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">Jobs (JSON)</label>
        <textarea
          v-model="form.jobsYaml"
          rows="20"
          class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
        ></textarea>
        <p class="mt-1 text-sm text-gray-500">
          Define jobs as a JSON array. Each job needs: name, steps array.
          Each step needs: name, task (type: "model_method" or "shell").
        </p>
      </div>

      <div class="flex justify-end space-x-4">
        <RouterLink
          :to="isNew ? '/workflows' : { name: 'workflow-detail', params: { id: idParam } }"
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
