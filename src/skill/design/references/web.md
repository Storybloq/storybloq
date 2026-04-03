# Web Platform Reference

Read this alongside the core design.md when building web apps, websites, landing pages, dashboards, or any browser-rendered interface.

---

## Web Interaction Model

Web is the most flexible platform. That flexibility must still feel intentional.

Design for:
- Responsive layout across breakpoints (mobile-first or desktop-first, but tested at both extremes)
- Semantic HTML (`<nav>`, `<main>`, `<section>`, `<article>`, proper heading hierarchy)
- Clear link vs. button distinction (links navigate, buttons act)
- Keyboard navigation and focus management
- Screen reader compatibility via semantic structure and ARIA where needed
- Efficient loading and progressive rendering

## Layout and Responsiveness

Web layouts must adapt gracefully across viewport sizes.

- Use flexible grids and content reflow -- not just stacking at breakpoints
- Define at least 3 breakpoints: compact (~375-640px), medium (~641-1024px), wide (~1025px+)
- Content should remain readable and scannable at every width
- Navigation should collapse or adapt rather than disappear
- Avoid horizontal scroll on content unless it serves a specific UX pattern (e.g., carousel, data table)

Do not make the web feel like a blown-up phone app. Desktop web should use horizontal space purposefully -- multi-column content, sidebars, split views where appropriate.

## Scroll Rhythm and Reading Flow

Web is a scrolling medium. Use that well.

- Structure content into clear visual sections with distinct rhythm
- Use scroll-triggered reveals and staggered entrances for editorial or marketing pages
- Keep utility/app-shell pages focused -- not everything needs scroll animation
- Anchor navigation or sticky headers for long-form content
- Manage scroll position on navigation and state changes

## Forms and Validation

Forms are one of the most common web patterns and one of the most neglected by AI-generated UI.

- Inline validation with specific, helpful error messages
- Clear visual distinction between valid, invalid, focused, and disabled states
- Logical tab order
- Submit button states: default, loading/submitting, disabled, success
- Accessible labels -- never rely on placeholder text alone as label
- Group related fields logically
- Support for keyboard submission (Enter key)

## Browser Behavior

Respect the browser as a platform:
- URLs should be meaningful and shareable where applicable
- Back/forward navigation should work predictably
- Opening in new tab should work for links
- Loading states should account for network latency
- Error states should offer recovery, not dead ends
- Favor progressive enhancement -- core functionality should survive missing JS where possible

## Web Visual Freedom

Web has creative latitude that native platforms constrain. Use it.

Web is well-suited for:
- Rich page composition and editorial storytelling
- Scroll-triggered structure and parallax (when purposeful)
- Custom cursors and hover effects
- Experimental typography and layout
- Full-bleed hero sections and atmospheric backgrounds
- Dashboard shells with flexible panel arrangements
- Marketing-to-app transitions on landing pages

This freedom does not override the priority order in design.md. Clarity and hierarchy still come first.

## Web-Specific Motion

- CSS transitions and animations preferred for performance
- Use Motion library for React when orchestration complexity justifies it
- Intersection Observer for scroll-triggered reveals
- Hover states should provide meaningful feedback, not just decoration
- Page transitions: keep fast for utility, allow cinematic for editorial/marketing
- Always include `prefers-reduced-motion` fallback

## Web Typography

- Import fonts from Google Fonts via `<link>` or `@import`
- Choose fonts that balance character with web performance (WOFF2, font-display: swap)
- Body text should be highly readable at all viewport sizes (16px minimum on mobile)
- Use clamp() or responsive type scales for fluid sizing
- Pair a distinctive display font with a refined, readable body font
- Do not default to the same web font every time -- the font should fit the product's tone

## Web Anti-Patterns

- Single-column phone-width layouts filling a 1440px screen
- Hover-only interactions with no touch/keyboard fallback
- Infinite scroll with no way to reach footer content
- Forms with no validation states
- Links that look like buttons and buttons that look like links
- Loading an entire SPA shell before showing any content
- Full-page overlays that break browser navigation
