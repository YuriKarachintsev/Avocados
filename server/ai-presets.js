// Fixed, server-side prompt presets. The browser only sends a preset id, never
// free text, so the AI service can only be asked for these specific edits.

const KEEP_IDENTITY =
  "Keep the person's identity, face, facial features, skin tone, skin texture, eyes, expression, head position, " +
  'body shape, pose, camera angle, framing, lighting and the background exactly the same. Photorealistic result.';

const outfit = (garment) =>
  `Change only the person's clothing to ${garment}. The clothes should fit naturally and look like real fabric. ${KEEP_IDENTITY}`;

const smile = (expr) =>
  `Change only the person's facial expression to ${expr}. Keep their identity, face shape, eyes, nose, skin, hair, pose, ` +
  'clothing, lighting and background exactly the same. Photorealistic result.';

const hair = (style) =>
  `Restyle only the person's hair to ${style}. Keep the same natural hair colour, face, facial features, skin, expression, ` +
  'pose, clothing, lighting and background exactly the same. Photorealistic result.';

export const EDIT_PRESETS = {
  outfit: {
    // Women — office
    'w-office-navy': { label: 'Navy blazer & white blouse', prompt: outfit('a tailored navy blue blazer over a crisp white silk blouse') },
    'w-office-black': { label: 'Black suit jacket', prompt: outfit('a tailored black suit jacket over a simple black round-neck top') },
    'w-office-charcoal': { label: 'Charcoal dress & blazer', prompt: outfit('a charcoal grey sheath dress with a matching fitted blazer') },
    'w-office-cream': { label: 'Cream blazer', prompt: outfit('a cream tailored blazer over an ivory blouse') },
    // Women — smart casual
    'w-smart-knit': { label: 'Camel fine knit', prompt: outfit('a fine camel-coloured knit sweater with a delicate round neckline') },
    'w-smart-white': { label: 'Relaxed white shirt', prompt: outfit('a relaxed white button-up shirt with the top button open') },
    'w-smart-blush': { label: 'Blush blouse & beige blazer', prompt: outfit('a soft blush-pink blouse under an unstructured beige blazer') },
    'w-smart-chambray': { label: 'Chambray shirt', prompt: outfit('a smart light-blue chambray shirt') },
    // Men — office
    'm-office-charcoal': { label: 'Charcoal suit & navy tie', prompt: outfit('a charcoal grey two-piece suit, a white dress shirt and a navy silk tie') },
    'm-office-navy': { label: 'Navy suit & burgundy tie', prompt: outfit('a navy blue suit, a light blue dress shirt and a burgundy tie') },
    'm-office-opencollar': { label: 'Dark suit, open collar', prompt: outfit('a dark grey suit jacket over a white dress shirt with an open collar and no tie') },
    'm-office-black': { label: 'Black suit & tie', prompt: outfit('a black suit, a white dress shirt and a black tie') },
    // Men — smart casual
    'm-smart-oxford': { label: 'Oxford shirt & navy blazer', prompt: outfit('a light blue oxford shirt under an unstructured navy blazer, no tie') },
    'm-smart-merino': { label: 'Merino over collar', prompt: outfit('a navy merino crew-neck sweater over a white collared shirt') },
    'm-smart-polo': { label: 'Knitted polo', prompt: outfit('a dark navy knitted polo shirt') },
    'm-smart-white': { label: 'Crisp white shirt', prompt: outfit('a crisp white shirt with an open collar') },
  },
  smile: {
    soft: { label: 'Soft smile', prompt: smile('a soft, natural closed-mouth smile') },
    natural: { label: 'Natural smile', prompt: smile('a natural, friendly smile showing a little of the teeth') },
    confident: { label: 'Confident', prompt: smile('a calm, confident, slight smile') },
    neutral: { label: 'Relaxed neutral', prompt: smile('a relaxed, neutral expression') },
  },
  hair: {
    tidy: { label: 'Tidy flyaways', prompt: hair('the same hairstyle, neat and tidy, with flyaway strands smoothed') },
    'w-sleek': { label: 'Sleek straight', prompt: hair('sleek, straight, shoulder-length hair') },
    'w-waves': { label: 'Soft waves', prompt: hair('soft, polished waves') },
    'w-bun': { label: 'Neat low bun', prompt: hair('a neat, low bun') },
    'w-bob': { label: 'Classic bob', prompt: hair('a classic chin-length bob') },
    'm-sidepart': { label: 'Side part', prompt: hair('a neat, short side-parted haircut') },
    'm-short': { label: 'Short & tidy', prompt: hair('a short, tidy haircut') },
    'm-textured': { label: 'Textured crop', prompt: hair('a short textured crop') },
    'm-slick': { label: 'Slicked back', prompt: hair('neatly slicked-back hair') },
  },
};

const BG = (scene) =>
  `A photorealistic, softly out-of-focus background for a professional headshot: ${scene}. ` +
  'Shallow depth of field, natural soft light, no people, no text, no logos, no watermark.';

export const BACKGROUND_PRESETS = {
  'ai-glass': { label: 'Modern glass office', prompt: BG('a modern office with glass walls and daylight') },
  'ai-openplan': { label: 'Bright open-plan', prompt: BG('a bright open-plan office with plants and large windows') },
  'ai-executive': { label: 'Executive office', prompt: BG('a warm executive office with wood panelling and bookshelves') },
  'ai-meeting': { label: 'Meeting room', prompt: BG('a minimal light-grey meeting room') },
  'ai-skyline': { label: 'City skyline', prompt: BG('an office window overlooking a city skyline in golden-hour light') },
  'ai-cowork': { label: 'Co-working space', prompt: BG('a calm co-working space with warm lighting') },
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
