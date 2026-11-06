// Models used only by one-click tools (upscale, avatars, lip-sync, motion control, video edit, …).
// Pure data so both catalog.js (GET /catalog) and ops.js can import it without a cycle.
// `kind` is the tool's modelKind; `endpoint` is the provider route; `price` is a rough guide in USD.

export const TOOL_MODELS = [
  // ---- upscale ----
  { id: 'fal/topaz-image', provider: 'fal', kind: 'upscale-image', label: 'Topaz Wonder 3.5 (fal)', blurb: 'Generative photo upscale up to 4×, face recovery. Best quality.', endpoint: 'topaz/upscale/image/generative', price: '≈$0.01–0.08 / image' },
  { id: 'fal/seedvr-image', provider: 'fal', kind: 'upscale-image', label: 'SeedVR2 (fal)', blurb: 'Faithful diffusion upscale, up to 10×. Very cheap.', endpoint: 'fal-ai/seedvr/upscale/image', price: '$0.001 / MP' },
  { id: 'fal/topaz-video', provider: 'fal', kind: 'upscale-video', label: 'Topaz Proteus (fal)', blurb: 'Studio video upscale up to 4×, optional frame-rate boost.', endpoint: 'topaz/upscale/video/precision', price: '≈$0.01 / unit' },
  { id: 'fal/seedvr-video', provider: 'fal', kind: 'upscale-video', label: 'SeedVR2 Video (fal)', blurb: 'Temporally consistent diffusion upscale to 1080p–4K.', endpoint: 'fal-ai/seedvr/upscale/video', price: '$0.001 / MP' },

  // ---- talking avatar (photo + audio) ----
  { id: 'fal/omnihuman-v2', provider: 'fal', kind: 'avatar', label: 'OmniHuman v2 (ByteDance)', blurb: 'Most expressive full-body talking performance from one photo.', endpoint: 'bytedance/omnihuman/v2', price: '$0.105 / s', minAudio: 4 },
  { id: 'fal/kling-avatar', provider: 'fal', kind: 'avatar', label: 'Kling AI Avatar Pro', blurb: 'Realistic humans, animals and cartoons; prompt-steerable.', endpoint: 'fal-ai/kling-video/v1/pro/ai-avatar', price: '$0.115 / s' },
  { id: 'fal/h3-lipsync', provider: 'fal', kind: 'avatar', label: 'MiniMax H3 Max Lip Sync', blurb: '2K talking video, up to 15 min of audio.', endpoint: 'minimax/h3-max/lip-sync/image-to-video', price: '$0.05 / s', minAudio: 5 },
  { id: 'fal/fabric', provider: 'fal', kind: 'avatar', label: 'VEED Fabric 1.0', blurb: 'Fast talking head at 480p / 720p.', endpoint: 'veed/fabric-1.0', price: '$0.08 / s' },

  // ---- lip-sync an existing video ----
  { id: 'fal/sync-v3', provider: 'fal', kind: 'lipsync', label: 'sync-3 (Sync Labs)', blurb: 'Best mouth realism on real footage; keeps teeth and identity.', endpoint: 'fal-ai/sync-lipsync/v3', price: '$8 / min' },
  { id: 'fal/veed-lipsync', provider: 'fal', kind: 'lipsync', label: 'VEED Lipsync v2', blurb: 'Production lip-sync, cheaper.', endpoint: 'veed/lipsync/v2', price: '≈$0.07 / unit' },

  // ---- translate + re-voice + lip-sync ----
  { id: 'fal/veed-dubbing', provider: 'fal', kind: 'dub', label: 'VEED Dubbing', blurb: 'Translate speech into 86 languages with the speaker’s cloned voice and lip-sync.', endpoint: 'veed/dubbing', price: '$0.11 / input s' },

  // ---- motion control (character image + driving video) ----
  { id: 'apimart/kling-v3-motion-control', provider: 'apimart', kind: 'motion', label: 'Kling 3.0 Motion Control (ApiMart)', blurb: 'Transfers the full performance of a reference video onto your character.', endpoint: 'kling-v3-motion-control' },
  { id: 'apimart/kling-v2-6-motion-control', provider: 'apimart', kind: 'motion', label: 'Kling 2.6 Motion Control (ApiMart)', blurb: 'Previous generation, cheaper.', endpoint: 'kling-v2-6-motion-control' },
  { id: 'fal/kling-v3-motion', provider: 'fal', kind: 'motion', label: 'Kling 3.0 Motion Control Pro (fal)', blurb: 'Same model on fal.', endpoint: 'fal-ai/kling-video/v3/pro/motion-control', price: '$0.168 / s' },

  // ---- video edit / restyle / recast ----
  { id: 'apimart/kling-v3-omni-edit', provider: 'apimart', kind: 'video-edit', label: 'Kling 3.0 Omni Edit (ApiMart)', blurb: 'Instruction edits, swaps and restyles with reference images. 3–10 s clips.', endpoint: 'kling-v3-omni' },
  { id: 'apimart/wan2.7-videoedit', provider: 'apimart', kind: 'video-edit', label: 'Wan 2.7 VideoEdit (ApiMart)', blurb: 'Edits or restyles 2–10 s clips; keeps original audio.', endpoint: 'wan2.7-videoedit' },
  { id: 'fal/kling-v4-edit', provider: 'fal', kind: 'video-edit', label: 'Kling 4.0 Video Edit (fal)', blurb: 'Edits 3–30 s clips at 1080p with image references.', endpoint: 'kling/v4/video-to-video/edit', price: '$0.157 / s' },
  { id: 'fal/kling-o3-edit', provider: 'fal', kind: 'video-edit', label: 'Kling O3 Edit (fal)', blurb: 'Omni edit for 3–15 s clips, keeps audio.', endpoint: 'fal-ai/kling-video/o3/standard/video-to-video/edit', price: '$0.14 / s' },
  { id: 'fal/pixverse-swap', provider: 'fal', kind: 'video-swap', label: 'PixVerse Swap (fal)', blurb: 'Swaps the person, an object or the background in a clip from one photo. Cheapest.', endpoint: 'fal-ai/pixverse/swap', price: '$0.05 / video' },

  // ---- native extension ----
  { id: 'fal/grok-extend', provider: 'fal', kind: 'extend', label: 'Grok Imagine Extend (fal)', blurb: 'Continues any 2–15 s MP4 by 2–10 s.', endpoint: 'xai/grok-imagine-video/extend-video', price: '$0.05 / s' },
  { id: 'fal/flux3-extend', provider: 'fal', kind: 'extend', label: 'FLUX 3 Extend (fal)', blurb: 'Continues a clip up to 20 s with generated audio, up to 4K.', endpoint: 'blackforestlabs/flux-3/extend-video', price: '$0.205 / s' },

  // ---- background removal ----
  { id: 'fal/bria-rmbg', provider: 'fal', kind: 'bg-remove', label: 'Bria RMBG 2.0 (fal)', blurb: 'Clean cut-outs, transparent PNG.', endpoint: 'fal-ai/bria/background/remove', price: '$0.018 / image' },
  { id: 'fal/bria-video-rmbg', provider: 'fal', kind: 'bg-remove-video', label: 'Bria VRMBG 3.0 (fal)', blurb: 'Video background removal with solid colour or alpha.', endpoint: 'bria/video/background-removal/v3', price: '$0.05 / s' },
  { id: 'fal/veed-video-rmbg', provider: 'fal', kind: 'bg-remove-video', label: 'VEED Video BG Removal (fal)', blurb: 'Fast, alpha WebM.', endpoint: 'veed/video-background-removal/fast', price: '$0.008 / 30 frames' },

  // ---- image utilities ----
  { id: 'fal/bria-expand', provider: 'fal', kind: 'expand', label: 'Bria Expand (fal)', blurb: 'Outpaints to a new aspect ratio, keeps original pixels.', endpoint: 'bria/fibo-edit-1.5/expand', price: '$0.04 / image' },
  { id: 'fal/flux2-outpaint', provider: 'fal', kind: 'expand', label: 'FLUX.2 Pro Outpaint (fal)', blurb: 'Highest-fidelity outpainting.', endpoint: 'fal-ai/flux-2-pro/outpaint', price: '$0.03 / MP' },
  { id: 'fal/flux-fill', provider: 'fal', kind: 'inpaint', label: 'FLUX.1 Pro Fill (fal)', blurb: 'Mask inpainting.', endpoint: 'fal-ai/flux-pro/v1/fill', price: '$0.05 / MP' },
  { id: 'apimart/gpt-image-2.6-inpaint', provider: 'apimart', kind: 'inpaint', label: 'GPT Image 2.6 mask edit (ApiMart)', blurb: 'Mask edit that understands complex instructions.', endpoint: 'gpt-image-2.6-flare' },
  { id: 'fal/finegrain-eraser', provider: 'fal', kind: 'erase', label: 'Finegrain Eraser (fal)', blurb: 'Removes objects with their shadows and reflections.', endpoint: 'fal-ai/finegrain-eraser', price: '$0.045 / image' },
  { id: 'fal/bria-relight', provider: 'fal', kind: 'relight', label: 'Bria Relight (fal)', blurb: 'Preset lighting styles and directions.', endpoint: 'bria/fibo-edit/relight', price: '$0.04 / image' },
  { id: 'fal/google-vto', provider: 'fal', kind: 'tryon', label: 'Google Virtual Try-On (fal)', blurb: 'Person + garment photo → try-on.', endpoint: 'google/virtual-try-on', price: '$0.075 / image' },
  { id: 'fal/seedream-layerize', provider: 'fal', kind: 'layers', label: 'Seedream 5.0 Layerize (fal)', blurb: 'Splits an image into transparent PNG layers.', endpoint: 'bytedance/seedream/v5/pro/layerize', price: '$0.034 / image' },

  // ---- sound ----
  { id: 'fal/mirelo-sfx', provider: 'fal', kind: 'sfx-video', label: 'Mirelo SFX 2.0 (fal)', blurb: 'Adds synced sound effects to a video, keeps speech.', endpoint: 'mirelo-ai/sfx2.0/video-to-video', price: '$0.01 / s' },
  { id: 'eleven/sfx', provider: 'eleven', kind: 'sfx', label: 'ElevenLabs Sound Effects', blurb: 'Text → sound effect, up to 30 s.', endpoint: 'sound-generation' },
  { id: 'eleven/music', provider: 'eleven', kind: 'music', label: 'Eleven Music', blurb: 'Text → full song or score.', endpoint: 'music' },
  { id: 'google/lyria-3.5', provider: 'google', kind: 'music', label: 'Lyria 3.5 (Gemini API)', blurb: 'Film score with a clean ending.', endpoint: 'lyria-3.5' },
  { id: 'google-ultra/lyria-3.5', provider: 'google-ultra', kind: 'music', label: 'Lyria 3.5 (AI Ultra plan)', blurb: 'Film score with a clean ending, included with your AI Ultra subscription.', endpoint: 'lyria-3.5' },
];
