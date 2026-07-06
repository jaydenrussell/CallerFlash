(function () {
  'use strict';

  var elNumber = document.getElementById('callerNumber');
  var elName = document.getElementById('callerName');
  var elTime = document.getElementById('timestamp');
  var elTitle = document.getElementById('headerTitle');
  var elInner = document.getElementById('toastInner');
  var elIcon = document.getElementById('iconRing');
  var elProg = document.getElementById('progressFill');

  var hideTimer = null;
  var progTimer = null;

  function fmt(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return '';
    }
  }

  function show(data) {
    if (!data) return;
    var c = data.config || {};
    var dur = (typeof c.duration === 'number' ? c.duration : 5) * 1000;

    elNumber.textContent = data.callerNumber || 'Unknown';
    elName.textContent = data.callerName || '';
    elName.style.display = data.callerName ? '' : 'none';
    elTime.textContent = fmt(data.timestamp);
    elTime.style.display = c.showTimestamp !== false ? '' : 'none';

    if (c.fontFamily) document.body.style.fontFamily = c.fontFamily;
    if (c.fontSize) {
      var b = c.fontSize;
      elNumber.style.fontSize = b + 'px';
      elName.style.fontSize = Math.max(10, b - 4) + 'px';
      elTime.style.fontSize = Math.max(9, b - 6) + 'px';
      elTitle.style.fontSize = Math.max(10, b - 5) + 'px';
    }
    if (c.backgroundColor) document.getElementById('toast').style.background = c.backgroundColor;
    if (c.accentColor) {
      var a = c.accentColor;
      elIcon.style.setProperty('--accent', a);
      elTitle.style.color = a;
      elProg.style.background = a;
      elProg.style.boxShadow = '0 0 6px ' + a + ', 0 0 20px ' + a + '80';
    }
    if (c.borderRadius) document.getElementById('toast').style.borderRadius = c.borderRadius + 'px';
    if (c.opacity !== undefined) document.getElementById('toast').style.opacity = String(c.opacity);

    elProg.style.width = '100%';
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    if (dur > 0) {
      var start = Date.now();
      progTimer = setInterval(function () {
        var pct = Math.max(0, (dur - (Date.now() - start)) / dur * 100);
        elProg.style.width = pct + '%';
        if (pct <= 0) clearInterval(progTimer);
      }, 30);
      hideTimer = setTimeout(function () {
        if (progTimer) { clearInterval(progTimer); progTimer = null; }
        window.__TAURI__.core.invoke('toast_hide').catch(function () {});
      }, dur);
    } else {
      elProg.style.width = '0%';
    }
  }

  var unlisten = null;

  function init() {
    window.__TAURI__.event
      .listen('toast:show:event', function (e) {
        if (e && e.payload) show(e.payload);
      })
      .then(function (u) {
        unlisten = u;
        window.__TAURI__.core
          .invoke('toast_get_initial')
          .then(function (d) {
            if (d) show(d);
          })
          .catch(function () {});
      })
      .catch(function () {});
  }

  init();

  elInner.addEventListener('click', function () {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    window.__TAURI__.core.invoke('toast_hide').catch(function () {});
  });

  function playTone(t) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      if (t === 'ring') {
        osc.type = 'sine'; osc.frequency.value = 440; g.gain.value = 0.3;
        osc.start(); osc.stop(ctx.currentTime + 0.5);
      } else if (t === 'beep') {
        osc.type = 'square'; osc.frequency.value = 800; g.gain.value = 0.2;
        osc.start(); osc.stop(ctx.currentTime + 0.15);
      } else if (t === 'gentle') {
        osc.type = 'sine'; osc.frequency.value = 523; g.gain.value = 0.15;
        g.gain.setValueAtTime(0.15, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
        osc.start(); osc.stop(ctx.currentTime + 0.8);
      } else {
        osc.type = 'sine'; osc.frequency.value = 880; g.gain.value = 0.2;
        osc.start(); osc.stop(ctx.currentTime + 0.2);
      }
    } catch (e) { console.log('[toast] audio error:', e); }
  }

  window.__TAURI__.event
    .listen('toast:show:event', function (e) {
      var c = (e && e.payload && e.payload.config) || {};
      if (c.soundEnabled !== false) playTone(c.soundName || 'chime');
    })
    .catch(function () {});
})();
