<script setup lang="ts">
// EXT-6: Robot's Brains — the panel directly below the camera viewport
// showing the Pilot's system prompt / options (e.g. middlewares) and a `>`
// command input, per the registered mockup. Distinct from the Tool Belt:
// belt = tools, brains = prompt (see the EXT-6 graph node).
//
// `systemPrompt` is the REAL behavioural prompt (system-prompt.md, baked in
// at build time — see vite.config.ts / env.d.ts), not placeholder text.
// `middlewareHint` is a static string sourced from pukeko.config.example.ts's
// own "Unified middleware stack — the same on every profile" comment
// (frontend-images/context-pruner/observability); there is no endpoint that
// exposes the *running* server's actual middleware list to the browser, so
// this is a presentational readout, not a live one — see the report.
defineProps<{
  presetName: string
  agentLabel: string
  systemPrompt: string
}>()

const MIDDLEWARE_HINT = 'frontend-images · context-pruner · observability'
</script>

<template>
  <section class="robots-brains" aria-label="Robot's Brains">
    <div class="brains-header">
      <span class="brains-dot" aria-hidden="true" />
      <span class="brains-name">Pilot</span>
      <span class="brains-status">
        {{ presetName }}<template v-if="agentLabel"> · {{ agentLabel }}</template>
      </span>
      <span class="brains-tag">Robot's Brains</span>
    </div>

    <div class="brains-section">
      <div class="brains-section-label">System prompt</div>
      <pre class="brains-prompt">{{ systemPrompt || '(system-prompt.md not found)' }}</pre>
    </div>

    <div class="brains-section brains-options">
      <div class="brains-section-label">Options</div>
      <div class="brains-options-value">{{ MIDDLEWARE_HINT }}</div>
    </div>

    <div class="brains-cmd">
      <span class="brains-cmd-caret" aria-hidden="true">&gt;</span>
      <input
        class="brains-cmd-input"
        type="text"
        placeholder="Command the Pilot directly… (coming soon)"
        disabled
        aria-label="Command the Pilot directly (not yet implemented)"
      />
    </div>
  </section>
</template>

<style scoped>
.robots-brains {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--rc-cockpit-surface, #1a1b34);
  border-top: 1px solid var(--rc-cockpit-border, #252740);
  color: var(--rc-cockpit-text, #e8e8f0);
  min-height: 0;
  max-height: 42%;
}

.brains-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.9rem 0.4rem;
  flex: 0 0 auto;
}

.brains-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--rc-pilot, #0ea5e9);
  flex-shrink: 0;
}

.brains-name {
  font-size: 0.8rem;
  font-weight: 800;
  color: var(--rc-pilot, #0ea5e9);
}

.brains-status {
  font-size: 0.75rem;
  color: var(--rc-cockpit-text-secondary, #9295b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brains-tag {
  margin-left: auto;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  /* AA-safe text-secondary, not the AA-Large-only --rc-cockpit-text-muted —
     this label is small (see WCAG note in the report). */
  color: var(--rc-cockpit-text-secondary, #9295b8);
  text-transform: uppercase;
  flex-shrink: 0;
}

.brains-section {
  padding: 0 0.9rem 0.5rem;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.brains-section-label {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--rc-cockpit-text-secondary, #9295b8);
  margin-bottom: 0.25rem;
  flex: 0 0 auto;
}

.brains-prompt {
  margin: 0;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
  font-size: 0.68rem;
  line-height: 1.45;
  color: var(--rc-cockpit-text, #e8e8f0);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  min-height: 0;
  flex: 1 1 auto;
  background: var(--rc-cockpit-bg, #13142a);
  border: 1px solid var(--rc-cockpit-border, #252740);
  border-radius: 0.375rem;
  padding: 0.5rem;
}

.brains-options {
  flex: 0 0 auto;
}

.brains-options-value {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
  font-size: 0.7rem;
  color: var(--rc-cockpit-text-secondary, #9295b8);
}

.brains-cmd {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.9rem 0.7rem;
  border-top: 1px solid var(--rc-cockpit-border, #252740);
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
  font-size: 0.75rem;
}

.brains-cmd-caret {
  color: var(--rc-pilot, #0ea5e9);
  font-weight: 700;
}

.brains-cmd-input {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--rc-cockpit-text, #e8e8f0);
  font: inherit;
}

.brains-cmd-input::placeholder {
  color: var(--rc-cockpit-text-muted, #7b7da0);
}

.brains-cmd-input:disabled {
  cursor: not-allowed;
}
</style>
