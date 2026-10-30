import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs";

const video = document.getElementById('cam');
const model = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let faces = null;
let lastTs = 0;
let running = false;
let samples = 0;
let lookingFrames = 0;
let faceFrames = 0;
let frameNo = 0;
let lastReport = 0;

function look(el) {
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const r = faces.detectForVideo(el, ts);
  const lm = r.faceLandmarks?.[0];
  const m = r.facialTransformationMatrixes?.[0]?.data;
  if (!lm || !m) return { face: false, looking: false };
  const yaw = Math.atan2(m[8], m[10]) * 180 / Math.PI;
  const pitch = Math.asin(-m[9]) * 180 / Math.PI;
  const iris = (o, i, c) => ((lm[c].x - lm[i].x) * (lm[o].x - lm[i].x) + (lm[c].y - lm[i].y) * (lm[o].y - lm[i].y)) /
    ((lm[o].x - lm[i].x) ** 2 + (lm[o].y - lm[i].y) ** 2);
  const eyesMid = [iris(33, 133, 468), iris(263, 362, 473)].every((t) => t > 0.25 && t < 0.75);
  return { face: true, looking: Math.abs(yaw) < 20 && Math.abs(pitch) < 20 && eyesMid };
}

function scoreNow() {
  if (samples < 15) return null;
  return Math.max(1, Math.min(10, Math.round(10 * lookingFrames / samples)));
}

function report() {
  const detail = {
    score: scoreNow(),
    percent: samples ? Math.round(100 * lookingFrames / samples) : 0,
    facePercent: samples ? Math.round(100 * faceFrames / samples) : 0,
    samples: samples
  };
  window.dispatchEvent(new CustomEvent('pc-face', { detail: detail }));
}

function frame() {
  const now = performance.now();
  if (running && faces && video.srcObject && video.readyState >= 2) {
    frameNo++;
    if (frameNo % 3 === 0) {
      try {
        const r = look(video);
        samples++;
        if (r.face) faceFrames++;
        if (r.looking) lookingFrames++;
      } catch (err) {
        running = false;
        window.dispatchEvent(new CustomEvent('pc-face-error', {
          detail: 'Face model error: ' + (err && err.message ? err.message : err)
        }));
      }
      if (now - lastReport > 250) {
        lastReport = now;
        report();
      }
    }
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
  else requestAnimationFrame(frame);
}

window.pcFace = {
  ready: false,
  begin: function () {
    samples = 0;
    lookingFrames = 0;
    faceFrames = 0;
    lastReport = 0;
    running = true;
    report();
  },
  end: function () {
    running = false;
    report();
  },
  score: function () {
    return scoreNow();
  }
};

try {
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm');
  faces = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: model },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFacialTransformationMatrixes: true
  });
  window.pcFace.ready = true;
  window.dispatchEvent(new CustomEvent('pc-face-ready'));
} catch (err) {
  window.dispatchEvent(new CustomEvent('pc-face-error', {
    detail: 'Eye contact needs the face model and it did not load: ' + (err && err.message ? err.message : err)
  }));
}

frame();
