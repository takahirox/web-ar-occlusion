import { DEPTH_MODEL_ID, DEPTH_MODEL_REVISION, TRANSFORMERS_JS_VERSION, WebGPUMonocularDepthProvider } from '/depth-webgpu.js';

const profiles = Object.freeze({
  performance: { hz: 8, width: 320, height: 192, maxDepthAgeMs: 250 },
  balanced: { hz: 12, width: 384, height: 224, maxDepthAgeMs: 250 },
  quality: { hz: 18, width: 480, height: 270, maxDepthAgeMs: 200 }
});

const elements = Object.fromEntries([
  'camera', 'gpu', 'stage', 'startScreen', 'start', 'stop', 'status', 'viewControls', 'orientationControls',
  'profileControls', 'profiles', 'fps', 'inference', 'depthAge', 'depthValid',
  'cameraSize', 'viewMode', 'lifecycle', 'provider', 'backend', 'model'
].map((id) => [id, document.getElementById(id)]));

const state = {
  lifecycle: 'idle', stream: null, generation: 0, requested: 'balanced', active: 'balanced',
  view: 'occlusion', previewFlipped: true, device: null, context: null, pipeline: null, uniformBuffer: null,
  bindGroup: null, placeholderDepth: null, depthFrame: null, depthValid: false,
  depthReason: 'no result', provider: null, providerState: 'idle', animation: 0,
  inferenceTimer: 0, inferencePending: false, inferenceRequest: 0, acceptedRequest: 0,
  inferenceCount: 0, inferenceWindowCount: 0, inferenceRate: 0, lastDepthTimestamp: 0,
  profileGeneration: 0, fpsFrames: 0, fps: 0, lastFpsSample: performance.now(),
  cleanup: Promise.resolve()
};

function setLifecycle(value, message = value, error = false) {
  state.lifecycle = value;
  elements.lifecycle.textContent = value;
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
  state.depthValid = false;
}

function fail(message, lifecycle = 'failed') {
  setLifecycle(lifecycle, message, true);
  elements.startScreen.classList.remove('hidden');
  elements.start.textContent = 'Try again';
  elements.start.disabled = false;
  elements.stop.disabled = !state.stream;
  updateTelemetry();
}

function selectButton(container, key, value) {
  for (const button of container.querySelectorAll(`button[data-${key}]`)) {
    button.setAttribute('aria-pressed', String(button.dataset[key] === value));
  }
}

function depthAge(now) {
  return state.lastDepthTimestamp ? Math.max(0, now - state.lastDepthTimestamp) : null;
}

function setDepthInput(texture) {
  if (!state.device || !state.pipeline || !state.uniformBuffer || !texture) return;
  state.bindGroup = state.device.createBindGroup({
    layout: state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: state.uniformBuffer } },
      { binding: 1, resource: texture.createView() }
    ]
  });
}

function invalidateDepth(reason, destroy = true) {
  state.depthValid = false;
  state.depthReason = reason;
  if (state.depthFrame && destroy) state.depthFrame.depth.destroy();
  state.depthFrame = null;
  if (state.placeholderDepth) setDepthInput(state.placeholderDepth);
}

function refreshDepthValidity(now = performance.now()) {
  const age = depthAge(now);
  const valid = state.lifecycle === 'running' && state.provider?.state === 'ready' &&
    state.depthFrame !== null && age !== null && age <= profiles[state.active].maxDepthAgeMs;
  if (!valid && state.depthFrame && age !== null && age > profiles[state.active].maxDepthAgeMs) {
    invalidateDepth('stale');
  } else {
    state.depthValid = valid;
  }
  return state.depthValid;
}

function updateTelemetry(now = performance.now()) {
  const valid = refreshDepthValidity(now);
  elements.provider.textContent = state.providerState;
  elements.profiles.textContent = `${state.requested} / ${state.active}`;
  elements.fps.textContent = state.lifecycle === 'running' ? state.fps.toFixed(1) : '—';
  elements.inference.textContent = `${state.inferenceCount} · ${state.inferenceRate.toFixed(1)} Hz`;
  const age = depthAge(now);
  const stale = age !== null && age > profiles[state.active].maxDepthAgeMs;
  elements.depthAge.textContent = age === null ? '—' : `${Math.round(age)} ms${stale ? ' · stale' : ''}`;
  elements.depthValid.textContent = String(valid);
  elements.cameraSize.textContent = state.stream ? `${elements.camera.videoWidth || 0}×${elements.camera.videoHeight || 0}` : 'off';
  elements.viewMode.textContent = state.view;
  if (state.lifecycle === 'running') {
    elements.status.textContent = valid ? 'Running · real relative depth' : `Running · no valid depth (${state.depthReason})`;
    elements.status.classList.remove('error');
  }
}

function scheduleInference() {
  clearTimeout(state.inferenceTimer);
  if (state.lifecycle !== 'running') return;
  const generation = state.generation;
  state.inferenceTimer = setTimeout(() => {
    if (generation !== state.generation || state.lifecycle !== 'running') return;
    if (!document.hidden && !state.inferencePending) runInference(generation);
    scheduleInference();
  }, 1000 / profiles[state.active].hz);
}

function runInference(generation) {
  const provider = state.provider;
  if (!provider || provider.state !== 'ready' || generation !== state.generation) return;
  let videoFrame;
  const requestId = ++state.inferenceRequest;
  const profileGeneration = state.profileGeneration;
  const timestamp = Math.round(performance.now() * 1000);
  const sourceFrameId = `video-frame:${timestamp}`;
  try {
    videoFrame = new VideoFrame(elements.camera, { timestamp });
  } catch (error) {
    handleInferenceFailure(error, generation);
    return;
  }
  state.inferencePending = true;
  void provider.infer(videoFrame).then((result) => {
    if (generation !== state.generation || profileGeneration !== state.profileGeneration ||
        provider !== state.provider || provider.state !== 'ready' || requestId <= state.acceptedRequest) {
      result.depth.destroy();
      result.confidence?.destroy();
      return;
    }
    if (result.sourceFrameId !== sourceFrameId || result.captureTimestamp !== timestamp / 1000 ||
        result.representation !== 'inverse-z' || result.scale !== 'relative' || result.unit !== null) {
      result.depth.destroy();
      result.confidence?.destroy();
      throw new Error('Depth result did not match its captured source frame or relative-depth contract.');
    }
    result.confidence?.destroy();
    invalidateDepth('superseded');
    state.depthFrame = result;
    state.lastDepthTimestamp = result.captureTimestamp;
    state.acceptedRequest = requestId;
    state.inferenceCount += 1;
    state.inferenceWindowCount += 1;
    state.depthReason = 'valid';
    state.depthValid = true;
    setDepthInput(result.depth);
    updateTelemetry();
  }).catch((error) => {
    if (error?.name !== 'AbortError') handleInferenceFailure(error, generation);
  }).finally(() => {
    videoFrame.close();
    if (generation === state.generation) state.inferencePending = false;
  });
}

function handleInferenceFailure(error, generation) {
  if (generation !== state.generation || state.lifecycle !== 'running') return;
  invalidateDepth('inference failed');
  stopCamera(false);
  fail(`Depth inference failed: ${error?.message || 'unknown error'}`, 'failed');
}

function requestProfile(name) {
  state.requested = name;
  selectButton(elements.profileControls, 'profile', name);
  state.active = name;
  state.profileGeneration += 1;
  state.provider?.abort();
  state.inferenceWindowCount = 0;
  state.lastDepthTimestamp = 0;
  invalidateDepth('profile changed');
  scheduleInference();
  updateTelemetry();
}

const shader = `
struct Values {
  view: f32,
  time: f32,
  aspect: f32,
  depthValid: f32,
  canvasSize: vec2f,
  pad: vec2f
}
@group(0) @binding(0) var<uniform> values: Values;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(positions[index], 0., 1.);
}

fn relativeDepthAt(uv: vec2f) -> f32 {
  let dimensions = vec2i(textureDimensions(depthTexture));
  let coordinate = clamp(vec2i(uv * vec2f(dimensions)), vec2i(0), dimensions - vec2i(1));
  return textureLoad(depthTexture, coordinate, 0).r;
}

@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / values.canvasSize;
  if (values.view > 1.5) {
    if (values.depthValid < .5) { return vec4f(0.); }
    let relativeDepth = relativeDepthAt(uv);
    return vec4f(vec3f(relativeDepth), 1.);
  }
  var p = uv * 2. - 1.;
  p.x *= values.aspect;
  let center = vec2f(.3 * sin(values.time * .55), -.08 + .07 * cos(values.time * .8));
  let local = p - center;
  let radius = .38;
  let radius2 = dot(local, local);
  if (radius2 > radius * radius) { discard; }
  let z = sqrt(radius * radius - radius2);
  let normal = normalize(vec3f(local, z));
  let light = normalize(vec3f(-.45, -.65, .9));
  let diffuse = max(dot(normal, light), 0.);
  let rim = pow(1. - normal.z, 2.6);
  let color = vec3f(.28, .45, 1.) * (.28 + .72 * diffuse) + vec3f(.2, .95, .78) * rim;
  let virtualRelativeDepth = clamp(z / radius, 0., 1.);
  if (values.view < .5 && values.depthValid > .5 && relativeDepthAt(uv) > virtualRelativeDepth) { discard; }
  return vec4f(color, .96);
}`;

async function initializeGpu(generation) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Enable WebGPU in a supported Chrome or Safari release.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU could not find a compatible adapter.');
  const device = await adapter.requestDevice();
  if (generation !== state.generation) { device.destroy(); return false; }
  device.lost.then((info) => {
    if (device !== state.device) return;
    stopCamera(false);
    fail(`WebGPU device lost: ${info.message || info.reason}`, 'device-lost');
  });

  try {
    const context = elements.gpu.getContext('webgpu');
    if (!context) throw new Error('The browser could not create a WebGPU canvas context.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const module = device.createShaderModule({ code: shader });
    const pipelineDescriptor = {
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{
        format,
        blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
      }] },
      primitive: { topology: 'triangle-list' }
    };
    const pipeline = device.createRenderPipelineAsync
      ? await device.createRenderPipelineAsync(pipelineDescriptor)
      : device.createRenderPipeline(pipelineDescriptor);
    if (generation !== state.generation) { device.destroy(); return false; }
    const uniformBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const placeholderDepth = device.createTexture({
      label: 'fail-closed-no-depth',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'r32float',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
    });
    device.queue.writeTexture({ texture: placeholderDepth }, new Float32Array([0]), {}, { width: 1, height: 1, depthOrArrayLayers: 1 });
    context.configure({ device, format, alphaMode: 'premultiplied' });
    Object.assign(state, { device, context, pipeline, uniformBuffer, placeholderDepth });
    setDepthInput(placeholderDepth);
    return true;
  } catch (error) {
    device.destroy();
    throw error;
  }
}

function resizeCanvas() {
  const ratio = Math.min(devicePixelRatio || 1, 3);
  const width = Math.max(1, Math.round(elements.stage.clientWidth * ratio));
  const height = Math.max(1, Math.round(elements.stage.clientHeight * ratio));
  if (elements.gpu.width !== width || elements.gpu.height !== height) {
    elements.gpu.width = width;
    elements.gpu.height = height;
  }
}

function render(now) {
  if (state.lifecycle !== 'running' || document.hidden || !state.device) return;
  resizeCanvas();
  const view = state.view === 'occlusion' ? 0 : state.view === 'none' ? 1 : 2;
  const valid = refreshDepthValidity(now);
  const values = new Float32Array([
    view, now / 1000, elements.gpu.width / elements.gpu.height, valid ? 1 : 0,
    elements.gpu.width, elements.gpu.height, 0, 0
  ]);
  state.device.queue.writeBuffer(state.uniformBuffer, 0, values);
  const encoder = state.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: state.context.getCurrentTexture().createView(),
    clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store'
  }] });
  pass.setPipeline(state.pipeline);
  pass.setBindGroup(0, state.bindGroup);
  pass.draw(3);
  pass.end();
  state.device.queue.submit([encoder.finish()]);

  state.fpsFrames += 1;
  if (now - state.lastFpsSample >= 1000) {
    const seconds = (now - state.lastFpsSample) / 1000;
    state.fps = state.fpsFrames / seconds;
    state.inferenceRate = state.inferenceWindowCount / seconds;
    state.fpsFrames = 0;
    state.inferenceWindowCount = 0;
    state.lastFpsSample = now;
    updateTelemetry(now);
  }
  state.animation = requestAnimationFrame(render);
}

function waitForVideo(generation) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Camera returned no usable video frames.')), 5000);
    const inspect = () => {
      if (generation !== state.generation) { clearTimeout(timeout); reject(new Error('Start cancelled.')); return; }
      if (elements.camera.videoWidth > 0 && elements.camera.videoHeight > 0 && elements.camera.readyState >= 2) {
        clearTimeout(timeout); resolve(); return;
      }
      requestAnimationFrame(inspect);
    };
    inspect();
  });
}

async function startCamera() {
  if (state.lifecycle === 'starting' || state.lifecycle === 'running' || state.lifecycle === 'model-loading') return;
  if (!window.isSecureContext) { fail('A secure context is required. Use the loopback demo URL or HTTPS.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { fail('Camera capture is unavailable in this browser.'); return; }
  if (typeof VideoFrame !== 'function') { fail('VideoFrame camera capture is unavailable in this browser.'); return; }
  const generation = ++state.generation;
  setLifecycle('starting', 'Checking WebGPU…');
  elements.start.disabled = true;
  try {
    await state.cleanup;
    if (generation !== state.generation || !await initializeGpu(generation)) return;
    setLifecycle('awaiting-camera', 'Waiting for camera permission…');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (generation !== state.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    state.stream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (generation !== state.generation || state.lifecycle !== 'running') return;
        stopCamera(false);
        fail('The camera stream ended. Check camera access and try again.', 'camera-ended');
      }, { once: true });
    }
    elements.camera.srcObject = stream;
    await elements.camera.play();
    await waitForVideo(generation);
    state.provider = new WebGPUMonocularDepthProvider({ device: state.device });
    state.providerState = state.provider.state;
    setLifecycle('model-loading', `Loading pinned ${DEPTH_MODEL_ID} on WebGPU…`);
    updateTelemetry();
    await state.provider.initialize();
    if (generation !== state.generation) return;
    state.providerState = state.provider.state;
    state.inferenceCount = 0;
    state.inferenceWindowCount = 0;
    state.inferenceRate = 0;
    state.lastDepthTimestamp = 0;
    state.lastFpsSample = performance.now();
    state.depthReason = 'awaiting first result';
    setLifecycle('running', 'Running · awaiting first real relative-depth result');
    elements.startScreen.classList.add('hidden');
    elements.stop.disabled = false;
    scheduleInference();
    render(performance.now());
  } catch (error) {
    if (generation !== state.generation) return;
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    const loading = state.lifecycle === 'model-loading';
    stopCamera(false);
    fail(denied ? 'Camera permission was denied. Allow camera access and try again.' :
      loading ? `Pinned depth model failed to load: ${error?.message || 'unknown error'}` : error?.message || 'Camera start failed.',
    loading ? 'model-failed' : 'failed');
  }
}

function stopCamera(showScreen = true) {
  state.generation += 1;
  cancelAnimationFrame(state.animation);
  clearTimeout(state.inferenceTimer);
  state.stream?.getTracks().forEach((track) => track.stop());
  elements.camera.pause();
  elements.camera.srcObject = null;

  const provider = state.provider;
  const device = state.device;
  const context = state.context;
  const uniformBuffer = state.uniformBuffer;
  const placeholderDepth = state.placeholderDepth;
  invalidateDepth('stopped');
  provider?.stop();
  context?.unconfigure();
  state.cleanup = Promise.resolve(provider?.dispose()).catch(() => undefined).finally(() => {
    uniformBuffer?.destroy();
    placeholderDepth?.destroy();
    device?.destroy();
  });
  Object.assign(state, {
    stream: null, device: null, context: null, pipeline: null, uniformBuffer: null,
    bindGroup: null, placeholderDepth: null, provider: null, providerState: 'stopped',
    depthFrame: null, depthValid: false, inferencePending: false, lastDepthTimestamp: 0,
    inferenceRate: 0
  });
  if (showScreen) {
    elements.startScreen.classList.remove('hidden');
    elements.start.disabled = false;
    elements.start.textContent = 'Start camera';
    elements.stop.disabled = true;
    setLifecycle('stopped', 'Stopped · camera off');
  }
  updateTelemetry();
}

elements.start.addEventListener('click', startCamera);
elements.stop.addEventListener('click', () => stopCamera());
elements.viewControls.addEventListener('click', ({ target }) => {
  const button = target.closest('button[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  selectButton(elements.viewControls, 'view', state.view);
  updateTelemetry();
});
elements.profileControls.addEventListener('click', ({ target }) => {
  const button = target.closest('button[data-profile]');
  if (button) requestProfile(button.dataset.profile);
});
elements.orientationControls.addEventListener('click', ({ target }) => {
  const button = target.closest('button[data-flip]');
  if (!button) return;
  state.previewFlipped = button.dataset.flip === 'true';
  elements.stage.classList.toggle('flip-x', state.previewFlipped);
  selectButton(elements.orientationControls, 'flip', String(state.previewFlipped));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(state.animation);
    invalidateDepth('page hidden');
    if (state.lifecycle === 'running') elements.status.textContent = 'Paused · page hidden · depth invalid';
  } else if (state.lifecycle === 'running') {
    state.lastFpsSample = performance.now();
    state.fpsFrames = 0;
    updateTelemetry();
    state.animation = requestAnimationFrame(render);
  }
});
window.addEventListener('pagehide', () => stopCamera(false));
window.addEventListener('resize', resizeCanvas);
elements.backend.textContent = `Transformers.js ${TRANSFORMERS_JS_VERSION} · WebGPU`;
elements.model.textContent = `${DEPTH_MODEL_ID}@${DEPTH_MODEL_REVISION}`;
updateTelemetry();
