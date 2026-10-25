# CAREer Studio — limitations, service dependencies and running costs

As of 25 October 2026. Prices change; re-check the linked pages before budgeting.

## What works, and how it was verified

| Feature | Status | Verified by |
| --- | --- | --- |
| Upload (choose, camera, drag-drop, paste), EXIF orientation, HEIC/size/type errors | Working | Browser tests (Chromium, desktop + phone emulation) |
| Face finding and selection in group photos | Working, on-device | Browser tests incl. a two-person photo |
| Skin: Fresh, Silk, Cute + smooth skin, even tone, eyes, teeth, under-eyes (face mask only) | Working, on-device | Browser test asserts the face changed and background pixels did not |
| Face shape: small face, cheekbones, defined chin (local warp; eyes, nose, mouth held rigid) | Working, on-device | Browser test asserts the jaw area changed and background pixels did not |
| Makeup: lipstick (5 shades), blush (4), contouring, eyebrows (4), eyelashes | Working, on-device | Browser test asserts the lips changed and background pixels did not |
| Passport photos: Schengen/ICAO, UK, USA, UAE; 600 dpi file + 10×15 cm print sheet; automatic checks | Working, on-device | Browser test checks a 827×1063 px, 600-dpi ICAO file and an 1800×1200 print sheet |
| Light looks, Adjust (10 sliders) | Working, on-device | Browser tests |
| Background: standard cut-out + 7 modern-office and 9 career-photoshoot backdrops, blur, own image | Working, on-device | Browser tests |
| Crop/framing (LinkedIn 1:1, CV 3:4, Corporate 4:5, ID 35×45) | Working | Browser test checks a 1536×2048 CV download from a 2048×2048 photo |
| Compare (hold), split slider, undo/redo, reset (undoable), full-res JPEG/PNG download, share sheet, Projects | Working | Browser tests |
| Outfit (10 women's + 10 men's), Hair (6 finishes), Smile, HD cut-out, 8 AI modern offices | **Built; needs your Replicate key** | Exercised end-to-end against a test double of Replicate's HTTP API; outfit blending verified to keep face pixels identical. Not yet run against the live service |
| Enquiry / application → Telegram, photo only with separate opt-in, CV upload | **Built; needs your bot token + chat ID** | Exercised against a test double of the Telegram Bot API |
| Privacy consent before upload, delete photo, delete everything, withdraw consent | Working | Browser + server tests |

## Limitations

1. **Live AI not yet exercised.** The Replicate request formats follow Replicate's published API and the FLUX Kontext Pro input schema; BiRefNet's parameter names come from its model page, which does not state types. Run the *First-run checks* in the README once keys are set.
2. **Browsers tested:** Chromium only (desktop and phone emulation with touch). Real iPhone (Safari) and Android testing is still needed. iOS specifics are handled in code: HEIC guidance, the 16.7-megapixel canvas limit, the share sheet.
3. **Resolution.** On-device edits run at full resolution up to 4096 px on the long side / 16.7 MP; larger photos are scaled down and the user is told. AI-generated areas (clothes, hair, lower face) are created at about 1 MP for the edited crop, then blended into the full-resolution photo — fabric detail is softer than the original photo on very large images. The face itself stays at original resolution for Outfit and Hair.
4. **Cut-out quality.** The on-device cut-out (256 px model refined at 1024 px) can be soft around hair and may include objects touching the person; *HD · AI* is better. Lighting is not re-rendered: *Blend light* only shifts colour slightly.
5. **Identity.** Outfit and Hair keep the original face pixels. Smile changes the lower face by design (eyes stay original) and is labelled as changing appearance. Age and gender transformations are deliberately not offered: they can misrepresent a candidate on application photos.
6. **Face finding** needs a reasonably front-facing face of at least ~80 px; otherwise face tools explain they are unavailable and other tools still work.
7. **Single server instance.** AI jobs, rate limits and the daily budget counter live in memory: a restart cancels running AI edits and resets counters; don't scale to several instances without a shared store.
8. **No accounts.** Projects live only in the visitor's browser; clearing site data removes them.
9. **Backdrops** are original stylised, defocused artwork — not photographs. Photoreal offices come from the AI option (per-use cost) or the optional `npm run backgrounds:ai` script.
10. **Legal text.** The privacy page is a plain-language template, not legal advice. Have it reviewed (e.g. UAE PDPL / GDPR if you serve EU users), sign Replicate's data-processing terms if required, and state your retention for Telegram messages.
11. **FaceApp inspection** used public pages only; see the evidence report for what remains Unknown.
12. **Passport photos are not guaranteed to be accepted.** Sizes and head rules follow official pages where available (GOV.UK, travel.state.gov, u.ae) and published Schengen/ICAO figures; the checks (facing the camera, eyes open, mouth closed, even light, plain background, resolution) are automatic estimates. The UK, US and UAE reject digitally altered photos, so "Plain background" carries a warning there. Official UAE sizes are inconsistent across government pages. Glasses and head coverings are not detected — the user is asked to check.
13. **Makeup and face shape** are on-device approximations placed from 68 face landmarks: they work best on front-facing faces and can misplace slightly on strong head turns. Face shaping changes appearance and is labelled so.
14. **Luxury outfits** describe premium tailoring and fabrics only; no brand names, logos or monograms are requested, and results depend on the AI model.

## Service dependencies

| Service | Used for | Needed for | If it's down |
| --- | --- | --- | --- |
| Replicate (USA) | Outfit, Smile, Hair, HD cut-out, AI backdrops | Optional | AI tools show an error; on-device tools keep working |
| Black Forest Labs FLUX.1 Kontext Pro (via Replicate) | Image edits and backdrop generation | Optional | As above |
| BiRefNet (`sprited/birefnet` community package via Replicate) | HD cut-out | Optional | Use the on-device cut-out; or set another matting model |
| Telegram Bot API | Enquiries and applications | Optional | Form shows "couldn't send"; set `CONTACT_EMAIL` as a fallback |
| Hosting (e.g. Render) + domain/DNS | Serving the site and API | Required | Site offline |

No third-party scripts, fonts, analytics or CDNs are loaded by visitors' browsers.

## Running costs

| Item | Price | Source |
| --- | --- | --- |
| Hosting: Render paid web service, 0.5 CPU / 512 MB, always on | $7 / month | [temps.sh, Render pricing 2026](https://temps.sh/blog/render-pricing-2026) |
| Render bandwidth (Hobby workspace) | 5 GB included, then $0.15 / GB | [Render article, July 2026](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses) |
| Outfit / Smile / Hair edit (FLUX Kontext Pro) | ≈ $0.04 per edit | [invideo price survey, Aug 2026](https://invideo.io/blog/ai-image-model-pricing/) |
| AI office backdrop (FLUX Kontext Pro) | ≈ $0.04 per backdrop | same |
| HD cut-out (BiRefNet on Replicate) | ≈ $0.0012 per run | [Replicate model page](https://replicate.com/sprited/birefnet) |
| Telegram Bot API | Free | — |
| Domain (.com) | Registrar price, typically a small yearly fee | Check your registrar |

**Worked example — 1,000 visitors a month who each make 2 outfit edits, 1 HD cut-out, and 1 in 5 also try smile/hair and 1 in 3 an AI backdrop:**
AI ≈ 1,000 × (2 × $0.04 + $0.0012 + 0.2 × $0.04 + 0.33 × $0.04) ≈ **$102**; bandwidth ≈ 12 MB × 1,000 ≈ 12 GB → ≈ $1; hosting $7. **≈ $110 / month.**
The default `DAILY_AI_BUDGET_USD=5` caps AI spend at about $150 / month; raise it as usage grows. On-device editing costs nothing per use.

## Security and privacy controls

- API keys only in server environment variables; `/api/config` exposes feature flags only (tested).
- Strict Content-Security-Policy (no inline script, no `eval`), `nosniff`, no referrer, COOP/CORP, HSTS on HTTPS, configurable `frame-ancestors`.
- State-changing API calls need a custom header and a same-origin `Origin`; session cookie is HttpOnly + SameSite=Strict (+ Secure on HTTPS).
- AI requests accept only fixed, server-defined style presets — no free-text prompts; uploads are type-sniffed and size/dimension-limited; per-IP rate limit, concurrency cap and daily budget cap.
- Model outputs are only downloaded from an allow-listed host (SSRF guard).
- Photos are held in memory only while an AI job runs, the Replicate copy is deleted when the prediction ends, results are dropped once downloaded or after 10 minutes, and "Delete" cancels running jobs. Nothing photographic is logged.
- Contact form: HTML-escaped, honeypot + timing check, rate limited; photo sent only with the separate opt-in; CV type checked by file signature.
