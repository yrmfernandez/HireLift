# HireLift UI/UX refresh — "Grimoire / Illuminated Parchment"

Files changed (drop into your repo, replacing the originals):
- public/styles.css   (full rewrite — same class/id contract, new design system)
- public/index.html   (fonts + ambient layers + hero eyebrow/gilded word + tiny glow script)

No changes to app.js, the backend, or any DOM id/class the JS depends on.
No new dependencies, no build step, no config. Google Fonts swapped to
Fraunces + Inter + JetBrains Mono (same CDN you already use).

## What changed
- Concept: light theme = warm parchment with gilt ink; dark theme = midnight
  grimoire. Lead accent is gilded GOLD; violet is atmosphere only (steers away
  from the generic near-black + neon-violet look).
- Type: Fraunces (display) / Inter (body) / JetBrains Mono (data & labels).
- Signature: cards carry a dim gilded conic edge that AWAKENS and rotates only
  while the pipeline is visible (body:has(#pipeline:not([hidden]))), and the
  build bar gains a casting shimmer. The "magic" activates when the agents work.
- Hero: status eyebrow ("Four agents · Groq-powered · free to run") + a gilded
  shimmer on "ATS filters".
- Ambient: aurora wash, CSS starfield (dark only), masked arcane grid, and a
  soft pointer-follow glow (disabled on touch and under reduced motion).
- Both themes still work with your existing theme toggle. Verdict colours stay
  semantic (pass = emerald, fail = rose). Resume sheet stays clean & document-like.
- Accessibility: visible focus rings kept, prefers-reduced-motion disables all
  motion + the cursor glow, print still outputs only the resume sheet.

## Commit message — short
refresh(ui): re-skin HireLift as gilded grimoire/parchment; pipeline-driven enchantment

## Commit message — detailed
refresh(ui): re-skin HireLift as gilded grimoire / illuminated parchment

Rework the visual identity around an illuminated-manuscript concept: the light
theme is warm parchment with gilt ink, the dark theme is a midnight grimoire.
Gold becomes the lead accent (the "lift", shimmer, and matched-keyword state)
with violet used only for atmosphere, moving away from the default near-black +
neon-violet SaaS look.

- Rewrite public/styles.css as a new token system (light + dark) while keeping
  every class/id the HTML and app.js rely on, so no JS changes are needed.
- Swap type to Fraunces (display) / Inter (body) / JetBrains Mono (data).
- Add a subject-true signature: cards carry a gilded conic border that awakens
  and rotates only while #pipeline is visible, and the build-progress bar gains
  a casting shimmer — the enchantment activates when the agents actually run.
- Add ambient layers (aurora wash, CSS starfield in dark, masked grid) and a
  soft pointer-follow glow, all disabled on touch and under reduced motion.
- Enchant the hero with a status eyebrow and a gilded shimmer on "ATS filters".
- Preserve accessibility (focus rings, reduced-motion, print = resume only) and
  keep the resume sheet a clean, trustworthy document.

No new dependencies, no config, no build step.
