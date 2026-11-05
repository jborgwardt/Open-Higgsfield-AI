// Preset libraries for one-click tools — Higgsfield's Effects, viral templates, ad scenes, photo styles, etc.
// Every preset is a tuned prompt template; tools.js turns each family into a select input, so fixing or adding a
// preset is a data change here (the web and Apple apps render whatever the engine serves).
// Templates: {subject} = what the user described (or "the person"), {product} = product name.

const P = (rows) => rows.map(([value, prompt, extra]) => ({ value: value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label: value, prompt, ...(extra || {}) }));

const KEEP = 'Keep {subject} exactly recognisable: same face, hair, body and outfit as the photo.';

/** Video effects (higgsfield.ai/effects) — photo → 5 s clip. */
export const VFX = P([
  ['Floating Fall', `{subject} gently tips backwards and falls in slow motion, floating weightlessly as if underwater; hair and clothes drift, dreamy soft light. ${KEEP}`],
  ['High Flip', `{subject} launches into a high acrobatic backflip, spins through the air and lands cleanly; camera tracks the arc, real physics. ${KEEP}`],
  ['Burning Man', `{subject} stands calm as flames ignite around their body and engulf them in a controlled cinematic fire, embers and heat haze swirl, they remain unharmed. ${KEEP}`],
  ['Scrapbook Collage', `The photo becomes an animated scrapbook page: paper cut-outs of {subject} slide in with tape, doodles and stickers, stop-motion jitter. ${KEEP}`],
  ['Comic', `The scene morphs into a living comic-book panel: ink outlines, halftone dots, speed lines; {subject} animates in comic style with dynamic poses. ${KEEP}`],
  ['Frozen in Motion', 'Time freezes mid-moment: dust, water droplets and strands of hair hang suspended in the air while the camera slowly glides around the frozen {subject}. Ultra-detailed, cinematic.'],
  ['Particles', `{subject} dissolves into thousands of glowing particles that swirl upward and drift away on the wind, revealing the background. ${KEEP}`],
  ['Pigeons', `A flock of pigeons bursts into flight all around {subject}, wings beating in slow motion, feathers drifting through the light. ${KEEP}`],
  ['Pearl Earring', `The image turns into a Vermeer-style oil painting: dark background, soft window light, blue and yellow headscarf and pearl earring; {subject} slowly turns to look over the shoulder. ${KEEP}`],
  ['Studio Slide', `{subject} slides into frame across a seamless coloured studio backdrop with a playful fashion-campaign move, crisp studio light. ${KEEP}`],
  ['Incline', `The camera inclines and rises over {subject} as they look up, dramatic low-to-high reveal. ${KEEP}`],
  ['Act Natural', `{subject} tries to act casual, awkwardly whistling and glancing around while something absurd happens behind them. Comedic timing. ${KEEP}`],
  ['Monster Dab', `A giant friendly furry monster pops up behind {subject} and both perform a synchronized dab. ${KEEP}`],
  ['Clones', `Clones of {subject} appear one by one across the frame, each striking a different pose. ${KEEP}`],
  ['Earth Zoom', `The camera rockets upward away from {subject}, through the clouds and into orbit, revealing the curve of planet Earth from space in one continuous zoom out.`],
  ['Cutout', `{subject} becomes a paper cut-out that peels off the background and flutters in a stop-motion style. ${KEEP}`],
  ['Mighty Fighter', `{subject} transforms into a martial-arts fighter and unleashes a powerful kick, impact shockwave ripples through the air. ${KEEP}`],
  ['Vanish', `{subject} snaps their fingers and vanishes in a puff of smoke, leaving the scene empty. ${KEEP}`],
  ['Moonwalk', `{subject} smoothly moonwalks backwards across the floor, iconic dance move, full body in frame. ${KEEP}`],
  ['Eyes In', 'Extreme macro push-in into {subject}\'s eye, through the iris into a glowing cosmic nebula.'],
  ['Street Colossus', `{subject} grows into a towering giant striding down a city street, cars and people tiny below, realistic scale and shadows. ${KEEP}`],
  ['Melting', `{subject} slowly melts like warm wax into a glossy liquid puddle, surreal but photoreal. ${KEEP}`],
  ['Architecture Wave', 'The buildings around {subject} ripple and fold upward like a wave, the city bending in on itself, mind-bending VFX.'],
  ['Agamemnon', `Golden ancient-Greek armour and a crested helmet materialise on {subject}, epic heroic pose, dust and god rays. ${KEEP}`],
  ['Cyclope', `{subject}'s two eyes merge into one large cyclops eye that blinks slowly, uncanny and photoreal.`],
  ['Canvas', `{subject} becomes a living oil painting on canvas, visible brush strokes animate as they move. ${KEEP}`],
  ['Tracking', `Smooth Steadicam tracking shot following {subject} walking forward confidently. ${KEEP}`],
  ['LSD', 'Psychedelic kaleidoscope: colours shift and swirl, the scene breathes and morphs into fractal patterns around {subject}.'],
  ['Blue Depth', `The scene floods with deep blue water; {subject} floats underwater with rising bubbles and dancing caustic light. ${KEEP}`],
  ['Wild Ride', `{subject} rides an impossibly fast wild ride, wind blasting their hair, speed lines and motion blur. ${KEEP}`],
  ['World Morphing', `The world around {subject} morphs through desert, snowfield, neon city and jungle while they stay perfectly still. ${KEEP}`],
  ['Stop World', `{subject} raises a hand and the whole world stops: cars, people and birds freeze mid-motion while {subject} walks through the frozen scene. ${KEEP}`],
  ['Bullet Time', `Bullet time: {subject} dodges in extreme slow motion while the camera orbits 180 degrees around them. ${KEEP}`],
  ['Infinite Clones', `An infinite recursive line of clones of {subject} stretches into the distance, each copying the movement with a slight delay. ${KEEP}`],
  ['Superstar', `{subject} walks a red carpet as a superstar, paparazzi camera flashes popping everywhere. ${KEEP}`],
  ['Skatedog', 'A dog in sunglasses cruises past on a skateboard; {subject} reacts and skates alongside, sunny street.'],
  ['Smash and Grab', `{subject} smashes through a glass display and grabs the prize in slow motion, shards glittering. ${KEEP}`],
  ['Selfception', `{subject} holds up a photo of themselves which holds a photo of themselves; the camera zooms endlessly into the recursive picture. ${KEEP}`],
  ['Lacewalker', `{subject} balances gracefully on a thread of delicate lace stretched across the sky above the clouds. ${KEEP}`],
  ['Boarding Pass', `{subject} flashes a boarding pass and is instantly on a runway as a jet roars past behind them. ${KEEP}`],
  ['Lidar Transition', `A glowing lidar point-cloud scan sweeps across {subject} and the scene, turning it into a 3D wireframe, then back to reality. ${KEEP}`],
  ['Fallen Angel', `Huge dark feathered wings unfold from {subject}'s back, feathers drift down in moody light. ${KEEP}`],
  ['Windows', 'The camera passes through a series of windows into different rooms, each revealing {subject} in a new setting.'],
  ['Fairytale Castle', `The background transforms into a magical fairytale castle with sparkles and fireworks as {subject} looks on in wonder. ${KEEP}`],
  ['Palette', `The scene's colour palette cycles through vivid grades in sweeping waves while {subject} poses. ${KEEP}`],
  ['Disintegration', `{subject} disintegrates into ash and dust from the edges inward, blown away by the wind. ${KEEP}`],
  ['Explosion', 'A massive fiery explosion erupts behind {subject} who walks calmly towards camera without looking back, debris and shockwave.'],
  ['Levitation', `{subject} slowly levitates off the ground, small objects around them float up too, mystical light. ${KEEP}`],
  ['Turning Metal', `{subject}'s skin and clothes turn into polished liquid chrome from the feet up, reflections ripple. ${KEEP}`],
  ['Thunder God', `Lightning crackles around {subject}, eyes glowing, storm clouds swirling overhead. ${KEEP}`],
  ['Inflate', '{subject} inflates like a balloon and floats up, cartoonish but photoreal.'],
  ['Squish', 'A giant hand squishes {subject} like soft foam, which springs back into shape. Playful.'],
  ['Cakeify', 'A knife slices through {subject}, revealing it is actually a realistic cake inside.'],
]);

/** Viral video templates (higgsfield.ai/apps trending templates) — photo → clip. */
export const VIRAL = P([
  ['On Fire', `{subject} sits calmly at a table holding a coffee mug, smiling, while the room around them is engulfed in flames — the "this is fine" meme as live action. ${KEEP}`],
  ['Mukbang', `{subject} hosts a viral mukbang eating show: a table piled with colourful food, ring light, they take a big bite and react to camera. ${KEEP}`],
  ['Cloud Surf', `{subject} surfs on a fluffy pink cloud through a pastel sunset sky, arms out, hair streaming. ${KEEP}`],
  ['Idol', `{subject} as a K-pop idol on a glittering stage, performing a sharp choreography move, lights and confetti. ${KEEP}`],
  ['Skibidi', 'Absurd meme: {subject}\'s head pops out of a toilet bowl and sings, surreal internet humour.'],
  ['Plushies', '{subject} as a soft felt plushie toy that comes to life and waves, stop-motion style.'],
  ['Behind the Scenes', `A behind-the-scenes shot of a film set: crew, lights and a camera rig around {subject} between takes, handheld documentary camera. ${KEEP}`],
  ['ASMR Host', `{subject} hosts an ASMR video: close-up, soft whispering, tapping on a microphone, cosy dim studio. ${KEEP}`],
  ['Urban Cuts', `{subject} struts down a city street in a beat-synced fashion reel, jump cuts on every beat between angles. ${KEEP}`],
  ['Micro-Beasts', `{subject} is surrounded by tiny adorable animals — kittens, ducklings, bunnies — climbing on them playfully. ${KEEP}`],
  ['Paparazzi Escape', `{subject} pushes through a crowd of paparazzi with flashing cameras, sunglasses on, cool and unbothered. ${KEEP}`],
  ['Dance Break', `{subject} breaks into a confident trending dance, full body visible, natural rhythm. ${KEEP}`],
]);

/** One Effects library: VFX presets + trending templates (both are photo → clip on the same model). */
export const EFFECTS = [...VFX, ...VIRAL];

/** Photo styles (games & characters, extras) — photo → image. */
export const PHOTO_STYLES = P([
  ['Game Dump', 'Turn {subject} into a 3x3 grid of 9 video-game characters, each in a different iconic game art style (16-bit pixel art, PS1 low-poly, cel-shaded, AAA photoreal, fighting game, cozy farm sim, isometric RPG, platformer, arcade). Same person recognisable in every tile.'],
  ['Nano Strike', 'Turn {subject} into a tactical-shooter game character: plate carrier, headset, rifle, gritty map in the background, AAA game render. Same face.'],
  ['Nano Theft', 'Turn {subject} into an open-world crime game loading-screen illustration, bold painted style, city skyline. Same face.'],
  ['Simlife', 'Turn {subject} into a life-simulation game character with a green plumbob diamond above the head, in a bright suburban home. Same face.'],
  ['3D Figure', 'Turn {subject} into a premium collectible 1/7 scale figurine on a desk, with its printed box and a computer showing the 3D model behind it. Same face, photoreal product shot.'],
  ['3D Render', 'Render {subject} as a stylised 3D animated-film character, soft subsurface skin, studio lighting.'],
  ['Mugshot', 'A police mugshot of {subject} holding a placard, height chart behind, harsh flash. Humorous, same face.'],
  ['Signboard', '{subject} painted as a giant stylish mural on a brick wall, people walking past for scale.'],
  ['Paint App', '{subject} redrawn as crude retro MS-Paint art with a 1990s paint program window around it.'],
  ['Japanese Show', '{subject} in a retro four-panel Japanese TV variety show frame with colourful captions and reaction faces.'],
  ['Glitter Sticker', '{subject} as a sparkly holographic glitter sticker with a white die-cut border on a laptop lid.'],
  ['Outfit Vending', '{subject}\'s outfit broken down into individual items displayed in an illuminated vending machine, each with a price tag.'],
  ['Plushie', '{subject} as a soft handmade felt plushie with button eyes, product photo.'],
  ['Claymation', '{subject} as a claymation character with visible fingerprints in the clay, stop-motion set.'],
  ['Anime', '{subject} as a hand-drawn anime key visual, cinematic lighting.'],
  ['Pixar-like', '{subject} as a charming 3D animated movie character, expressive eyes.'],
]);

/** Product ad scenes (Ads & Products apps) — keyframe composed with the product, then animated. */
export const AD_SCENES = P([
  ['Bullet Time White', '{product} floating on a seamless pure-white studio sweep, soft shadow, premium packshot lighting', { motion: 'smooth 360-degree orbit around the product, bullet-time, studio light glints' }],
  ['Bullet Time Scene', '{product} hero placement in a lush environment that matches its brand, dramatic light', { motion: 'bullet-time orbit around the product while the environment shifts and adapts to it' }],
  ['Bullet Time Splash', '{product} mid-air with a frozen splash of liquid and fruit pieces around it', { motion: 'frozen splash, slow bullet-time orbit, droplets suspended' }],
  ['Billboard Ad', 'a giant billboard takeover in a busy city at dusk showing {product}', { motion: 'slow push-in towards the billboard as traffic flows below' }],
  ['Truck Ad', 'a moving truck with a full-side wrap advertising {product} driving down a city avenue', { motion: 'tracking shot alongside the moving truck' }],
  ['Giant Product', '{product} as a giant monument towering over a city skyline, people gather to look up', { motion: 'aerial pull-back revealing the giant product over the city' }],
  ['Volcano Ad', '{product} on a rock in front of an erupting volcano at night, lava glow', { motion: 'slow push-in as lava bursts behind the product' }],
  ['Fridge Ad', '{product} on a shelf inside a glowing refrigerator, frost and condensation', { motion: 'the fridge door swings open, light floods in, camera pushes towards the product' }],
  ['Packshot', '{product} centred on an elegant gradient backdrop, closing-frame packshot, perfect reflections', { motion: 'slow elegant dolly in to a final hero frame' }],
  ['Macro Scene', 'extreme macro of {product} showing textures and materials in an adaptive styled set', { motion: 'macro slider move revealing details, shallow depth of field' }],
  ['Magic Button', '{product} on a pedestal in a whimsical magical scene with floating sparkles', { motion: 'magic sparkles swirl and the product glows' }],
  ['Kick Ad', '{product} on a sports field next to rival unbranded products', { motion: 'a foot kicks the rival products away, {product} remains standing triumphantly' }],
  ['Graffiti Ad', '{product} painted as vibrant street graffiti on a city wall', { motion: 'spray paint animates the graffiti into being, camera slides along the wall' }],
  ['Chameleon', 'a chameleon on a branch next to {product}', { motion: 'the chameleon changes colour to match the product' }],
  ['ASMR Add-On', '{product} on a soft textured ASMR set with a microphone close by', { motion: 'hands tap and unbox the product slowly, crisp close-up ASMR sounds' }],
  ['Poster', 'a bold graphic poster design featuring {product}, striking typography area left empty', { motion: 'subtle parallax push-in on the poster' }],
]);

/** Video restyle / Mixed Media looks. */
export const RESTYLES = P([
  ['Anime', 'hand-drawn Japanese anime, clean line art, cel shading, painted backgrounds'],
  ['Claymation', 'claymation stop-motion, plasticine textures, visible fingerprints'],
  ['Comic Ink', 'black ink comic book art with halftone shading and bold outlines'],
  ['Watercolor', 'loose watercolor painting with bleeding pigments on paper texture'],
  ['Oil Painting', 'impasto oil painting with thick visible brush strokes'],
  ['Pixel Art', '16-bit pixel art video game look'],
  ['Brick Toy', 'everything built from plastic toy bricks'],
  ['Pencil Sketch', 'graphite pencil sketch, animated line boil'],
  ['Neon Cyberpunk', 'neon cyberpunk night, holograms, rain, magenta and cyan light'],
  ['Paper Cutout', 'layered paper cut-out craft animation'],
  ['Film Noir', 'black-and-white film noir with hard shadows'],
  ['VHS 1980s', '1980s VHS camcorder footage, tracking lines, colour bleed'],
  ['Low Poly', 'low-poly 3D render with flat shading'],
  ['Stained Glass', 'stained glass with lead lines and glowing colour'],
  ['Thermal', 'thermal camera vision, heat palette'],
  ['Ukiyo-e', 'Japanese ukiyo-e woodblock print'],
]);

export const HEADSHOTS = P([
  ['Corporate Grey', 'professional corporate headshot, charcoal grey seamless backdrop, soft key light, business attire'],
  ['Studio White', 'clean studio headshot on white, bright even light, smart casual'],
  ['Outdoor Natural', 'outdoor headshot with soft daylight and a blurred green park background'],
  ['Creative Dark', 'moody creative headshot, dark backdrop, Rembrandt lighting'],
  ['Actor', 'actor headshot, natural expression, neutral backdrop, soft window light, 85mm'],
  ['Tech Founder', 'modern startup founder portrait in a bright office, candid smile'],
]);

export const RELIGHT_DIRECTIONS = P([['Left', 'from the left'], ['Right', 'from the right'], ['Front', 'from the front'], ['Back (rim)', 'from behind as a rim light'], ['Top', 'from above'], ['Bottom', 'from below']]);
export const RELIGHT_COLORS = P([['Warm Tungsten', 'warm 3200K tungsten'], ['Daylight', 'neutral 5600K daylight'], ['Golden Hour', 'golden-hour sunlight'], ['Cool Blue', 'cool blue moonlight'], ['Neon Magenta', 'neon magenta and cyan'], ['Red Alert', 'saturated red'], ['Candlelight', 'flickering candlelight']]);

/** Shot sets for the Shots / Zooms / Angles apps (one image each). */
export const SHOT_SETS = {
  coverage: ['establishing extreme wide shot of the whole location', 'full shot, head to toe', 'medium shot from the waist up', 'medium close-up from the chest up', 'tight close-up on the face', 'extreme close-up detail of the eyes or hands', 'over-the-shoulder shot', 'low-angle hero shot', 'high-angle top-down shot'],
  zooms: ['extreme wide aerial view', 'very wide shot', 'wide shot', 'full shot', 'medium shot', 'medium close-up', 'close-up', 'extreme close-up', 'macro detail'],
  angles: ['front view', 'three-quarter view from the left', 'left profile view', 'view from behind', 'three-quarter view from the right', 'right profile view', 'top-down view', 'low-angle view looking up', 'high-angle view looking down'],
  next: ['the very next moment', 'a few seconds later, the main character reacts', 'something unexpected enters the frame', 'the camera reveals what they are looking at', 'later that night in the same place', 'the tension escalates', 'a quiet emotional beat', 'the dramatic payoff'],
};

export const ANGLES = SHOT_SETS.angles.map((a) => ({ value: a.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), label: a.replace(/^./, (c) => c.toUpperCase()), prompt: a }));

export const TRANSITIONS = P([
  ['Seamless Morph', 'the first image seamlessly morphs into the second, fluid continuous transformation'],
  ['Camera Fly-through', 'the camera flies forward through the first scene and emerges into the second without a cut'],
  ['Whip Pan', 'fast whip pan with motion blur from the first scene into the second'],
  ['Match Cut', 'graphic match cut: shapes in the first image line up with the second'],
  ['Zoom Through', 'push-in through an object in the first scene that opens into the second'],
  ['Time Lapse', 'time lapse transforms the first scene into the second as light and seasons change'],
]);

export const LANGUAGES = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['zh', 'Chinese (Mandarin)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['sv', 'Swedish']].map(([value, label]) => ({ value, label }));

export const options = (list) => list.map(({ value, label }) => ({ value, label }));
export const byValue = (list, v) => list.find((p) => p.value === v) || list[0];
export const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
