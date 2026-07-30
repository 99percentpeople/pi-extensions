---
name: gpt-image-prompts
description: Craft and refine production-ready prompts for GPT Image 2. Use when a user needs an image-generation prompt, a stronger visual brief, prompt variations, or precise edit instructions for photos, illustrations, posters, ads, product visuals, characters, diagrams, or reference-guided images.
license: MIT
compatibility: Prompt-only guidance optimized for GPT Image 2. It does not require or prescribe an image tool, API, credential, or file workflow.
---

# GPT Image Prompts

Write clear, visually specific prompts for GPT Image 2. Preserve the user's idea
and improve only the details that materially increase control, composition, and
image quality.

This is a **prompt-writing skill only**. Do not turn its output into a tool
manual, API request, command, path policy, authentication flow, or error guide.
Tool selection and execution are outside this skill.

## Output contract

- Return a ready-to-use image prompt, not a tutorial, unless the user asks for
  an explanation.
- Keep simple requests to one to three clear sentences. Use short labeled lines
  for complex scenes, edits, layouts, or exact in-image text.
- Preserve the user's language and all exact quoted text. Do not translate,
  paraphrase, or "improve" required copy unless asked.
- If the user asks for multiple options, make each variation intentionally
  different in art direction, composition, palette, or mood—not minor synonym
  changes.
- Do not include tool names, model parameters, JSON, API fields, output paths,
  credentials, or implementation steps in the final prompt.
- Ask one concise question only when a missing detail would make the result
  materially wrong, such as the exact required text, the edit target, or a
  contradictory composition. Otherwise make the smallest reasonable inference.

## Core method

### 1. Preserve intent

Identify the user's non-negotiables before adding detail:

- what the image is for;
- the main subject and action;
- required style or medium;
- required composition or orientation;
- exact text that must appear;
- elements that must stay unchanged;
- elements that must not appear.

Do not invent extra characters, props, slogans, logos, brand colors, story
beats, or side-specific placement that the request does not imply.

### 2. Choose the right amount of detail

- If the request is already specific, normalize it into a clean visual brief
  without adding creative requirements.
- If it is vague, add only high-value visual decisions: a useful framing,
  coherent lighting, a compatible palette, and concrete material or texture
  cues.
- Prefer observable descriptions over vague praise. Use "soft window light from
  the left, low contrast, warm highlights" instead of "beautiful lighting".
- Prefer a few strong constraints over a long negative-prompt inventory.

### 3. Structure the prompt

Use this order when relevant:

1. **Purpose and format** — editorial illustration, campaign image, book cover,
   product visual, poster, diagram, character sheet, and so on.
2. **Scene or backdrop** — place, era, weather, environment, and depth.
3. **Subject and action** — appearance, pose, gaze, scale, interaction, and the
   focal moment.
4. **Style or medium** — photograph, watercolor, gouache, ink, oil, 3D, collage,
   printmaking, flat graphic design, and its concrete visual traits.
5. **Composition** — framing, viewpoint, perspective, subject placement,
   hierarchy, negative space, and crop.
6. **Lighting and color** — direction, softness, contrast, time of day, palette,
   atmosphere, and mood.
7. **Materials and finish** — surfaces, fabric, skin, paper, brushwork, grain,
   imperfections, or print texture.
8. **Text** — exact wording, typography, size, color, placement, and frequency.
9. **Constraints** — what to preserve, what to avoid, and what must not change.

Not every prompt needs every section. Remove empty or low-value lines.

## Visual direction

### Photorealistic scenes

Use `photorealistic` explicitly when realism is the goal. Describe the image as
a real moment being photographed:

- camera distance and framing: close-up, medium shot, wide shot, full body;
- viewpoint: eye-level, top-down, low angle, over-the-shoulder;
- natural light and atmosphere;
- believable skin, fabric, material wear, reflections, and imperfections;
- candid pose, gaze, and object interaction;
- restrained processing when the image should feel documentary or unstaged.

Camera and lens language is useful for overall look, but do not overload the
prompt with technical specifications that do not affect the requested image.

### Illustration and painting

Describe visual properties rather than relying on an artist's name:

- medium and surface: watercolor on cold-press paper, thick oil on canvas,
  gouache, charcoal, risograph, woodblock, cel animation, digital matte painting;
- mark-making: loose washes, dry-brush texture, visible impasto, fine crosshatch,
  clean geometric shapes, soft pencil underdrawing;
- edge treatment: crisp silhouette, lost-and-found edges, soft atmospheric
  contours, bold ink outline;
- shape language and depth: rounded friendly forms, angular silhouettes,
  layered foreground/midground/background;
- palette and value structure: muted earth tones, limited duotone, luminous
  jewel colors, high-key pastels, deep chiaroscuro;
- finish: handmade irregularity, subtle paper grain, screen-print misregistration,
  polished animation background.

For a consistent character, repeat the defining facial features, proportions,
outfit, palette, and personality in every revision.

### Composition and people

When composition matters, specify:

- orientation or canvas intent: portrait, landscape, square, panoramic;
- focal point and visual hierarchy;
- foreground, midground, and background relationships;
- usable negative space only when copy or UI genuinely needs it;
- body framing such as "full body visible, feet included";
- gaze and action such as "looking at the open book, not at the camera";
- hand/object interaction such as "both hands naturally gripping the handle".

Use left/right placement only when the user or intended layout requires it.

## Text inside images

Text is a visual constraint, not an afterthought:

- Put exact copy in quotes or ALL CAPS.
- Say `verbatim`, specify that it appears exactly once, and prohibit extra text.
- Specify typography category, weight, color, alignment, placement, and relative
  size.
- Keep copy short where possible.
- For an uncommon name or difficult word, add a spelling cue such as
  `S-T-R-I-P-E`, while retaining the normal verbatim text that must be rendered.
- For posters, diagrams, and infographics, define hierarchy and reading order;
  require sharp, legible text and adequate whitespace.

Example constraint:

```text
Text (verbatim, exactly once): "WEEKLY PLAN"
Typography: bold white geometric sans-serif, centered at the top, large headline
No other words, letters, logos, signatures, or watermarks.
```

## Reference images

When images are provided, assign each a role instead of treating every image as
an edit target:

```text
Image 1: base scene and composition reference.
Image 2: subject identity reference.
Image 3: color and brushwork reference only.
```

Then state the relationship explicitly: what to borrow, what to transplant,
what to change, and what must remain untouched. For compositing, specify
placement, scale, perspective, lighting, contact shadows, and occlusion.

## Precise edits

Lead with the single requested change, followed by a preservation lock:

```text
Change only <target change>.
Preserve <identity, geometry, pose, framing, lighting, background, typography>.
Keep everything else exactly unchanged.
Do not add <unwanted elements>.
```

Repeat the preservation lock on every edit iteration. For identity-sensitive
work, explicitly preserve face, facial features, skin tone, body shape,
proportions, pose, expression, hair, and camera angle as applicable.

## Iteration

Improve images through small, diagnosable revisions:

1. Establish the core scene and composition.
2. Review the mismatch in concrete visual terms.
3. Change one major variable at a time.
4. Restate critical invariants so the image does not drift.

Good follow-ups:

- `Keep the same composition; make the window light warmer and softer.`
- `Change only the jacket to dark navy wool; preserve identity and pose.`
- `Remove the extra tree; keep the landscape, camera angle, and palette unchanged.`

Avoid rewriting the entire prompt when a targeted correction is enough.

## Prompt templates

### New image

```text
Purpose: <intended asset and audience>
Scene: <setting, era, weather, backdrop>
Subject: <main subject, appearance, action, gaze, interaction>
Style/medium: <visual medium and concrete stylistic traits>
Composition: <orientation, framing, viewpoint, placement, negative space>
Lighting/color: <direction, softness, contrast, palette, mood>
Materials/texture: <important surfaces and finish>
Text (verbatim): "<exact copy>"
Constraints: <must include; must preserve; must avoid>
```

### Edit

```text
Primary change: Change only <specific target>.
Preserve: <identity, geometry, pose, composition, lighting, background, text>.
Integration: Match <perspective, scale, material behavior, shadows, color temperature>.
Constraints: Keep everything else exactly unchanged; <additional exclusions>.
```

### Reference-guided image

```text
Image 1: <role>.
Image 2: <role>.
Primary request: <new scene or transformation>.
Borrow from references: <identity/style/palette/composition cues>.
Preserve: <locked attributes>.
Do not copy or add: <logos, unrelated text, extra elements>.
```

## Examples

### Natural photograph

```text
Create a photorealistic candid photograph of an elderly sailor adjusting a net
on a small fishing boat while his dog rests nearby. Medium close-up at eye
level, soft coastal daylight, shallow depth of field, subtle film grain, natural
color, weathered skin, worn fabric, and salt-aged wood. The moment should feel
honest and unstaged—no glamorization, heavy retouching, text, or watermark.
```

### Painterly illustration

```text
Create a quiet fantasy editorial illustration of a lone herbalist crossing a
misty alpine meadow at dawn. Hand-painted gouache on textured paper, simplified
rounded shapes, soft dry-brush edges, layered atmospheric depth, muted sage and
umber palette with a small amber accent on the lantern. Wide landscape
composition with the figure small against the mountains; no text, logo, or
watermark.
```

### Poster with exact text

```text
Create a minimal vertical event poster built from bold cobalt and warm ivory
geometric shapes with generous negative space and crisp screen-print texture.
Text (verbatim, exactly once): "NIGHT MARKET". Set it in a heavy condensed
sans-serif, ivory, centered in the upper third as the dominant element. No
other words, letters, logos, signatures, or watermarks.
```

### Surgical edit

```text
Change only the white dining chairs to natural oak chairs with realistic wood
grain. Preserve the exact room geometry, camera angle, table, walls, floor,
lighting direction, contact shadows, and all surrounding objects. Match the
original perspective and color temperature. Keep everything else exactly
unchanged; add no new decor or text.
```
