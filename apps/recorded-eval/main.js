const IMPLEMENTATION_KIND = 'web-ar-occlusion-relative-inverse-depth';
const controller = new AbortController();

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dimension(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function bundleUrl(path) {
  requiredString(path, 'RGB source path');
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw new TypeError('RGB source path must be bundle-relative');
  const segments = path.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) throw new TypeError('RGB source path contains an unsafe segment');
  return `/bundle/${segments.map(encodeURIComponent).join('/')}`;
}

export function validateCorpus(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== 'quality-corpus-manifest'
      || value.provenance !== 'recorded-rgbd' || !Array.isArray(value.sources) || value.sources.length === 0
      || !Array.isArray(value.samples) || value.samples.length === 0) {
    throw new TypeError('corpus.json is not a schemaVersion 1 recorded-rgbd quality corpus');
  }
  const sources = new Map();
  for (const [index, source] of value.sources.entries()) {
    if (!object(source) || !object(source.metadata)) throw new TypeError(`source ${index} is malformed`);
    const id = requiredString(source.id, `source ${index} id`);
    if (sources.has(id)) throw new TypeError(`duplicate source ID: ${id}`);
    const path = requiredString(source.metadata.rgbPath, `source ${index} metadata.rgbPath`);
    bundleUrl(path);
    sources.set(id, path);
  }
  const ids = new Set();
  return value.samples.map((sample, index) => {
    if (!object(sample)) throw new TypeError(`sample ${index} is malformed`);
    const sourceFrameId = requiredString(sample.id, `sample ${index} id`);
    if (ids.has(sourceFrameId)) throw new TypeError(`duplicate source frame ID: ${sourceFrameId}`);
    ids.add(sourceFrameId);
    const sourceId = requiredString(sample.sourceId, `sample ${index} sourceId`);
    const path = sources.get(sourceId);
    if (path === undefined) throw new TypeError(`sample ${index} references an unknown source`);
    return Object.freeze({ sourceFrameId, rgbPath: path });
  });
}

export function validateModelDepth(result) {
  if (!object(result) || result.orientation !== 'near-is-larger' || !dimension(result.width) || !dimension(result.height)) {
    throw new TypeError('model returned invalid relative inverse-depth metadata');
  }
  if (!result.data || typeof result.data.length !== 'number' || result.data.length !== result.width * result.height) {
    throw new TypeError('model returned a depth buffer with the wrong size');
  }
  const values = new Float32Array(result.data.length);
  for (let index = 0; index < result.data.length; index += 1) {
    const value = Number(result.data[index]);
    if (!Number.isFinite(value)) throw new TypeError('model depth must contain only finite values');
    values[index] = value;
  }
  return { values, width: result.width, height: result.height };
}

export function nearestResample(values, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!dimension(sourceWidth) || !dimension(sourceHeight) || !dimension(targetWidth) || !dimension(targetHeight)
      || values.length !== sourceWidth * sourceHeight) throw new TypeError('invalid nearest-resample dimensions');
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) return Float32Array.from(values);
  const output = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + .5) * sourceHeight / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + .5) * sourceWidth / targetWidth));
      output[y * targetWidth + x] = values[sourceY * sourceWidth + sourceX];
    }
  }
  return output;
}

const RGB_GUIDED_MEDIAN_RADIUS = 2;
const RGB_GUIDED_MEDIAN_DISTANCE = 24;
const RGB_GUIDED_MEDIAN_DISTANCE_SQUARED = RGB_GUIDED_MEDIAN_DISTANCE ** 2;

export function rgbGuidedMedian5x5(values, rgba, width, height) {
  if (!dimension(width) || !dimension(height) || values?.length !== width * height
      || rgba?.length !== width * height * 4) {
    throw new TypeError('invalid RGB-guided median dimensions');
  }
  const output = new Float32Array(values.length);
  const candidates = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      candidates.length = 0;
      const pixelIndex = y * width + x;
      const centerOffset = pixelIndex * 4;
      const centerRed = rgba[centerOffset];
      const centerGreen = rgba[centerOffset + 1];
      const centerBlue = rgba[centerOffset + 2];
      const minimumY = Math.max(0, y - RGB_GUIDED_MEDIAN_RADIUS);
      const maximumY = Math.min(height - 1, y + RGB_GUIDED_MEDIAN_RADIUS);
      const minimumX = Math.max(0, x - RGB_GUIDED_MEDIAN_RADIUS);
      const maximumX = Math.min(width - 1, x + RGB_GUIDED_MEDIAN_RADIUS);
      for (let neighborY = minimumY; neighborY <= maximumY; neighborY += 1) {
        for (let neighborX = minimumX; neighborX <= maximumX; neighborX += 1) {
          const neighborIndex = neighborY * width + neighborX;
          const neighborOffset = neighborIndex * 4;
          const redDelta = rgba[neighborOffset] - centerRed;
          const greenDelta = rgba[neighborOffset + 1] - centerGreen;
          const blueDelta = rgba[neighborOffset + 2] - centerBlue;
          if (redDelta ** 2 + greenDelta ** 2 + blueDelta ** 2 <= RGB_GUIDED_MEDIAN_DISTANCE_SQUARED) {
            candidates.push(values[neighborIndex]);
          }
        }
      }
      candidates.sort((left, right) => left - right);
      output[pixelIndex] = candidates[(candidates.length - 1) >> 1];
    }
  }
  return output;
}

export function createPredictionDocument(frames, implementationId, evaluatedAt = new Date().toISOString()) {
  requiredString(implementationId, 'implementationId');
  if (!Array.isArray(frames) || frames.length === 0) throw new TypeError('at least one prediction frame is required');
  return {
    schemaVersion: 1,
    kind: IMPLEMENTATION_KIND,
    evaluatedAt,
    implementationId,
    frames: frames.map((frame) => ({
      id: requiredString(frame.sourceFrameId, 'prediction sourceFrameId'),
      width: frame.width,
      height: frame.height,
      inverseDepth: Array.from(frame.relativeInverseDepth),
    })),
  };
}

function setStatus(message, state = 'loading') {
  const status = document.querySelector('#status');
  status.textContent = message;
  status.dataset.state = state;
}

async function fetchCorpus(signal) {
  const response = await fetch('/bundle/corpus.json', { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`corpus.json request failed (${response.status})`);
  if (!response.headers.get('content-type')?.startsWith('application/json')) throw new TypeError('corpus.json has the wrong MIME type');
  return validateCorpus(await response.json());
}

async function captureRgb(frame, signal) {
  const response = await fetch(bundleUrl(frame.rgbPath), { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`RGB request failed for ${frame.sourceFrameId} (${response.status})`);
  if (!/^image\/(png|jpeg)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new TypeError(`RGB source has the wrong MIME type: ${frame.sourceFrameId}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable');
    context.imageSmoothingEnabled = false;
    context.globalCompositeOperation = 'copy';
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    if (image.data.length !== bitmap.width * bitmap.height * 4) throw new TypeError('RGBA capture has the wrong size');
    return { pixels: new Uint8ClampedArray(image.data), image, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function normalizedPreview(values) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  const pixels = new Uint8ClampedArray(values.length * 4);
  const range = maximum - minimum;
  for (let index = 0; index < values.length; index += 1) {
    const shade = range === 0 ? 255 : Math.round(255 * (values[index] - minimum) / range);
    pixels[index * 4] = shade;
    pixels[index * 4 + 1] = shade;
    pixels[index * 4 + 2] = shade;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

function addPreview(frame, rgb, values) {
  const article = document.createElement('article');
  const title = document.createElement('h2');
  title.textContent = `${frame.sourceFrameId} — ${frame.width}×${frame.height}`;
  const pair = document.createElement('div');
  pair.className = 'pair';
  for (const [caption, render] of [
    ['Exact RGB source', (context) => context.putImageData(rgb, 0, 0)],
    ['Normalized near-is-lighter preview', (context) => context.putImageData(new ImageData(normalizedPreview(values), frame.width, frame.height), 0, 0)],
  ]) {
    const figure = document.createElement('figure');
    const label = document.createElement('figcaption');
    const canvas = document.createElement('canvas');
    label.textContent = caption;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D preview canvas is unavailable');
    render(context);
    figure.append(label, canvas);
    pair.append(figure);
  }
  article.append(title, pair);
  document.querySelector('#previews').append(article);
}

function enableDownload(documentValue) {
  const button = document.querySelector('#download');
  button.disabled = false;
  button.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(documentValue, null, 2)}\n`], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'recorded-relative-inverse-depth.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, { once: true });
}

async function run() {
  globalThis.__recordedEvalResult = undefined;
  let runtime;
  let estimator;
  try {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable');
    const module = await import('/depth-webgpu.js');
    const implementationId = `transformers.js@${module.TRANSFORMERS_JS_VERSION}:${module.DEPTH_MODEL_ID}@${module.DEPTH_MODEL_REVISION}:webgpu:${module.DEPTH_MODEL_DTYPE}:rgb-guided-lower-median:r2:rgb-euclidean24`;
    document.querySelector('#runtime').textContent = `Pinned model ${module.DEPTH_MODEL_ID} · revision ${module.DEPTH_MODEL_REVISION} · Transformers.js ${module.TRANSFORMERS_JS_VERSION} · WebGPU · ${module.DEPTH_MODEL_DTYPE}`;
    const corpus = await fetchCorpus(controller.signal);
    runtime = module.createTransformersDepthRuntime();
    setStatus(`Initializing ${module.DEPTH_MODEL_ID} on WebGPU…`);
    estimator = await runtime.createEstimator({
      model: module.DEPTH_MODEL_ID,
      revision: module.DEPTH_MODEL_REVISION,
      device: 'webgpu',
      dtype: module.DEPTH_MODEL_DTYPE,
    });
    const predictions = [];
    for (let index = 0; index < corpus.length; index += 1) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const frame = corpus[index];
      setStatus(`Frame ${index + 1}/${corpus.length}: loading RGB for ${frame.sourceFrameId}…`);
      const capture = await captureRgb(frame, controller.signal);
      setStatus(`Frame ${index + 1}/${corpus.length}: inferring ${frame.sourceFrameId}…`);
      const raw = validateModelDepth(await estimator.infer({ data: capture.pixels, width: capture.width, height: capture.height }, { signal: controller.signal }));
      const resampled = nearestResample(raw.values, raw.width, raw.height, capture.width, capture.height);
      const values = rgbGuidedMedian5x5(resampled, capture.pixels, capture.width, capture.height);
      const resolvedFrame = { ...frame, width: capture.width, height: capture.height };
      addPreview(resolvedFrame, capture.image, values);
      predictions.push({ sourceFrameId: frame.sourceFrameId, width: capture.width, height: capture.height, relativeInverseDepth: values });
    }
    await estimator.dispose?.();
    estimator = undefined;
    await runtime.dispose?.();
    runtime = undefined;
    const result = createPredictionDocument(predictions, implementationId);
    globalThis.__recordedEvalResult = result;
    enableDownload(result);
    setStatus(`Complete: ${predictions.length} sequential frame predictions. Development observation only; no benchmark result.`, 'complete');
  } catch (error) {
    globalThis.__recordedEvalResult = undefined;
    try { await estimator?.dispose?.(); } catch {}
    try { await runtime?.dispose?.(); } catch {}
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    setStatus(`Failed closed: ${message}`, 'error');
  }
}

if (typeof document !== 'undefined') {
  addEventListener('beforeunload', () => controller.abort(new DOMException('Page closed', 'AbortError')), { once: true });
  void run();
}
