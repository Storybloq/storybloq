# Android Platform Reference

Read this alongside the core design.md when building Android native apps (Jetpack Compose/XML), React Native for Android, Flutter for Android, or any interface targeting Android phones, tablets, and foldables.

---

## Android Interaction Model

Android is a touch-first platform with a broader hardware spectrum than iOS -- varying screen sizes, densities, aspect ratios, foldable states, and manufacturer customizations. Design must be adaptive, not fixed.

Design for:
- Touch-first interaction with Android-native feedback patterns (ripple, state overlays)
- System back behavior as a first-class navigation rule -- predictive back gesture on Android 14+
- Adaptive layouts that respond to actual window size, not just device type
- Edge-to-edge rendering that properly respects system bars and insets
- Touch targets >= 48dp for all interactive elements
- Variable screen densities (mdpi through xxxhdpi)

## Navigation Patterns

Android navigation differs meaningfully from iOS. Do not port iOS patterns directly.

- **Bottom navigation**: For 3-5 top-level destinations. Persistent, with clear active state. Equivalent to iOS tab bar but follows Material conventions.
- **Navigation rail**: For tablets, foldables, and large-window layouts. Vertical strip on the leading edge -- replaces bottom nav at wider breakpoints.
- **Navigation drawer**: For apps with many top-level sections or infrequent navigation. Can be modal or persistent depending on screen width.
- **Top app bar**: Title, navigation icon, and actions. Scrolling behavior (lift on scroll, collapse) should match content type.
- **System back**: Must work correctly everywhere. Back should dismiss sheets, close dialogs, pop navigation, and ultimately exit the app. Never trap the user.
- **Predictive back**: On Android 14+, users can preview the back destination with a swipe gesture. Ensure back targets are correct and meaningful.

Do not use iOS-style swipe-from-left-edge as the primary back mechanism. Android users rely on the system back gesture or button.

## Adaptive Layout

Android runs on phones, tablets, foldables, Chromebooks, and desktop-mode windows. Layout must adapt.

- **Compact width** (<600dp): Single-column, bottom navigation, focused flows
- **Medium width** (600-840dp): List-detail side-by-side, navigation rail, two-column content
- **Expanded width** (840dp+): Three-pane layouts, persistent navigation, dense information display

Use window size classes, not device type, to drive layout decisions. A foldable in half-open posture and a small tablet may share the same layout.

Content should reflow smoothly -- not snap between discrete phone and tablet layouts.

## Material Design Baseline

Material Design is the native design language for Android. Use it as the structural baseline.

- **Surfaces and elevation**: Material uses tonal elevation (surface color shifts) rather than drop shadows as the primary depth cue. Understand the surface hierarchy.
- **Color system**: Material 3 uses dynamic color derived from a source color. Define primary, secondary, tertiary, error, surface, and on-surface roles. Support Material You dynamic theming where appropriate.
- **Shape**: Material 3 uses a shape scale (none, extra-small, small, medium, large, extra-large, full). Apply consistently to containers, buttons, chips, cards.
- **Typography**: Material 3 type scale -- display, headline, title, body, label. Map these to your content roles.

You can customize Material heavily -- the point is not to look like stock Material, but to use its structural logic (color roles, elevation model, shape system, type scale) as the foundation.

## Typography for Android

- System sans-serif (Roboto on most devices) is the safe native baseline for body text and dense data UI.
- Custom brand typography is valid and encouraged for headings, hero sections, and branded moments -- provided readability and density remain strong.
- Support text scaling -- users can set system font size from small to very large. Test at 200% and ensure layouts don't break.
- Minimum body text: 14sp. Labels and captions: 12sp. Use sp (scale-independent pixels) to respect user preferences.
- Do not use fixed dp for text sizes -- this ignores accessibility scaling.

## Color and Theming

- Support both light and dark themes -- test both thoroughly
- Use Material color roles semantically: primary for key actions, secondary for less prominent elements, surface for containers, error for problems
- Support **Material You** dynamic color where it adds value (user wallpaper-derived palette)
- Ensure contrast ratios meet WCAG guidelines in both themes
- Do not rely on color alone -- pair with icons, text labels, or shape changes

## States and Feedback

Android has its own feedback language. Respect it.

- **Ripple effect**: The standard touch feedback. Apply to all tappable surfaces. Do not replace with iOS-style opacity changes.
- **State overlays**: Hovered, focused, pressed, dragged states use semi-transparent overlays on the surface color. Material defines specific opacity values for each.
- **Snackbars**: For lightweight, transient feedback ("Message sent", "Item deleted" with undo). Appear at the bottom, auto-dismiss.
- **Loading**: Progress indicators (linear or circular) with context. Skeleton screens for content loading. Pull-to-refresh for list content.
- **Empty states**: Clear illustration or icon + explanation + primary action
- **Error states**: Inline for form fields, banners for page-level errors, snackbar for transient failures with retry

## Android-Specific Motion

- Use Material motion principles: container transforms, shared axis, fade through, fade
- **Container transform**: An element expands into its detail view -- maintains spatial continuity
- **Shared axis**: Forward/backward, up/down transitions for navigation within a hierarchy
- **Fade through**: For transitions between unrelated content
- Respect `Settings > Accessibility > Remove animations` -- provide instant fallbacks
- Keep transitions under 300ms for utility flows
- Spring physics are acceptable but less idiomatic than Material easing curves

## Forms on Android

- Use appropriate `inputType` for each field (text, number, email, phone, password)
- Autofill hints via `autofillHints` for common fields
- Material text fields: outlined or filled variants with clear label, helper text, error text, character counter
- Validation: inline, specific messages, shown on focus loss or submit attempt
- Keyboard should not obscure the active field -- manage `windowSoftInputMode` or scroll behavior
- Use dropdowns, date pickers, and time pickers where appropriate instead of free text

## Foldable and Large Screen Considerations

- Test on foldable emulators (fold/unfold transitions, tabletop posture, book posture)
- Content should not be lost or hidden during fold state changes
- Use the hinge area intentionally -- do not place interactive elements across it
- In tabletop posture (half-folded): consider split layout with content above and controls below the fold
- Support multi-window and picture-in-picture where appropriate

## Jetpack Compose Notes

When implementing with Compose:

- Use `Modifier` chains intentionally for layout, spacing, semantics, and interaction
- Hoist state for reusable and testable composables
- Use `Material3` theme and components as the baseline
- Prefer `WindowSizeClass` for adaptive layout decisions
- Use `semantics` modifier for accessibility labeling
- Support dark theme via `MaterialTheme` color scheme switching
- Test with font scale, display size, and TalkBack

## Android Anti-Patterns

- iOS navigation patterns (swipe-from-edge back, bottom sheets as primary navigation)
- iOS-style toggle switches and segmented controls without adaptation
- Ignoring system back behavior or trapping the user
- Fixed layouts that break on non-standard aspect ratios or foldables
- Ripple-free tap targets (feels broken on Android)
- Snackbar-less error handling (overusing dialogs for transient messages)
- Ignoring Material elevation and surface model (everything flat or everything shadowed)
- One rigid phone layout that doesn't adapt to tablet or foldable
- Text in dp instead of sp, breaking accessibility scaling
- Testing only on Pixel -- Samsung, OnePlus, and others have meaningful differences
