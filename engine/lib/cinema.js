// Cinema Studio presets + prompt compiler, served to the web app and the Apple app (GET /cinema/presets).
// Mirrors Higgsfield Cinema Studio 4.0: camera body, lens, focal length, aperture, up to 3 stacked camera
// moves (Higgsfield's camera-control library), genre, era / colour grade, montage pacing and emotion.

const opt = (rows) => rows.map(([value, prompt, label]) => ({ value, label: label || value, prompt }));

export const CAMERAS = opt([
  ['Modular 8K Digital', 'modular 8K digital cinema camera, crisp micro-detail, clean shadows'],
  ['Full-Frame Cine Digital', 'full-frame digital cinema camera, shallow natural depth, wide dynamic range'],
  ['Grand Format 70mm Film', 'grand format 70mm film camera, epic resolution, fine organic grain, rich highlight roll-off'],
  ['Studio Digital S35', 'Super 35 studio digital cinema camera, classic cinematic field of view'],
  ['Classic 16mm Film', 'classic 16mm film camera, visible grain, soft halation, documentary texture'],
  ['Premium Large Format Digital', 'premium large-format digital cinema camera, immersive depth, smooth skin tones'],
  ['Vintage 35mm Film', '35mm motion picture film stock, warm grain, gentle gate weave'],
  ['Handheld Mini Cinema', 'compact handheld cinema camera, intimate run-and-gun feel'],
]);

export const LENSES = opt([
  ['Creative Tilt Lens', 'creative tilt-shift lens, selective focus plane'],
  ['Compact Anamorphic', 'compact anamorphic lens, oval bokeh, subtle horizontal flares'],
  ['Extreme Macro', 'extreme macro lens, microscopic detail'],
  ['70s Cinema Prime', '1970s cinema prime lens, low contrast, warm vintage rendering'],
  ['Classic Anamorphic', 'classic anamorphic lens, 2.39:1 feel, blue streak flares, oval bokeh'],
  ['Premium Modern Prime', 'premium modern cinema prime, clean sharp rendering'],
  ['Warm Cinema Prime', 'warm-toned cinema prime lens, creamy skin'],
  ['Swirl Bokeh Portrait', 'swirl bokeh portrait lens, painterly background'],
  ['Vintage Prime', 'vintage prime lens, soft edges, gentle flare'],
  ['Halation Diffusion', 'halation diffusion filter, glowing highlights'],
  ['Clinical Sharp Prime', 'ultra-sharp clinical prime lens, edge-to-edge clarity'],
]);

export const FOCALS = [8, 14, 24, 35, 50, 85, 135].map((f) => ({
  value: String(f), label: `${f}mm`,
  prompt: `${f}mm focal length (${{ 8: 'ultra-wide fisheye-like perspective', 14: 'dramatic wide-angle perspective', 24: 'wide dynamic perspective', 35: 'natural cinematic perspective', 50: 'standard human-eye perspective', 85: 'flattering portrait compression', 135: 'telephoto compression, isolated subject' }[f]})`,
}));

export const APERTURES = opt([
  ['f/1.4', 'aperture f/1.4, very shallow depth of field, creamy bokeh'],
  ['f/2.8', 'aperture f/2.8, shallow depth of field, subject separation'],
  ['f/4', 'aperture f/4, balanced depth of field'],
  ['f/8', 'aperture f/8, deep focus'],
  ['f/11', 'aperture f/11, deep focus clarity, sharp foreground to background'],
]);

// Higgsfield camera-control library (names as on higgsfield.ai/camera-controls) → motion language video models follow.
export const MOVES = opt([
  ['Static', 'locked-off static camera on a tripod, no camera movement'],
  ['Handheld', 'handheld camera with natural organic shake and breathing'],
  ['Dolly In', 'smooth dolly push-in towards the subject'],
  ['Dolly Out', 'smooth dolly pull-back away from the subject'],
  ['Dolly Left', 'lateral dolly move tracking to the left'],
  ['Dolly Right', 'lateral dolly move tracking to the right'],
  ['Super Dolly In', 'fast, long dolly push-in from wide to close-up'],
  ['Super Dolly Out', 'fast, long dolly pull-out from close-up to a wide reveal'],
  ['Double Dolly', 'double dolly: subject and camera glide forward together, background drifts behind'],
  ['Dolly Zoom In', 'dolly zoom (vertigo effect): camera pulls back while zooming in, background stretches'],
  ['Dolly Zoom Out', 'reverse dolly zoom: camera pushes in while zooming out, background compresses'],
  ['Zoom In', 'slow optical zoom in'],
  ['Zoom Out', 'slow optical zoom out'],
  ['Crash Zoom In', 'sudden crash zoom in onto the subject'],
  ['Crash Zoom Out', 'sudden crash zoom out to reveal the scene'],
  ['Rapid Zoom In', 'rapid snap zoom in'],
  ['Rapid Zoom Out', 'rapid snap zoom out'],
  ['YoYo Zoom', 'yo-yo zoom: quick zoom in then back out'],
  ['Eating Zoom', 'extreme zoom pushing into the subject’s mouth as they eat'],
  ['Eyes In', 'extreme push-in into the subject’s eye, entering the iris'],
  ['Mouth In', 'extreme push-in into the subject’s open mouth'],
  ['Pan Left', 'smooth pan to the left'],
  ['Pan Right', 'smooth pan to the right'],
  ['Whip Pan', 'fast whip pan with motion blur'],
  ['Tilt Up', 'smooth tilt up revealing height'],
  ['Tilt Down', 'smooth tilt down'],
  ['Arc Left', 'camera arcs around the subject to the left'],
  ['Arc Right', 'camera arcs around the subject to the right'],
  ['360 Orbit', 'full 360-degree orbit around the subject'],
  ['3D Rotation', 'the subject rotates in place as if on a turntable, camera steady'],
  ['Lazy Susan', 'slow turntable rotation of the subject, product-shot style'],
  ['Bullet Time', 'bullet time: action frozen while the camera orbits around the subject'],
  ['Crane Up', 'crane shot rising upward'],
  ['Crane Down', 'crane shot descending downward'],
  ['Crane Over The Head', 'crane move sweeping up and over the subject’s head'],
  ['Jib Up', 'jib arm lifting the camera upward'],
  ['Jib Down', 'jib arm lowering the camera'],
  ['Aerial Pullback', 'aerial drone pull-back rising away to reveal the landscape'],
  ['FPV Drone', 'FPV drone flight, fast and agile, banking through the scene'],
  ['Overhead', 'top-down overhead bird’s-eye shot'],
  ['Dutch Angle', 'tilted dutch angle, uneasy framing'],
  ['Fisheye', 'fisheye lens distortion, ultra-wide bulge'],
  ['Head Tracking', 'camera tracks the subject’s head closely as they move'],
  ['Hero Cam', 'low-angle hero shot slowly rising, subject looks powerful'],
  ['Snorricam', 'snorricam: camera rigged to the actor’s body, face locked in frame while the world moves'],
  ['Car Chasing', 'camera car chasing the vehicle at speed'],
  ['Car Grip', 'camera mounted on the side of a moving car'],
  ['Road Rush', 'low camera rushing forward over the road surface'],
  ['Buckle Up', 'camera rocks and jolts like a vehicle hitting turbulence'],
  ['Robo Arm', 'robotic motion-control arm move, precise fast sweep'],
  ['Object POV', 'point of view from an object in the scene'],
  ['Through Object In', 'camera passes through a foreground object into the scene'],
  ['Through Object Out', 'camera pulls back through a foreground object out of the scene'],
  ['Flying Cam Transition', 'camera flies through the scene as a seamless transition'],
  ['Focus Change', 'rack focus from foreground to background'],
  ['Low Shutter', 'low shutter speed, dreamy streaked motion blur'],
  ['Hyperlapse', 'hyperlapse moving through the location, time compressed'],
  ['Timelapse Landscape', 'landscape timelapse, clouds and light racing'],
  ['Timelapse Human', 'timelapse of people rushing around a still subject'],
  ['Timelapse Glam', 'glamour timelapse with flickering lights'],
  ['Incline', 'camera inclines and rises over the subject'],
  ['Wiggle', 'playful wiggle camera shake'],
  ['Glam', 'glamorous slow push with sparkling highlights'],
  ['BTS', 'behind-the-scenes handheld documentary camera'],
]);

export const GENRES = opt([
  ['General', ''],
  ['Action', 'action film: kinetic energy, dynamic blocking, impactful motion'],
  ['Epic', 'epic film: grand scale, sweeping vistas, heroic framing'],
  ['Drama', 'drama: intimate performances, motivated naturalistic light'],
  ['Comedy', 'comedy: bright, clean, warm, playful timing'],
  ['Horror', 'horror: dread, deep shadows, unsettling stillness'],
  ['Thriller', 'thriller: tension, cool tones, tight framing'],
  ['Sci-Fi', 'science fiction: futuristic production design, practical glow'],
  ['Romance', 'romance: soft warm light, tender closeness'],
  ['Noir', 'film noir: hard light, venetian-blind shadows, smoke'],
  ['Documentary', 'documentary realism: available light, observational camera'],
]);

export const ERAS = opt([
  ['Modern', ''],
  ['1960s', '1960s film stock, Technicolor saturation, soft grain'],
  ['1970s', '1970s film look, warm faded colours, heavy grain, halation'],
  ['1980s', '1980s film look, neon accents, high-contrast colour, bloom'],
  ['1990s', '1990s 35mm print look, bleach-bypass contrast'],
  ['2000s', 'early digital cinema look, teal and orange'],
  ['2010s', 'clean modern digital grade'],
]);

export const GRADES = opt([
  ['Natural', 'natural colour science'],
  ['Teal & Orange', 'teal and orange blockbuster grade'],
  ['Kodak 2383', 'Kodak 2383 print film emulation, rich blacks'],
  ['Fuji Eterna', 'Fuji Eterna film emulation, muted pastel tones'],
  ['Bleach Bypass', 'bleach bypass, desaturated high contrast'],
  ['Monochrome', 'black and white, deep contrast'],
  ['Neon Noir', 'neon noir grade, magenta and cyan'],
  ['Golden Hour', 'warm golden hour grade'],
  ['Moonlight', 'cool moonlit blue grade'],
]);

export const PACING = opt([
  ['Single Shot', 'one continuous shot, no cuts'],
  ['Calm', 'calm pacing: two or three long, unhurried shots with gentle cuts'],
  ['Dynamic', 'dynamic montage: several shots of varied size cut on action'],
  ['Chaotic', 'chaotic montage: rapid cuts, whip transitions, frenetic energy'],
]);

export const EMOTIONS = opt([
  ['Neutral', ''], ['Joy', 'the character radiates joy'], ['Sadness', 'the character is quietly heartbroken'], ['Anger', 'the character seethes with anger'],
  ['Fear', 'the character is terrified'], ['Surprise', 'the character is astonished'], ['Determination', 'the character is steely and determined'], ['Love', 'the character looks on with love'],
]);

export const ASPECTS = ['16:9', '21:9', '9:16', '1:1', '4:3', '3:4'].map((v) => ({ value: v, label: v }));

const find = (list, v) => list.find((o) => o.value === String(v));

export function cinemaPresets() {
  const strip = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    cameras: strip(CAMERAS), lenses: strip(LENSES), focals: strip(FOCALS), apertures: strip(APERTURES), moves: strip(MOVES),
    genres: strip(GENRES), eras: strip(ERAS), grades: strip(GRADES), pacing: strip(PACING), emotions: strip(EMOTIONS), aspects: ASPECTS,
    defaults: { camera: 'Full-Frame Cine Digital', lens: 'Premium Modern Prime', focal: '35', aperture: 'f/2.8', moves: ['Dolly In'], genre: 'General', era: 'Modern', grade: 'Natural', pacing: 'Single Shot', emotion: 'Neutral' },
  };
}

/**
 * Compile a Cinema Studio prompt. Photo mode describes the still; video mode adds up to 3 ordered camera moves,
 * pacing and a no-cuts / cuts instruction video models follow reliably.
 */
export function buildCinemaPrompt({ prompt, mode = 'video', camera, lens, focal, aperture, moves = [], genre, era, grade, pacing, emotion, duration }) {
  const parts = [String(prompt || '').trim()];
  const g = find(GENRES, genre)?.prompt;
  if (g) parts.push(g);
  const e = find(EMOTIONS, emotion)?.prompt;
  if (e) parts.push(e);
  const look = [find(CAMERAS, camera)?.prompt, find(LENSES, lens)?.prompt, find(FOCALS, focal)?.prompt, find(APERTURES, aperture)?.prompt].filter(Boolean);
  if (look.length) parts.push(`Shot on a ${look.join(', ')}`);
  const tone = [find(ERAS, era)?.prompt, find(GRADES, grade)?.prompt].filter(Boolean);
  if (tone.length) parts.push(`Look: ${tone.join(', ')}`);
  if (mode === 'video') {
    const ms = moves.filter(Boolean).slice(0, 3).map((m) => find(MOVES, m)?.prompt || m);
    if (ms.length === 1) parts.push(`Camera: ${ms[0]}`);
    else if (ms.length > 1) parts.push(`Camera, in this order: ${ms.map((m, i) => `${['first', 'then', 'finally'][i]} ${m}`).join('; ')}`);
    const p = find(PACING, pacing)?.prompt;
    if (p) parts.push(`Editing: ${p}`);
    if (duration) parts.push(`About ${Math.round(duration)} seconds`);
    parts.push('Cinematic motion, realistic physics, consistent faces and wardrobe, no on-screen text or subtitles');
  } else {
    parts.push('Cinematic film still, motivated lighting, high dynamic range, natural skin texture, no text');
  }
  return parts.filter(Boolean).join('. ').replace(/\.\./g, '.');
}
