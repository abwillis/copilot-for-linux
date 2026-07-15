'use strict';

(function () {
  var termEl   = document.getElementById('term');
  var matchEl  = document.getElementById('match');
  var statusEl = document.getElementById('status');
  var api      = window.findModal;

  if (!api) {
    if (statusEl) {
      statusEl.textContent = 'Find modal preload missing.';
      statusEl.className = 'status none';
    }
    return;
  }

  function setStatus(text, cls) {
    try {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.className = 'status' + (cls ? ' ' + cls : '');
    } catch (e) {}
  }

  function submitFind(kind) {
    var term = (termEl.value || '').trim();
    if (term) setStatus('Searching...', 'searching');
    api.submit({
      kind: kind,
      term: termEl.value || '',
      matchCase: !!matchEl.checked,
    });
  }

  document.getElementById('next').onclick  = function () { submitFind('next'); };
  document.getElementById('prev').onclick  = function () { submitFind('prev'); };
  document.getElementById('clear').onclick = function () {
    setStatus('No active search', '');
    api.clear();
  };
  document.getElementById('close').onclick = function () { api.close(); };

  termEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitFind(e.shiftKey ? 'prev' : 'next');
    if (e.key === 'Escape') {
      setStatus('No active search', '');
      api.clear();
      api.close();
    }
  });

  termEl.addEventListener('input', function () {
    if (!(termEl.value || '').trim()) setStatus('No active search', '');
  });

  api.onResults(function (result) {
    if (!result || result.kind === 'reset') {
      setStatus('No active search', '');
      return;
    }
    if (result.kind === 'searching') {
      setStatus('Searching...', 'searching');
      return;
    }
    var matches = Number(result.matches || 0);
    var active  = Number(result.activeMatchOrdinal || 0);
    if (!matches) {
      setStatus('No matches', 'none');
    } else if (active > 0) {
      setStatus(active + ' of ' + matches, 'ok');
    } else {
      setStatus(matches + ' match' + (matches === 1 ? '' : 'es'), 'ok');
    }
  });
})();
