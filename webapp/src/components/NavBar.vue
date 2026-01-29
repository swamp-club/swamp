<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <nav class="bg-gray-800 text-white shadow-lg">
    <div class="container mx-auto px-4">
      <div class="flex items-center justify-between h-16">
        <RouterLink to="/" class="flex items-center space-x-2">
          <span class="text-2xl font-bold text-green-400">Swamp</span>
        </RouterLink>

        <div class="flex items-center space-x-4">
          <RouterLink
            to="/"
            class="px-3 py-2 rounded-md text-sm font-medium hover:bg-gray-700 transition-colors"
            active-class="bg-gray-700"
          >
            Dashboard
          </RouterLink>
          <RouterLink
            to="/models"
            class="px-3 py-2 rounded-md text-sm font-medium hover:bg-gray-700 transition-colors"
            active-class="bg-gray-700"
          >
            Models
          </RouterLink>
          <RouterLink
            to="/workflows"
            class="px-3 py-2 rounded-md text-sm font-medium hover:bg-gray-700 transition-colors"
            active-class="bg-gray-700"
          >
            Workflows
          </RouterLink>
        </div>
      </div>
    </div>
  </nav>
</template>
