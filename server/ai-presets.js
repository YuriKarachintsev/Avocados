// Fixed, server-side prompt presets. The browser only sends a preset id, never
// free text, so the AI service can only be asked for these specific edits.

const KEEP_IDENTITY =
  "Keep the person's identity, face, facial features, skin tone, skin texture, eyes, expression, head position, " +
  'body shape, pose, camera angle, framing, lighting and the background exactly the same. Photorealistic result.';

// "Luxury" is described as quality and finish only — no brand names, logos or monograms.
const LUXURY =
  'Luxury-label tailoring quality: premium natural fabric with a subtle sheen, precise fit, sharp clean lines, ' +
  'expertly pressed, understated and elegant. No visible logos, monograms, brand marks or text.';

const outfit = (garment) =>
  `Change only the person's clothing to ${garment}. ${LUXURY} The clothes should fit the person's body and pose naturally. ${KEEP_IDENTITY}`;

const smile = (expr) =>
  `Change only the person's facial expression to ${expr}. Keep their identity, face shape, eyes, nose, skin, hair, pose, ` +
  'clothing, lighting and background exactly the same. Photorealistic result.';

const hair = (finish) =>
  `Change only the person's hair to ${finish}. Keep the same natural hair colour and approximate length, and keep the face, ` +
  'facial features, hairline, skin, expression, pose, clothing, lighting and background exactly the same. Photorealistic result.';

export const EDIT_PRESETS = {
  outfit: {
    // Women — office
    'w-office-ivory': { label: 'Ivory double-breasted blazer', prompt: outfit('a tailored ivory double-breasted blazer in fine wool with peak lapels, worn over a silk camisole') },
    'w-office-tuxedo': { label: 'Black tuxedo blazer', prompt: outfit('a black single-button tuxedo-style blazer with satin peak lapels over a crisp white silk blouse') },
    'w-office-camel': { label: 'Camel cashmere blazer', prompt: outfit('a camel cashmere-blend blazer with structured shoulders over a cream silk shell top') },
    'w-office-navy': { label: 'Navy blazer & bow blouse', prompt: outfit('a navy fine-wool blazer over a white silk blouse with a soft pussy-bow neckline') },
    'w-office-greige': { label: 'Greige sheath & jacket', prompt: outfit('a greige crepe sheath dress with a softly structured matching collarless jacket') },
    // Women — smart casual
    'w-smart-cashmere': { label: 'Cream cashmere roll-neck', prompt: outfit('a fine-gauge cream cashmere roll-neck sweater with minimal gold jewellery') },
    'w-smart-silk': { label: 'Champagne silk shirt', prompt: outfit('a champagne silk shirt with a relaxed open collar and a delicate gold pendant') },
    'w-smart-boucle': { label: 'Bouclé jacket', prompt: outfit('a soft blush bouclé tweed jacket with braided trim over a white fitted top') },
    'w-smart-knitblazer': { label: 'Knit blazer & tee', prompt: outfit('a soft black knitted blazer over a white fitted crew-neck top') },
    'w-smart-trench': { label: 'Trench collar & fine knit', prompt: outfit('a beige gabardine trench coat with the collar visible over a navy fine-knit top') },
    // Men — office
    'm-office-charcoal': { label: 'Charcoal suit & navy tie', prompt: outfit('a charcoal grey super-fine wool two-piece suit, a crisp white dress shirt and a navy silk grenadine tie') },
    'm-office-chalk': { label: 'Navy chalk-stripe suit', prompt: outfit('a navy suit with a very subtle chalk stripe, a light-blue dress shirt and a burgundy silk tie') },
    'm-office-3piece': { label: 'Midnight three-piece', prompt: outfit('a midnight-blue three-piece suit with a waistcoat, a white dress shirt and a silver-grey silk tie') },
    'm-office-black': { label: 'Black suit & silk tie', prompt: outfit('a black slim-cut suit, a white dress shirt and a black silk tie') },
    'm-office-glen': { label: 'Glen-check double-breasted', prompt: outfit('a grey glen-check double-breasted suit jacket, a white dress shirt and a dark-blue knitted silk tie') },
    // Men — smart casual
    'm-smart-camel': { label: 'Camel blazer, open collar', prompt: outfit('an unstructured camel cashmere blazer over a white shirt with an open collar') },
    'm-smart-polo': { label: 'Knit polo & linen blazer', prompt: outfit('a navy fine merino knitted polo under a stone-coloured linen-blend blazer') },
    'm-smart-rollneck': { label: 'Roll-neck & charcoal blazer', prompt: outfit('a black fine-gauge merino roll-neck under a charcoal wool blazer') },
    'm-smart-oxford': { label: 'Oxford shirt & navy blazer', prompt: outfit('a light-blue oxford button-down shirt under a navy hopsack blazer, no tie') },
    'm-smart-suede': { label: 'Suede jacket & white tee', prompt: outfit('a tan suede jacket over a white crew-neck T-shirt') },
  },
  smile: {
    soft: { label: 'Soft smile', prompt: smile('a soft, natural closed-mouth smile') },
    natural: { label: 'Natural smile', prompt: smile('a natural, friendly smile showing a little of the teeth') },
    confident: { label: 'Confident', prompt: smile('a calm, confident, slight smile') },
    neutral: { label: 'Relaxed neutral', prompt: smile('a relaxed, neutral expression') },
  },
  hair: {
    straight: { label: 'Straight', prompt: hair('sleek, straight hair that is smooth from root to tip') },
    volume: { label: 'Volume', prompt: hair('fuller, voluminous hair with natural lift at the roots') },
    curly: { label: 'Curly', prompt: hair('defined, natural-looking curls with soft bounce') },
    shiny: { label: 'Shiny', prompt: hair('the same hairstyle with healthy, glossy, light-reflecting shine') },
    texture: { label: 'Texture', prompt: hair('the same hairstyle with soft, piece-y, textured definition') },
    keratin: { label: 'Keratin', prompt: hair('a keratin-treatment finish: frizz-free, ultra-smooth, sleek and glossy hair') },
  },
};

const BG = (scene) =>
  `A photorealistic, softly out-of-focus background for a professional headshot: ${scene}. ` +
  'Shallow depth of field, natural soft light, no people, no text, no logos, no watermark.';

export const BACKGROUND_PRESETS = {
  'ai-glass': { label: 'Glass-walled office', prompt: BG('a modern office with floor-to-ceiling glass walls and daylight') },
  'ai-openplan': { label: 'Open-plan with plants', prompt: BG('a bright modern open-plan office with plants and large windows') },
  'ai-executive': { label: 'Executive office', prompt: BG('a modern executive office with warm wood panelling and bookshelves') },
  'ai-minimal': { label: 'Minimal white office', prompt: BG('a minimalist white office with soft architectural lines') },
  'ai-meeting': { label: 'Meeting room', prompt: BG('a light-grey modern meeting room with a glass partition') },
  'ai-skyline': { label: 'City skyline', prompt: BG('a high-rise office window overlooking a city skyline in golden-hour light') },
  'ai-lounge': { label: 'Business lounge', prompt: BG('a calm, elegant business lounge with warm lighting') },
  'ai-cowork': { label: 'Co-working space', prompt: BG('a stylish co-working space with warm lighting and greenery') },
};

export const ASPECTS = new Set(['3:4', '4:3', '1:1', '2:3', '3:2']);

export function editPrompt(feature, presetId) {
  const group = EDIT_PRESETS[feature];
  return group?.[presetId]?.prompt || null;
}

export function publicPresetList() {
  const out = {};
  for (const [feature, group] of Object.entries(EDIT_PRESETS)) {
    out[feature] = Object.entries(group).map(([id, p]) => ({ id, label: p.label }));
  }
  out.background = Object.entries(BACKGROUND_PRESETS).map(([id, p]) => ({ id, label: p.label }));
  return out;
}
