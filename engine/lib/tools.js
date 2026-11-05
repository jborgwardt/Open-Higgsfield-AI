// Server-driven registry of one-click tools (Higgsfield "Apps", Effects, Speak, Recast, Upscale, …).
// GET /engine/api/tools serves the public schema below; POST /engine/api/tools/:id/run starts a job that is
// polled with GET /engine/api/jobs/:id. The web Tools page and the Apple app both render tools generically
// from this file, so adding or fixing a tool (prompt template, default model, limits) is a change here only.
//
// Public schema (stable contract with the Apple app):
// [{ id, title, sfSymbol, category, description,
//    inputs: [{ key, type: 'text'|'longtext'|'image'|'video'|'audio'|'select'|'number'|'toggle'|'character'|'voice'|'model',
//               label, help, options: [{ value, label }], default, required, min, max, modelKind }],
//    run: { method, path }, output: 'image'|'video'|'audio' }]
// Optional extras some clients use: input.annotate ('draw' | 'mask') on image inputs = offer a sketch/mask canvas.
import { startRun } from './jobs.js';
import { materialize } from './catalog.js';
import { assetPath } from './store.js';
import * as ff from './ffmpeg.js';
import * as op from './ops.js';
import { buildCinemaPrompt, CAMERAS, LENSES, FOCALS, APERTURES, MOVES, GENRES, ERAS, GRADES, PACING, EMOTIONS, cinemaPresets } from './cinema.js';
import { VFX, VIRAL, PHOTO_STYLES, AD_SCENES, RESTYLES, HEADSHOTS, RELIGHT_DIRECTIONS, RELIGHT_COLORS, SHOT_SETS, ANGLES, TRANSITIONS, LANGUAGES, options, byValue, fill } from './presets.js';
import { elevenAvailable, elevenVoices, ELEVEN_DEFAULT_VOICE } from './providers/eleven.js';
import { googleAvailable, GEMINI_VOICES } from './providers/google.js';
import { xaiAvailable } from './providers/xai.js';

/* ---------------- model preferences (best quality first) ---------------- */

const IMG_EDIT = ['google/gemini-nano-banana-2.1', 'apimart/gpt-image-2.6-flare', 'google/gemini-3-pro-image', 'apimart/seedream-5-0-pro', 'xai/grok-imagine-image-2.0', 'apimart/flux-2-max', 'kie/nano-banana-2', 'fal/kontext-dev'];
const IMG_GEN = ['google/gemini-3-pro-image', 'apimart/gpt-image-2.6-flare', 'google/gemini-nano-banana-2.1', 'apimart/seedream-5-0-pro', 'apimart/flux-2-max', 'xai/grok-imagine-image-2.0'];
// Real-person photos: Gemini Omni refuses likenesses of real people, so it is never a default here.
const I2V_PERSON = ['apimart/kling-v3', 'apimart/seedance-2.0', 'apimart/veo3.1-fast', 'apimart/kling-v4', 'apimart/kling-v3-omni', 'xai/grok-imagine-video-1.5', 'apimart/MiniMax-Hailuo-2.3', 'fal/wan22-a14b'];
const I2V_DIALOGUE = ['apimart/veo3.1-fast', 'apimart/seedance-2.0', 'apimart/kling-v4', 'apimart/kling-v3-omni', 'xai/grok-imagine-video-1.5'];
const I2V_CINEMA = ['apimart/veo3.1-fast', 'apimart/kling-v3-omni', 'apimart/kling-v3', 'apimart/seedance-2.0', 'xai/grok-imagine-video-1.5', 'google/gemini-omni-1.1-flash'];
const VIDEO_END = ['apimart/kling-v3', 'apimart/veo3.1-fast', 'apimart/seedance-2.0', 'apimart/kling-v4', 'apimart/kling-v3-omni', 'xai/grok-imagine-video-1.5'];

/* ---------------- input helpers ---------------- */

const text = (key, label, o = {}) => ({ key, type: 'text', label, ...o });
const long = (key, label, o = {}) => ({ key, type: 'longtext', label, ...o });
const img = (key, label, o = {}) => ({ key, type: 'image', label, required: true, ...o });
const vid = (key, label, o = {}) => ({ key, type: 'video', label, required: true, ...o });
const aud = (key, label, o = {}) => ({ key, type: 'audio', label, required: false, ...o });
const sel = (key, label, opts, def, o = {}) => ({ key, type: 'select', label, options: opts, default: def ?? opts[0]?.value, ...o });
const num = (key, label, def, min, max, o = {}) => ({ key, type: 'number', label, default: def, min, max, ...o });
const tog = (key, label, def = false, o = {}) => ({ key, type: 'toggle', label, default: def, ...o });
const mdl = (modelKind, prefer, o = {}) => ({ key: 'model', type: 'model', label: 'Model', modelKind, prefer, ...o });
const voice = (o = {}) => ({ key: 'voice', type: 'voice', label: 'Voice', help: 'ElevenLabs voices incl. your clones', ...o });
const character = (o = {}) => ({ key: 'character', type: 'character', label: 'Saved character', required: false, help: 'Optional — use a saved character instead of uploading a photo', ...o });
const opts = (vals) => vals.map((v) => (typeof v === 'object' ? v : { value: String(v), label: String(v) }));
const aspect = (def = 'auto', list = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']) => sel('aspect', 'Aspect ratio', opts(list.map((v) => (v === 'auto' ? { value: 'auto', label: 'Match photo' } : v))), def);
const seconds = (def = '5', list = ['5', '8', '10']) => sel('duration', 'Duration (s)', opts(list.map((v) => ({ value: v, label: `${v} s` }))), def);
const resolution = (def = '1080p', list = ['720p', '1080p']) => sel('resolution', 'Resolution', opts(list), def);
const subject = () => text('subject', 'Who / what is in the photo', { help: 'e.g. "the woman in the red coat" — helps the effect target the right subject', default: 'the person' });

/* ---------------- run helpers ---------------- */

const KEEP_ID = 'Keep every person exactly recognisable — same face, hair, skin tone, body and outfit as the reference.';
const PHOTO_QUALITY = 'Photoreal, natural skin texture, high detail, no text, no watermark.';

async function autoAspect(ref, fallback = '16:9', list = ['16:9', '9:16', '1:1']) {
  const a = await materialize(ref).catch(() => null);
  if (!a) return fallback;
  const info = a.width ? a : await ff.probe(assetPath(a)).catch(() => ({}));
  if (!info.width || !info.height) return fallback;
  const r = info.width / info.height;
  const ratios = list.map((s) => { const [w, h] = s.split(':').map(Number); return { s, d: Math.abs(Math.log((w / h) / r)) }; });
  return ratios.sort((x, y) => x.d - y.d)[0].s;
}

const pickAspect = (v, ref, list) => (v.aspect && v.aspect !== 'auto' ? v.aspect : autoAspect(ref, '16:9', list));

/** Photo or saved character → image ref (+ extra character refs). */
async function personRef(v, key = 'image', signal) {
  if (v[key]) return { image: v[key], refs: [] };
  const c = await op.characterInfo(v.character, signal);
  if (c?.refs?.length) return { image: c.refs[0], refs: c.refs.slice(1), voice: c.voice, name: c.name };
  throw Object.assign(new Error('upload a photo or pick a saved character'), { status: 400 });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const model = (v, kind, prefer) => op.resolveModel(v.model, kind, prefer).id;

/* ---------------- the registry ---------------- */

const CINEMA_MOVES = [{ value: '', label: '— none —' }, ...options(MOVES)];

export const TOOLS = [
  /* ================= Cinema ================= */
  {
    id: 'cinema-shot', title: 'Cinema Studio shot', sfSymbol: 'film', category: 'Cinema', output: 'video',
    description: 'Virtual camera body, lens, focal length and aperture, up to 3 stacked camera moves, genre, era and grade — as a video or a film still.',
    inputs: [
      long('prompt', 'Scene', { required: true, help: 'Who, where, what happens' }),
      sel('mode', 'Output', opts([{ value: 'video', label: 'Video' }, { value: 'photo', label: 'Still photo' }]), 'video'),
      img('image', 'Start frame', { required: false, help: 'Optional — animate this frame instead of generating one' }),
      sel('camera', 'Camera', options(CAMERAS), 'Full-Frame Cine Digital'), sel('lens', 'Lens', options(LENSES), 'Premium Modern Prime'),
      sel('focal', 'Focal length', options(FOCALS), '35'), sel('aperture', 'Aperture', options(APERTURES), 'f/2.8'),
      sel('move1', 'Camera move 1', CINEMA_MOVES, 'Dolly In'), sel('move2', 'Camera move 2', CINEMA_MOVES, ''), sel('move3', 'Camera move 3', CINEMA_MOVES, ''),
      sel('genre', 'Genre', options(GENRES), 'General'), sel('era', 'Era', options(ERAS), 'Modern'), sel('grade', 'Colour grade', options(GRADES), 'Natural'),
      sel('pacing', 'Montage pacing', options(PACING), 'Single Shot'), sel('emotion', 'Emotion', options(EMOTIONS), 'Neutral'),
      aspect('16:9', ['16:9', '21:9', '9:16', '1:1', '4:3']), seconds('8', ['5', '8', '10', '15']), resolution('1080p', ['720p', '1080p', '4k']),
      { ...mdl('video', I2V_CINEMA), key: 'videoModel', label: 'Video model' },
      { ...mdl('image', IMG_GEN), key: 'imageModel', label: 'Image model' },
    ],
    async run(v, ctx) {
      const moves = [v.move1, v.move2, v.move3].filter(Boolean);
      const prompt = buildCinemaPrompt({ ...v, moves, mode: v.mode, duration: Number(v.duration) });
      const imageModel = op.resolveModel(v.imageModel, 'image', IMG_GEN).id;
      if (v.mode === 'photo') return op.genImage({ model: v.image ? op.resolveModel(v.imageModel, 'image-edit', IMG_EDIT).id : imageModel, prompt, image: v.image, aspect: v.aspect, resolution: '2k' }, ctx);
      const vm = op.resolveModel(v.videoModel, 'video', I2V_CINEMA);
      let start = v.image;
      if (!start && !vm.caps?.t2v) start = await op.genImage({ model: imageModel, prompt: buildCinemaPrompt({ ...v, moves, mode: 'photo' }), aspect: v.aspect }, ctx);
      const asset = await op.genVideo({ model: vm.id, prompt, image: start, aspect: v.aspect, duration: Number(v.duration), resolution: v.resolution }, ctx);
      return { asset, text: prompt };
    },
  },
  {
    id: 'storyboard', title: 'Storyboard (Popcorn)', sfSymbol: 'rectangle.split.3x3', category: 'Cinema', output: 'image',
    description: 'Up to 8 consistent frames — same characters, wardrobe, location and light — from a story and reference photos.',
    inputs: [
      long('prompt', 'Story', { required: true, help: 'A few sentences; each frame becomes one beat' }),
      img('ref1', 'Reference 1', { required: false, help: 'Character, product or location' }), img('ref2', 'Reference 2', { required: false }), img('ref3', 'Reference 3', { required: false }),
      character(), num('frames', 'Frames', 6, 2, 8), text('style', 'Look', { help: 'e.g. "moody 35mm film, teal night"' }),
      aspect('16:9', ['16:9', '9:16', '1:1', '21:9', '4:3']), mdl('image-edit', IMG_EDIT),
    ],
    async run(v, ctx) {
      const c = await op.characterInfo(v.character, ctx.signal);
      const refs = [v.ref1, v.ref2, v.ref3, ...(c?.refs || [])].filter(Boolean).slice(0, 4);
      const n = v.frames;
      const plan = await op.llmJSON('You are a storyboard artist. Split the story into exactly N sequential frames. Reply JSON {"frames":[{"prompt":"self-contained visual description: shot size, subject action, setting, light"}]}.', `N=${n}\nLook: ${v.style || 'cinematic'}\nStory: ${v.prompt}`, ctx.signal);
      const beats = (plan?.frames || []).map((f) => f.prompt || f).filter(Boolean);
      while (beats.length < n) beats.push(`${v.prompt} — beat ${beats.length + 1} of ${n}, a new camera angle as the story moves forward`);
      const m = model(v, 'image-edit', IMG_EDIT);
      const assets = [];
      for (let i = 0; i < n; i++) {
        ctx.onStatus?.({ message: `Frame ${i + 1} of ${n}`, progress: i / n });
        const prev = assets.at(-1);
        assets.push(await op.genImage({ model: m, prompt: `Storyboard frame ${i + 1} of ${n} from one continuous film. ${v.style ? `Look: ${v.style}. ` : ''}${beats[i]}. Keep the same characters (faces, hair, wardrobe), locations, lighting and colour grade as the reference images${prev ? ' and the previous frame' : ''}. Cinematic film still, no text, no panels.`, refs: [...refs, ...(prev ? [prev] : [])].slice(-5), aspect: v.aspect }, ctx));
      }
      return { asset: assets[0], assets };
    },
  },
  {
    id: 'shots', title: 'Shots, Zooms & Angles', sfSymbol: 'square.grid.3x3', category: 'Cinema', output: 'image',
    description: 'Nine new shots of the same scene from one image: coverage, a zoom ladder, orbit angles or "what happens next".',
    inputs: [
      img('image', 'Scene'), sel('set', 'Set', opts([{ value: 'coverage', label: 'Shots — full coverage' }, { value: 'zooms', label: 'Zooms — 9 zoom levels' }, { value: 'angles', label: 'Angles — orbit the subject' }, { value: 'next', label: "What's next? — story beats" }]), 'coverage'),
      num('count', 'How many', 9, 2, 9), mdl('image-edit', IMG_EDIT),
    ],
    async run(v, ctx) {
      const specs = SHOT_SETS[v.set].slice(0, v.count);
      const m = model(v, 'image-edit', IMG_EDIT);
      let done = 0;
      const assets = await pool(specs, 3, async (spec) => {
        const prompt = v.set === 'next'
          ? `Show ${spec} in this same scene, as the next shot of the same film. Same people, wardrobe, location, lighting and colour grade. ${KEEP_ID} Cinematic film still, no text.`
          : `Re-photograph this exact scene as a ${spec}. Same people, same location, lighting, colour grade and time of day — only the camera position and framing change. ${KEEP_ID} ${PHOTO_QUALITY}`;
        const a = await op.genImage({ model: m, prompt, image: v.image }, ctx);
        ctx.onStatus?.({ message: `${++done} of ${specs.length} shots`, progress: done / specs.length });
        return a;
      });
      return { asset: assets[0], assets };
    },
  },
  {
    id: 'angles', title: 'Angles', sfSymbol: 'rotate.3d', category: 'Cinema', output: 'image',
    description: 'See any photo from another angle — profile, behind, top-down, low angle.',
    inputs: [img('image', 'Photo'), sel('angle', 'Angle', options(ANGLES), ANGLES[1].value), mdl('image-edit', IMG_EDIT)],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `Show this exact subject and scene from a ${byValue(ANGLES, v.angle).prompt}. Rotate the camera only; ${KEEP_ID} ${PHOTO_QUALITY}`, image: v.image }, ctx),
  },
  {
    id: 'transitions', title: 'Transitions', sfSymbol: 'arrow.left.arrow.right', category: 'Cinema', output: 'video',
    description: 'A seamless shot that travels from your first image to your last.',
    inputs: [img('start', 'First frame'), img('end', 'Last frame'), sel('style', 'Transition', options(TRANSITIONS)), text('prompt', 'Extra direction'), mdl('video-end', VIDEO_END), seconds('5', ['5', '8', '10']), aspect('auto', ['auto', '16:9', '9:16', '1:1'])],
    async run(v, ctx) {
      return op.genVideo({ model: model(v, 'video-end', VIDEO_END), prompt: `${byValue(TRANSITIONS, v.style).prompt}. ${v.prompt || ''} Smooth, continuous, cinematic.`, image: v.start, endImage: v.end, aspect: await pickAspect(v, v.start), duration: Number(v.duration) }, ctx);
    },
  },
  {
    id: 'draw-to-video', title: 'Draw to Video', sfSymbol: 'pencil.and.scribble', category: 'Cinema', output: 'video',
    description: 'Draw arrows and notes on a frame; the marks are read as directions, removed, and the frame is animated.',
    inputs: [img('sketch', 'Annotated frame', { annotate: 'draw', help: 'Draw arrows / write notes on the image' }), long('prompt', 'Extra direction'), mdl('i2v', I2V_PERSON), seconds('5', ['5', '8', '10']), aspect('auto', ['auto', '16:9', '9:16', '1:1'])],
    async run(v, ctx) {
      ctx.onStatus?.({ message: 'Reading your annotations' });
      const directions = await op.readAnnotations(await materialize(v.sketch, ctx.signal), ctx.signal);
      ctx.onStatus?.({ message: 'Cleaning the frame' });
      const clean = await op.genImage({ model: op.resolveModel(null, 'image-edit', IMG_EDIT).id, prompt: 'Remove every hand-drawn mark from this image — arrows, lines, circles, numbers, scribbles and handwritten text — and restore what is underneath. Change nothing else.', image: v.sketch }, ctx);
      const prompt = [v.prompt, directions, directions ? '' : 'Animate the scene following the drawn arrows and notes.'].filter(Boolean).join(' ');
      const asset = await op.genVideo({ model: model(v, 'i2v', I2V_PERSON), prompt, image: clean, aspect: await pickAspect(v, v.sketch), duration: Number(v.duration) }, ctx);
      return { asset, assets: [asset, clean], text: prompt };
    },
  },

  /* ================= Effects & templates ================= */
  {
    id: 'vfx', title: 'Video Effects', sfSymbol: 'sparkles', category: 'Effects', output: 'video',
    description: `${VFX.length} viral VFX presets — Bullet Time, Earth Zoom, Melting, Particles, Burning Man… One photo in, one clip out.`,
    inputs: [img('image', 'Photo'), sel('effect', 'Effect', options(VFX), 'bullet-time'), subject(), mdl('i2v', I2V_PERSON), seconds('5', ['5', '8', '10']), aspect('auto', ['auto', '9:16', '16:9', '1:1'])],
    async run(v, ctx) {
      return op.genVideo({ model: model(v, 'i2v', I2V_PERSON), prompt: `${fill(byValue(VFX, v.effect).prompt, { subject: v.subject || 'the person' })} Photoreal, cinematic VFX, smooth motion.`, image: v.image, aspect: await pickAspect(v, v.image), duration: Number(v.duration) }, ctx);
    },
  },
  {
    id: 'camera-motion', title: 'Camera Motion', sfSymbol: 'video.badge.waveform', category: 'Effects', output: 'video',
    description: `Animate a photo with up to 3 stacked moves from ${MOVES.length} camera-control presets (Crash Zoom, FPV Drone, Snorricam, Dolly Zoom…).`,
    inputs: [img('image', 'Photo'), sel('move1', 'Move 1', options(MOVES), 'Dolly In'), sel('move2', 'Move 2', CINEMA_MOVES, ''), sel('move3', 'Move 3', CINEMA_MOVES, ''), text('prompt', 'What happens'), mdl('i2v', I2V_PERSON), seconds('5', ['5', '8', '10']), aspect('auto', ['auto', '16:9', '9:16', '1:1'])],
    async run(v, ctx) {
      const prompt = buildCinemaPrompt({ prompt: v.prompt || 'The scene comes to life with natural motion', mode: 'video', moves: [v.move1, v.move2, v.move3].filter(Boolean) });
      return op.genVideo({ model: model(v, 'i2v', I2V_PERSON), prompt, image: v.image, aspect: await pickAspect(v, v.image), duration: Number(v.duration) }, ctx);
    },
  },
  {
    id: 'viral', title: 'Viral Templates', sfSymbol: 'flame', category: 'Effects', output: 'video',
    description: 'Trending templates: On Fire, Mukbang, Cloud Surf, Idol, Behind the Scenes, ASMR Host…',
    inputs: [img('image', 'Photo'), sel('template', 'Template', options(VIRAL)), subject(), mdl('i2v', I2V_PERSON), seconds('5', ['5', '8', '10']), aspect('9:16', ['auto', '9:16', '16:9', '1:1'])],
    async run(v, ctx) {
      return op.genVideo({ model: model(v, 'i2v', I2V_PERSON), prompt: `${fill(byValue(VIRAL, v.template).prompt, { subject: v.subject || 'the person' })} Social-media ready, photoreal.`, image: v.image, aspect: await pickAspect(v, v.image, ['9:16', '16:9', '1:1']), duration: Number(v.duration) }, ctx);
    },
  },
  {
    id: 'photo-styles', title: 'Photo Styles', sfSymbol: 'theatermasks', category: 'Effects', output: 'image',
    description: 'Game Dump, 3D Figure, Simlife, Mugshot, Glitter Sticker, Claymation and more — your face, new world.',
    inputs: [img('image', 'Photo'), sel('style', 'Style', options(PHOTO_STYLES)), subject(), mdl('image-edit', IMG_EDIT), aspect('auto', ['auto', '1:1', '4:3', '3:4', '16:9', '9:16'])],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `${fill(byValue(PHOTO_STYLES, v.style).prompt, { subject: v.subject || 'the person in the photo' })} Keep the face recognisable.`, image: v.image, aspect: v.aspect }, ctx),
  },

  /* ================= Ads & products ================= */
  {
    id: 'click-to-ad', title: 'Click to Ad (UGC)', sfSymbol: 'cart.badge.plus', category: 'Ads & Products', output: 'video',
    description: 'Product link or photo → a scripted UGC or studio video ad with a presenter who speaks your line (native audio).',
    inputs: [
      text('url', 'Product page URL', { help: 'Optional — title, description and photo are read from the page' }), img('product', 'Product photo', { required: false }),
      long('about', 'What are you selling?', { help: 'Name + key benefit; leave empty to use the page' }),
      img('presenter', 'Presenter photo', { required: false, help: 'Optional — otherwise a fitting creator is cast' }), character(),
      sel('style', 'Style', opts([{ value: 'selfie', label: 'UGC selfie review' }, { value: 'unboxing', label: 'Unboxing' }, { value: 'street', label: 'Street interview' }, { value: 'studio', label: 'Studio commercial' }, { value: 'lifestyle', label: 'Lifestyle in use' }]), 'selfie'),
      text('line', 'Spoken line', { help: 'Optional — otherwise the director LLM writes the hook' }),
      { ...mdl('i2v', I2V_DIALOGUE), key: 'model', label: 'Video model (with audio)' }, { ...mdl('image-edit', IMG_EDIT), key: 'imageModel', label: 'Keyframe model' },
      aspect('9:16', ['9:16', '16:9', '1:1']), seconds('8', ['8', '10', '15']),
    ],
    async run(v, ctx) {
      const page = v.url ? await op.readProductPage(v.url, ctx.signal) : null;
      const product = v.product || page?.image;
      if (!product) throw Object.assign(new Error('add a product photo or a product page with an image'), { status: 400 });
      const about = v.about || [page?.title, page?.description].filter(Boolean).join(' — ') || 'the product';
      let presenter = v.presenter;
      if (!presenter && v.character) presenter = (await op.characterInfo(v.character, ctx.signal))?.refs?.[0];
      const STYLE = {
        selfie: { look: 'a creator filming a selfie-style UGC review on their phone at home, holding the product near the camera, natural window light, authentic and unpolished', act: 'handheld selfie framing, they hold up the product and talk to camera' },
        unboxing: { look: 'hands and face of a creator unboxing the product at a desk, top-down and selfie angles, cosy room', act: 'they open the box, lift out the product and react' },
        street: { look: 'a street-interview setup: a passer-by holding the product talks into a handheld microphone on a city sidewalk', act: 'handheld interview framing, quick natural reaction' },
        studio: { look: 'a polished studio commercial: model presents the product on a seamless backdrop, softbox lighting', act: 'slow dolly in, confident delivery to camera' },
        lifestyle: { look: 'a person using the product in a real everyday setting that fits it, golden light', act: 'natural in-use moment, then a look to camera' },
      }[v.style];
      ctx.onStatus?.({ message: 'Writing the hook' });
      const script = v.line ? { line: v.line } : await op.llmJSON('You write scroll-stopping short-form video ads. Reply JSON {"line":"one spoken sentence, max 22 words, first person, natural, no hashtags","scene":"one sentence describing the setting"}', `Product: ${about}\nStyle: ${v.style}`, ctx.signal);
      const line = String(script?.line || `Okay, I have to show you this — ${about.split(/[.—-]/)[0].trim()}. Honestly, it changed my routine.`).replace(/"/g, "'");
      ctx.onStatus?.({ message: 'Composing the keyframe' });
      const keyframe = await op.genImage({ model: op.resolveModel(v.imageModel, 'image-edit', IMG_EDIT).id, prompt: `${STYLE.look}${script?.scene ? `, ${script.scene}` : ''}. The product is exactly the one in the product photo — same shape, colours, label and logo, clearly visible.${presenter ? ` The presenter is the person in the presenter photo. ${KEEP_ID}` : ''} ${PHOTO_QUALITY} Vertical social video frame.`, image: product, refs: presenter ? [presenter] : [], aspect: v.aspect }, ctx);
      const asset = await op.genVideo({ model: model(v, 'i2v', I2V_DIALOGUE), prompt: `${STYLE.act}. The presenter looks into the camera and says: "${line}" Natural lip-sync and voice, authentic ${v.style === 'studio' ? 'commercial' : 'UGC'} feel, the product label stays legible.`, image: keyframe, aspect: v.aspect, duration: Number(v.duration) }, ctx);
      return { asset, assets: [asset, keyframe], text: line };
    },
  },
  {
    id: 'product-scenes', title: 'Product Ad Scenes', sfSymbol: 'shippingbox', category: 'Ads & Products', output: 'video',
    description: 'Bullet Time, Billboard, Truck Ad, Giant Product, Volcano, Fridge, Packshot, Macro, Kick Ad… your product, animated.',
    inputs: [img('product', 'Product photo'), text('name', 'Product name', { default: 'the product' }), sel('scene', 'Scene', options(AD_SCENES)), mdl('i2v', I2V_PERSON), { ...mdl('image-edit', IMG_EDIT), key: 'imageModel', label: 'Keyframe model' }, aspect('9:16', ['9:16', '16:9', '1:1']), seconds('5', ['5', '8', '10'])],
    async run(v, ctx) {
      const s = byValue(AD_SCENES, v.scene);
      const vars = { product: v.name || 'the product' };
      const keyframe = await op.genImage({ model: op.resolveModel(v.imageModel, 'image-edit', IMG_EDIT).id, prompt: `Commercial product photography: ${fill(s.prompt, vars)}. The product must look exactly like the reference photo — same shape, colours, materials, label and logo text. Premium lighting, photoreal, no added text.`, image: v.product, aspect: v.aspect }, ctx);
      const asset = await op.genVideo({ model: model(v, 'i2v', I2V_PERSON), prompt: `${fill(s.motion, vars)}. The product stays identical to the first frame with a legible label. High-end commercial, smooth motion.`, image: keyframe, aspect: v.aspect, duration: Number(v.duration) }, ctx);
      return { asset, assets: [asset, keyframe] };
    },
  },
  {
    id: 'product-placement', title: 'Product Placement', sfSymbol: 'bag', category: 'Ads & Products', output: 'image',
    description: 'Place a product naturally into any scene — perspective, light and shadows matched.',
    inputs: [img('scene', 'Scene'), img('product', 'Product'), text('where', 'Where / how', { help: 'e.g. "in her right hand", "on the kitchen counter"' }), mdl('image-edit', IMG_EDIT)],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `Place the product from image 2 into the scene of image 1${v.where ? `, ${v.where}` : ' where it fits naturally'}. Match perspective, scale, lighting, reflections and shadows; the product keeps its exact shape, colours and label. Leave everything else in image 1 unchanged. ${PHOTO_QUALITY}`, image: v.scene, refs: [v.product] }, ctx),
  },

  /* ================= Image tools ================= */
  {
    id: 'image-edit', title: 'Edit Image', sfSymbol: 'wand.and.stars', category: 'Image', output: 'image',
    description: 'Describe the change — swap objects, change outfits, fix details — with up to 2 extra references.',
    inputs: [img('image', 'Image'), long('prompt', 'Change', { required: true }), img('ref1', 'Reference 1', { required: false }), img('ref2', 'Reference 2', { required: false }), mdl('image-edit', IMG_EDIT), aspect('auto', ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'])],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `${v.prompt}. Change only what is asked; keep everything else identical.`, image: v.image, refs: [v.ref1, v.ref2].filter(Boolean), aspect: v.aspect }, ctx),
  },
  {
    id: 'inpaint', title: 'Inpaint', sfSymbol: 'paintbrush', category: 'Image', output: 'image',
    description: 'Paint over an area and describe what should be there.',
    inputs: [img('image', 'Image'), img('mask', 'Mask', { annotate: 'mask', help: 'White = change, black = keep' }), long('prompt', 'Fill with', { required: true }), mdl('inpaint', ['fal/flux-fill', 'apimart/gpt-image-2.6-inpaint'])],
    run: (v, ctx) => op.inpaint(v, ctx),
  },
  {
    id: 'expand', title: 'Expand Image', sfSymbol: 'arrow.up.left.and.arrow.down.right', category: 'Image', output: 'image',
    description: 'Outpaint beyond the edges to a new aspect ratio.',
    inputs: [img('image', 'Image'), sel('aspect', 'New aspect', opts(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4'])), text('prompt', 'What to add', { help: 'Optional' }), mdl('expand', ['fal/bria-expand', 'fal/flux2-outpaint'])],
    run: (v, ctx) => op.expandImage(v, ctx),
  },
  {
    id: 'relight', title: 'Relight', sfSymbol: 'lightbulb', category: 'Image', output: 'image',
    description: 'Move the light, change its colour and strength.',
    inputs: [img('image', 'Photo'), sel('direction', 'Light from', options(RELIGHT_DIRECTIONS)), sel('color', 'Colour', options(RELIGHT_COLORS)), sel('intensity', 'Strength', opts(['soft', 'medium', 'dramatic']), 'medium'), mdl('image-edit', IMG_EDIT)],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `Relight this photo: a ${v.intensity} ${byValue(RELIGHT_COLORS, v.color).prompt} key light ${byValue(RELIGHT_DIRECTIONS, v.direction).prompt}, with physically correct shadows, highlights and colour spill on skin and surfaces. Do not change the people, pose, composition or background content. ${PHOTO_QUALITY}`, image: v.image }, ctx),
  },
  {
    id: 'skin-enhancer', title: 'Skin Enhancer', sfSymbol: 'face.smiling', category: 'Image', output: 'image',
    description: 'Natural, realistic skin texture — removes the plastic AI look and blemishes, keeps identity.',
    inputs: [img('image', 'Portrait'), sel('strength', 'Retouch', opts(['subtle', 'balanced', 'glam']), 'balanced'), mdl('image-edit', IMG_EDIT)],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `High-end ${v.strength} skin retouch: realistic pores and fine skin texture, even tone, remove temporary blemishes, keep freckles, moles and natural features. No plastic smoothing. ${KEEP_ID} Same framing and light.`, image: v.image }, ctx),
  },
  {
    id: 'color-grade', title: 'Colour Grading', sfSymbol: 'camera.filters', category: 'Image', output: 'image',
    description: 'Film looks for stills: Kodak 2383, Teal & Orange, Bleach Bypass, Neon Noir…',
    inputs: [img('image', 'Image'), sel('grade', 'Grade', options(GRADES), 'Kodak 2383'), sel('era', 'Era', options(ERAS), 'Modern'), mdl('image-edit', IMG_EDIT)],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `Colour grade this image: ${byValue(GRADES, v.grade).prompt}${byValue(ERAS, v.era).prompt ? `, ${byValue(ERAS, v.era).prompt}` : ''}. Change only colour, contrast and film texture — the content, people and composition stay identical.`, image: v.image }, ctx),
  },
  {
    id: 'style-transfer', title: 'Style Transfer', sfSymbol: 'paintpalette', category: 'Image', output: 'image',
    description: 'Restyle an image as anime, claymation, oil paint… or match a style reference.',
    inputs: [img('image', 'Image'), sel('style', 'Style', options(RESTYLES)), img('styleRef', 'Style reference', { required: false, help: 'Optional — overrides the preset' }), mdl('image-edit', IMG_EDIT)],
    run: (v, ctx) => op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: v.styleRef ? 'Redraw image 1 in the exact artistic style of image 2 (medium, palette, brushwork, lighting). Keep image 1\'s composition, subjects and poses.' : `Redraw this image as ${byValue(RESTYLES, v.style).prompt}. Keep the composition, subjects and poses.`, image: v.image, refs: v.styleRef ? [v.styleRef] : [] }, ctx),
  },
  {
    id: 'bg-remove', title: 'Background Remover', sfSymbol: 'person.crop.rectangle', category: 'Image', output: 'image',
    description: 'Clean transparent cut-out (PNG).',
    inputs: [img('image', 'Image'), text('keep', 'Keep', { help: 'Optional — e.g. "the person and the dog"' })],
    run: (v, ctx) => op.removeBackground(v, ctx),
  },
  {
    id: 'erase', title: 'Object Eraser', sfSymbol: 'eraser', category: 'Image', output: 'image',
    description: 'Remove objects with their shadows and reflections.',
    inputs: [img('image', 'Image'), text('what', 'What to remove', { required: true })],
    run: (v, ctx) => op.erase(v, ctx),
  },
  {
    id: 'breakdown', title: 'Breakdown (layers)', sfSymbol: 'square.3.layers.3d', category: 'Image', output: 'image',
    description: 'Split an image into its separate elements as transparent PNG layers.',
    inputs: [img('image', 'Image'), text('prompt', 'Which elements', { help: 'Optional' })],
    run: (v, ctx) => op.layerize(v, ctx),
  },
  {
    id: 'image-upscale', title: 'Upscale Image', sfSymbol: 'arrow.up.backward.and.arrow.down.forward', category: 'Image', output: 'image',
    description: 'Topaz-grade upscaling up to 4× with face recovery.',
    inputs: [img('image', 'Image'), sel('factor', 'Scale', opts([{ value: '2', label: '2×' }, { value: '4', label: '4×' }]), '2'), mdl('upscale-image', ['fal/topaz-image', 'fal/seedvr-image'])],
    run: (v, ctx) => op.upscaleImage(v, ctx),
  },
  {
    id: 'vector-gif', title: 'Vector & GIF', sfSymbol: 'scribble.variable', category: 'Image', output: 'image',
    description: 'GPT Image 2.6: editable SVG vectors and looping GIFs from a prompt.',
    inputs: [long('prompt', 'Prompt', { required: true }), sel('format', 'Format', opts([{ value: 'svg', label: 'SVG vector' }, { value: 'gif', label: 'Looping GIF' }, { value: 'png', label: 'PNG' }]), 'svg'), sel('variant', 'Variant', opts([{ value: 'apimart/gpt-image-2.6-flare', label: 'Flare (fast)' }, { value: 'apimart/gpt-image-2.6-sunburst', label: 'Sunburst (precise)' }]), 'apimart/gpt-image-2.6-flare'), aspect('1:1', ['1:1', '16:9', '9:16', '4:3', '3:4'])],
    async run(v, ctx) {
      const a = await op.genImage({ model: v.variant, prompt: v.prompt, aspect: v.aspect, format: v.format }, ctx);
      return op.sanitizeSvg(a);
    },
  },

  /* ================= Face & identity ================= */
  {
    id: 'face-swap', title: 'Face Swap', sfSymbol: 'person.2.crop.square.stack', category: 'Face & Identity', output: 'image',
    description: 'Put a face onto another photo — pose, light and expression preserved.',
    inputs: [img('image', 'Target photo'), img('face', 'Face', { required: false }), character(), mdl('image-edit', IMG_EDIT)],
    async run(v, ctx) {
      const f = await personRef(v, 'face', ctx.signal);
      return op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: 'Replace the face of the person in image 1 with the face of the person in image 2 (identity, facial structure, eyes, nose, mouth, skin tone). Keep image 1\'s pose, head angle, expression, hair style, lighting, colour grade and background. Seamless, photoreal.', image: v.image, refs: [f.image, ...f.refs].slice(0, 3) }, ctx);
    },
  },
  {
    id: 'character-swap', title: 'Character Swap', sfSymbol: 'person.crop.rectangle.stack', category: 'Face & Identity', output: 'image',
    description: 'Replace the whole person in a photo with your character — outfit, body and face.',
    inputs: [img('image', 'Photo'), img('person', 'Your character', { required: false }), character(), mdl('image-edit', IMG_EDIT)],
    async run(v, ctx) {
      const p = await personRef(v, 'person', ctx.signal);
      return op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: 'Replace the main person in image 1 with the character from image 2 — their face, hair, body type and outfit — in exactly the same pose, position, scale and lighting. Background and composition of image 1 stay unchanged. Photoreal.', image: v.image, refs: [p.image, ...p.refs].slice(0, 3) }, ctx);
    },
  },
  {
    id: 'headshot', title: 'Headshot Generator', sfSymbol: 'person.crop.square', category: 'Face & Identity', output: 'image',
    description: 'Studio-quality professional headshots from a selfie.',
    inputs: [img('image', 'Selfie', { required: false }), character(), sel('style', 'Style', options(HEADSHOTS)), mdl('image-edit', IMG_EDIT)],
    async run(v, ctx) {
      const p = await personRef(v, 'image', ctx.signal);
      return op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `${byValue(HEADSHOTS, v.style).prompt} of this exact person, head and shoulders, 85mm lens, eyes sharp. ${KEEP_ID} ${PHOTO_QUALITY}`, image: p.image, refs: p.refs, aspect: '4:5' }, ctx);
    },
  },
  {
    id: 'try-on', title: 'Outfit Swap / AI Stylist', sfSymbol: 'tshirt', category: 'Face & Identity', output: 'image',
    description: 'Try any garment — or a whole look from up to 3 pieces — on a person.',
    inputs: [img('person', 'Person', { required: false }), character(), img('garment', 'Garment'), img('garment2', 'Garment 2', { required: false }), img('garment3', 'Garment 3', { required: false }), sel('engine', 'Engine', opts([{ value: 'auto', label: 'Auto' }, { value: 'vto', label: 'Google Virtual Try-On' }, { value: 'edit', label: 'Image editor (multi-piece)' }]), 'auto'), mdl('image-edit', IMG_EDIT)],
    async run(v, ctx) {
      const p = await personRef(v, 'person', ctx.signal);
      const pieces = [v.garment, v.garment2, v.garment3].filter(Boolean);
      const useVto = v.engine === 'vto' || (v.engine === 'auto' && pieces.length === 1 && op.modelOptions('tryon').length);
      if (useVto) return op.virtualTryOn({ person: p.image, garment: pieces[0] }, ctx);
      return op.genImage({ model: model(v, 'image-edit', IMG_EDIT), prompt: `Dress the person from image 1 in the clothing from the other images (${pieces.length} piece${pieces.length > 1 ? 's' : ''}), styled as one outfit with realistic fit, drape and fabric. Same pose, face, body and background. ${KEEP_ID}`, image: p.image, refs: pieces }, ctx);
    },
  },

  /* ================= Video tools ================= */
  {
    id: 'video-edit', title: 'Edit Video (Genjutsu)', sfSymbol: 'film.stack', category: 'Video', output: 'video',
    description: 'Rebuild part of a clip with an instruction — swap objects, outfits, backgrounds — keeping everything else as shot.',
    inputs: [vid('video', 'Clip', { help: '3–10 s works with every model' }), long('prompt', 'Change', { required: true, help: 'Reference images as {ref1} / {ref2}' }), img('ref1', 'Reference 1', { required: false }), img('ref2', 'Reference 2', { required: false }), mdl('video-edit', ['apimart/kling-v3-omni-edit', 'fal/kling-v4-edit', 'apimart/wan2.7-videoedit', 'fal/kling-o3-edit']), resolution('1080p'), tog('keepAudio', 'Keep original audio', true)],
    run: (v, ctx) => op.videoEdit({ ...v, prompt: `${v.prompt}. Keep everything else exactly as in {video}: motion, camera, timing and people.`, refs: [v.ref1, v.ref2] }, ctx),
  },
  {
    id: 'recast', title: 'Recast', sfSymbol: 'person.and.arrow.left.and.arrow.right', category: 'Video', output: 'video',
    description: 'Replace the actor in a clip with your character — performance, camera and timing kept.',
    inputs: [vid('video', 'Clip'), img('person', 'Character photo', { required: false }), character(), text('prompt', 'Extra direction'), mdl('video-edit', ['apimart/kling-v3-omni-edit', 'fal/kling-v4-edit', 'apimart/wan2.7-videoedit']), resolution('1080p'), tog('keepAudio', 'Keep original audio', true)],
    async run(v, ctx) {
      const p = await personRef(v, 'person', ctx.signal);
      return op.videoEdit({ video: v.video, model: v.model, resolution: v.resolution, keepAudio: v.keepAudio, refs: [p.image], prompt: `Replace the main person in {video} with the character from {ref1} — their face, hair, body and outfit — performing exactly the same motion, expressions and timing. Camera, background and lighting unchanged. ${v.prompt || ''}` }, ctx);
    },
  },
  {
    id: 'video-face-swap', title: 'Video Face Swap', sfSymbol: 'face.dashed', category: 'Video', output: 'video',
    description: 'Swap a face (or the whole person / background) in a clip from one photo.',
    inputs: [vid('video', 'Clip'), img('face', 'Face / replacement', { required: false }), character(), sel('mode', 'Swap', opts([{ value: 'person', label: 'Person' }, { value: 'object', label: 'Object' }, { value: 'background', label: 'Background' }]), 'person'), sel('engine', 'Engine', opts([{ value: 'swap', label: 'PixVerse Swap (fast, 720p)' }, { value: 'edit', label: 'Kling edit (best, 1080p)' }]), 'swap')],
    async run(v, ctx) {
      const f = await personRef(v, 'face', ctx.signal);
      if (v.engine === 'edit') return op.videoEdit({ video: v.video, refs: [f.image], prompt: v.mode === 'background' ? 'Replace the background of {video} with the scene in {ref1}; people and motion unchanged.' : 'Replace only the face of the main person in {video} with the face from {ref1}; keep expressions, lip movement, head motion, hair, body and lighting.' }, ctx);
      return op.videoSwap({ video: v.video, image: f.image, mode: v.mode }, ctx);
    },
  },
  {
    id: 'restyle', title: 'Mixed Media / Restyle', sfSymbol: 'paintbrush.pointed', category: 'Video', output: 'video',
    description: 'Turn footage into anime, claymation, ink, watercolor, VHS… or match a style frame.',
    inputs: [vid('video', 'Clip'), sel('style', 'Look', options(RESTYLES)), img('styleRef', 'Style frame', { required: false }), mdl('video-edit', ['apimart/wan2.7-videoedit', 'apimart/kling-v3-omni-edit', 'fal/kling-v4-edit']), resolution('1080p')],
    run: (v, ctx) => op.videoEdit({ video: v.video, model: v.model, resolution: v.resolution, keepAudio: true, refs: v.styleRef ? [v.styleRef] : [], prompt: v.styleRef ? 'Restyle {video} entirely in the visual style of {ref1}; keep the motion, timing and composition.' : `Restyle {video} as ${byValue(RESTYLES, v.style).prompt}; keep the motion, timing and composition.` }, ctx),
  },
  {
    id: 'motion-control', title: 'Motion Control', sfSymbol: 'figure.dance', category: 'Video', output: 'video',
    description: 'Your character performs the exact motion of a reference video (dances, gestures, acting).',
    inputs: [img('image', 'Character photo', { required: false }), character(), vid('video', 'Motion reference', { help: '3–30 s, one clearly visible person' }), sel('orientation', 'Follow orientation of', opts([{ value: 'video', label: 'Reference video (up to 30 s)' }, { value: 'image', label: 'Photo (up to 10 s)' }]), 'video'), sel('quality', 'Quality', opts([{ value: 'pro', label: 'Pro' }, { value: 'std', label: 'Standard' }]), 'pro'), text('prompt', 'Direction'), tog('keepSound', 'Keep reference audio', true), mdl('motion', ['apimart/kling-v3-motion-control', 'fal/kling-v3-motion', 'apimart/kling-v2-6-motion-control'])],
    async run(v, ctx) {
      const p = await personRef(v, 'image', ctx.signal);
      return op.motionControl({ ...v, image: p.image }, ctx);
    },
  },
  {
    id: 'extend', title: 'Extend Video', sfSymbol: 'arrow.right.to.line', category: 'Video', output: 'video',
    description: 'Continue a clip: native extenders keep the footage flowing; any video model continues from the last frame.',
    inputs: [vid('video', 'Clip'), long('prompt', 'What happens next', { required: true }), num('seconds', 'Add (s)', 6, 2, 15), { ...mdl('extend', ['fal/grok-extend', 'fal/flux3-extend']), kinds: ['extend', 'i2v'], help: 'Extenders continue the actual footage; video models continue from the last frame' }],
    run: (v, ctx) => op.extendVideo(v, ctx),
  },
  {
    id: 'video-upscale', title: 'Upscale Video', sfSymbol: 'sparkles.tv', category: 'Video', output: 'video',
    description: 'Topaz / SeedVR2 video super-resolution to 2–4×, optional frame-rate boost.',
    inputs: [vid('video', 'Clip'), sel('factor', 'Scale', opts([{ value: '2', label: '2×' }, { value: '4', label: '4×' }]), '2'), sel('fps', 'Frame rate', opts([{ value: '0', label: 'Keep' }, { value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]), '0'), mdl('upscale-video', ['fal/topaz-video', 'fal/seedvr-video'])],
    run: (v, ctx) => op.upscaleVideo(v, ctx),
  },
  {
    id: 'video-bg-remove', title: 'Video Background Remover', sfSymbol: 'person.crop.rectangle.badge.plus', category: 'Video', output: 'video',
    description: 'Remove a clip’s background — solid colour or transparent.',
    inputs: [vid('video', 'Clip'), sel('color', 'Background', opts(['Green', 'Black', 'White', 'Blue', 'Transparent']), 'Green'), mdl('bg-remove-video', ['fal/bria-video-rmbg', 'fal/veed-video-rmbg'])],
    run: (v, ctx) => op.removeVideoBackground(v, ctx),
  },
  {
    id: 'video-sfx', title: 'Add Sound Effects', sfSymbol: 'speaker.wave.3', category: 'Video', output: 'video',
    description: 'Generates synced sound effects and ambience for a clip, keeping its speech.',
    inputs: [vid('video', 'Clip'), text('prompt', 'Sounds', { help: 'Optional — e.g. "rain on windows, distant thunder"' }), tog('keepSpeech', 'Keep speech', true)],
    run: (v, ctx) => op.videoSfx(v, ctx),
  },

  /* ================= Speak & audio ================= */
  {
    id: 'talking-avatar', title: 'Speak — Talking Avatar', sfSymbol: 'person.wave.2', category: 'Speak & Audio', output: 'video',
    description: 'A photo speaks your script in any ElevenLabs voice (or your own audio).',
    inputs: [img('image', 'Photo', { required: false }), character(), long('text', 'Script', { help: 'Leave empty when uploading audio' }), voice(), aud('audio', 'Or upload audio'), text('prompt', 'Performance', { help: 'e.g. "warm, smiles, gestures with hands"' }), mdl('avatar', ['fal/omnihuman-v2', 'fal/kling-avatar', 'fal/h3-lipsync', 'fal/fabric']), sel('resolution', 'Resolution', opts(['720p', '1080p', '480p']), '720p')],
    async run(v, ctx) {
      const p = await personRef(v, 'image', ctx.signal);
      return op.talkingAvatar({ ...v, image: p.image, voice: v.voice || p.voice }, ctx);
    },
  },
  {
    id: 'lipsync', title: 'Lipsync Studio', sfSymbol: 'mouth', category: 'Speak & Audio', output: 'video',
    description: 'Make the person in a video say a new line — script + voice or uploaded audio.',
    inputs: [vid('video', 'Clip'), long('text', 'Script', { help: 'Leave empty when uploading audio' }), voice(), aud('audio', 'Or upload audio'), mdl('lipsync', ['fal/sync-v3', 'fal/veed-lipsync'])],
    run: (v, ctx) => op.lipsyncVideo(v, ctx),
  },
  {
    id: 'dub', title: 'Translate & Dub', sfSymbol: 'globe', category: 'Speak & Audio', output: 'video',
    description: 'Translate speech into another language in the speaker’s own voice, lip-synced.',
    inputs: [vid('video', 'Clip'), sel('language', 'Into', LANGUAGES, 'es'), text('keyterms', 'Names to keep', { help: 'Comma-separated brand / people names' })],
    run: (v, ctx) => op.dubVideo(v, ctx),
  },
  {
    id: 'tts', title: 'Voiceover', sfSymbol: 'waveform', category: 'Speak & Audio', output: 'audio',
    description: 'Text to speech in your cloned or stock ElevenLabs voices.',
    inputs: [long('text', 'Text', { required: true }), voice()],
    run: (v, ctx) => op.textToSpeech(v, ctx),
  },
  {
    id: 'sfx', title: 'Sound Effects', sfSymbol: 'speaker.badge.exclamationmark', category: 'Speak & Audio', output: 'audio',
    description: 'Describe a sound; get a clean effect up to 30 s.',
    inputs: [long('prompt', 'Sound', { required: true }), num('seconds', 'Length (s)', 5, 1, 30), tog('loop', 'Seamless loop', false)],
    run: (v, ctx) => op.soundEffect(v, ctx),
  },
  {
    id: 'music', title: 'Music', sfSymbol: 'music.note', category: 'Speak & Audio', output: 'audio',
    description: 'Score or song from a prompt — Eleven Music or Lyria.',
    inputs: [long('prompt', 'Music', { required: true }), num('seconds', 'Length (s)', 30, 10, 300), tog('instrumental', 'Instrumental', true), mdl('music', ['eleven/music', 'google/lyria-3.5'])],
    run: (v, ctx) => op.music(v, ctx),
  },
];

/* ---------------- public schema + runner ---------------- */

const CATEGORY_ORDER = ['Cinema', 'Effects', 'Ads & Products', 'Video', 'Image', 'Face & Identity', 'Speak & Audio'];

async function voiceOptions() {
  const out = [];
  if (elevenAvailable()) {
    const vs = await Promise.race([elevenVoices().catch(() => []), new Promise((r) => setTimeout(() => r([]), 4000))]);
    out.push(...vs.map((x) => ({ value: x.id, label: x.note ? `${x.name} — ${x.note}` : x.name })));
    if (!out.length) out.push({ value: ELEVEN_DEFAULT_VOICE, label: 'George (ElevenLabs)' });
  }
  if (googleAvailable()) out.push(...GEMINI_VOICES.map((x) => ({ value: `google:${x}`, label: `${x} (Gemini)` })));
  if (xaiAvailable()) out.push(...['eve', 'ara'].map((x) => ({ value: `xai:${x}`, label: `${x} (Grok)` })));
  return out;
}

/** Public, JSON-safe registry with model / voice options resolved against what is connected right now. */
export async function listTools() {
  const voices = TOOLS.some((t) => t.inputs.some((i) => i.type === 'voice')) ? await voiceOptions() : [];
  return TOOLS.map((t) => ({
    id: t.id, title: t.title, sfSymbol: t.sfSymbol, category: t.category, description: t.description, output: t.output,
    run: { method: 'POST', path: `/engine/api/tools/${t.id}/run` },
    inputs: t.inputs.map(({ prefer, kinds, ...i }) => {
      if (i.type === 'model') {
        const list = (kinds || [i.modelKind]).flatMap((k) => op.modelOptions(k));
        const seen = new Set();
        const o = list.filter((m) => !seen.has(m.value) && seen.add(m.value)).map(({ value, label }) => ({ value, label }));
        const def = (prefer || []).find((id) => o.some((x) => x.value === id)) || o[0]?.value || '';
        return { ...i, options: o, default: def, required: false };
      }
      if (i.type === 'voice') return { ...i, options: voices, default: voices[0]?.value || '' };
      return i;
    }),
  })).sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
}

export const getTool = (id) => TOOLS.find((t) => t.id === id);

/** Validate + normalise input values against a tool's schema. Throws 400-style errors. */
export function normalize(tool, raw = {}) {
  const v = {};
  for (const i of tool.inputs) {
    let x = raw[i.key];
    if (x === '' || x === null) x = undefined;
    if (x === undefined && i.default !== undefined && i.type !== 'model') x = i.default;
    if (i.type === 'number' && x !== undefined) {
      x = Number(x);
      if (!Number.isFinite(x)) x = i.default;
      if (i.min != null) x = Math.max(i.min, x);
      if (i.max != null) x = Math.min(i.max, x);
    }
    if (i.type === 'toggle') x = x === undefined ? !!i.default : x === true || x === 'true' || x === 1 || x === '1';
    if (i.type === 'select' && x !== undefined && !i.options.some((o) => o.value === String(x))) x = i.default;
    if (['text', 'longtext'].includes(i.type) && x !== undefined) x = String(x).slice(0, 8000);
    if (i.required && (x === undefined || x === '')) throw Object.assign(new Error(`${i.label} is required`), { status: 400 });
    v[i.key] = x;
  }
  return v;
}

/** Start a tool run; resolves to the job view ({ id, status, … }) polled via GET /jobs/:id. */
export function runTool(id, raw) {
  const tool = getTool(id);
  if (!tool) throw Object.assign(new Error(`no tool "${id}"`), { status: 404 });
  const values = normalize(tool, raw);
  return startRun({
    label: tool.title,
    tool: tool.id,
    run: async (ctx) => {
      const r = await tool.run(values, ctx);
      return r?.asset ? r : { asset: r };
    },
  });
}

export { cinemaPresets };
