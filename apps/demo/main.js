const profiles = Object.freeze({
  performance: { hz: 8, width: 320, height: 192, maxDepthAgeMs: 250 },
  balanced: { hz: 12, width: 384, height: 224, maxDepthAgeMs: 250 },
  quality: { hz: 18, width: 480, height: 270, maxDepthAgeMs: 200 }
});

const elements = Object.fromEntries([
  'camera', 'gpu', 'stage', 'startScreen', 'start', 'stop', 'status', 'viewControls',
  'profileControls', 'profiles', 'fps', 'inference', 'depthAge', 'cameraSize',
  'viewMode', 'lifecycle'
].map((id) => [id, document.getElementById(id)]));

const state = {
  lifecycle: 'idle', stream: null, generation: 0, requested: 'balanced', active: 'balanced',
  view: 'occlusion', device: null, context: null, pipeline: null, uniformBuffer: null,
  bindGroup: null, animation: 0, inferenceTimer: 0, inferenceCount: 0,
  inferenceWindowCount: 0, inferenceRate: 0, lastInference: 0, boundary: 0.52,
  fpsFrames: 0, fps: 0, lastFpsSample: performance.now()
};

function setLifecycle(value, message = value, error = false) {
  state.lifecycle = value;
  elements.lifecycle.textContent = value;
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
}

function fail(message) {
  setLifecycle('error', message, true);
  elements.startScreen.classList.remove('hidden');
  elements.start.textContent = 'Try again';
  elements.start.disabled = false;
  elements.stop.disabled = !state.stream;
}

function selectButton(container, key, value) {
  for (const button of container.querySelectorAll(`button[data-${key}]`)) {
    button.setAttribute('aria-pressed', String(button.dataset[key] === value));
  }
}

function updateTelemetry(now = performance.now()) {
  elements.profiles.textContent = `${state.requested} / ${state.active}`;
  elements.fps.textContent = state.lifecycle === 'running' ? state.fps.toFixed(1) : '—';
  elements.inference.textContent = `${state.inferenceCount} · ${state.inferenceRate.toFixed(1)} Hz`;
  const depthAge = state.lastInference ? Math.round(now - state.lastInference) : null;
  const stale = depthAge !== null && depthAge > profiles[state.active].maxDepthAgeMs;
  elements.depthAge.textContent = depthAge === null ? '—' : `${depthAge} ms${stale ? ' · stale' : ''}`;
  elements.cameraSize.textContent = state.stream ? `${elements.camera.videoWidth || 0}×${elements.camera.videoHeight || 0}` : 'off';
  elements.viewMode.textContent = state.view;
}

function scheduleInference() {
  clearTimeout(state.inferenceTimer);
  if (state.lifecycle !== 'running') return;
  const profile = profiles[state.active];
  state.inferenceTimer = setTimeout(() => {
    if (state.lifecycle !== 'running') return;
    state.inferenceCount += 1;
    state.inferenceWindowCount += 1;
    state.lastInference = performance.now();
    state.boundary = 0.5 + Math.sin(state.inferenceCount * 0.23) * 0.16;
    scheduleInference();
  }, 1000 / profile.hz);
}

function requestProfile(name) {
  state.requested = name;
  selectButton(elements.profileControls, 'profile', name);
  state.active = name;
  state.inferenceWindowCount = 0;
  state.lastInference = 0;
  scheduleInference();
  updateTelemetry();
}

const shader = `
struct Values { view: f32, time: f32, boundary: f32, aspect: f32, pad: vec4f }
@group(0) @binding(0) var<uniform> values: Values;

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(positions[index], 0., 1.);
}

@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions_placeholder);
  let uv = position.xy / size;
  let foreground = uv.y > values.boundary + .055 * sin(uv.x * 15. + values.time * .7);
  if (values.view > 1.5) {
    if (foreground) { return vec4f(.05, .92, .66, .52); }
    return vec4f(0.);
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
  let virtualDepth = 1.35 - z;
  let fakeMetricDepth = select(2.4, .72, foreground);
  if (values.view < .5 && virtualDepth > fakeMetricDepth) { discard; }
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
    fail(`WebGPU device lost: ${info.message || info.reason}`);
  });

  try {
    const context = elements.gpu.getContext('webgpu');
    if (!context) throw new Error('The browser could not create a WebGPU canvas context.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const module = device.createShaderModule({ code: shader.replace('textureDimensions_placeholder', 'f32(values.pad.x), f32(values.pad.y)') });
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
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
    });
    context.configure({ device, format, alphaMode: 'premultiplied' });
    Object.assign(state, { device, context, pipeline, uniformBuffer, bindGroup });
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
  const values = new Float32Array([view, now / 1000, state.boundary, elements.gpu.width / elements.gpu.height, elements.gpu.width, elements.gpu.height, 0, 0]);
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
  if (state.lifecycle === 'starting' || state.lifecycle === 'running') return;
  if (!window.isSecureContext) { fail('A secure context is required. Use the loopback demo URL or HTTPS.'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { fail('Camera capture is unavailable in this browser.'); return; }
  const generation = ++state.generation;
  setLifecycle('starting', 'Checking WebGPU…');
  elements.start.disabled = true;
  try {
    if (!await initializeGpu(generation)) return;
    setLifecycle('starting', 'Waiting for camera permission…');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (generation !== state.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    state.stream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (generation !== state.generation || state.lifecycle !== 'running') return;
        stopCamera(false);
        fail('The camera stream ended. Check camera access and try again.');
      }, { once: true });
    }
    elements.camera.srcObject = stream;
    await elements.camera.play();
    await waitForVideo(generation);
    state.inferenceCount = 0;
    state.inferenceWindowCount = 0;
    state.inferenceRate = 0;
    state.lastInference = 0;
    state.lastFpsSample = performance.now();
    setLifecycle('running', 'Running · synthetic depth');
    elements.startScreen.classList.add('hidden');
    elements.stop.disabled = false;
    scheduleInference();
    render(performance.now());
  } catch (error) {
    if (generation !== state.generation) return;
    stopCamera(false);
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    fail(denied ? 'Camera permission was denied. Allow camera access and try again.' : error.message || 'Camera start failed.');
  }
}

function stopCamera(showScreen = true) {
  state.generation += 1;
  cancelAnimationFrame(state.animation);
  clearTimeout(state.inferenceTimer);
  state.stream?.getTracks().forEach((track) => track.stop());
  state.device?.destroy();
  elements.camera.pause();
  elements.camera.srcObject = null;
  Object.assign(state, { stream: null, device: null, context: null, pipeline: null, uniformBuffer: null, bindGroup: null, lastInference: 0, inferenceRate: 0 });
  if (showScreen) elements.startScreen.classList.remove('hidden');
  elements.start.disabled = false;
  elements.start.textContent = 'Start camera';
  elements.stop.disabled = true;
  setLifecycle('idle', 'Idle · camera off');
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(state.animation);
    if (state.lifecycle === 'running') elements.status.textContent = 'Paused · page hidden';
  } else if (state.lifecycle === 'running') {
    state.lastFpsSample = performance.now();
    state.fpsFrames = 0;
    elements.status.textContent = 'Running · synthetic depth';
    state.animation = requestAnimationFrame(render);
  }
});
window.addEventListener('pagehide', () => stopCamera(false));
window.addEventListener('resize', resizeCanvas);
updateTelemetry();
