(function () {
  var API = location.pathname.split('/proxy/')[0] + '/proxy/19040/v1';
  var SEGMENT_MS = 5000;

  var cam = document.getElementById('cam');
  var camNote = document.getElementById('camNote');
  var timeEl = document.getElementById('time');
  var wordsEl = document.getElementById('words');
  var wpmEl = document.getElementById('wpm');
  var fillersEl = document.getElementById('fillers');
  var startBtn = document.getElementById('start');
  var stopBtn = document.getElementById('stop');
  var langSel = document.getElementById('lang');
  var errorEl = document.getElementById('error');
  var summaryEl = document.getElementById('summary');
  var transcriptEl = document.getElementById('transcript');

  var stream = null;
  var recorder = null;
  var segmentTimer = null;
  var ticker = null;
  var audioCtx = null;
  var analyser = null;
  var loudLevel = 0;
  var chunkLoud = false;
  var running = false;
  var startedAt = 0;
  var finalWords = 0;
  var fillerCount = 0;
  var spokenText = '';
  var queue = Promise.resolve();
  var ending = false;
  var queued = 0;
  var finalSeen = false;

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function countWords(text) {
    var parts = text.trim().split(/\s+/);
    var n = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) n++;
    }
    return n;
  }

  function isFiller(token) {
    var w = token.toLowerCase().replace(/[.,!?;:\u2026"'«»()\[\]]/g, '');
    if (!w) return false;
    if (/^u+m+h*$/.test(w)) return true;
    if (/^u+h+$/.test(w)) return true;
    if (/^[ae]h+$/.test(w)) return true;
    if (/^e+r+m*$/.test(w)) return true;
    if (/^h+m+$/.test(w)) return true;
    if (/^э+м*$/.test(w)) return true;
    if (/^ә+$/.test(w)) return true;
    if (w === 'ну') return true;
    if (w === 'типа') return true;
    return false;
  }

  function countFillers(text) {
    var parts = text.split(/\s+/);
    var n = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && isFiller(parts[i])) n++;
    }
    return n;
  }

  function formatTime(ms) {
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function elapsedSeconds() {
    return running ? (performance.now() - startedAt) / 1000 : stoppedSeconds;
  }

  var stoppedSeconds = 0;

  function speedNow() {
    var sec = elapsedSeconds();
    if (sec < 3 || finalWords === 0) return null;
    return Math.round(finalWords / (sec / 60));
  }

  function updateStats() {
    timeEl.textContent = formatTime(elapsedSeconds() * 1000);
    wordsEl.textContent = String(finalWords);
    fillersEl.textContent = String(fillerCount);
    var wpm = speedNow();
    wpmEl.textContent = wpm === null ? '\u2014' : String(wpm);
  }

  function renderTranscript() {
    transcriptEl.textContent = spokenText || 'Listening\u2026';
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser cannot open the camera and microphone. Use Chrome.'));
    }
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true
    }).then(function (s) {
      stream = s;
      cam.srcObject = s;
      camNote.style.display = 'none';
      return cam.play();
    });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    cam.srcObject = null;
    camNote.style.display = 'grid';
    camNote.textContent = 'Camera is off';
  }

  function startAnalyser() {
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor || !stream) return;
    audioCtx = new AudioCtor();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    var data = new Uint8Array(analyser.fftSize);
    setInterval(function () {
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      var sum = 0;
      for (var i = 0; i < data.length; i++) {
        var v = (data[i] - 128) / 128;
        sum += v * v;
      }
      loudLevel = Math.sqrt(sum / data.length);
      if (loudLevel > 0.02) chunkLoud = true;
    }, 100);
  }

  function stopAnalyser() {
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
      analyser = null;
    }
    loudLevel = 0;
  }

  function pickMime() {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < types.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  function transcribe(blob) {
    var form = new FormData();
    form.append('file', blob, 'talk.webm');
    form.append('language', langSel.value);
    form.append('model', langSel.value === 'kk' ? 'gigaam' : 'whisper');
    return fetch(API + '/audio/transcriptions', { method: 'POST', body: form })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error('Server ' + r.status + ': ' + t.slice(0, 200));
          });
        }
        return r.json();
      })
      .then(function (data) {
        return data.text || '';
      });
  }

  function startSegment() {
    if (!running || !stream) return;
    var audioOnly = new MediaStream(stream.getAudioTracks());
    var mime = pickMime();
    var rec;
    try {
      rec = mime ? new MediaRecorder(audioOnly, { mimeType: mime }) : new MediaRecorder(audioOnly);
    } catch (err) {
      showError('This browser cannot record the microphone: ' + err.message);
      return;
    }

    var parts = [];
    chunkLoud = false;
    recorder = rec;

    rec.ondataavailable = function (event) {
      if (event.data && event.data.size > 0) parts.push(event.data);
    };

    rec.onstop = function () {
      var hadSound = chunkLoud;
      chunkLoud = false;
      var type = rec.mimeType || 'audio/webm';
      var blob = new Blob(parts, { type: type });
      if (running) {
        startSegment();
      } else {
        finalSeen = true;
        stopAnalyser();
        stopCamera();
      }

      var job = Promise.resolve();
      if (hadSound && blob.size >= 2000) {
        queued++;
        job = queue.then(function () {
          return transcribe(blob);
        }).then(function (text) {
          var clean = text.trim();
          if (!clean) return;
          finalWords += countWords(clean);
          fillerCount += countFillers(clean);
          spokenText = (spokenText + ' ' + clean).trim();
          renderTranscript();
          updateStats();
          if (!summaryEl.hidden) renderSummary();
        }).catch(function (err) {
          showError('Could not turn speech into words: ' + err.message);
        });
        queue = job;
      }
      job.then(function () {
        if (queued > 0) queued--;
        if (ending && finalSeen && queued === 0) finishSummary();
      });
    };

    rec.start();
    segmentTimer = setTimeout(function () {
      if (rec.state !== 'inactive') rec.stop();
    }, SEGMENT_MS);
  }

  function start() {
    if (!window.MediaRecorder) {
      showError('This browser cannot record the microphone. Use Chrome.');
      return;
    }
    clearError();
    summaryEl.hidden = true;
    startBtn.disabled = true;
    langSel.disabled = true;
    stopBtn.disabled = false;
    finalWords = 0;
    fillerCount = 0;
    ending = false;
    queued = 0;
    finalSeen = false;
    spokenText = '';
    stoppedSeconds = 0;
    renderTranscript();
    updateStats();

    startCamera().then(function () {
      running = true;
      startedAt = performance.now();
      startAnalyser();
      startSegment();
      if (ticker) clearInterval(ticker);
      ticker = setInterval(updateStats, 250);
    }).catch(function (err) {
      showError('Camera or microphone did not start: ' + (err && err.message ? err.message : err));
      startBtn.disabled = false;
      langSel.disabled = false;
      stopBtn.disabled = true;
    });
  }

  function tipFor(wpm) {
    if (finalWords > 0 && fillerCount / finalWords > 0.06) {
      return 'Many "umm". Instead of a filler, take a short silent pause.';
    }
    if (wpm === null) return 'Not enough words to measure the speed.';
    if (wpm < 100) return 'A bit slow. Try to speak a little faster.';
    if (wpm > 160) return 'Too fast. Slow down and breathe.';
    return 'Good pace.';
  }

  function renderSummary() {
    if (stoppedSeconds < 1) {
      summaryEl.hidden = true;
      return;
    }
    var wpm = speedNow();
    summaryEl.textContent = finalWords + ' words in ' + formatTime(stoppedSeconds * 1000) + ' \u2014 ' +
      (wpm === null ? '\u2014' : wpm) + ' words per minute, ' + fillerCount + ' filler ' +
      (fillerCount === 1 ? 'word' : 'words') + '. ' + tipFor(wpm);
    summaryEl.hidden = false;
  }

  function finishSummary() {
    ending = false;
    updateStats();
    renderSummary();
  }

  function stop() {
    if (!running) return;
    stoppedSeconds = (performance.now() - startedAt) / 1000;
    running = false;
    ending = true;
    if (segmentTimer) {
      clearTimeout(segmentTimer);
      segmentTimer = null;
    }
    var active = recorder && recorder.state !== 'inactive';
    if (active) {
      recorder.stop();
    }
    recorder = null;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    stopBtn.disabled = true;
    startBtn.disabled = false;
    langSel.disabled = false;
    if (!active) {
      stopAnalyser();
      stopCamera();
      finishSummary();
    }
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  window.addEventListener('beforeunload', function () {
    if (running) {
      running = false;
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    }
  });
})();
