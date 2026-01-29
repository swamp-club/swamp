<script setup lang="ts" generic="T extends Record<string, unknown>">
defineProps<{
  columns: Array<{
    key: string;
    label: string;
    format?: (value: unknown, row: T) => string;
  }>;
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
}>();

defineEmits<{
  rowClick: [row: T];
}>();

function getValue(row: T, key: string): unknown {
  const keys = key.split(".");
  let value: unknown = row;
  for (const k of keys) {
    if (value && typeof value === "object" && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return value;
}

function formatValue(
  value: unknown,
  row: T,
  format?: (value: unknown, row: T) => string,
): string {
  if (format) {
    return format(value, row);
  }
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="min-w-full divide-y divide-gray-200">
      <thead class="bg-gray-50">
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        <tr v-if="loading">
          <td
            :colspan="columns.length"
            class="px-6 py-4 text-center text-gray-500"
          >
            Loading...
          </td>
        </tr>
        <tr v-else-if="data.length === 0">
          <td
            :colspan="columns.length"
            class="px-6 py-4 text-center text-gray-500"
          >
            {{ emptyMessage || "No data available" }}
          </td>
        </tr>
        <tr
          v-else
          v-for="(row, index) in data"
          :key="index"
          class="hover:bg-gray-50 cursor-pointer transition-colors"
          @click="$emit('rowClick', row)"
        >
          <td
            v-for="column in columns"
            :key="column.key"
            class="px-6 py-4 whitespace-nowrap text-sm text-gray-900"
          >
            {{ formatValue(getValue(row, column.key), row, column.format) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
