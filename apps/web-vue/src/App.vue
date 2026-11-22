<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";
import AppShell from "./components/AppShell.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import { useThemeStore } from "./stores/theme";

useThemeStore();
const route = useRoute();

const isAuthLayout = computed(() => route.meta.layout === "auth");
</script>

<template>
  <RouterView v-if="isAuthLayout" />
  <AppShell v-else>
    <RouterView v-slot="{ Component, route: r }">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 translate-y-1"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <component :is="Component" :key="r.path" />
      </Transition>
    </RouterView>
  </AppShell>
  <ToastHost />
</template>
