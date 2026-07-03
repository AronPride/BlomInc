/**
 * Browser face detection for Play page (MediaPipe BlazeFace).
 * All processing stays on-device.
 */

const FACE_SMOOTH = 0.18;
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

window.PlayFaceTracker = class PlayFaceTracker {
  constructor(video) {
    this.video = video;
    this.detector = null;
    this.ready = false;
    this.lastTimestamp = -1;
    this.detectEvery = 2;
    this.frameCount = 0;
    this.target = null;
    this.smooth = null;
  }

  async init() {
    const vision = await import(`${VISION_CDN}/+esm`);
    const wasm = `${VISION_CDN}/wasm`;

    const tryCreate = async (delegate) => {
      const fileset = await vision.FilesetResolver.forVisionTasks(wasm);
      return vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.55
      });
    };

    try {
      this.detector = await tryCreate('GPU');
    } catch (err) {
      console.warn('[Blom Face] GPU delegate unavailable, using CPU.', err);
      this.detector = await tryCreate('CPU');
    }

    this.ready = true;
  }

  update() {
    if (!this.ready || !this.detector || this.video.readyState < 2) return this.smooth;

    this.frameCount++;
    if (this.frameCount % this.detectEvery !== 0) return this.smooth;

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return this.smooth;

    let ts = performance.now();
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    let result;
    try {
      result = this.detector.detectForVideo(this.video, ts);
    } catch (err) {
      console.warn('[Blom Face] detect failed', err);
      return this.smooth;
    }

    const detections = result && result.detections ? result.detections : [];
    if (!detections.length) {
      this.target = null;
      if (this.smooth) {
        this.smooth.confidence = lerp(this.smooth.confidence, 0, 0.2);
        if (this.smooth.confidence < 0.05) this.smooth = null;
      }
      return this.smooth;
    }

    const box = detections[0].boundingBox;
    const padX = box.width * 0.38;
    const padTop = box.height * 0.58;
    const padBottom = box.height * 0.34;
    const w = box.width + padX * 2;
    const h = box.height + padTop + padBottom;
    const cx = box.originX + box.width * 0.5;
    const cy = box.originY + box.height * 0.5 + (padBottom - padTop) * 0.5;

    this.target = {
      cx: cx / vw,
      cy: cy / vh,
      w: w / vw,
      h: h / vh,
      confidence: detections[0].categories?.[0]?.score ?? 1
    };

    if (!this.smooth) {
      this.smooth = { ...this.target };
    } else {
      this.smooth.cx = lerp(this.smooth.cx, this.target.cx, FACE_SMOOTH);
      this.smooth.cy = lerp(this.smooth.cy, this.target.cy, FACE_SMOOTH);
      this.smooth.w = lerp(this.smooth.w, this.target.w, FACE_SMOOTH);
      this.smooth.h = lerp(this.smooth.h, this.target.h, FACE_SMOOTH);
      this.smooth.confidence = lerp(this.smooth.confidence, this.target.confidence, FACE_SMOOTH);
    }

    return this.smooth;
  }

  get detected() {
    return !!(this.smooth && this.smooth.confidence > 0.25);
  }
};
