/**

 * BLOM Play — camera + reaction-diffusion orchestration.

 * Never call getContext('2d') on #play-canvas (WebGL only).

 */



const PLAY_LAYOUT = { controlW: 184 };
const INTENSITY_SLIDER_MIN = 0.2;
const INTENSITY_SLIDER_MAX = 1.5;
const MAILCHIMP_POST_JSON = 'https://blomn.us18.list-manage.com/subscribe/post-json?u=b3ce9b1b82dee829faff54aaf&id=fe086f8a79';

function intensityToSlider(intensity) {
  return INTENSITY_SLIDER_MIN + INTENSITY_SLIDER_MAX - intensity;
}

function sliderToIntensity(sliderVal) {
  return INTENSITY_SLIDER_MIN + INTENSITY_SLIDER_MAX - sliderVal;
}

function dataUrlToBlob(dataUrl) {
  var parts = dataUrl.split(',');
  var mime = parts[0].match(/:(.*?);/)[1];
  var bin = atob(parts[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function subscribeToMailchimp(email) {
  var url = MAILCHIMP_POST_JSON + '&EMAIL=' + encodeURIComponent(email);
  return new Promise(function (resolve) {
    var script = document.createElement('script');
    var callbackName = 'blomMcCb_' + Date.now();
    window[callbackName] = function (data) {
      delete window[callbackName];
      script.remove();
      resolve(data);
    };
    script.src = url + '&c=' + callbackName;
    script.onerror = function () {
      delete window[callbackName];
      script.remove();
      resolve({ result: 'error' });
    };
    document.body.appendChild(script);
  });
}



function waitForVideoMeta(video) {

  if (video.videoWidth > 0) return Promise.resolve();

  return new Promise(function (resolve, reject) {

    video.onloadedmetadata = function () { resolve(); };

    video.onerror = function () { reject(new Error('Video failed to load.')); };

    setTimeout(function () { reject(new Error('Camera timed out.')); }, 15000);

  });

}



function presetLabel(index) {

  var presets = window.CAM_PRESETS || window.KF_PRESETS;

  var p = presets[index];

  return p ? p.name + (p.hint ? ' · ' + p.hint : '') : String(index);

}



function formatCalRange(sim, cal) {

  var lo = cal ? cal.kf_lo : sim.params.kf_lo;

  var hi = cal ? cal.kf_hi : sim.params.kf_hi;

  return lo.toFixed(2) + '–' + hi.toFixed(2);

}



function showLiveControls(sim) {

  document.getElementById('play-screenshot-btn').classList.add('is-visible');

  document.getElementById('play-controls').classList.remove('is-idle');



  ['play-da-row', 'play-zoom-row', 'play-detail-row', 'play-edge-row', 'play-face-only-row'].forEach(function (id) {

    document.getElementById(id).classList.add('is-visible');

  });



  var daSlider = document.getElementById('play-da-slider');

  daSlider.value = sim.params.dA;

  document.getElementById('play-da-value').textContent = sim.params.dA.toFixed(2);



  var zoomSlider = document.getElementById('play-zoom-slider');

  zoomSlider.value = sim.params.camZoom;

  document.getElementById('play-zoom-value').textContent = sim.params.camZoom.toFixed(2) + '×';



  var detailSlider = document.getElementById('play-detail-slider');

  detailSlider.value = intensityToSlider(sim.params.intensity);

  document.getElementById('play-detail-value').textContent = intensityToSlider(sim.params.intensity).toFixed(2);



  var edgeSlider = document.getElementById('play-edge-slider');

  edgeSlider.value = sim.params.pattern_range;

  document.getElementById('play-edge-value').textContent = sim.params.pattern_range.toFixed(2);



  var faceOnlyCheck = document.getElementById('play-face-only');

  faceOnlyCheck.checked = sim.getFaceOnly();



  var presetRow = document.getElementById('play-presets');

  presetRow.classList.add('is-visible');

  presetRow.querySelectorAll('.btn--preset').forEach(function (btn) {

    btn.classList.add('is-visible');

    btn.classList.toggle('is-active', parseInt(btn.dataset.preset, 10) === sim.activePreset);

  });

  document.getElementById('play-canvas').style.cursor = 'crosshair';

}



window.addEventListener('DOMContentLoaded', function () {

  var btn = document.getElementById('play-start-btn');

  var screenshotBtn = document.getElementById('play-screenshot-btn');

  var daSlider = document.getElementById('play-da-slider');

  var daValue = document.getElementById('play-da-value');

  var zoomSlider = document.getElementById('play-zoom-slider');

  var zoomValue = document.getElementById('play-zoom-value');

  var detailSlider = document.getElementById('play-detail-slider');

  var detailValue = document.getElementById('play-detail-value');

  var edgeSlider = document.getElementById('play-edge-slider');

  var edgeValue = document.getElementById('play-edge-value');

  var faceOnlyCheck = document.getElementById('play-face-only');

  var status = document.getElementById('play-status');

  var canvas = document.getElementById('play-canvas');

  var video = document.getElementById('play-video');

  var camCanvas = document.getElementById('play-cam-canvas');

  var stream = null;

  var sim = null;

  var faceTracker = null;



  function setStatus(msg, isError) {

    status.textContent = msg;

    status.className = isError ? 'error' : '';

  }



  btn.addEventListener('click', function () {

    btn.disabled = true;

    setStatus('Requesting camera…');



    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {

      setStatus('Camera API not available. Use HTTPS or localhost.', true);

      btn.disabled = false;

      return;

    }



    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })

      .then(function (s) {

        stream = s;

        video.srcObject = stream;

        video.muted = true;

        return video.play();

      })

      .then(function () { return waitForVideoMeta(video); })

      .then(function () {

        btn.style.display = 'none';

        document.getElementById('play-badge').textContent = 'Live';



        if (typeof PlaySimulation === 'undefined') {

          throw new Error('Simulation failed to load.');

        }



        setStatus('Loading face detection…');



        faceTracker = new PlayFaceTracker(video);

        return faceTracker.init().catch(function (err) {

          console.warn('[Blom Play] Face detection unavailable:', err);

          faceTracker = null;

        });

      })

      .then(function () {

        sim = new PlaySimulation(canvas, video, camCanvas, PLAY_LAYOUT);

        return sim.loadLogoMask().then(function () {

          if (faceTracker) sim.setFaceTracker(faceTracker);

          sim.setFaceOnly(faceOnlyCheck.checked);

          return sim.start().then(function (cal) {

            showLiveControls(sim);

            setStatus(

              'Live — ' + presetLabel(sim.activePreset) +

              (faceTracker ? ' · face tracking' : '') +

              ' · ' + formatCalRange(sim, cal)

            );

          });

        });

      })

      .catch(function (err) {

        console.error('[Blom Play]', err);

        if (sim) sim.stop();

        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });

        stream = null;

        sim = null;

        faceTracker = null;

        setStatus(

          err.name === 'NotAllowedError'

            ? 'Camera denied. Check browser permissions and try again.'

            : (err.message || 'Could not start.'),

          true

        );

        btn.disabled = false;

        btn.style.display = 'block';

      });

  });



  var captureModal = document.getElementById('play-capture-modal');
  var capturePreview = document.getElementById('play-capture-preview');
  var captureForm = document.getElementById('play-capture-form');
  var captureEmail = document.getElementById('play-capture-email');
  var captureMarketing = document.getElementById('play-capture-marketing');
  var captureError = document.getElementById('play-capture-error');
  var captureActions = document.getElementById('play-capture-actions');
  var captureDownload = document.getElementById('play-capture-download');
  var captureInstagram = document.getElementById('play-capture-instagram');
  var captureCancel = document.getElementById('play-capture-cancel');
  var captureLead = document.getElementById('play-capture-lead');
  var captureBlobUrl = null;
  var captureBlob = null;

  function revokeCaptureBlob() {
    if (captureBlobUrl) {
      URL.revokeObjectURL(captureBlobUrl);
      captureBlobUrl = null;
    }
    captureBlob = null;
  }

  function closeCaptureModal() {
    captureModal.classList.remove('is-open');
    captureModal.hidden = true;
    captureForm.hidden = false;
    captureActions.classList.remove('is-visible');
    capturePreview.parentElement.classList.remove('is-ready');
    captureError.classList.remove('is-visible');
    captureError.textContent = '';
    captureLead.textContent = 'Enter your email to download or share your creation.';
    revokeCaptureBlob();
  }

  function openCaptureModal(dataUrl) {
    revokeCaptureBlob();
    captureBlob = dataUrlToBlob(dataUrl);
    captureBlobUrl = URL.createObjectURL(captureBlob);
    capturePreview.src = dataUrl;
    captureDownload.href = captureBlobUrl;
    capturePreview.parentElement.classList.remove('is-ready');
    captureForm.reset();
    captureForm.hidden = false;
    captureActions.classList.remove('is-visible');
    captureError.classList.remove('is-visible');
    captureLead.textContent = 'Enter your email to download or share your creation.';
    captureModal.hidden = false;
    captureModal.classList.add('is-open');
    captureEmail.focus();
  }

  function revealCaptureActions() {
    captureForm.hidden = true;
    captureActions.classList.add('is-visible');
    capturePreview.parentElement.classList.add('is-ready');
    captureLead.textContent = 'Tap Download or Instagram to save your pattern.';
  }

  screenshotBtn.addEventListener('click', function () {
    if (!sim || !sim.running) return;
    try {
      openCaptureModal(sim.captureFrame());
    } catch (err) {
      console.error('[Blom Play] Screenshot failed:', err);
      setStatus('Could not capture screenshot.', true);
    }
  });

  captureCancel.addEventListener('click', closeCaptureModal);

  captureModal.addEventListener('click', function (e) {
    if (e.target === captureModal) closeCaptureModal();
  });

  captureForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = captureEmail.value.trim();
    if (!isValidEmail(email)) {
      captureError.textContent = 'Please enter a valid email address.';
      captureError.classList.add('is-visible');
      return;
    }
    captureError.classList.remove('is-visible');
    var submitBtn = document.getElementById('play-capture-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    var marketing = captureMarketing.checked;
    var done = function () {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue';
      revealCaptureActions();
    };

    if (marketing) {
      subscribeToMailchimp(email).finally(done);
    } else {
      done();
    }
  });

  captureInstagram.addEventListener('click', function () {
    if (!captureBlob) return;
    var file = new File([captureBlob], 'blom-pattern.png', { type: 'image/png' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({
        files: [file],
        title: 'BLOM Pattern',
        text: 'Made with BLOM reaction diffusion'
      }).catch(function () {});
      return;
    }
    var link = document.createElement('a');
    link.href = captureBlobUrl;
    link.download = 'blom-pattern.png';
    link.click();
    window.open('https://www.instagram.com/', '_blank', 'noopener,noreferrer');
  });

  capturePreview.addEventListener('click', function () {
    if (captureForm.hidden && captureBlobUrl) captureDownload.click();
  });



  daSlider.addEventListener('input', function () {

    var value = parseFloat(daSlider.value);

    daValue.textContent = value.toFixed(2);

    if (sim) sim.setDA(value);

  });



  zoomSlider.addEventListener('input', function () {

    var value = parseFloat(zoomSlider.value);

    zoomValue.textContent = value.toFixed(2) + '×';

    if (sim) sim.setCamZoom(value);

  });



  detailSlider.addEventListener('input', function () {

    var sliderVal = parseFloat(detailSlider.value);

    detailValue.textContent = sliderVal.toFixed(2);

    if (sim) sim.setDetail(sliderToIntensity(sliderVal));

  });



  edgeSlider.addEventListener('input', function () {

    var value = parseFloat(edgeSlider.value);

    edgeValue.textContent = value.toFixed(2);

    if (sim) sim.setPatternRange(value);

  });



  faceOnlyCheck.addEventListener('change', function () {

    if (sim) sim.setFaceOnly(faceOnlyCheck.checked);

  });



  document.getElementById('play-presets').addEventListener('click', function (e) {

    var presetBtn = e.target.closest('[data-preset]');

    if (!presetBtn || !sim) return;

    var index = parseInt(presetBtn.dataset.preset, 10);

    var cal = sim.switchPreset(index);

    showLiveControls(sim);

    var msg = 'Preset ' + presetLabel(index);

    if (cal) {

      msg += ' · ' + formatCalRange(sim, cal);

    }

    setStatus(msg);

  });



  canvas.addEventListener('pointerdown', function (e) {

    if (!sim || !sim.running) return;

    if (e.button !== 0) return;

    var pt = sim.clientToSim(e.clientX, e.clientY);

    if (pt) sim.seedAt(pt.x, pt.y);

  });



  window.addEventListener('keydown', function (e) {

    if (e.key === 'Escape' && captureModal.classList.contains('is-open')) {
      closeCaptureModal();
      return;
    }

    if (e.key !== 's' && e.key !== 'S') return;

    var tag = e.target && e.target.tagName;

    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (!sim || !sim.running) return;

    e.preventDefault();

    sim.seedFullScreen();

  });



  window.addEventListener('beforeunload', function () {

    if (sim) sim.stop();

    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });

  });

});

