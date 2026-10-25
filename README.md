# CAREer Studio

A mobile-first professional-photo editor: skin finishes, makeup, face shaping, luxury office and smart-casual outfits for women and men, hair finishes, modern-office and career-photoshoot backgrounds, passport photos, and framing for LinkedIn, CVs and company profiles. Enquiries and applications are delivered to your Telegram.

- **On-device (free, nothing uploaded):** face finding & selection; **Skin** (Fresh, Silk, Cute + smooth, even tone, eyes, teeth, under-eyes); **Face shape** (small face, cheekbones, defined chin); **Makeup** (lipstick ×5 shades, blush ×4, contouring, eyebrows ×4, eyelashes); Light looks; Adjust; standard cut-out with built-in modern-office and career-photoshoot studio backdrops, blur or your own image; **Passport photos** (Schengen/ICAO, UK, USA, UAE); Crop; before/after compare; undo/redo; full-resolution download; Projects.
- **AI service (Replicate, pay-per-use, opt-in per visit):** **Outfit** (10 women's + 10 men's luxury-tailored looks, office and smart casual), **Hair** (Straight, Volume, Curly, Shiny, Texture, Keratin), Smile (4), HD cut-out, photorealistic AI modern offices (8, no photo sent).

The server is plain Node.js with **no runtime dependencies**. API keys stay on the server.

## Quick start (local)

Requirements: Node.js 20.10+ (22 recommended).

```bash
cp .env.example .env      # then edit .env (see below) — or leave keys empty to try on-device tools only
npm start                 # http://localhost:8080
```

Open http://localhost:8080 on your computer, or on a phone on the same Wi-Fi via your computer's IP address. (The camera button needs HTTPS when not on localhost.)

## Configure

All settings are environment variables — see `.env.example` for the full list.

### AI editing (Replicate)
1. Create an account at replicate.com, add billing, and create an API token (Account ▸ API tokens).
2. Set `REPLICATE_API_TOKEN=` in `.env`.
3. Set a spending cap: `DAILY_AI_BUDGET_USD` (default 5). AI tools pause for the rest of the UTC day once reached; on-device tools keep working. Also set a monthly limit in your Replicate billing settings.
4. Verify with real calls (see *First-run checks* below).

Models (override if you prefer others with the same inputs):
| Purpose | Default | Notes |
| --- | --- | --- |
| Outfit, Smile, Hair, AI backdrops | `black-forest-labs/flux-kontext-pro` | Prompts are fixed presets in `server/ai-presets.js` (no brand names or logos) |
| HD cut-out | `sprited/birefnet` (variant `portrait`) | Community package of BiRefNet (MIT). Pin a version with `owner/name:versionid` for stability |

### Telegram (enquiries & applications)
1. In Telegram, open **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (or add it to a team group and post there).
3. Run `npm run telegram:chat-id` and copy the printed `TELEGRAM_CHAT_ID` into `.env`.
4. Restart. The Profile page form now delivers messages; photos are attached only when the visitor adds one **and** ticks the separate photo-sharing box. CVs (PDF/DOC/DOCX ≤ 5 MB) are sent as documents.

### Branding
- Colours and fonts are CSS tokens at the top of `public/css/app.css` (taken from the brand mockup: cream `#faf2eb`, ink `#391e21`, plum `#5e2f3b`, mauve CTA `#8a5a65`, copper sparkle `#ad6e3e`; Newsreader serif + the device's system font).
- The primary buttons carry the diagonal light sweep (top-left → bottom-right), `.btn-shine`; it stops for visitors who prefer reduced motion.
- Hero portrait: add a licensed photo at `public/brand/hero.jpg` (portrait orientation, ~1200×1600) and it appears on the home page automatically.
- Backdrops: original artwork in `public/backgrounds/` — 7 modern offices and 9 career-photoshoot studio backdrops (regenerate with `npm run backgrounds:art`, needs Python + numpy/opencv/Pillow). Optional photoreal office set: `npm run backgrounds:ai` (uses your Replicate key; check the model's output licence).

### Passport photos
The Passport tool always starts from the **original** photo (no skin, makeup, shape or AI edits), straightens a tilted head, sizes the head to the official rule and exports at 600 dpi with a 10×15 cm print sheet. Formats and rules (checked 25 Oct 2026):

| Format | Size | Head (chin–crown) | Background | Editing rule |
| --- | --- | --- | --- | --- |
| Schengen / ICAO | 35×45 mm | 32–36 mm | white / very light grey | no filters or retouching |
| UK | 35×45 mm | 29–34 mm | plain cream or light grey | must be unaltered by software (GOV.UK) |
| USA | 2×2 in | 25–35 mm | white / off-white | no digital changes, filters, apps or AI (travel.state.gov) |
| UAE | 4.5×5.5 cm | 70–80 % of height | white | altered photos reported as rejected; official pages give inconsistent sizes — confirm with ICP |

"Plain background" is optional and clearly marked as a digital edit; for the UK, USA and UAE the safe route is a photo taken against a plain light wall, and the tool's checks say so.

## Deploy with the domain careerstudioapp.com

**Step-by-step click guide: [`docs/DEPLOY.md`](docs/DEPLOY.md).**

The brief asks for a domain containing `careerstudioapp`. A search found no live site at careerstudioapp.com, but availability can only be confirmed at a registrar. Register it (or e.g. `careerstudioapp.app`) yourself.

**Render (simplest):** push this folder to a GitHub repo → Render ▸ New ▸ Blueprint → pick the repo (uses `render.yaml`) → enter `REPLICATE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` → Deploy. Then Settings ▸ Custom Domains → add `careerstudioapp.com` and `www.careerstudioapp.com`, and create the DNS records Render shows at your registrar. HTTPS certificates are automatic.

**Any Docker host / VPS:** `docker build -t careerstudio . && docker run -p 8080:8080 --env-file .env careerstudio`, behind a TLS-terminating proxy (Caddy/Nginx) with `TRUST_PROXY=1`.

Production checklist: `PUBLIC_ORIGIN=https://careerstudioapp.com`, `ALLOWED_ORIGINS=https://www.careerstudioapp.com`, `NODE_ENV=production`, `TRUST_PROXY=1`, run **one** instance (AI jobs and limits are held in memory).

**Adding it to an existing website:** link to `https://careerstudioapp.com/editor` (e.g. `?format=linkedin`, `cv` or `corporate` pre-frames the photo), or embed it in an iframe after setting `FRAME_ANCESTORS="https://your-main-site.example"`.

## First-run checks with real services

The AI and Telegram integrations were tested against faithful test doubles of their APIs (no live keys were available while building). After adding real keys:

1. Open `/profile` → *Service status* shows AI editing and Contact form as Available.
2. Editor ▸ Outfit ▸ pick a style → accept consent → result appears within ~10–30 s; Apply; hold Compare.
3. Background ▸ HD · AI ▸ an office → cut-out quality check around the hair.
4. Background ▸ an *AI office* → a generated backdrop appears.
5. Profile ▸ send a test enquiry → it arrives in Telegram. Send one with a photo (ticking the photo box) → the photo arrives as a document.
6. Replicate dashboard ▸ Predictions → each call appears; Files list stays empty after edits finish.

If a step fails, the server log prints the provider's error detail (never the photo or personal data).

## Tests

```bash
npm test               # 22 server tests: API, AI job lifecycle, deletion, CSRF, SSRF guard, budget, rate limits, Telegram, opt-in
npm i -D playwright && npx playwright install chromium
npm run test:e2e       # browser: upload → skin → face shape → makeup → light → AI outfit → AI hair → HD background → AI office → compare → passport (+ print sheet) → crop → undo/redo/reset → download; contact form; projects; deletion; group photo; desktop + phone
```

The test doubles in `test/fakes.js` stand in for Replicate and Telegram and return synthetic patterns — they are never used by the running app.

## Project layout

```
server/            Node HTTP server: static files, AI job queue, Replicate client, Telegram, security
public/            The site: index (home), editor, projects, profile, privacy
  js/engine/       Pixel operations (worker-based), undo/redo history
  js/editor/       Editor UI, canvas view, face finding, on-device cut-out, AI client & region blending
  vendor/, models/ face-api (MIT) + TensorFlow.js, face models, selfie segmentation model
  backgrounds/     Original office backdrops
scripts/           Telegram chat-id helper, backdrop generators
test/              Server tests, browser end-to-end test, test doubles, fixtures
docs/              Operations: limitations, service dependencies, costs, security & privacy
```

See `docs/OPERATIONS.md` for limitations, dependencies and running costs, and `docs/THIRD-PARTY.md` for licences.
