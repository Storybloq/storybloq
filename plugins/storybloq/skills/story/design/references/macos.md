# macOS / Desktop Platform Reference

Read this alongside the core design.md when building macOS native apps, Electron/Tauri desktop apps, or any interface intended for keyboard-and-pointer desktop use.

---

## Desktop Interaction Model

Desktop users operate with a keyboard, mouse/trackpad, and large viewport. They expect precision, density, and simultaneous context.

Design for:
- Denser information display -- desktop users expect more content per screen
- Multi-pane layouts (sidebar + content + inspector where appropriate)
- Resizable, adaptable windows that reflow content intelligently
- Keyboard-first usage (shortcuts, tab order, arrow-key navigation within lists/tables)
- Hover precision (tooltips, hover states, right-click/context menus)
- Drag and drop where it serves the workflow (files, list reordering, canvas objects)

Desktop users tolerate and often expect more density and more direct control than mobile users.

## Layout Patterns

Desktop excels at showing multiple panels of related information simultaneously.

Common effective patterns:
- **Sidebar + content** -- navigation or filtering on the left, main content area
- **Sidebar + content + inspector** -- three-pane with detail panel (e.g., mail, Xcode, Finder column view)
- **Toolbar + canvas** -- creative/productivity apps with tools above a workspace
- **Source list + detail** -- master-detail for collections
- **Tab-based workspaces** -- for multi-document or multi-context workflows

Window resizing should degrade gracefully: inspector can collapse, sidebar can become compact icons, content can reflow.

Do not waste desktop space with oversized cards, giant padding, or mobile-like stacking unless the product explicitly calls for it.

## Keyboard and Shortcuts

Desktop interfaces must be navigable without a mouse.

- Tab moves between focusable elements in logical order
- Arrow keys navigate within lists, tables, menus, tab groups
- Enter/Return confirms, Escape cancels/dismisses
- Common shortcuts (Cmd+S, Cmd+Z, Cmd+F, Cmd+N) should work where semantically appropriate
- Display keyboard shortcuts in menus and tooltips where relevant
- Focus states must be clearly visible

For native macOS: respect the system menu bar, Cmd+Q, Cmd+W, Cmd+comma for preferences.

## Information Density

Desktop gives you viewport. Use it.

- Rows in tables can be compact (28-36px height)
- Lists can show metadata inline rather than requiring drill-down
- Sidebars can display tree structures and nested navigation
- Multi-column layouts are expected, not unusual
- Secondary information can coexist with primary content rather than hiding behind tabs or disclosure

Dense does not mean cluttered. Group related information, maintain consistent spacing, and use borders or subtle surface differences to separate regions.

## Context Menus and Direct Manipulation

- Right-click / context menu on actionable items (files, list rows, selections)
- Drag and drop for reordering, moving between panes, and file operations
- Double-click to open/edit where semantically appropriate
- Multi-select with Cmd+click and Shift+click in lists and tables
- Inline editing where it reduces friction (rename, quick value changes)

## Typography for Desktop

- For native macOS: SF Pro is often the correct choice for body text, labels, and dense data UI. It integrates with system rendering, supports Dynamic Type, and matches platform expectations.
- Reserve custom/characterful fonts for headings, branding, hero sections, or marketing surfaces within the app.
- Dense UI text can go smaller than mobile (13px body is comfortable on desktop, 11-12px for metadata).
- Use font weight variation (regular, medium, semibold) to create hierarchy within dense layouts rather than relying solely on size changes.

## Desktop-Specific Motion

- Sidebar reveal/collapse with smooth transitions
- Panel resize animations
- List item reorder with spring physics
- Sheet/dialog presentation with subtle scale or slide
- Avoid heavy page-level transitions -- desktop navigation should feel instant
- Respect system `prefers-reduced-motion`

For native macOS: use spring-style animation curves that match system behavior. Avoid web-style easing functions that feel foreign on the platform.

## macOS Native Considerations

When building for macOS specifically:

- Respect the traffic light window controls (close/minimize/fullscreen)
- Support full-screen mode gracefully
- Toolbar items should be appropriately sized and spaced for mouse precision
- Preferences/Settings should use the standard Cmd+comma shortcut
- Menu bar integration where appropriate
- NSToolbar patterns for native toolbar behavior
- Sidebar selection states should match system conventions (highlight color, rounded selection)
- Vibrancy and translucency are valid atmospheric tools on macOS -- use sparingly and purposefully

## Desktop Anti-Patterns

- Mobile-width content centered in a wide window with empty gutters
- Oversized touch-target buttons that waste space
- Single-column layouts that ignore available horizontal space
- Navigation patterns that require many clicks to access parallel information
- Hiding commonly-used actions behind hamburger menus
- Ignoring keyboard navigation entirely
- Modals that block all other interaction when a panel or inspector would serve better
- Toast notifications that stack up and obscure content
