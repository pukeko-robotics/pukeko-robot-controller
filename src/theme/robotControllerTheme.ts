// PLAT-22: the robot-controller app's theme, delivered through PLAT-23's
// `applyTheme` token seam (galvanized-pukeko/vue-ui) rather than forked
// component styles or hardcoded hex in this app's own component <style>
// blocks. Source: the 2026-07-14 colour-palette spike
// (`_spikes/2026-07-14-color-palette-spike/`, findings doc
// `docs/attention/2026-07-14-color-palette-brand-tokens.md`) for the
// colours/borders/gradients/styling *language*; positions/names are locked
// separately by EXT-6 and are NOT this file's concern.
//
// Two zones, two mechanisms (see the task report for the full rationale):
//
// 1. TUTOR_THEME — the light Tutor-chat zone. Applied via `applyTheme(...)`
//    scoped to the Tutor panel's root element (NOT global `:root`), because
//    that's the only zone where vue-ui components actually consume the
//    `--pk-color-*` token contract (ChatInterface, ToolCallBadge, PkButton's
//    danger variant). Every value below was checked for WCAG AA against the
//    surfaces it's actually painted on in THIS app (see the report for the
//    computed ratios) — a couple of brand hexes needed a darker sibling shade
//    to actually clear AA at the font sizes vue-ui renders them at:
//      - `info-text`: the raw Pilot teal (#0EA5E9) and even its own "hover"
//        shade (#0284C7) both fail AA (3.84:1 / 3.57:1) against the light
//        info-surface tints at ToolCallBadge's 0.85rem/500-weight header
//        text. Darkened to Tailwind sky-700 (#0369A1, 5.57:1 / 5.17:1) —
//        still unambiguously in the Pilot teal family, now AA-compliant.
//      - `danger` (#EF4444) is only ever painted as a UI-component fill
//        (the stop button's gradient background, with a small SVG glyph on
//        top) in this app, never as small body text — 3.76:1 on white clears
//        WCAG 1.4.11's 3:1 non-text threshold but NOT 1.4.3's 4.5:1 text
//        threshold. Anywhere actual small danger TEXT is needed, use
//        `danger-text` (#991B1B, 8.31:1) instead — that's what the token
//        exists for (mirrors vue-ui's own default theme split between
//        `danger` and `danger-text`).
//
// 2. Cockpit-zone-local CSS custom properties (`--rc-*`) — the dark Cockpit
//    zone. NOT applied via `applyTheme`/the `PkColorToken` contract: no
//    vue-ui component actually renders inside the Cockpit today
//    (`PkWebcamPanel` paints its own background from the *generic*
//    `--grey-13` var, not a `--pk-color-*` token), and the Cockpit's dark
//    palette doesn't semantically fit the `PkColorToken` contract's
//    light-theme-shaped fallback defaults anyway. Per the brief: "it's fine
//    to introduce robot-controller-local CSS custom properties alongside the
//    vue-ui token application" for exactly this kind of app-specific need.
//    Defined as plain scoped CSS in App.vue (on the `.cockpit` root) rather
//    than JS here, since — unlike the Tutor palette — nothing needs to swap
//    this at runtime. `COCKPIT_VARS` below is a documentation/report mirror
//    of those literal values, not the mechanism that applies them.
import type { PkTheme } from '@galvanized-pukeko/vue-ui'

export const TUTOR_THEME: PkTheme = {
  // Surfaces & structure
  '--pk-color-surface': '#FFFFFF',
  '--pk-color-surface-muted': '#F3F4F6',
  '--pk-color-surface-sunken': '#F9FAFB',
  '--pk-color-border': '#E5E7EB',
  // Text
  '--pk-color-text': '#111827',
  '--pk-color-text-muted': '#6B7280',
  '--pk-color-text-secondary': '#6B7280',
  // Primary / accent — Tutor identity (plumage indigo)
  '--pk-color-primary': '#4338CA',
  '--pk-color-on-primary': '#FFFFFF',
  '--pk-color-link': '#4338CA',
  // Danger — beak scarlet, reserved for errors/E-Stop only (never agent
  // identity — see META-5 DL-8). `danger` itself is a UI-component fill
  // (3:1 threshold); the *-strong/-hover/-text variants are darker Tailwind
  // red shades chosen so every actual usage clears real AA — see report.
  '--pk-color-danger': '#EF4444',
  '--pk-color-danger-strong': '#B91C1C',
  '--pk-color-danger-hover': '#DC2626',
  '--pk-color-danger-hover-strong': '#991B1B',
  '--pk-color-danger-text': '#991B1B',
  '--pk-color-danger-surface': '#FEF2F2',
  // Informational (tool-call badge family) — deliberately tinted with the
  // Pilot's teal-cyan rather than left at vue-ui's default blue: a
  // ToolCallBadge rendered in the Tutor chat is literally reporting a
  // Pilot tool call, so "teal = robot acting" (the findings doc's mental
  // model) carries into the one place Pilot activity surfaces in the Tutor
  // zone. info-text is darkened off the raw Pilot hex for AA — see above.
  '--pk-color-info-surface': '#F0F9FF',
  '--pk-color-info-surface-hover': '#E0F2FE',
  '--pk-color-info-border': '#BAE6FD',
  '--pk-color-info-text': '#0369A1',
}

/** Documentation mirror of the Cockpit zone's literal `--rc-*` values — the
 *  actual mechanism is plain scoped CSS on `.cockpit` in App.vue. Kept here
 *  so the two zones' full palettes are readable from one file. */
export const COCKPIT_VARS: Record<string, string> = {
  '--rc-cockpit-bg': '#13142A',
  '--rc-cockpit-surface': '#1A1B34',
  '--rc-cockpit-border': '#252740',
  '--rc-cockpit-text': '#E8E8F0',
  // AA-Large / non-text UI only (4.55:1 on --rc-cockpit-bg, 4.23:1 on
  // --rc-cockpit-surface — clears the 3:1 non-text/large-text floor but not
  // full-AA 4.5:1 body text on every cockpit surface). Never use for small
  // body text — use --rc-cockpit-text-secondary instead.
  '--rc-cockpit-text-muted': '#7B7DA0',
  // AA-compliant small secondary/body text for the Cockpit zone (6.21:1 /
  // 5.77:1) — not in the brief's palette table; added because the brief's
  // literal "muted" hex is AA-Large-only and this app needs small,
  // legible secondary text (status lines, tool tooltips) in the dark zone.
  '--rc-cockpit-text-secondary': '#9295B8',
  '--rc-pilot': '#0EA5E9',
  '--rc-pilot-hover': '#0284C7',
  '--rc-danger': '#EF4444',
  '--rc-success': '#22C55E',
  '--rc-warning': '#F59E0B',
}
