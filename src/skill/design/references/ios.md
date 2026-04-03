# iOS Platform Reference

Read this alongside the core design.md when building iOS native apps (SwiftUI/UIKit), React Native for iOS, or any interface targeting iPhone and iPad.

---

## iOS Interaction Model

iOS is a touch-first, single-focus platform. Users interact with thumbs on a handheld device in variable contexts -- walking, one-handed, distracted.

Design for:
- Touch-first interaction -- no hover states as primary affordance
- Thumb-reach ergonomics -- primary actions in the bottom third of the screen
- Single-task focus -- one primary action per screen, not competing panels
- Motion and transitions that maintain spatial orientation
- Concise flows -- minimize steps, maximize clarity per step
- Gesture restraint -- only use gestures that are obvious and discoverable

## Navigation Patterns

iOS has strong navigation conventions. Respect them.

- **Navigation stack** (push/pop): For hierarchical drill-down. Title in nav bar, back button preserves context. This is the primary pattern.
- **Tab bar**: For top-level app sections (2-5 tabs). Persistent at bottom, always accessible.
- **Sheets and modals**: For focused sub-tasks, creation flows, or settings. Half-sheet for quick actions, full sheet for complex tasks.
- **Segmented controls**: For switching views within a single context (e.g., list/grid, day/week/month).
- **Action sheets**: For contextual choices triggered by user action.
- **Swipe actions**: For list item operations (delete, archive, pin). Use sparingly and for common actions only.

Do not invent custom navigation paradigms when standard patterns work. Users have strong muscle memory for iOS navigation.

## Safe Areas and Layout

- Respect safe area insets on all edges (status bar, home indicator, notch/Dynamic Island)
- Content should not hide behind system UI
- Scrollable content should extend edge-to-edge behind the nav bar and tab bar with proper insets
- Landscape orientation: adjust layout for wide-and-short viewport if supported
- iPad: consider split view, sidebar, and adaptive layout for larger canvas

## Touch Targets

- Minimum 44x44pt tap targets for all interactive elements
- Adequate spacing between adjacent tap targets to prevent mis-taps
- Primary actions should be large, obvious, and reachable by thumb
- Destructive actions should require deliberate targeting -- not placed where accidental taps happen

## Thumb Zone Ergonomics

On iPhone, design with the thumb-reach heat map in mind:

- **Easy reach** (bottom center): Place primary actions, main navigation, frequently used controls
- **Moderate reach** (middle of screen): Content display, lists, secondary actions
- **Hard reach** (top corners): Search, settings, infrequent actions -- or use pull-down gestures to make them accessible

Tab bars, bottom toolbars, and floating action areas take advantage of easy reach. Top nav bars are standard but should not house primary repeated actions.

## Typography for iOS

- **SF Pro** (system font) is the correct choice for body text, labels, list content, and dense data UI on iOS. It respects Dynamic Type scaling, integrates with system accessibility, and matches platform expectations.
- Reserve custom/characterful fonts for headings, hero sections, onboarding, branding moments, and marketing surfaces.
- Support **Dynamic Type** -- text should scale with the user's system text size preference. Use system text styles (`.body`, `.headline`, `.caption`, etc.) or custom styles that scale proportionally.
- Do not use fixed font sizes that ignore accessibility scaling.
- Minimum body text size: 17pt (system body default). Metadata and captions can go to 13pt.

## Color and Appearance

- Support both light and dark mode using semantic system colors or a custom semantic palette
- Use high contrast between text and backgrounds (system colors handle this well)
- Tint colors should have a clear accent role -- not spread across every surface
- Respect the `UIAccessibility` increased contrast setting
- Avoid relying on color alone to convey meaning -- pair with icons, labels, or shape

## States and Feedback

iOS users expect immediate, tactile feedback:

- **Tap feedback**: Highlight state on press, subtle scale or opacity change
- **Haptics**: Use for meaningful moments -- successful action, toggle, destructive confirmation, selection change. Not for every tap.
- **Loading**: Skeleton screens or activity indicators with context ("Loading your messages" not just a spinner)
- **Empty states**: Clear explanation + primary action to resolve ("No conversations yet -- Start a new chat")
- **Error states**: Specific message + recovery action, not generic alerts
- **Pull-to-refresh**: Standard pattern for list content where data can be stale
- **Swipe-to-delete**: With confirmation for destructive actions

## iOS-Specific Motion

- Use **spring animations** for transitions -- iOS motion feels physical, not eased
- Navigation pushes and pops should feel like spatial movement
- Sheet presentation: slide up from bottom with spring settle
- Dismiss: swipe down gesture with velocity-based completion
- Content transitions: crossfade for in-place changes, slide for spatial changes
- Respect `UIAccessibility.isReduceMotionEnabled` -- provide instant transitions as fallback

Avoid:
- Web-style fade-in-from-nothing animations
- Excessive parallax
- Decorative motion on utility screens
- Animations that delay task completion

## Forms on iOS

- Use appropriate keyboard types for each field (email, number, phone, URL)
- Use `textContentType` hints for autofill (name, email, password, address)
- Inline validation -- mark fields as invalid with specific messages
- Respect the keyboard safe area -- content should scroll or adjust to remain visible above the keyboard
- Group related fields into logical sections
- Use pickers, date pickers, and segmented controls where appropriate instead of free-text input

## iPad Considerations

When targeting iPad as well:

- Support multitasking (Split View, Slide Over) where appropriate
- Use sidebar navigation on iPad (collapsible, adapts to compact width)
- Two-column or three-column layouts for master-detail patterns
- Support pointer/trackpad interaction (hover states, right-click menus)
- Keyboard shortcut support for productivity workflows
- Adapt layout for regular and compact size classes

## iOS Anti-Patterns

- Desktop-density layouts crammed onto a 390pt-wide screen
- Custom navigation that fights the back gesture
- Tab bars with more than 5 items
- Primary actions placed in hard-to-reach top corners
- Text that doesn't scale with Dynamic Type
- Alerts and modals for every error instead of inline feedback
- Hamburger menus hiding primary navigation
- Gesture-only interactions with no visible affordance
- Ignoring the home indicator safe area
- Fixed font sizes that break at larger accessibility sizes
- Loading states with no contextual information
