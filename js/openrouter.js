// openrouter.js — OpenRouter API calls from browser
// D11: AbortController timeout support
// D12: Rate limit (429) detection
// D14: Model-specific error logging

// Models ordered best to worst (all OpenRouter image-generation models)
// modality: 'both' = text+image output, 'image' = image-only output
// cost = approximate $ per image generation
const MODELS = [
  // === Tier 1: Premium ===
  { id: 'gpt-5-image',              route: 'openai/gpt-5-image',                       label: 'GPT-5 Image',                 cost: 0.04,  modality: 'both'  },
  { id: 'riverflow-v2-pro',          route: 'sourceful/riverflow-v2-pro',               label: 'Riverflow V2 Pro',            cost: 0.15,  modality: 'image' },
  { id: 'riverflow-v2-max-preview',  route: 'sourceful/riverflow-v2-max-preview',       label: 'Riverflow V2 Max Preview',    cost: 0.075, modality: 'image' },
  { id: 'flux-2-max',                route: 'black-forest-labs/flux.2-max',             label: 'FLUX.2 Max',                  cost: 0.07,  modality: 'image' },
  { id: 'flux-2-flex',               route: 'black-forest-labs/flux.2-flex',            label: 'FLUX.2 Flex',                 cost: 0.06,  modality: 'image' },
  // === Tier 2: High Quality ===
  { id: 'seedream-4.5',              route: 'bytedance-seed/seedream-4.5',              label: 'Seedream 4.5',                cost: 0.04,  modality: 'image' },
  { id: 'riverflow-v2-standard-preview', route: 'sourceful/riverflow-v2-standard-preview', label: 'Riverflow V2 Standard Preview', cost: 0.035, modality: 'image' },
  { id: 'flux-2-pro',                route: 'black-forest-labs/flux.2-pro',             label: 'FLUX.2 Pro',                  cost: 0.03,  modality: 'image' },
  { id: 'riverflow-v2-fast-preview', route: 'sourceful/riverflow-v2-fast-preview',      label: 'Riverflow V2 Fast Preview',   cost: 0.03,  modality: 'image' },
  { id: 'nano-banana-pro',           route: 'google/gemini-3-pro-image-preview',        label: 'Nano Banana Pro',             cost: 0.01,  modality: 'both'  },
  // === Tier 3: Mid-Range ===
  { id: 'flux-2-klein',              route: 'black-forest-labs/flux.2-klein-4b',        label: 'FLUX.2 Klein',                cost: 0.014, modality: 'image' },
  { id: 'gpt-5-image-mini',          route: 'openai/gpt-5-image-mini',                 label: 'GPT-5 Image Mini',            cost: 0.012, modality: 'both'  },
  // === Tier 4: Budget ===
  { id: 'nano-banana-2',             route: 'google/gemini-3.1-flash-image-preview',    label: 'Nano Banana 2',               cost: 0.006, modality: 'both'  },
  { id: 'riverflow-v2-fast',         route: 'sourceful/riverflow-v2-fast',              label: 'Riverflow V2 Fast',           cost: 0.04,  modality: 'image' },
  { id: 'nano-banana',               route: 'google/gemini-2.5-flash-image',            label: 'Nano Banana',                 cost: 0.003, modality: 'both'  },
];

const MODEL_MAP = {};
const MODEL_COSTS = {};
const MODEL_LABELS = {};
const MODEL_MODALITY = {};
MODELS.forEach(m => {
  MODEL_MAP[m.id] = m.route;
  MODEL_COSTS[m.id] = m.cost;
  MODEL_LABELS[m.id] = m.label;
  MODEL_MODALITY[m.id] = m.modality;
});

// D11: Generate image with AbortController + timeout
// signal: external AbortSignal (from job queue cancel)
// timeoutMs: auto-abort if API takes too long
async function generateImage(prompt, modelId, apiKey, signal, timeoutMs) {
  const model = MODEL_MAP[modelId] || modelId;
  const modality = MODEL_MODALITY[modelId] || 'both';
  const modalities = modality === 'image' ? ['image'] : ['image', 'text'];

  // D11: Compose abort signals — external cancel + timeout
  const controller = new AbortController();
  let timeoutId;

  if (timeoutMs) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  // Forward external signal to our controller
  if (signal) {
    if (signal.aborted) { clearTimeout(timeoutId); throw new DOMException('Aborted', 'AbortError'); }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://alexandria-cover-designer.app',
        'X-Title': 'Alexandria Cover Designer',
      },
      body: JSON.stringify({
        model: model,
        modalities: modalities,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    });

    clearTimeout(timeoutId);

    // D12: Rate limit detection
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      throw new Error(`429 Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      // D14: Log model-specific error
      console.error(`[${modelId}] API error ${resp.status}:`, errText.substring(0, 300));
      throw new Error(`OpenRouter API error ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) {
      // D14: Log full error object
      console.error(`[${modelId}] Response error:`, data.error);
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new DOMException(
        signal?.aborted ? 'Cancelled by user' : `Timed out after ${Math.round((timeoutMs||0)/1000)}s`,
        'AbortError'
      );
    }
    throw e;
  }
}

// Extract image data URL from OpenRouter response
// D14: Enhanced logging when extraction fails
function extractImageFromResponse(data) {
  try {
    const choice = data.choices && data.choices[0];
    if (!choice) {
      console.error('[extractImage] No choices in response:', JSON.stringify(data).substring(0, 300));
      return null;
    }
    const msg = choice.message;
    if (!msg) {
      console.error('[extractImage] No message in choice:', JSON.stringify(choice).substring(0, 300));
      return null;
    }

    // Check for images array on message (OpenRouter standard format)
    if (msg.images && msg.images.length > 0) {
      const img = msg.images[0];
      if (img.image_url && img.image_url.url) return img.image_url.url;
      if (typeof img === 'string') return img;
      if (img.url) return img.url;
    }

    // Check for inline_data in content array
    if (msg.content && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url) {
          return part.image_url.url;
        }
        if (part.type === 'image' && part.image_url) {
          return part.image_url.url;
        }
        if (part.inline_data) {
          return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
      }
    }

    // Check for direct base64 in message content (some models)
    if (typeof msg.content === 'string') {
      const dataUrlMatch = msg.content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
      if (dataUrlMatch) return dataUrlMatch[1];
      
      if (msg.content.match(/^[A-Za-z0-9+/=]{100,}$/)) {
        return `data:image/png;base64,${msg.content}`;
      }
    }

    // D14: Log the structure so we can debug new model formats
    console.error('[extractImage] Could not find image in response. Message keys:', Object.keys(msg),
      'Content type:', typeof msg.content,
      Array.isArray(msg.content) ? `(${msg.content.length} parts: ${msg.content.map(p=>p.type).join(',')})` : '');

    return null;
  } catch (e) {
    console.error('Failed to extract image:', e);
    return null;
  }
}

// Convert data URL to Blob
function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const raw = atob(parts[1]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Convert blob to data URL
function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// Load image from blob or data URL
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (src instanceof Blob) {
      img.src = URL.createObjectURL(src);
    } else {
      img.src = src;
    }
  });
}

window.OpenRouter = {
  MODELS, MODEL_MAP, MODEL_COSTS, MODEL_LABELS, MODEL_MODALITY,
  generateImage, extractImageFromResponse, dataUrlToBlob, blobToDataUrl, loadImage
};