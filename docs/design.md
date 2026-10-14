# Design system

The admin UI uses [shadcn/ui](https://ui.shadcn.com) (base-luma style, Base UI primitives) on the neutral theme. Any UI added here uses its tokens and components instead of inventing colours, sizes or components.

## How it is wired

- `app/globals.css` imports Tailwind, `tw-animate-css` and `shadcn/tailwind.css`, then defines the theme: stock shadcn neutral variables for light (`:root`) and dark (`.dark`), plus the few tokens this app adds (`success`, `warning`, `emphasis`, the type scale).
- `components.json` sets the shadcn style to `base-luma`. Add components with `pnpm dlx shadcn@latest add <name>` and check what it writes (imports, new packages).
- `components/ui/` holds the installed components: alert, alert-dialog, badge, button, card, dialog, empty, field, input, item, label, native-select, radio-group, scroll-area, separator, sheet, sidebar, skeleton, sonner, spinner, switch, table, textarea, tooltip, plus `logo.tsx` and the icon modules in `icons/`.
- `logo.tsx` is a placeholder: the Material Symbols `shield_lock` glyph and an "Alarm Panel" wordmark, in `currentColor`. `public/icon.svg` is the same glyph as the favicon. A proper logo is tracked separately.
- Only the light theme is reachable in the admin: nothing sets `.dark` on `<html>`.

## Colours

Use the semantic utilities: `bg-background` `text-foreground` `bg-card` `bg-primary` `text-primary-foreground` `bg-secondary` `bg-muted` `text-muted-foreground` `bg-accent` `border-border` `border-input` `ring-ring` `bg-destructive` `bg-success` `bg-warning` and the `emphasis` family. Never a raw hex value in `app/admin` or `components/`: ESLint rejects hex in a class and arbitrary text sizes.

- `accent` is shadcn's: a light hover and active surface.
- `emphasis` (`border-emphasis`, `bg-emphasis/15`) marks the one thing that matters in a view: a selected row, the armed state in the header pill, a featured card, the heatmap's busiest cells.
- `success`, `warning`, `destructive` carry status only.

## Typography

`font-sans` is Figtree, `font-display` is Fraunces (headings), `font-mono` is JetBrains Mono. All three come from Google Fonts through `next/font/google` in `app/layout.tsx`: downloaded at build time and served by the app, so the running app never calls out.

Sizes come from the type scale in `app/globals.css`: `text-title-xs` (24px) for page, dialog and card headings, `text-body-m` (16px), `text-body-s` (14px), `text-body-xs` (12px) and `text-eyebrow-s` (10px, mono, uppercase, `tracking-eyebrow`) for labels. Tailwind's `text-xs`, `text-sm` and `text-base` match the three body sizes and are also fine.

`lib/utils.ts` extends `tailwind-merge` with the scale. Keep it in step with the scale, or a component's own `text-sm` will survive next to a `text-body-*` class.

## Icons

Icons are Material Symbols (Apache-2.0), Rounded, weight 300, one module per icon in `components/ui/icons/`:

```tsx
import { CheckIcon } from "@/components/ui/icons/check";
<CheckIcon size={16} />
```

Add one by copying a module and changing the glyph. Icons are decorative (`aria-hidden`) unless you pass `label`; an icon-only button needs a `label` or an `aria-label`. ESLint blocks `lucide-react` and the vendor package outside `components/ui/icons/`.

## Surfaces

- `/admin`: React with the components above. Eight screens (Overview, Sensors, PINs, Delays, Audit log, Events, Tasks, Settings), the setup wizard and the sign-in screen. `rounded-lg` for buttons, inputs and cards, soft shadow on cards. Only circles (health dots, the PIN hint) stay round.
- `/panel`: the wall-tablet kiosk. It does not use React components or Tailwind classes, on purpose: it targets iOS 12 and old Safari (`.browserslistrc`) and is a server-rendered page plus one hand-written script (`public/panel.js`), verified with JavaScript disabled. Its colours are the neutral dark theme written out as hex custom properties (`--panel-*`) in `app/panel/panel.css`:
  - **Colour:** always dark (`--panel-bg` `#171717`), with green success, amber warning and red destructive state banners, and `--panel-ok-text` `#6ee7b7` for small success text, which the banner green is too dim for.
  - **Arm button:** the only orange fill (`--panel-arm` `#ea580c`). It is the one action on the wall, read from across the room. An open door uses a lighter orange outline (`--panel-attention`), so arming stays the loudest thing on screen.
  - **Shape:** 10px corners on controls and containers, circles for the PIN dots and door dots.
  - **Type:** sizes sit on the same scale as the admin, in rem. Buttons and keys are sentence case; only eyebrow labels are mono uppercase.
  - **iOS 12:** no `gap` on flex containers, no `aspect-ratio`, no `clamp()`, no `:focus-visible` (see the notes at the top of `panel.css`).
- `panel.js` loads through `next/script` with `strategy="afterInteractive"`: a plain deferred script can mutate the DOM before Next's hydration pass and leave `getElementById` references pointing at detached nodes. Keep that in mind when adding a script tag or a dynamically mutated element to the page.

## Local components

These are built here with tokens, not installed from shadcn:

- the header status pill (arm state, countdown, dot);
- the arm and disarm activity heatmap (Overview);
- the sensor list rows with a health dot and the mode picker (Delayed, Instant, Ignore);
- the camera tile (live stream with a snapshot fallback and an expand dialog);
- the incident rows on the Events screen;
- the settings form (`app/admin/SettingsGroupForm.tsx`), shared by Settings and the setup wizard.

## Checking a UI change

`pnpm shots:baseline` on `main` and `pnpm shots` on your branch compare the screenshots pixel for pixel (see CONTRIBUTING.md): the admin screens and dialogs at 1440 and 390 pixels wide, and the kiosk states at tablet sizes plus one 390 pixel overflow check. Run the keyboard flows in `e2e/` too: `pnpm test:e2e`.
