import '@galvanized-pukeko/vue-ui/style.css'
// PLAT-13: the headless CopilotKit engine's stylesheets — CopilotKit's own,
// plus the /copilot bundle's extracted scoped styles (HeadlessChat et al.).
// Same pair the galvanized web-client loads for its CopilotKit-backed modes.
import '@copilotkit/vue/styles.css'
import '@galvanized-pukeko/vue-ui/copilot/style.css'

import { createApp } from 'vue'
import App from './App.vue'

import { configService } from '@galvanized-pukeko/vue-ui'

async function init() {
  await configService.load()
  createApp(App).mount('#app')
}

init()
