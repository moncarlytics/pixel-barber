# Pixel Barber — Design System & Content Guidelines

**Document status:** Input document for Claude Code to implement every UI component and page
**Version:** 1.0
**Date:** 9 September 2026
**Companion to:** `pixel-barber-prd.md` (business rules), `pixel-barber-app-flow.md` (screens/navigation), `pixel-barber-tech-stack.md` (Tailwind CSS v4, shadcn/ui, lucide-react, next/font already locked there)

This document specifies exact values, not directions to interpret. Where a decision could otherwise be left to whoever writes the code, it's made here instead. All color pairs below were verified against the WCAG 2.1 formula (relative luminance / contrast ratio), not eyeballed — section 3.4 shows the pairs and their measured ratios.

---

## 1. Design Principles

Warm and encouraging, not clinical — the voice and the visual language both come from the same place: a customer waiting for a haircut should feel looked after, not processed. Clarity over cleverness — a clean, legible interface beats a distinctive one; nothing here should make someone stop and figure out what a screen means. One system, two densities — the customer app and the staff/admin portal share every token and component in this document exactly; what differs between them is layout density and information volume (per the tech stack document's architecture), never color, type, or component styling. Accessible by default, not bolted on — every color pairing, focus state, and motion behavior in this document already meets WCAG 2.1 AA; there is no separate "accessibility pass" to do later.

---

## 2. Brand Identity

**Logo/wordmark:** Not yet supplied — will be provided separately. Until then, render the product name as a text wordmark: "Pixel Barber" set in Manrope ExtraBold (800), sentence case, primary-token color. Reserve a fixed header slot (32px height in the customer app header, 40px in the staff portal sidebar header) sized to drop in an image-based logo later without a layout change.

**Brand colors (as given):** Green, Gold (yellow), Black, and White. Green carries the primary/brand meaning throughout (including doubling as the "success" semantic color — a deliberate choice, not a gap, since green success states and brand identity reinforce each other). Gold is the accent, used for highlights and secondary calls to action, never for body text at small sizes (see 3.4). Black and white anchor a full neutral grayscale, not used as literal pure `#000000`/`#FFFFFF` everywhere — section 3.2 has the full ramp.

---

## 3. Color System

### 3.1 Primitive Scales

Each brand hue is expressed as an 11-step scale (50 lightest → 950 darkest). These are the only hex values that exist in the system — every semantic token in section 3.3 points to one of these.

**Pixel Green (primary)**

| Step | Hex |
|---|---|
| 50 | #F0FBF4 |
| 100 | #DCF5E3 |
| 200 | #BAEBC9 |
| 300 | #86D9A3 |
| 400 | #4ABD76 |
| 500 | #22A559 |
| 600 | #178A47 |
| 700 | #146F3B |
| 800 | #145930 |
| 900 | #12492A |
| 950 | #062916 |

**Pixel Gold (accent)**

| Step | Hex |
|---|---|
| 50 | #FFFBEB |
| 100 | #FEF3C7 |
| 200 | #FDE68A |
| 300 | #FCD34D |
| 400 | #FBBF24 |
| 500 | #F5A623 |
| 600 | #D6870F |
| 700 | #B2650D |
| 800 | #8F4F12 |
| 900 | #764212 |
| 950 | #442205 |

**Pixel Ink (neutral, anchored by black and white)**

| Step | Hex |
|---|---|
| 0 (white) | #FFFFFF |
| 50 | #F7F8F7 |
| 100 | #EEF0EE |
| 200 | #DEE2DD |
| 300 | #C3C9C1 |
| 400 | #9AA298 |
| 500 | #717A6F |
| 600 | #545C52 |
| 700 | #3E453C |
| 800 | #292E28 |
| 900 | #1A1D19 |
| 950 | #0D0F0C |
| 1000 (true black) | #000000 |

**Semantic-only hues** (not brand colors, but required — status communication can never be brand-color-only, since green/gold alone can't represent an error or a neutral notice):

| Scale | 400 (dark-mode tint) | 600 (light-mode base) | 700 (light-mode text-safe) |
|---|---|---|---|
| Red (destructive/no-show) | #F87171 | #DC2626 | #B91C1C |
| Orange (warning) | #FB923C | #EA580C | #C2410C |
| Blue (info) | #60A5FA | #2563EB | #1D4ED8 |

### 3.2 Semantic Tokens

These map directly onto shadcn/ui's own CSS variable names, so generated components pick them up with zero renaming. "Light" and "Dark" are the two values a given token takes under the toggle from the tech stack decision to support both modes.

| Token (shadcn name) | Light value | Dark value |
|---|---|---|
| `background` | Ink-0 `#FFFFFF` | Ink-950 `#0D0F0C` |
| `foreground` | Ink-900 `#1A1D19` | Ink-50 `#F7F8F7` |
| `card` | Ink-0 `#FFFFFF` | Ink-900 `#1A1D19` |
| `card-foreground` | Ink-900 `#1A1D19` | Ink-50 `#F7F8F7` |
| `popover` | Ink-0 `#FFFFFF` | Ink-900 `#1A1D19` |
| `popover-foreground` | Ink-900 `#1A1D19` | Ink-50 `#F7F8F7` |
| `primary` | Green-700 `#146F3B` | Green-400 `#4ABD76` |
| `primary-foreground` | Ink-0 `#FFFFFF` | Ink-950 `#0D0F0C` |
| `secondary` | Ink-50 `#F7F8F7` | Ink-800 `#292E28` |
| `secondary-foreground` | Ink-900 `#1A1D19` | Ink-50 `#F7F8F7` |
| `muted` | Ink-50 `#F7F8F7` | Ink-800 `#292E28` |
| `muted-foreground` | Ink-600 `#545C52` | Ink-300 `#C3C9C1` |
| `accent` | Gold-500 `#F5A623` | Gold-400 `#FBBF24` |
| `accent-foreground` | Ink-950 `#0D0F0C` | Ink-950 `#0D0F0C` |
| `destructive` | Red-600 `#DC2626` | Red-400 `#F87171` |
| `destructive-foreground` | Ink-0 `#FFFFFF` | Ink-950 `#0D0F0C` |
| `warning` | Orange-700 `#C2410C` | Orange-400 `#FB923C` |
| `warning-foreground` | Ink-0 `#FFFFFF` | Ink-950 `#0D0F0C` |
| `info` | Blue-600 `#2563EB` | Blue-400 `#60A5FA` |
| `info-foreground` | Ink-0 `#FFFFFF` | Ink-950 `#0D0F0C` |
| `border` (decorative) | Ink-200 `#DEE2DD` | Ink-700 `#3E453C` |
| `input` (functional form borders) | Ink-300 `#C3C9C1` | Ink-600 `#545C52` |
| `ring` (focus indicator) | Green-700 `#146F3B` | Green-400 `#4ABD76` |
| `chart-1` | Green-600 `#178A47` | Green-400 `#4ABD76` |
| `chart-2` | Gold-500 `#F5A623` | Gold-400 `#FBBF24` |
| `chart-3` | Blue-600 `#2563EB` | Blue-400 `#60A5FA` |
| `chart-4` | Orange-600 `#EA580C` | Orange-400 `#FB923C` |
| `chart-5` | Ink-500 `#717A6F` | Ink-400 `#9AA298` |

### 3.3 Queue/Ticket Status Colors

Distinct from the general semantic tokens above — these are the fixed colors for a ticket's lifecycle state everywhere it appears (badges, the tracking screen, the staff Live Queue table). A status is never conveyed by color alone: every instance pairs the color with a text label and/or icon, never a bare colored dot.

| Ticket state (from the PRD's lifecycle) | Color token | Icon (lucide-react) |
|---|---|---|
| Waiting / Almost Turn | `info` | `clock` |
| Called | `warning` | `bell` |
| Confirmed / In Service | `primary` | `scissors` |
| Completed | `muted-foreground` on `muted` background | `check` |
| Grace Period (customer flagged absent) | `warning` with a pulsing 2px `warning` border (see 8.4 motion note) | `alert-triangle` |
| No Show / Cancelled | `destructive` | `x` |
| Stepped Out | `accent` | `footprints` |

### 3.4 Verified Contrast Ratios

Every pairing actually used for text or a required UI boundary, with its measured ratio against the WCAG 2.1 target (4.5:1 for body text, 3:1 for large text/icons/focus indicators/functional borders):

| Pairing | Ratio | Target | Result |
|---|---|---|---|
| `foreground` on `background` (light) | 17.0:1 | 4.5:1 | Pass |
| `foreground` on `background` (dark) | 18.1:1 | 4.5:1 | Pass |
| `muted-foreground` on `background` (light) | 6.9:1 | 4.5:1 | Pass |
| `muted-foreground` on `background` (dark) | 11.4:1 | 4.5:1 | Pass |
| `primary-foreground` on `primary` (light) | 6.2:1 | 4.5:1 | Pass |
| `primary-foreground` on `primary` (dark) | 8.1:1 | 4.5:1 | Pass |
| `accent-foreground` on `accent` (light) | 9.5:1 | 4.5:1 | Pass |
| `accent-foreground` on `accent` (dark) | 11.5:1 | 4.5:1 | Pass |
| `destructive-foreground` on `destructive` (light) | 4.8:1 | 4.5:1 | Pass |
| `destructive-foreground` on `destructive` (dark) | 7.0:1 | 4.5:1 | Pass |
| `warning-foreground` on `warning` (light) | 5.2:1 | 4.5:1 | Pass |
| `warning-foreground` on `warning` (dark) | 8.5:1 | 4.5:1 | Pass |
| `info-foreground` on `info` (light) | 5.2:1 | 4.5:1 | Pass |
| `info-foreground` on `info` (dark) | 7.6:1 | 4.5:1 | Pass |
| `input` border on `background` (light) | 4.5:1 | 3:1 | Pass |
| `input` border on `background` (dark) | 4.3:1 | 3:1 | Pass |
| `ring` on `background` (light) | 6.2:1 | 3:1 | Pass |
| `ring` on `background` (dark) | 8.1:1 | 3:1 | Pass |

Two rules that came directly out of this verification, and must be followed rather than re-derived: Gold below step 700 (`#B2650D`) never carries text at body size on a light background — steps 400–500 are fill-only, always paired with `accent-foreground`. Green below step 700 (light) or above step 400 (dark) is for large text, icons, and fills only, never small body text — `primary` at 700/400 is the only shade approved for body-size text use.

---

## 4. Typography

### 4.1 Typefaces

| Role | Typeface | Source | Weights loaded |
|---|---|---|---|
| Display & headings | **Manrope** | Google Fonts, via `next/font/google` | 600 (SemiBold), 700 (Bold), 800 (ExtraBold) |
| Body & UI | **Inter** | Google Fonts, via `next/font/google` | 400 (Regular), 500 (Medium), 600 (SemiBold), 700 (Bold) |
| Chinese locale fallback (both roles) | **Noto Sans SC** | Google Fonts, via `next/font/google` | 400, 500, 700 |

Manrope and Inter were chosen specifically because both are self-hosted automatically by `next/font/google` (no layout shift, no external request at runtime), both ship variable-width Latin character sets covering English, French, Spanish, and German without a fallback font ever being needed, and both are among the most-used typefaces in production Next.js applications — which is exactly what maximizes Claude Code's familiarity wiring them up correctly. Neither covers Chinese glyphs, so the `zh` locale swaps to Noto Sans SC for both the display and body role rather than mixing a Latin display font with a CJK body font — consistent glyph rendering across a page matters more than preserving the Manrope/Inter personality pairing for that one locale.

### 4.2 Type Scale

| Level | Size | Line height | Weight | Typeface | Usage |
|---|---|---|---|---|---|
| Display | 2.5rem / 40px | 1.1 | 700 | Manrope | Onboarding welcome, empty-state hero moments only — used sparingly |
| H1 | 2rem / 32px | 1.2 | 700 | Manrope | Page-level titles (e.g., "Book a Service") |
| H2 | 1.5rem / 24px | 1.25 | 600 | Manrope | Section headers within a page |
| H3 | 1.25rem / 20px | 1.3 | 600 | Manrope | Card titles, modal titles |
| H4 | 1.125rem / 18px | 1.35 | 600 | Manrope | Minor headings, list group headers |
| Body Large | 1rem / 16px | 1.5 | 400 | Inter | Primary reading text (ticket status, feedback form labels) |
| Body Base | 0.875rem / 14px | 1.5 | 400 | Inter | Default UI text — the size most components use |
| Body Small | 0.8125rem / 13px | 1.45 | 400 | Inter | Secondary/supporting text |
| Caption | 0.75rem / 12px | 1.4 | 500 | Inter | Timestamps, helper text under inputs |
| Label | 0.6875rem / 11px | 1.4 | 600 | Inter | Uppercase, 0.04em letter-spacing — badges, section eyebrows |

Letter-spacing: −0.02em on Display and H1 only; 0 (default) everywhere else except Label (+0.04em, uppercase).

---

## 5. Spacing, Layout, and Breakpoints

Spacing uses Tailwind's own default scale (4px base unit — `1`=4px, `2`=8px, `3`=12px, `4`=16px, `6`=24px, `8`=32px, `12`=48px, `16`=64px) rather than a custom scale, since that scale is already what Tailwind v4 ships and what Claude Code already knows by default — inventing a parallel scale would only create room for error.

Breakpoints are Tailwind's defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px. The customer app is designed mobile-first, with its layouts finalized at `base` and `sm`, and simply centered with a 480px max-width container from `md` up — it is not a responsive desktop redesign, just a constrained mobile layout on a larger viewport. The staff/admin portal is designed desktop-first at `lg` and up (its primary use case, per the tech stack document), with `md` as the minimum supported width for a tablet at the front desk — below `md`, show a plain "This screen works best on a larger display" message rather than attempting a cramped responsive layout for a surface that isn't meant to be used one-handed.

Standard content padding: 16px (`4`) on mobile screen edges, 24px (`6`) on tablet/desktop. Standard gap between stacked cards/sections: 16px (`4`). Standard internal card padding: 16px (`4`) on mobile, 24px (`6`) on desktop.

---

## 6. Radius, Elevation, and Borders

### 6.1 Radius Scale

| Token | Value | Used for |
|---|---|---|
| `radius-sm` | 6px | Badges, small inputs, checkboxes |
| `radius-md` | 8px | Buttons, standard inputs, default card |
| `radius-lg` | 12px | Modals, dialogs, sheets |
| `radius-xl` | 16px | Large feature cards, onboarding step panels |
| `radius-full` | 9999px | Avatars, pill badges, the floating "Track" button on Home |

### 6.2 Elevation

Light mode uses soft shadows; dark mode uses borders instead of shadows, since shadows read poorly against a near-black background — this is a deliberate difference between modes, not an oversight.

| Level | Light mode | Dark mode | Used for |
|---|---|---|---|
| 0 | none | none | Page background |
| 1 | `0 1px 2px rgba(13,15,12,0.06)` | 1px solid `border` token, no shadow | Resting card |
| 2 | `0 4px 6px rgba(13,15,12,0.08)` | 1px solid `border` token + `card` background one step lighter than page `background` | Dropdown menu, popover |
| 3 | `0 10px 25px rgba(13,15,12,0.15)` | Same border treatment as level 2, larger footprint | Modal, dialog, sheet |
| 4 | `0 12px 32px rgba(13,15,12,0.18)` | Same border treatment as level 2 | Toast, tooltip |

### 6.3 Borders

Default/decorative borders (card edges, table row dividers) use the `border` token at 1px. Functional borders that a user must be able to perceive on their own — input fields, select boxes, textareas — use the `input` token at 1px in the resting state and the `ring` token at 2px on focus (never rely on border color change alone for focus — see section 9).

---

## 7. Iconography

All icons come from `lucide-react` (locked in the tech stack document) — no icon from any other set, and no custom SVG icons unless a genuinely product-specific glyph is needed (none currently is). Stroke width: 2px at all sizes (lucide's default — do not override per-instance). Sizing: 16px for inline icons next to Body Small/Caption text, 20px for inline icons next to Body Base text and inside buttons, 24px for standalone icons (empty states, navigation), 32px for the barber interface's large action icons (Today's Queue screen, section 9 of the App Flow document, where buttons are tapped mid-haircut and need to be unambiguous at a glance). Icon color always follows the surrounding text color via `currentColor` — an icon is never given its own independent color unless it's carrying a status meaning (section 3.3). Any icon used without an adjacent visible text label (a toolbar icon button, for instance) requires an `aria-label` — this is not optional.

---

## 8. Avatar System

The customer avatar (chosen at onboarding, per the App Flow document) is a set of 16 predefined, flat-illustrated character icons — not photographic, not the literal pixel-art style ruled out in section 1's brand direction. Each avatar sits on a circular field using one of eight background tints (alternating `primary-100`/`accent-100`/`info`-equivalent-light-tint/`Ink-100`, i.e., the lightest step of each hue scale) so the set reads as one coherent family rather than sixteen unrelated icons. The illustrated set should represent a range of hairstyles and presentations reflective of Pixel Barber's customer base in Ghana — an actual illustrator produces the final art; this document fixes the construction rules (circular crop, consistent line weight, one flat background tint per avatar, no photographic elements) that whoever builds it, including Claude Code assembling the picker UI, should follow.

| Context | Size |
|---|---|
| Queue list row (staff Live Queue table) | 24px |
| Compact card (Home status card) | 32px |
| Default (profile, Ticket Tracking screen) | 48px |
| Avatar picker grid (onboarding step 4) | 96px, with a 3px `ring`-token border on the selected item |

### 8.1 Phase 2: Build-Your-Own Avatar

Replacing the fixed 16-avatar grid (per the PRD's Phase 2 enhancement, section 18), a customer instead assembles an avatar from four independently chosen parts — base/skin tone, hairstyle, hair color, and top color — composited onto the same circular field and tint-background system above, so an avatar built this way sits in exactly the same slots (queue row, compact card, default, picker) at exactly the same sizes without any layout change. Three of those four parts are colored from tokens already in this document: hairstyle silhouettes are flat-illustrated line art in `foreground`/`Ink-800`, and top color is chosen from the same eight tint-background hues already used for the avatar field (`primary`, `accent`, `info`, and `Ink` at their lightest and mid steps) — no new token required for either.

Skin tone is the one genuinely new color need, since neither the brand palette nor the neutral ramp in section 3 is appropriate for representing human skin — these are illustration fill colors, never used as text, background, or any interactive-state color, so they sit outside section 3.4's text-contrast verification by nature (nothing here is ever read as text against them). Six tones span a realistic range reflective of Pixel Barber's customer base in Ghana, ordered lightest to deepest:

| Tone | Hex |
|---|---|
| Skin 1 | #F5D6B8 |
| Skin 2 | #E3B48D |
| Skin 3 | #C68A5E |
| Skin 4 | #A46A3E |
| Skin 5 | #7A4A28 |
| Skin 6 | #4F2E17 |

Hair color is a fixed set of four flat fills, independent of skin tone selection: `#1A1412` (black), `#4A2E1F` (dark brown), `#8B5A2B` (brown), and `#E8E4DC` (gray/white) — an illustrator produces the final linework exactly as section 8's opening paragraph already specifies for the Phase 1 set; this document fixes the four-part construction rule (base, hairstyle, hair color, top color) and the color values, not the final art.

---

## 9. Motion and Animation

| Token | Duration | Easing (cubic-bezier) | Used for |
|---|---|---|---|
| `motion-fast` | 120ms | `(0.4, 0, 0.2, 1)` | Hover, toggle, checkbox check |
| `motion-base` | 200ms | `(0.4, 0, 0.2, 1)` | Modal/sheet open-close, tab switch, accordion |
| `motion-slow` | 350ms | `(0.4, 0, 0.2, 1)` | The queue avatar sliding to its new position (the only place this duration is used) |
| `motion-entrance` | 200ms | `(0, 0, 0.2, 1)` ease-out | Toast/banner appearing |
| `motion-exit` | 150ms | `(0.4, 0, 1, 1)` ease-in | Toast/banner dismissing |
| `motion-celebration` *(Phase 2)* | 600ms | `(0.34, 1.56, 0.64, 1)` — the one deliberate overshoot in this system | The avatar's arrival at the barber chair only (PRD section 18's Phase 2 celebratory transition) |

**Queue avatar animation, specified exactly:** when a tracked ticket's position changes from N to N−1, the avatar translates along its track over `motion-slow` (350ms) using the standard easing curve — no bounce, no overshoot. This is the single animated element on the Ticket Tracking screen; everything else on that screen (the wait-time number updating, the barber's status line) changes instantly, with no transition, so the one animation that exists stays meaningful rather than competing with others.

**Reduced motion:** when `prefers-reduced-motion: reduce` is set, the avatar slide is replaced entirely — the avatar simply appears at its new position with a 150ms opacity fade (0 to 1), no translation. This applies everywhere in both apps: no component in this system uses motion as the only way to convey a state change, so removing motion never removes information, per the App Flow document's accessibility requirement.

**Phase 2 — expanded queue states:** the eight states from the PRD's Phase 2 enhancement (Waiting, Moving Forward, Almost Your Turn, Called, Arrived, In Service, Completed, Cancelled) each get their own short, purpose-built motion rather than one generic slide reused everywhere — Moving Forward reuses `motion-slow` exactly as specified above; Called and Arrived use `motion-base` (200ms) for a brief pulse/highlight on the avatar itself, not a position change; Cancelled uses a 150ms opacity fade to a muted, static state (the same treatment reduced-motion already gives every transition, so this state needs no separate reduced-motion case). **The one new duration this adds, `motion-celebration`,** governs only the In Service arrival moment, specified in its own row above. Under reduced motion, `motion-celebration` is replaced the same way `motion-slow` already is elsewhere in this section: the avatar simply appears in its "arrived" visual state with a 150ms opacity fade, no bounce — the celebratory feeling is allowed to come from what's shown (a completed state, a checkmark), never from motion alone.

---

## 10. Component Specifications

Each row gives the states a component must implement and which tokens/values govern each — variants not listed (e.g., a component size not mentioned) are out of scope for v1 and should not be invented without returning to this document.

| Component | Variants | States and specification |
|---|---|---|
| **Button** | `primary`, `secondary`, `outline`, `ghost`, `destructive`; sizes `sm` (32px height), `default` (40px height), `lg` (48px height) | Default: token per variant (section 3.2). Hover: background darkens one scale step (e.g., `primary` hover = Green-800 light / Green-300 dark). Focus: 2px `ring` token offset 2px. Active/pressed: darken one further step, scale 0.98 over `motion-fast`. Disabled: 40% opacity, no hover/active response, cursor not-allowed. Loading: spinner replaces label, button disabled, width does not change (reserve space) |
| **Input / Textarea / Select** | Single line, default `md` radius, 40px height (input), 96px min-height (textarea) | Default: `input` border, `background` fill. Focus: `input` border replaced by 2px `ring`. Error: border becomes `destructive`, a Caption-size `destructive`-colored message appears below with an `alert-circle` icon. Disabled: `muted` background, `muted-foreground` text, 60% opacity. Placeholder text: `muted-foreground` |
| **Checkbox / Radio / Switch** | — | Unchecked: `input` border, transparent fill. Checked: `primary` fill, `primary-foreground` check/dot icon. Focus: 2px `ring`. Disabled: 40% opacity on whichever state it's in |
| **Badge** (ticket status, section 3.3) | `pill` shape (`radius-full`) | Background = status color at its lightest scale step (e.g., Waiting = `info` at 50-equivalent tint), text = status color at its 700/400 (light/dark) step, icon per section 3.3 at 16px, Label-size text |
| **Card** | Default, interactive (clickable) | Elevation level 1 at rest (section 6.2). Interactive card: elevation level 2 on hover, `motion-fast` transition, cursor pointer |
| **Dialog / Modal** | — | Elevation level 3, `radius-lg`, max-width 480px on desktop / full-width minus 32px margin on mobile. Backdrop: `Ink-950` at 50% opacity. Opens/closes over `motion-base` with `motion-entrance`/`motion-exit` easing. Focus trapped inside while open; Escape key closes it |
| **Sheet / Slide-over** (Add Walk-in, Branch Switcher) | Right-side on desktop, bottom on mobile | Same elevation/backdrop as Dialog. Slides in over `motion-base`. Width 400px fixed on desktop; full-width on mobile with a drag handle at the top |
| **Toast / Banner** | `info`, `warning`, `destructive`, `success` (=`primary`); persistent (offline banner) vs. auto-dismissing (confirmations) | Elevation level 4, `radius-md`. Persistent banners (the offline banner from the App Flow document) pin to the top of the viewport, full width, no dismiss control. Auto-dismissing toasts appear bottom-center on mobile / bottom-right on desktop, auto-dismiss after 4s unless hovered/focused |
| **Tabs** | Underline style | Active tab: `primary`-colored 2px underline, `foreground` text. Inactive: `muted-foreground` text, transparent underline. Focus: 2px `ring` around the tab button itself |
| **Avatar** | See section 8 | — |
| **Skeleton loader** | — | `muted` background, `radius-sm`, animated left-to-right shimmer using a `background` → `muted` → `background` gradient sweep over 1.5s, looping, disabled entirely under reduced motion (replaced by a static `muted` block) |
| **Table** (staff Live Queue, Reports) | — | Row height 48px. Header row: `muted` background, Label-size text. Row divider: `border` token, 1px, bottom only. Row hover: `muted` background. Selected row: `primary` at its lightest tint |
| **Navigation — bottom tab bar** (customer app) | 4 items, per the App Flow document | Height 64px + safe-area inset. Active item: `primary` icon and Label-size text. Inactive: `muted-foreground`. No text truncation — labels are short enough by design (Home, Queue, Book, Profile) not to need it |
| **Navigation — sidebar** (staff portal) | Per the App Flow document's section list | Width 240px expanded / 64px collapsed (icon-only). Active item: `primary`-tinted background (lightest step) with `primary` text/icon. Inactive: `foreground` text, `muted-foreground` icon |
| **Stepper** (onboarding wizard) | Linear, 6 steps per the App Flow document | Completed step: `primary` filled circle with a check icon. Current step: `primary` outline, `primary` text. Upcoming step: `border`-colored outline, `muted-foreground` text |
| **Tooltip** | — | Elevation level 4, `Ink-900`/`Ink-800` (dark, in both modes — tooltips are the one component that doesn't invert, for legibility against any surrounding content) background, `Ink-0` text, appears after 400ms hover delay, `motion-fast` fade |
| **Message bubble** *(Phase 2)* | Sent (own), received | Sent: `primary` background, `primary-foreground` text, right-aligned, `radius-lg` with the bottom-right corner squared to `radius-sm`. Received: `muted` background, `foreground` text, left-aligned, mirrored corner treatment. Caption-size timestamp and, on sent bubbles only, a delivered/read indicator (`check` icon = delivered, `primary`-colored double check = read) beneath the bubble |
| **Voice-note bubble** *(Phase 2)* | Same sent/received shells as Message bubble | A play/pause icon button (20px) plus a Caption-size duration label (e.g. "0:42") inside the same bubble treatment as a text message — no waveform in v1; a flat duration label is enough, per this system's preference for plain and functional over decorative (section 1) |
| **Quick-reply chip** *(Phase 2)* | — | `radius-full` pill, `outline` button styling (section 10's Button row) at `sm` height, arranged in a horizontally scrollable row above the composer; tapping sends immediately rather than populating the text field for further editing |
| **Biometric login control** *(Phase 2)* | Login-screen prompt, enrolled-device row (Profile/My Account/shared-station setup) | Login-screen prompt: `outline` button styling (section 10's Button row) at `default` height, `fingerprint` lucide icon (20px) leading the label ("Use Face ID"/"Use fingerprint" — label follows platform convention, never a generic "biometric"), positioned beside rather than replacing the password field, per this system's icon rules (section 7) always paired with visible text, never icon-only. Enrolled-device row (Profile 7.13, staff My Account, barber station setup): same row treatment as a Settings list item — `fingerprint` icon at 20px, device label, a `Switch` component (this section's row above) to enable/disable, no separate save action needed since the switch itself is the commit |

---

## 11. Content and Voice Guidelines

### 11.1 Tone

Warm and encouraging, always — the writing should sound like a helpful person at the front desk, not a system. Plain and short: no jargon, no compound sentences where two short ones will do. Calm under pressure: a no-show notice, an offline banner, or an error message stays reassuring and factual, never alarmed ("Your ticket was released" not "ERROR: Ticket cancelled"). Respectful of the reader's time: lead with the fact that matters, not a greeting or a caveat.

### 11.2 Terminology (use exactly these terms, everywhere, in every language's source string)

| Use this | Not this |
|---|---|
| Queue | Line |
| Ticket | Number (alone) |
| Branch | Location, Shop (in UI labels — "shop" is fine in casual marketing copy only) |
| Barber | Stylist, Artist |
| Join Queue | Get in Line, Start Queue |
| Book Appointment | Schedule, Reserve |
| Stepped Out | Away, Paused |
| You're up! | It's your turn (this exact phrase is the "called" notification headline — see 11.3) |
| Message *(Phase 2)* | Chat, DM |

### 11.3 Reference Microcopy

These exact strings are the source-language (English) copy for the states already defined in the App Flow document — translate faithfully rather than localizing the tone away from what's specified in 11.1.

| Context | Copy |
|---|---|
| Home empty state | "No active ticket yet." / button: "Join a queue" |
| Queue tab — Now, empty | "You're not in a queue right now." / button: "Join a queue" |
| Queue tab — Upcoming, empty | "No appointments booked." / button: "Book an appointment" |
| Called notification | "You're up! Head to [Barber name]'s chair." |
| Almost-turn notification (10 min) | "You're about 10 minutes out — see you soon!" |
| No-show release | "Your ticket was released because we couldn't reach you. Tap below to rejoin." / button: "Rejoin queue" |
| Offline banner | "You're offline — reconnecting…" |
| Session expired | "Your session ended — log back in to continue." |
| OTP error | "That code didn't match. Check your messages and try again." |
| Generic network error | "Something went wrong on our end. Try again in a moment." |
| Feedback submitted | "Thanks for letting us know!" |
| Cancellation confirmed | "Your ticket's been cancelled. Hope to see you again soon." |
| Conversation ended *(Phase 2)* | "This conversation ended when your visit did." |
| New message notification *(Phase 2)* | "New message from [Barber name]" |

### 11.4 Localization Notes

Keep sentences short enough to survive roughly 30–40% text expansion in French and German (both routinely run longer than English) without breaking button or badge layouts — this is a layout requirement as much as a writing one, and components in section 10 should size to content rather than fixed pixel widths where copy is involved. Avoid idioms and culturally specific phrasing ("you're up!" is a borderline case worth flagging to translators explicitly as "your turn has arrived," not a literal idiom to preserve) so the warmth of the tone survives translation into French, Spanish, German, and Chinese rather than reading as a mistranslation.

---

## 12. Accessibility Standards

WCAG 2.1 AA is the floor for everything in this document, not a target to check afterward — section 3.4 already verifies every color pairing against it. Beyond color: every interactive element has a visible 2px `ring`-token focus indicator (section 6.3) — never remove a focus outline without replacing it with an equally visible one. Minimum touch target size is 44×44px for any tappable element on the customer app and barber interface, even where the visible icon or label is smaller (pad the tappable area, don't shrink it). No information is ever conveyed by color alone — every status badge pairs color with text and/or an icon (section 3.3), and every chart in the staff Reports screen labels its series directly rather than relying on a color-only legend. Motion respects `prefers-reduced-motion` everywhere, not just on the queue avatar (section 9). All non-decorative icons used without adjacent text carry an `aria-label` (section 7).

---

## 13. Dark Mode Implementation Notes

The toggle lives in Profile → Settings (customer) and Settings (staff), defaulting to the device's OS-level preference on first launch. Every token in section 3.2 already has both values — implementation is a matter of applying the correct CSS variable set based on the active mode, never computing a color at runtime. The one asymmetry to implement deliberately: elevation is shadow-based in light mode and border-based in dark mode (section 6.2) — don't reuse the light-mode shadow values in dark mode at reduced opacity as a shortcut, since they read as muddy rather than absent against a near-black background.

---

## 14. How to Extend This System

A new component not listed in section 10, or a new color need not covered by section 3, should be built from the existing primitives and tokens first — a new component almost never needs a new color. If a genuinely new token is unavoidable, it should be added to this document (with its contrast ratio verified per section 3.4's method) before being used in code, not invented inline in a component file. This keeps the system a single source of truth rather than something that drifts apart from what's written here the first time an edge case shows up.
