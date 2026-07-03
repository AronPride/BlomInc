(function () {
  var STORAGE_KEY = 'blom-age-verified';
  var pending = [];

  function isVerified() {
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  }

  function onVerified(fn) {
    if (typeof fn !== 'function') return;
    if (isVerified()) fn();
    else pending.push(fn);
  }

  function emitVerified() {
    pending.splice(0).forEach(function (fn) { fn(); });
    document.dispatchEvent(new CustomEvent('blom-age-verified'));
  }

  window.BlomAgeGate = { isVerified: isVerified, onVerified: onVerified };

  function prepareLogo(imgEl, src) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var px = data.data;
      for (var i = 0; i < px.length; i += 4) {
        if (px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40) {
          px[i + 3] = 0;
        }
      }
      ctx.putImageData(data, 0, 0);
      imgEl.src = canvas.toDataURL('image/png');
    };
    img.onerror = function () {
      imgEl.src = src;
    };
    img.src = src;
  }

  if (isVerified()) return;

  var gate = document.createElement('div');
  gate.id = 'age-gate';
  gate.className = 'age-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-labelledby', 'age-gate-title');
  gate.innerHTML =
    '<div class="age-gate__panel">' +
      '<div class="age-gate__logo-wrap">' +
        '<img class="age-gate__logo" alt="BLOM">' +
      '</div>' +
      '<h1 id="age-gate-title" class="age-gate__title">Are you 21 or older?</h1>' +
      '<p class="age-gate__text">You must be of legal smoking age to enter this site.</p>' +
      '<div class="age-gate__actions">' +
        '<button type="button" class="age-gate__btn age-gate__btn--yes">Yes</button>' +
        '<button type="button" class="age-gate__btn age-gate__btn--no">No</button>' +
      '</div>' +
      '<p id="age-gate-denied" class="age-gate__denied" hidden>Sorry, you must be 21 or older to view this site.</p>' +
    '</div>';

  function mount() {
    document.body.appendChild(gate);
    document.documentElement.classList.add('age-gate-open');
    prepareLogo(gate.querySelector('.age-gate__logo'), 'assets/LogoMark.png');
  }

  gate.querySelector('.age-gate__btn--yes').addEventListener('click', function () {
    sessionStorage.setItem(STORAGE_KEY, '1');
    gate.remove();
    document.documentElement.classList.remove('age-gate-open');
    emitVerified();
  });

  gate.querySelector('.age-gate__btn--no').addEventListener('click', function () {
    gate.querySelector('#age-gate-denied').hidden = false;
  });

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
