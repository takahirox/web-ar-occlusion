import {
  DEPTH_MODEL_DTYPE,
  DEPTH_MODEL_ID,
  DEPTH_MODEL_REVISION,
  METRIC_DEPTH_MODEL_ID,
  METRIC_DEPTH_MODEL_REVISION,
  ONNX_RUNTIME_WEB_VERSION,
  TRANSFORMERS_JS_VERSION,
  createTransformersDepthRuntime,
  WebGPUMonocularDepthProvider
} from '/depth-webgpu.js';
import {
  applyKnownPlaneCalibration,
  captureKnownPlaneAnchor,
  fitKnownPlaneCalibration
} from '/metric-calibration.js';
import {
  createMetricDistanceState,
  reduceMetricDistanceState
} from '/metric-distance-state.js';
import {
  createMetricScaleShiftRefinerState,
  refineMetricScaleShift,
  resetMetricScaleShiftRefinerState
} from '/metric-scale-shift-refiner.js';
import {
  DIAGNOSTIC_RELATIVE_DEPTH_CEILING,
  DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM,
  sampleMetricDepthProbe,
  trackMetricDepthSurface,
  updateMetricCrossingMask
} from './occlusion.js';

const profiles = Object.freeze({
  performance: { hz: 8, width: 320, height: 192, maxDepthAgeMs: 250 },
  balanced: { hz: 12, width: 384, height: 224, maxDepthAgeMs: 250 },
  quality: { hz: 18, width: 480, height: 270, maxDepthAgeMs: 200 }
});

const elements = Object.fromEntries([
  'camera', 'gpu', 'stage', 'startScreen', 'start', 'stop', 'status', 'viewControls', 'orientationControls',
  'modeControls', 'anchorDistance', 'captureAnchor', 'clearCalibration', 'virtualZ', 'entryHysteresis',
  'exitHysteresis', 'probeOverlay', 'probeControls', 'clearProbes', 'probeStatus', 'depthMode',
  'calibrationStatus', 'metricRuntimeStatus', 'metricSourceStatus', 'profileControls', 'profiles', 'fps', 'inference',
  'depthAge', 'depthValid', 'cameraSize', 'viewMode', 'lifecycle', 'provider', 'backend', 'model'
].map((id) => [id, document.getElementById(id)]));

const state = {
  lifecycle: 'idle', stream: null, generation: 0, requested: 'balanced', active: 'balanced',
  view: 'occlusion', mode: 'metric', previewFlipped: true, device: null, context: null, pipeline: null,
  uniformBuffer: null, bindGroup: null, placeholderDepth: null, depthFrame: null, depthValid: false,
  depthReason: 'no result', provider: null, providerState: 'idle', animation: 0, sourceId: null,
  providerKind: 'native-metric', nativeFailureReason: null,
  inferenceTimer: 0, inferencePending: false, inferenceRequest: 0, acceptedRequest: 0,
  inferenceCount: 0, inferenceWindowCount: 0, inferenceRate: 0, lastDepthTimestamp: 0,
  profileGeneration: 0, fpsFrames: 0, fps: 0, lastFpsSample: performance.now(),
  anchors: [], anchorSequence: 0, pendingAnchorDistance: null, calibrationModel: null,
  calibrationReason: 'relative-only', metricTexture: null, metricMask: null,
  metricLinearZ: null, metricValidity: null, metricSourceFrameId: null, metricCaptureTimestamp: null,
  metricProvenance: null,
  metricRefinerState: createMetricScaleShiftRefinerState(), metricRefinement: null,
  probesEnabled: false, probes: [], probeSequence: 0,
  cleanup: Promise.resolve()
};

const MAX_DISTANCE_PROBES = 6;
const PROBE_ROI_RADIUS = 2;
const PROBE_SEARCH_RATIO = 0.06;
const PROBE_MINIMUM_DEPTH_TOLERANCE_METERS = 0.12;
const PROBE_DEPTH_TOLERANCE_RATIO = 0.12;

const METRIC_STATUS_LABELS = Object.freeze({
  starting: 'starting',
  unavailable: 'unavailable',
  approximate: 'approximate',
  refining: 'refining',
  stable: 'stable'
});
const METRIC_GUIDANCE_LABELS = Object.freeze({
  'acquire-target': 'acquire target',
  'keep-target-framed': 'keep target framed',
  'move-slowly-side-to-side': 'move slowly side to side',
  'hold-steady-when-noisy': 'hold steady while readings are noisy',
  'stable-repeatability-accuracy-unverified': 'repeatability stable; accuracy unverified'
});
const REFINEMENT_GUIDANCE_LABELS = Object.freeze({
  'collecting-temporal-evidence': 'collecting temporal evidence',
  'passive-refinement-active': 'passive temporal alignment active; absolute accuracy unverified',
  'temporally-stable-not-ground-truth': 'temporally stable; absolute accuracy unverified',
  'using-unrefined-native-prior': 'move the camera slowly side to side'
});

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

function metricGuidanceText(metricState) {
  if (metricState.unavailableReason === 'tracking-lost') return 'tracking lost · no stale value';
  if (metricState.unavailableReason === 'stale-result') return 'result stale · acquire a fresh target';
  if (metricState.unavailableReason === 'calibration-lost') return 'metric evidence unavailable';
  if (metricState.unavailableReason === 'provider-failure') return 'depth provider unavailable';
  return METRIC_GUIDANCE_LABELS[metricState.guidance];
}

function metricResultAvailable() {
  return state.metricTexture !== null &&
    state.metricLinearZ !== null &&
    state.metricValidity !== null &&
    state.metricProvenance !== null &&
    state.metricSourceFrameId === state.depthFrame?.sourceFrameId &&
    state.metricCaptureTimestamp === state.depthFrame?.captureTimestamp;
}

function renderDistanceProbes() {
  const metricReady = metricResultAvailable();
  const onButton = elements.probeControls.querySelector('button[data-probes="on"]');
  onButton.disabled = !metricReady;
  onButton.title = metricReady ? 'Click an object to attach and track an approximate distance label.' : 'A source-associated metric result is required before meters can be displayed.';
  elements.clearProbes.disabled = state.probes.length === 0;
  elements.stage.classList.toggle('probes-enabled', state.probesEnabled && metricReady);
  elements.probeStatus.textContent = state.probesEnabled
    ? `${state.probes.length} tracked object${state.probes.length === 1 ? '' : 's'} · ${metricReady ? 'click image to add' : 'metric unavailable'}`
    : `off · ${metricReady ? `${state.metricProvenance} ready` : 'metric result required'}`;
  elements.probeOverlay.replaceChildren();
  if (!state.probesEnabled) return;

  for (const probe of state.probes) {
    const metricState = probe.metricState;
    const displayDepthMeters = metricState.displayDepthMeters;
    const label = document.createElement('div');
    label.className = `probe-label${displayDepthMeters === null ? ' invalid' : ''}`;
    label.style.left = `${probe.x * 100}%`;
    label.style.top = `${probe.y * 100}%`;
    const value = document.createElement('strong');
    const detail = document.createElement('small');
    value.textContent = displayDepthMeters === null ? `P${probe.id} —` : `≈ ${displayDepthMeters.toFixed(2)} m`;
    detail.textContent = `P${probe.id} · ${METRIC_STATUS_LABELS[metricState.status]} · temporal repeatability ${Math.round(metricState.temporalRepeatability * 100)}% · ${metricGuidanceText(metricState)}`;
    label.append(value, detail);
    elements.probeOverlay.append(label);
  }
}

function invalidateProbeMetricStates(type) {
  for (const probe of state.probes) {
    probe.metricState = reduceMetricDistanceState(probe.metricState, { type });
    probe.targetDepth = null;
    probe.lostFrames = 0;
  }
  renderDistanceProbes();
}

function recreateProbeMetricStates(sourceId) {
  for (const probe of state.probes) {
    probe.metricState = createMetricDistanceState(sourceId);
    probe.targetDepth = null;
    probe.lostFrames = 0;
  }
  renderDistanceProbes();
}

function updateDistanceProbeMeasurement(probe, linearZ, validity, width, height, result) {
  let depthX = state.previewFlipped ? 1 - probe.x : probe.x;
  if (probe.targetDepth !== null) {
    const searchRadius = Math.max(8, Math.round(Math.min(width, height) * PROBE_SEARCH_RATIO));
    const maximumDepthDeltaMeters = Math.max(PROBE_MINIMUM_DEPTH_TOLERANCE_METERS, probe.targetDepth * PROBE_DEPTH_TOLERANCE_RATIO);
    const tracking = trackMetricDepthSurface(linearZ, validity, width, height, depthX, probe.y, probe.targetDepth, searchRadius, maximumDepthDeltaMeters);
    if (!tracking.valid) {
      probe.metricState = reduceMetricDistanceState(probe.metricState, { type: 'tracking-lost' });
      probe.targetDepth = null;
      probe.lostFrames += 1;
      return;
    }
    depthX = tracking.normalizedX;
    probe.x = state.previewFlipped ? 1 - tracking.normalizedX : tracking.normalizedX;
    probe.y = tracking.normalizedY;
  }
  const sample = sampleMetricDepthProbe(linearZ, validity, width, height, depthX, probe.y, PROBE_ROI_RADIUS);
  if (!sample.valid) {
    probe.metricState = reduceMetricDistanceState(probe.metricState, { type: 'tracking-lost' });
    probe.targetDepth = null;
    probe.lostFrames += 1;
    return;
  }
  probe.targetDepth = sample.depthMeters;
  probe.lostFrames = 0;
  probe.metricState = reduceMetricDistanceState(probe.metricState, {
    type: 'observation',
    observation: {
      sourceId: state.sourceId,
      sourceFrameId: result.sourceFrameId,
      captureTimestamp: result.captureTimestamp,
      depthMeters: sample.depthMeters,
      normalizedX: depthX,
      provenance: state.metricProvenance ?? 'manual-known-plane'
    }
  });
}

function updateDistanceProbeMeasurements(linearZ, validity, width, height, result) {
  for (const probe of state.probes) updateDistanceProbeMeasurement(probe, linearZ, validity, width, height, result);
  renderDistanceProbes();
}

function addDistanceProbe(x, y) {
  if (!state.sourceId) return;
  if (state.probes.length >= MAX_DISTANCE_PROBES) state.probes.shift();
  const probe = { id: ++state.probeSequence, x, y, metricState: createMetricDistanceState(state.sourceId), targetDepth: null, lostFrames: 0 };
  state.probes.push(probe);
  if (state.metricLinearZ && state.metricValidity && state.depthFrame) {
    updateDistanceProbeMeasurement(probe, state.metricLinearZ, state.metricValidity, state.depthFrame.width, state.depthFrame.height, state.depthFrame);
  }
  renderDistanceProbes();
}

function setDistanceProbesEnabled(enabled) {
  state.probesEnabled = enabled && metricResultAvailable();
  selectButton(elements.probeControls, 'probes', state.probesEnabled ? 'on' : 'off');
  renderDistanceProbes();
}

function clearMetricMask(reason, invalidationType = 'calibration-lost') {
  state.metricTexture?.destroy();
  state.metricTexture = null;
  state.metricMask = null;
  state.metricLinearZ = null;
  state.metricValidity = null;
  state.metricSourceFrameId = null;
  state.metricCaptureTimestamp = null;
  state.metricProvenance = null;
  state.metricRefinerState = resetMetricScaleShiftRefinerState();
  state.metricRefinement = null;
  invalidateProbeMetricStates(invalidationType);
  if (state.mode === 'metric' && state.placeholderDepth) setDepthInput(state.placeholderDepth);
  if (reason) state.depthReason = reason;
}

function clearMetricCalibration(reason = 'cleared') {
  clearMetricMask(reason, 'calibration-lost');
  state.anchors = [];
  state.pendingAnchorDistance = null;
  state.calibrationModel = null;
  state.calibrationReason = reason;
}

function supersedeDepth() {
  state.depthFrame?.depth.destroy();
  state.depthFrame = null;
  state.metricTexture?.destroy();
  state.metricTexture = null;
  state.metricLinearZ = null;
  state.metricValidity = null;
  state.metricSourceFrameId = null;
  state.metricCaptureTimestamp = null;
}

function updateCalibrationControls() {
  const metricReady = metricResultAvailable();
  const nativeActive = state.metricProvenance === 'native-metric';
  const metricButton = elements.modeControls.querySelector('button[data-mode="metric"]');
  metricButton.disabled = !metricReady;
  metricButton.title = metricReady ? '' : 'Awaiting a source-associated native metric result or manual fallback.';
  elements.captureAnchor.disabled = nativeActive || state.lifecycle !== 'running' || state.provider?.state !== 'ready' || state.pendingAnchorDistance !== null;
  elements.depthMode.textContent = state.mode === 'metric'
    ? (nativeActive ? 'native model meters' : 'manual calibration estimated meters')
    : 'relative unitless';
  elements.calibrationStatus.textContent = nativeActive
    ? 'native metric active · manual fallback idle'
    : (state.calibrationModel ? `manual fallback valid · ${state.anchors.length} anchors · RMSE ${state.calibrationModel.inverseDepthRmse.toFixed(4)} 1/m` : `${state.calibrationReason} · ${state.anchors.length} anchors`);
  renderDistanceProbes();
}
function metricEvidence(result) { return { sourceId: state.sourceId, sourceFrameId: result.sourceFrameId, captureTimestamp: result.captureTimestamp, rawInverseDepth: result.rawInverseDepth, width: result.width, height: result.height }; }
function numericControl(element, minimum, maximum, label) { const value = Number(element.value); if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} is outside its allowed range.`); return value; }
function uploadMetricMask(mask, width, height) { const bytesPerRow = Math.ceil(width / 256) * 256; const padded = new Uint8Array(bytesPerRow * height); for (let row = 0; row < height; row += 1) padded.set(mask.subarray(row * width, (row + 1) * width), row * bytesPerRow); const texture = state.device.createTexture({ label: 'metric-crossing-mask', size: { width, height, depthOrArrayLayers: 1 }, format: 'r8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING }); try { state.device.queue.writeTexture({ texture }, padded, { bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 }); return texture; } catch (error) { texture.destroy(); throw error; } }
function applyMetricBuffers(result, linearZ, validity, provenance) {
  const previousProvenance = state.metricProvenance;
  const mask = updateMetricCrossingMask(
    state.metricMask,
    linearZ,
    validity,
    numericControl(elements.virtualZ, 0.1, 20, 'Virtual Z'),
    numericControl(elements.entryHysteresis, 0, 1, 'Entry hysteresis'),
    numericControl(elements.exitHysteresis, 0, 1, 'Exit hysteresis')
  );
  const texture = uploadMetricMask(mask, result.width, result.height);
  state.metricTexture?.destroy();
  Object.assign(state, {
    metricTexture: texture,
    metricMask: mask,
    metricLinearZ: linearZ,
    metricValidity: validity,
    metricSourceFrameId: result.sourceFrameId,
    metricCaptureTimestamp: result.captureTimestamp,
    metricProvenance: provenance
  });
  if (previousProvenance !== null && previousProvenance !== provenance) {
    recreateProbeMetricStates(state.sourceId);
  }
  updateDistanceProbeMeasurements(linearZ, validity, result.width, result.height, result);
}

function validatedNativeMetric(result) {
  const nativeMetric = result.nativeMetric;
  if (!(nativeMetric.linearZMeters instanceof Float32Array) ||
      !(nativeMetric.validity instanceof Uint8Array) ||
      nativeMetric.representation !== 'linear-z' || nativeMetric.scale !== 'metric' || nativeMetric.unit !== 'meter' ||
      nativeMetric.sourceFrameId !== result.sourceFrameId || nativeMetric.captureTimestamp !== result.captureTimestamp ||
      nativeMetric.width !== result.width || nativeMetric.height !== result.height ||
      nativeMetric.linearZMeters.length !== result.width * result.height ||
      nativeMetric.validity.length !== result.width * result.height) {
    throw new TypeError('Native metric evidence did not match its captured source frame contract.');
  }
  let validSamples = 0;
  for (let index = 0; index < nativeMetric.validity.length; index += 1) {
    if (nativeMetric.validity[index] === 1 &&
        Number.isFinite(nativeMetric.linearZMeters[index]) &&
        nativeMetric.linearZMeters[index] > 0) validSamples += 1;
  }
  if (validSamples === 0) throw new RangeError('Native metric evidence contained no valid samples.');
  return nativeMetric;
}

function updateMetricResult(result) {
  if (result.nativeMetric !== undefined) {
    state.pendingAnchorDistance = null;
    try {
      const nativeMetric = validatedNativeMetric(result);
      const refinement = refineMetricScaleShift(state.metricRefinerState, {
        sourceId: state.sourceId,
        sourceFrameId: result.sourceFrameId,
        captureTimestamp: result.captureTimestamp,
        width: result.width,
        height: result.height,
        linearZ: nativeMetric.linearZMeters,
        validity: nativeMetric.validity
      });
      state.metricRefinerState = refinement.state;
      state.metricRefinement = refinement.output.diagnostics;
      applyMetricBuffers(
        result,
        refinement.output.linearZ,
        refinement.output.validity,
        'native-metric'
      );
      state.calibrationReason = 'native-metric-active';
    } catch (error) {
      clearMetricMask(error?.message || 'native-metric-rejected', 'provider-failure');
    }
    return;
  }

  const frame = metricEvidence(result);
  state.metricRefinerState = resetMetricScaleShiftRefinerState();
  state.metricRefinement = null;
  if (state.pendingAnchorDistance !== null) {
    const distanceMeters = state.pendingAnchorDistance;
    state.pendingAnchorDistance = null;
    try {
      const anchor = captureKnownPlaneAnchor({
        id: `anchor-${++state.anchorSequence}`,
        frame,
        expectedSourceFrameId: result.sourceFrameId,
        expectedCaptureTimestamp: result.captureTimestamp,
        x: Math.floor(result.width / 2),
        y: Math.floor(result.height / 2),
        radius: 2,
        distanceMeters
      });
      state.anchors.push(anchor);
      const distinctDistances = new Set(state.anchors.map((item) => item.distanceMeters)).size;
      const distinctRaw = new Set(state.anchors.map((item) => item.rawInverseDepth)).size;
      if (distinctDistances < 2 || distinctRaw < 2) {
        state.calibrationModel = null;
        state.calibrationReason = 'distinct-distance-and-raw-anchors-required';
        invalidateProbeMetricStates('calibration-lost');
      } else {
        const fit = fitKnownPlaneCalibration(state.anchors, { nowTimestamp: result.captureTimestamp });
        state.calibrationModel = fit.valid ? fit.model : null;
        state.calibrationReason = fit.valid ? 'calibrated' : fit.reason;
        if (!fit.valid) invalidateProbeMetricStates('calibration-lost');
      }
    } catch (error) {
      state.calibrationModel = null;
      state.calibrationReason = error?.message || 'anchor-rejected';
      invalidateProbeMetricStates('calibration-lost');
    }
    return;
  }
  if (!state.calibrationModel) return;
  const application = applyKnownPlaneCalibration(frame, state.calibrationModel, performance.now());
  if (!application.usable) {
    clearMetricCalibration(application.reason);
    return;
  }
  if (application.sourceId !== state.sourceId || application.sourceFrameId !== result.sourceFrameId ||
      application.captureTimestamp !== result.captureTimestamp || application.representation !== 'linear-z' ||
      application.scale !== 'metric' || application.unit !== 'meter') {
    clearMetricCalibration('metric-source-association-mismatch');
    return;
  }
  try {
    applyMetricBuffers(
      result,
      application.linearZ,
      application.validity,
      'manual-known-plane'
    );
  } catch (error) {
    clearMetricMask(error?.message || 'metric-mask-rejected');
  }
}

function invalidateDepth(reason, destroy = true, metricInvalidation = 'stale-result') {
  state.depthValid = false;
  state.depthReason = reason;
  clearMetricMask(reason, metricInvalidation);
  if (state.depthFrame && destroy) state.depthFrame.depth.destroy();
  state.depthFrame = null;
  if (state.placeholderDepth) setDepthInput(state.placeholderDepth);
}

function refreshDepthValidity(now = performance.now()) {
  if (state.calibrationModel && now - state.calibrationModel.newestAnchorTimestamp > state.calibrationModel.maximumApplicationAgeMs) clearMetricCalibration('calibration-stale');
  const age = depthAge(now);
  const baseValid = state.lifecycle === 'running' && state.provider?.state === 'ready' &&
    state.depthFrame !== null && age !== null && age <= profiles[state.active].maxDepthAgeMs;
  if (!baseValid && state.depthFrame && age !== null && age > profiles[state.active].maxDepthAgeMs) {
    invalidateDepth('stale', true, 'stale-result');
    return false;
  }
  const metricAssociated = metricResultAvailable();
  state.depthValid = baseValid && (state.mode === 'relative' || metricAssociated);
  return state.depthValid;
}

function metricRuntimeSummary() {
  if (!metricResultAvailable()) {
    return state.providerKind === 'relative-manual-fallback'
      ? 'Metric depth: unavailable · native model failed · capture two manual fallback anchors'
      : 'Metric depth: unavailable · awaiting valid source-associated evidence';
  }
  if (state.metricRefinement) {
    const refinement = state.metricRefinement;
    const residual = refinement.normalizedResidual === null
      ? 'residual pending'
      : `normalized residual ${(refinement.normalizedResidual * 100).toFixed(1)}%`;
    return `Metric depth: ${refinement.stage} · scale ${refinement.scale.toFixed(3)} · shift ${refinement.shiftMeters.toFixed(3)} m · support ${refinement.inlierCount}/${refinement.supportCount} · ${residual} · ${REFINEMENT_GUIDANCE_LABELS[refinement.guidance]}`;
  }
  if (state.probes.length === 0) return 'Metric depth: manual fallback · add a tracked object';
  const metricStates = state.probes.map((probe) => probe.metricState);
  let status = 'unavailable';
  if (metricStates.every((item) => item.status === 'stable')) status = 'stable';
  else if (metricStates.some((item) => item.status === 'refining')) status = 'refining';
  else if (metricStates.some((item) => item.status === 'approximate')) status = 'approximate';
  else if (metricStates.some((item) => item.status === 'starting')) status = 'starting';
  const repeatability = metricStates.reduce((sum, item) => sum + item.temporalRepeatability, 0) / metricStates.length;
  return `Metric depth: ${status} · temporal repeatability ${Math.round(repeatability * 100)}%`;
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
  elements.metricRuntimeStatus.textContent = metricRuntimeSummary();
  elements.metricSourceStatus.textContent = state.sourceId
    ? (state.metricProvenance === 'native-metric' ? 'native model · metric m' : (state.metricProvenance === 'manual-known-plane' ? 'manual fallback · estimated m' : (state.providerKind === 'relative-manual-fallback' ? 'relative provider · manual fallback required' : 'metric evidence pending')))
    : 'relative unitless · no active camera source';
  updateCalibrationControls();
  if (state.lifecycle === 'running') {
    const semantics = state.mode === 'metric' ? `${state.metricProvenance ?? 'pending'} metric mask` : 'real relative depth';
    elements.status.textContent = valid ? `Running · ${semantics}` : `Running · zero occlusion (${state.depthReason})`;
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
      if (generation === state.generation && provider === state.provider) invalidateProbeMetricStates('stale-result');
      return;
    }
    if (result.sourceFrameId !== sourceFrameId || result.captureTimestamp !== timestamp / 1000 ||
        result.representation !== 'inverse-z' || result.scale !== 'relative' || result.unit !== null) {
      result.depth.destroy();
      result.confidence?.destroy();
      throw new Error('Depth result did not match its captured source frame or relative-depth contract.');
    }
    result.confidence?.destroy();
    supersedeDepth();
    state.depthFrame = result;
    state.lastDepthTimestamp = result.captureTimestamp;
    state.acceptedRequest = requestId;
    state.inferenceCount += 1;
    state.inferenceWindowCount += 1;
    state.depthReason = 'valid';
    updateMetricResult(result);
    if (state.mode === 'relative') setDepthInput(result.depth);
    else if (state.metricTexture && state.metricSourceFrameId === result.sourceFrameId && state.metricCaptureTimestamp === result.captureTimestamp) setDepthInput(state.metricTexture);
    else setDepthInput(state.placeholderDepth);
    updateTelemetry();
  }).catch((error) => {
    if (error?.name !== 'AbortError') handleInferenceFailure(error, generation);
  }).finally(() => {
    videoFrame.close();
    if (generation === state.generation) {
      state.inferencePending = false;
      updateTelemetry();
    }
  });
}

function handleInferenceFailure(error, generation) {
  if (generation !== state.generation || state.lifecycle !== 'running') return;
  invalidateDepth('inference failed', true, 'provider-failure');
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
  invalidateProbeMetricStates('stale-result');
  clearMetricCalibration('profile changed');
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
  metricMode: f32,
  pad: f32
}
@group(0) @binding(0) var<uniform> values: Values;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
const diagnosticRelativeDepthHeadroom: f32 = ${DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM};
const diagnosticRelativeDepthCeiling: f32 = ${DIAGNOSTIC_RELATIVE_DEPTH_CEILING};

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
    let depthOrMask = relativeDepthAt(uv);
    return vec4f(vec3f(depthOrMask), 1.);
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
  let virtualRelativeDepth = mix(
    diagnosticRelativeDepthHeadroom,
    diagnosticRelativeDepthCeiling,
    clamp(z / radius, 0., 1.)
  );
  if (values.view < .5 && values.depthValid > .5) {
    if (values.metricMode > .5 && relativeDepthAt(uv) > .5) { discard; }
    if (values.metricMode < .5 && relativeDepthAt(uv) > virtualRelativeDepth) { discard; }
  }
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
    elements.gpu.width, elements.gpu.height, state.mode === 'metric' ? 1 : 0, 0
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
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack?.id) throw new Error('Camera returned no stable video track identity.');
    const sourceId = `camera-track:${videoTrack.id}`;
    if (state.sourceId !== sourceId) {
      clearMetricCalibration('source changed');
      state.sourceId = sourceId;
      recreateProbeMetricStates(sourceId);
    } else {
      state.sourceId = sourceId;
    }
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
    state.providerKind = 'native-metric';
    state.nativeFailureReason = null;
    state.provider = new WebGPUMonocularDepthProvider({ device: state.device });
    state.providerState = state.provider.state;
    setLifecycle('model-loading', `Loading pinned ${METRIC_DEPTH_MODEL_ID} on WebGPU…`);
    updateTelemetry();
    try {
      await state.provider.initialize();
    } catch (nativeError) {
      if (generation !== state.generation) return;
      await state.provider.dispose();
      if (generation !== state.generation) return;
      state.providerKind = 'relative-manual-fallback';
      state.nativeFailureReason = nativeError?.message || 'native metric initialization failed';
      state.calibrationReason = 'native-metric-unavailable-manual-fallback-required';
      state.provider = new WebGPUMonocularDepthProvider({
        device: state.device,
        runtime: createTransformersDepthRuntime()
      });
      state.providerState = state.provider.state;
      elements.backend.textContent = `Transformers.js ${TRANSFORMERS_JS_VERSION} · WebGPU · manual fallback`;
      elements.model.textContent = `${DEPTH_MODEL_ID}@${DEPTH_MODEL_REVISION} · ${DEPTH_MODEL_DTYPE}`;
      setLifecycle('model-loading', `Native metric unavailable; loading pinned manual fallback ${DEPTH_MODEL_ID}…`);
      updateTelemetry();
      await state.provider.initialize();
    }
    if (generation !== state.generation) return;
    state.providerState = state.provider.state;
    state.inferenceCount = 0;
    state.inferenceWindowCount = 0;
    state.inferenceRate = 0;
    state.lastDepthTimestamp = 0;
    state.lastFpsSample = performance.now();
    state.depthReason = 'awaiting first result';
    setLifecycle(
      'running',
      state.providerKind === 'native-metric'
        ? 'Running · awaiting first native metric-depth result'
        : 'Running · relative depth ready · capture two manual fallback anchors'
    );
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
  clearMetricCalibration('stopped');
  invalidateProbeMetricStates('provider-failure');
  invalidateDepth('stopped', true, 'stale-result');
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
    inferenceRate: 0, sourceId: null
  });
  state.providerKind = 'native-metric';
  state.nativeFailureReason = null;
  elements.backend.textContent = `ONNX Runtime Web ${ONNX_RUNTIME_WEB_VERSION} · WebGPU`;
  elements.model.textContent = `${METRIC_DEPTH_MODEL_ID}@${METRIC_DEPTH_MODEL_REVISION}`;
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
elements.modeControls.addEventListener('click', ({ target }) => { const button = target.closest('button[data-mode]'); if (!button || button.disabled || button.dataset.mode === state.mode) return; clearMetricMask('mode changed'); state.mode = button.dataset.mode; selectButton(elements.modeControls, 'mode', state.mode); setDepthInput(state.mode === 'relative' && state.depthFrame ? state.depthFrame.depth : state.placeholderDepth); updateTelemetry(); });
elements.captureAnchor.addEventListener('click', () => { try { state.pendingAnchorDistance = numericControl(elements.anchorDistance, 0.1, 20, 'Known distance'); state.calibrationReason = 'awaiting exact accepted source frame'; clearMetricMask('awaiting calibration anchor'); } catch (error) { state.calibrationReason = error?.message || 'invalid known distance'; } updateTelemetry(); });
elements.clearCalibration.addEventListener('click', () => { clearMetricCalibration('cleared'); updateTelemetry(); });
for (const control of [elements.virtualZ, elements.entryHysteresis, elements.exitHysteresis]) control.addEventListener('input', () => { clearMetricMask('metric controls changed'); updateTelemetry(); });
elements.probeControls.addEventListener('click', ({ target }) => {
  const button = target.closest('button[data-probes]');
  if (!button || button.disabled) return;
  setDistanceProbesEnabled(button.dataset.probes === 'on');
});
elements.clearProbes.addEventListener('click', () => {
  state.probes = [];
  renderDistanceProbes();
});
elements.stage.addEventListener('click', (event) => {
  if (!state.probesEnabled || !metricResultAvailable() || state.lifecycle !== 'running' || !elements.startScreen.classList.contains('hidden')) return;
  const bounds = elements.stage.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
  const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
  addDistanceProbe(x, y);
});

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
  for (const probe of state.probes) probe.x = 1 - probe.x;
  elements.stage.classList.toggle('flip-x', state.previewFlipped);
  selectButton(elements.orientationControls, 'flip', String(state.previewFlipped));
  invalidateProbeMetricStates('tracking-lost');
  if (state.metricLinearZ && state.metricValidity && state.depthFrame) {
    updateDistanceProbeMeasurements(state.metricLinearZ, state.metricValidity, state.depthFrame.width, state.depthFrame.height, state.depthFrame);
  } else {
    invalidateProbeMetricStates('tracking-lost');
  }
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
elements.backend.textContent = `ONNX Runtime Web ${ONNX_RUNTIME_WEB_VERSION} · WebGPU`;
elements.model.textContent = `${METRIC_DEPTH_MODEL_ID}@${METRIC_DEPTH_MODEL_REVISION}`;
updateTelemetry();
