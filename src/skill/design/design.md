# Frontend Design -- Evaluation & Implementation Guide

This file is referenced from SKILL.md for `/story design` commands and when working on UI tickets.

**Skill command name:** When this file references `/story` in user-facing output, use the actual command that invoked you (e.g., `/story design` for standalone install, `/story:go design` for plugin install).

## Evaluation Mode (/story design)

When invoked via `/story design`:

1. **Detect platform** from project code:
   - package.json with react/next/vue/angular/svelte deps -> web
   - .xcodeproj or SwiftUI imports -> macOS (check for iOS targets -> ios)
   - build.gradle.kts + AndroidManifest.xml -> android
   - pubspec.yaml -> flutter (ask which platform target)
   - **Multi-platform**: If multiple platform indicators found, ask via AskUserQuestion which platform(s) to evaluate. Allow multiple passes. Scope scanning to the relevant app/package paths, not the whole repo.
   - If no frontend code detected, tell the user and exit gracefully.

2. **Accept platform override**: `/story design web`, `/story design ios`, `/story design macos`, `/story design android`.

3. **Load platform reference**: Read `references/<platform>.md` in the same directory as this file. If not found, tell the user to run `claudestory setup-skill` to update skill files.

4. **Check existing design issues**: Before creating new issues, list existing open issues with component "design" (via `claudestory_issue_list` MCP tool or `claudestory issue list --component design` CLI). Match findings against existing issues by title and location. Update existing issues instead of creating duplicates. Mark resolved issues when the underlying code no longer violates the rule.

5. **Scan UI code**: Read component files, layout files, style files, routing. Evaluate against the principles in this file AND the loaded platform reference. Check: hierarchy, state completeness, accessibility, design system consistency, typography, color system, layout, motion, anti-patterns.

6. **Output findings** (three-tier fallback):
   - If claudestory MCP tools available: create/update issues via `claudestory_issue_create` and `claudestory_issue_update` (severity based on priority order, components: `["design", "<platform>"]`, location: file paths with line numbers)
   - If MCP unavailable but claudestory CLI installed: use `claudestory issue create` and `claudestory issue update` via Bash
   - If neither available: output markdown checklist grouped by severity

7. **Present summary**: Show a table of findings grouped by severity (critical, high, medium, low), then use AskUserQuestion:
   - question: "What would you like to do?"
   - header: "Design"
   - options:
     - "Fix the most critical issue (Recommended)" -- start working on the highest-severity finding
     - "See detailed rationale for a finding" -- explain why a specific finding matters
     - "Done for now" -- return to normal session

## Implementation Guidance Mode

When working on UI tickets (not explicit `/story design` invocation), use the principles below and the relevant platform reference to guide implementation. Do not output the design reasoning unless the user explicitly asks for a design review or rationale. Go straight to high-quality implementation.

---

## Platform Routing

After reading this file, also read the platform-specific reference for the target:

- **Web** -> `references/web.md`
- **macOS / Desktop** -> `references/macos.md`
- **iOS** -> `references/ios.md`
- **Android** -> `references/android.md`
- **Flutter** -> ask which target platform(s), then read the corresponding reference(s): `references/ios.md` for iOS, `references/android.md` for Android, `references/web.md` for web
- **React Native** -> read both `references/ios.md` and `references/android.md`

If the platform is ambiguous, infer from context. Default to web only when the request is clearly browser or UI artifact oriented. If multi-platform, read all relevant references.

## Stack Handling

Implementation stacks are handled in this file. Platform-specific behavior is handled in references/*.md. Do not let cross-platform code-sharing override target platform fit.

---

## Prime Directive

Clarity before flair.

A user must quickly understand: where they are, what matters most, what they can do next, what changed, and what to do when something goes wrong.

If the interface looks impressive but creates hesitation, confusion, or false affordances, it failed.

---

## Operating Mode

Before designing, determine silently:

- **Product goal** -- What problem is this interface solving?
- **Primary user** -- Who is using it, and in what context?
- **Main task** -- What is the single most important thing the user needs to accomplish here?
- **Target platform** -- Web, macOS/desktop, iOS, Android, or multi-platform?
- **Implementation stack** -- Native, React Native, Flutter, Web React/Next, or other?
- **Content shape** -- Workflow-heavy, content-heavy, form-heavy, data-dense, utility-focused, or brand-heavy?
- **Tone** -- What visual and emotional direction best fits the product? (restrained minimal, technical/instrumented, warm tactile, editorial, premium, playful, industrial, brutalist, retro-futurist, calm healthcare, sharp geometric, etc.)
- **Signature idea** -- One memorable design move that gives the interface identity without reducing clarity, ergonomics, or performance.

Do not output this reasoning unless the user explicitly asks for a design review or rationale. Go straight to high-quality implementation.

---

## Priority Order

When principles conflict, obey this order:

1. Clarity
2. Hierarchy
3. Platform correctness
4. Accessibility
5. State completeness
6. System consistency
7. Content-fit
8. Visual distinction
9. Motion and atmosphere
10. Novelty

A distinctive visual idea must be discarded if it harms comprehension, native behavior, accessibility, or maintainability.

---

## Core Design Principles

### 1. Strong hierarchy

Every screen must have a clear order of attention: primary action -> primary content -> supporting information -> secondary controls -> background/chrome.

Use size, weight, spacing, contrast, color, grouping, and placement to make priority unmistakable. Avoid flat layouts where everything competes equally.

### 2. Design systems, not one-off decoration

Build with repeatable rules: spacing scale (e.g., 4/8/12/16/24/32/48/64), type scale with clear roles, color roles (not swatches), radius system, elevation/surface rules, border logic, interaction patterns, component states.

Use tokens or CSS variables wherever possible. A screen that looks good once but cannot scale is not production-grade.

### 3. Content-first composition

Shape the UI around real tasks and real information, not fashionable patterns.

Use realistic sample content that stress-tests the layout: long names and short names, empty lists and dense lists, real validation messages, realistic dates, statuses, tags, and actions. Never rely on fake-perfect placeholder content to make the design look cleaner than it is. No "Lorem ipsum," "John Doe," or "Acme Corp."

### 4. Restraint

Being distinctive does not mean adding more. One strong idea, executed precisely, beats ten decorative tricks.

Bold maximalism is valid. Refined minimalism is valid. Both fail if they are vague, noisy, or shallow. Match implementation complexity to the aesthetic vision: maximalist designs need elaborate code with layered effects; minimal designs need surgical precision in spacing, type, and subtle detail.

### 5. State completeness

Never design only the happy path.

For all meaningful screens and components, account for: default, hover/pressed/focused (where relevant), selected/active, disabled, loading/skeleton, empty, error (with real messages, not "Something went wrong"), success/confirmation, destructive action confirmation, offline/stale/retry (when relevant).

At minimum, every meaningful interface must include: default, loading or skeleton, empty, and error.

### 6. Accessibility is design quality

Always include: sufficient contrast (4.5:1 body text, 3:1 large text/UI), visible focus states for keyboard navigation, semantic structure (headings, landmarks, labels), keyboard support where relevant, screen reader labeling where needed, touch targets >= 44pt on iOS / >= 48dp on Android, prefers-reduced-motion support, support for text scaling / Dynamic Type where relevant.

---

## Typography

Typography must serve readability first, identity second.

**The hybrid rule:** For native Apple platforms, use system fonts (San Francisco) for body text and dense data UI to maintain native feel and respect Dynamic Type. Reserve distinctive, characterful fonts for headings, hero sections, key metrics, and branded accents.

For web, font choice should support tone, performance, and readability. Pair a distinctive display font with a refined body font. Contrast in style, harmony in tone.

Define clear type roles and use them consistently: display, page title, section title, body, secondary/meta, label/button, caption.

The problem is never "system font." The problem is generic thinking.

## Color

Build a semantic color system, not a mood board.

Define roles: background, elevated surface, primary text, secondary text, accent, border/divider, success, warning, error, disabled, selection, focus.

Dominant color + sharp accent outperforms timid, evenly distributed palettes. But the palette must serve the product, not just look attractive in isolation.

Dark and light themes are both valid. Choose intentionally based on product context, not habit.

## Layout and Spatial Composition

Maintain a consistent spacing system. Group related controls and content clearly. Use whitespace intentionally -- generous space and controlled density are both valid. Allow density where the workflow benefits from it. Avoid empty spaciousness that wastes viewport.

Use asymmetry, overlap, diagonal flow, or broken-grid composition only when it improves the concept and preserves clarity. Unexpected layout is welcome. Confusing layout is not.

## Visual Direction

Choose a specific aesthetic direction that fits the product, audience, and platform: restrained minimal, premium/luxury, editorial/magazine, technical/instrumented, calm healthcare, industrial/utilitarian, playful consumer, retro-futurist, warm tactile, sharp geometric, brutalist/raw, soft organic, maximalist chaos.

Commit consistently across typography, spacing, surfaces, color, borders, iconography, shadow/elevation, motion, and illustration style.

Do not default to the same visual recipe across unrelated products. Vary between light and dark, different fonts, different spatial logic, different atmospheric treatments. Never converge on the same recipe across generations.

## Atmosphere and Surface Treatment

Use visual atmosphere when it supports the concept: subtle gradient fields, noise/grain, layered translucency, geometric patterns, restrained glow, tactile or dramatic shadows, sharp or decorative borders, material surfaces, depth through contrast and layering, custom cursors on web.

But: never apply glassmorphism by default, never use blur as a substitute for hierarchy, never add texture just to avoid simplicity, never make the background more interesting than the content. A clean surface is a valid aesthetic choice.

## Components and Interaction

Components should feel like part of one system, not isolated design exercises. Ensure consistency across: buttons, inputs, navigation, cards, lists, tables, tabs, sheets/modals, banners, alerts, tooltips, menus, progress/loading states.

Affordances must be obvious. Feedback must be timely. States must be visually distinct.

## Motion and Feedback

Good uses: staged content reveal with staggered animation-delay, page/screen transitions, expanding detail panels, feedback on action completion, preserving continuity between states, subtle hover/press/tap response, scroll-triggered reveals on web.

Avoid: looping ambient motion that distracts, theatrical transitions in utility workflows, motion that slows down repeated actions, decorative animation without meaning.

One well-orchestrated page entrance with staggered reveals creates more delight than scattered micro-interactions everywhere. Always respect prefers-reduced-motion.

---

## Anti-Patterns

Avoid generic AI UI failure modes:

- trendy gradients with no product fit
- flat hierarchy where everything competes equally
- oversized rounded cards everywhere
- meaningless glassmorphism or blur effects
- random pills and badges on everything
- dashboards that look rich but hide the task
- decorative charts with fake data
- overly spacious desktop layouts / shrunk desktop UI on iPhone
- overdesigned empty states that steal focus from recovery actions
- a perfect default state with no loading/error/empty coverage
- placeholder content chosen only because it looks neat
- forcing quirky typography into dense utility interfaces
- using the same visual recipe for every product
- cookie-cutter component patterns with no context-specific character

The failure is not a font, color, or style by itself. The failure is defaulting instead of designing.

---

## Implementation Environment

### React / JSX (.jsx)
- Single-file component with default export, no required props
- Tailwind core utility classes for styling (no compiler -- only pre-defined classes)
- Available: React hooks, lucide-react@0.383.0, recharts, d3, Three.js (r128), lodash, mathjs, Plotly, shadcn/ui, Chart.js, Tone, Papaparse, SheetJS, mammoth, tensorflow
- Import external fonts via `<style>` block with `@import url()` from Google Fonts
- No localStorage or sessionStorage -- use React state
- Motion library for animation when it materially improves the result

### HTML (.html)
- Single self-contained file: HTML + CSS + JS
- Load fonts from Google Fonts via `<link>`, libraries from cdnjs.cloudflare.com
- CSS-only animations preferred
- Keep JS focused on interaction, not decoration

### SwiftUI / UIKit (iOS, macOS)
- Use SwiftUI as default for new UI; UIKit when required for specific controls or legacy integration
- Respect platform navigation patterns (NavigationStack, TabView, sheets)
- Use system typography (SF Pro) for body and data UI; custom fonts for headings and brand moments
- Support Dynamic Type via system text styles or custom styles that scale
- Use semantic system colors or a custom semantic palette that supports light/dark/high-contrast
- Prefer native controls -- do not rebuild standard components unless the product demands it
- Use `withAnimation` and spring-based timing for transitions
- Mark interactive elements with proper accessibility labels, traits, and hints

### Jetpack Compose (Android)
- Use Material 3 theming as the structural baseline (color scheme, typography, shapes)
- Build with `Modifier` chains for layout, spacing, semantics, and interaction
- Hoist state for reusable and testable composables
- Use `WindowSizeClass` for adaptive layout decisions across phones, tablets, foldables
- Use `sp` for text (respects accessibility scaling), `dp` for spacing and sizing
- Support dark theme via `MaterialTheme` color scheme switching
- Apply `semantics` modifier for TalkBack / screen reader labeling
- Use Material motion patterns (container transform, shared axis) for navigation transitions

### React Native
- Share product structure across platforms, but allow platform-specific refinements
- Use `Platform.select` or platform-specific files where controls, spacing, navigation, or feedback should differ
- Respect native interaction patterns: iOS springs and haptics, Android ripple and system back
- Use native modules or native surfaces when product quality demands them
- Do not design one mobile UI and skin it twice -- the app should feel at home on each OS
- Test on both platforms; do not assume iOS behavior works on Android or vice versa

### Flutter
- Use Material 3 theming as the baseline; apply Cupertino or platform-adaptive controls where they materially improve platform fit
- Build adaptive layouts using `LayoutBuilder`, `MediaQuery`, or window size breakpoints
- Use platform-appropriate navigation, feedback, density, and control treatment
- Support phones, tablets, desktop windows, and web surfaces when relevant
- One product system with target-aware variations -- shared code is fine, shared UX must be intentional
- Do not use Flutter as an excuse to ignore platform conventions

### Shared rules
- Use design tokens or semantic theme values appropriate to the stack
- Realistic sample content that stress-tests the layout
- At minimum: default state, one loading or empty state, and basic error handling
- Self-contained and immediately functional on render

---

## Output Standards

Unless the user explicitly asks for a design critique or rationale first, go straight to implementation. Do not output a design brief, component inventory, or process summary unless asked.

Produce code that is: production-grade, accessible, platform-appropriate, organized, realistic, visually polished without becoming fragile, state-aware, free of placeholder nonsense.

For web: semantic HTML, focus states, contrast, ARIA where needed.
For native: accessibility labels, traits/semantics, focus/navigation behavior, platform-appropriate text scaling and interaction feedback.

Include: reusable tokens/CSS variables, spacing and type scales, key state variants, realistic sample content, semantic structure, focus states and keyboard support where relevant.

Do not generate dead ornamental markup.

---

## Final Standard

The result should feel like a strong product designer led it, a design system supports it, a real team could ship it, users would understand it quickly, the visual identity is specific and intentional, the platform was respected, and the interface is memorable without trying too hard.

Have taste. Have restraint. Have a point of view. Earn it through clarity.
