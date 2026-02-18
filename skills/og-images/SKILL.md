---
name: og-images
description: Create or modify Open Graph images for Next.js pages using next/og (Satori). Covers Satori rendering quirks, testing patterns, and the project's OG image conventions.
---

# OG Images Skill

## Overview

OG images are dynamically generated at request time by Next.js using `next/og` (Satori engine). They render JSX → SVG → PNG. Images are **not static files** — they query ClickHouse for live data and always reflect current numbers. No cron jobs or manual regeneration needed.

## Architecture

Each route can have an `opengraph-image.tsx` file that Next.js serves at `/<route>/opengraph-image`. Next.js automatically:
- Adds `<meta property="og:image">` and `<meta name="twitter:image">` to the page's `<head>`
- Caches the generated image
- Includes size and content-type metadata

### Files

| File | What it generates |
|------|-------------------|
| `app/src/app/opengraph-image.tsx` | Homepage — headline AI share % + sparkline |
| `app/src/app/bots/[id]/opengraph-image.tsx` | Per-product — avatar, description, 3 stat boxes |
| `app/src/app/compare/opengraph-image.tsx` | Compare — horizontal bar chart of top products |
| `app/src/app/orgs/opengraph-image.tsx` | Orgs listing — grid of top org avatars |

### Data flow

```
Request → opengraph-image.tsx → queries ClickHouse → Satori renders JSX → PNG response
```

Product descriptions and stats come from the `products` table (synced from `pipeline/src/bots.ts`). OG images always show current data.

## Satori Rendering Rules (CRITICAL)

Satori is NOT a browser. It converts JSX to SVG, which means many CSS features don't work. These rules are non-negotiable:

### 1. Every `<div>` with children MUST have `display: "flex"`

```tsx
// ❌ WILL CRASH — "Expected <div> to have explicit display: flex"
<div>
  <span>Hello</span>
  <span>World</span>
</div>

// ✅ Correct
<div style={{ display: "flex" }}>
  <span>Hello</span>
  <span>World</span>
</div>
```

This is the #1 source of errors. If Satori throws `Expected <div> to have explicit "display: flex"`, you have a div somewhere without it.

### 2. Even empty/placeholder divs need `display: "flex"`

```tsx
// ❌ Will crash
<div style={{ width: "100px", height: "100px" }} />

// ✅ Correct
<div style={{ display: "flex", width: "100px", height: "100px" }} />
```

### 3. Conditional rendering must maintain `display: flex`

Both branches of a ternary must produce elements with `display: flex`:

```tsx
// ✅ Both branches have display: flex
{hasData ? (
  <div style={{ display: "flex" }}>...</div>
) : (
  <div style={{ display: "flex", width: "400px" }} />
)}
```

### 4. No Tailwind, no CSS classes

All styles must be inline `style={{}}` objects. CSS custom properties (`var(--x)`) don't work.

### 5. Limited CSS support

**Works:** flexbox, padding, margin, border, borderRadius, background, color, fontSize, fontWeight, lineHeight, letterSpacing, opacity, gap, transform, overflow, linear-gradient, width/height
**Doesn't work:** grid, position:absolute (limited), box-shadow, backdrop-filter, animation, pseudo-elements, media queries, CSS variables
**Partially works:** `overflow: "hidden"` (basic clipping)

### 6. Images must use `<img>` with full URLs

```tsx
// ✅ Works in Satori
<img src="https://avatars.githubusercontent.com/..." width={80} height={80} alt="" />

// ❌ Won't work — relative paths or next/image
<Image src="/logo.png" ... />
```

### 7. SVG works natively

SVG is rendered directly (Satori's output is SVG). Sparklines, shapes, etc. work well:

```tsx
<svg width="400" height="120" viewBox="0 0 400 120">
  <path d={pathData} stroke="#7c3aed" strokeWidth="4" fill="none" />
</svg>
```

### 8. Text wrapping

Text in flex containers wraps naturally. Set `lineHeight` explicitly. Don't use `-webkit-line-clamp` — it doesn't work in Satori. Instead, truncate in JavaScript before passing to JSX.

### 9. `backgroundClip: "text"` doesn't work reliably

Gradient text via `backgroundClip: "text"` / `color: "transparent"` is unreliable. Use solid colors.

## Project Conventions

### Visual design
- **Background:** `linear-gradient(135deg, #0a0a1a 0%, #1a1040 50%, #0a0a1a 100%)` — matches dark theme
- **Text color:** `#e2e8f0` primary, `#94a3b8` secondary, `#64748b` muted
- **Font:** `system-ui, -apple-system, sans-serif`
- **Size:** 1200×630px (standard OG)
- **Padding:** `60px 80px` (or `50px 60px` for denser layouts)

### Logo watermark (bottom-right of every image)
```tsx
<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
  <div style={{
    width: "28px", height: "28px", display: "flex",
    background: "linear-gradient(135deg, #a78bfa, #6d28d9)",
    borderRadius: "5px", transform: "rotate(45deg)", opacity: 0.9,
  }} />
  <div style={{ fontSize: "18px", fontWeight: 700, display: "flex" }}>
    <span style={{ color: "#c4b5fd" }}>Code</span>
    <span style={{ color: "#a78bfa" }}>Review</span>
    <span style={{ color: "#22d3ee" }}>Trends</span>
  </div>
</div>
```

### Product pages use brand colors
Read `brand_color` from the product and use it for the product name, stat values, and avatar border.

### Stat boxes
```tsx
<div style={{
  display: "flex", flexDirection: "column",
  padding: "20px 36px", borderRadius: "16px",
  border: "1px solid rgba(148, 163, 184, 0.2)",
  background: "rgba(255, 255, 255, 0.05)",
}}>
  <div style={{ fontSize: "16px", color: "#94a3b8", display: "flex" }}>Label</div>
  <div style={{ fontSize: "40px", fontWeight: 800, color: brandColor, display: "flex" }}>Value</div>
</div>
```

### Required exports

Every `opengraph-image.tsx` must export:
```tsx
export const runtime = "nodejs";
export const alt = "Descriptive alt text";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
```

## Testing

### Manual (dev server)
```bash
# Direct image URLs — open in browser or curl
curl -o /tmp/og.png http://localhost:<port>/opengraph-image
curl -o /tmp/og-bot.png http://localhost:<port>/bots/coderabbit/opengraph-image
```

### Playwright (CI)
OG images are tested in `app/e2e/og-images.spec.ts`:
- Every OG image route returns 200 with `image/png` content type
- Homepage OG image is > 10KB (not a broken/empty image)
- HTML `<meta og:image>` tag is present on pages

### Verifying meta tags
```bash
curl -s http://localhost:<port>/bots/copilot | grep 'og:image'
# Should contain: <meta property="og:image" content="...opengraph-image..." />
```

## Adding a New OG Image

1. Create `app/src/app/<route>/opengraph-image.tsx`
2. Add the 4 required exports (runtime, alt, size, contentType)
3. Query ClickHouse for data (wrap in try/catch for graceful fallback)
4. Build JSX with `display: "flex"` on EVERY div
5. Return `new ImageResponse(<jsx>, { ...size })`
6. Test: `curl -o /tmp/test.png http://localhost:<port>/<route>/opengraph-image`
7. Add a test case in `app/e2e/og-images.spec.ts`
