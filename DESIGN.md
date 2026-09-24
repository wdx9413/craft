---
version: alpha
name: Craft Studio
description: A dense local-first desktop workbench that treats every task as a continuing conversation, while retaining Craft's warm operational signature.
colors:
  background: "#FFFFFF"
  chrome: "rgb(249, 250, 251)"
  ink: "rgb(15, 17, 21)"
  muted: "rgb(97, 102, 107)"
  brand: "#B08A4E"
  link: "rgb(65, 118, 230)"
  success: "rgb(34, 197, 94)"
  warning: "rgb(221, 134, 41)"
  danger: "rgb(236, 19, 19)"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif'
  mono:
    fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, monospace'
rounded:
  micro: "6px"
  control: "8px"
  surface: "12px"
  menu: "20px"
  composer: "22px"
  pill: "999px"
spacing:
  titlebar: "40px; compact navigation and application menus only"
  statusbar: "24px"
  rail: "232px"
  aside: "280px"
components:
  shell: { chrome: "--bg-rail", divider: "--hair" }
  button: { focus: "--accent", radius: "--r2" }
  surface: { stroke: "--stroke", elevation: "--shadow-panel" }
  scrollbar: { thumb: "--scrollbar-thumb" }
---

# Craft Studio Design System

## Overview

### Creative North Star

DeepSeek Harness supplies the visual grammar: quiet blue-neutral surfaces, hairline separation, compact spatial rhythm and a single clear active state. Craft is not rebranded as DeepSeek: its warm khaki accent is reserved for work, focus and selection while blue remains informational.

### Product context and register

- **Audience and primary job:** Operators running, checking and resuming governed agent work from a local desktop workbench.
- **Locale(s) and language policy:** `zh-CN` and `en-US`; the primary Studio copy is concise Chinese with system and CJK font fallbacks.
- **Usage scene:** A desktop application used repeatedly beside terminals and editors; high information density is more valuable than decorative empty space.
- **Register:** Product.
- **Memorable signature:** A restrained three-column workbench around a single compact composer, rendered with translucent hairlines rather than card-heavy panels.
- **Restraint:** Tables, forms, activity and destructive actions use familiar product controls; no visual treatment may obscure execution state.
- **Anti-references:** Marketing gradients, oversized rounded cards and saturated blue-as-brand treatments are deliberately excluded.
- **Token ownership/runtime mapping:** `workbench/app.css` is canonical (Model B). The frontmatter mirrors `--bg*`, `--text*`, `--accent`, `--r*`, `--hair`, `--shadow*` and scrollbar tokens. `app.css` is served unchanged by `core/workbench-server.ts`; the Tauri sidecar preparation copies that same workbench through `desktop/scripts/prepare-sidecar.mjs`.

## Colors

Light and dark themes remap semantic variables under `html[data-theme]`; components consume variables only. `--bg-rail` aliases `--bg-chrome` so shell surfaces cannot drift. `--accent` is interactive, `--link` informational, and semantic feedback always carries text or an icon in addition to colour.

## Typography

The system sans stack prioritizes native rendering and CJK coverage. Interface text is 14px/22px; compact labels and technical values use the mono stack at 12px/19px. Heading contrast comes from modest weight and spacing rather than display typography.

## Layout

The shell owns the viewport and uses a 40px title bar, 24px status bar, 232px rail and 280px contextual aside. The title bar contains only rail/navigation controls and File/Edit/View/Help; the browser app host retains actual window controls. Both rail and contextual aside can collapse without changing content semantics. Each scrollable panel owns its overflow; loading and feedback preserve the surrounding geometry.

## Elevation & Depth

Default hierarchy is tonal plus a 0.5px hairline. Raised surfaces use `--stroke` with the smallest matching shadow; only palettes and sheets receive prominent elevation. The dark theme uses the same semantic levels with stronger occlusion shadows.

## Shapes

Radii are intentionally non-uniform: 6px micro details, 8px controls, 12px surfaces, 20px menus and 22px composer. Pills are only for inherently compact controls. Where supported, the interface uses a subtle superellipse corner shape.

## Components

Buttons, icon buttons, inputs, rows, tabs and palette items provide hover, active, disabled and visible keyboard focus states. Task threads use own-message/right and model-message/left alignment; activity remains a separate factual projection. Sheets replace browser dialogs, toast messages use one live region, secret fields are masked, and reduced motion collapses transitions. Scrollbars use globally inherited visible thumb styling.

## Do's and Don'ts

- **Do:** use semantic Studio tokens and the shared `app.css` shell across served and packaged surfaces.
- **Do:** make active work and keyboard focus unambiguous with accent plus non-colour affordances.
- **Don't:** introduce raw brand-blue controls or a screen-local theme.
- **Don't:** hide scrollbars, use browser dialogs, or let loading move the primary controls.
