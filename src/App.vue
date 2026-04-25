<script setup lang="ts">
import { ChatInterface } from '@galvanized-pukeko/vue-ui'
import WebcamPanel from './components/WebcamPanel.vue'
</script>

<template>
  <div class="robot-controller">
    <header class="robot-header">
      <h1>Pukeko Robot Controller</h1>
    </header>
    <main class="robot-panels">
      <section class="panel webcam-section">
        <h2>Camera Feed</h2>
        <WebcamPanel />
      </section>
      <section class="panel chat-section">
        <ChatInterface />
      </section>
    </main>
  </div>
</template>

<style scoped>
.robot-controller {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary, #1a1a2e);
  color: var(--text-primary, #e0e0e0);
}

.robot-header {
  padding: 0.75rem 1.5rem;
  background: var(--bg-secondary, #16213e);
  border-bottom: 1px solid var(--border-color, #0f3460);
}

.robot-header h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.robot-panels {
  flex: 1;
  display: flex;
  gap: 1rem;
  padding: 1rem;
  overflow: hidden;
}

.panel {
  flex: 1;
  min-width: 0;
  background: var(--bg-secondary, #16213e);
  border-radius: 8px;
  border: 1px solid var(--border-color, #0f3460);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.panel h2 {
  margin: 0;
  padding: 0.75rem 1rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-bottom: 1px solid var(--border-color, #0f3460);
}
</style>
