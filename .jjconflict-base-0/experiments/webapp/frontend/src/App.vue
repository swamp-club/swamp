<script setup lang="ts">
import NavBar from "./components/NavBar.vue";
</script>

<template>
  <div class="min-h-screen">
    <NavBar />
    <main class="container mx-auto px-4 py-8">
      <RouterView />
    </main>
  </div>
</template>
