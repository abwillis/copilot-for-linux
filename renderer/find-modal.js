'use strict';

(function () {
  var termEl   = document.getElementById('term');
  var matchEl  = document.getElementById('match');
  var statusEl = document.getElementById('status');
  var cancelEl = document.getElementById('cancel-indexing');
  var snippetsEl = document.getElementById('snippets');
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

  function setIndexing(active) {
    try {
      if (cancelEl) cancelEl.hidden = !active;
    } catch (e) {}
  }

  function renderSnippets(snippets) {
    try {
      if (!snippetsEl) return;
      snippetsEl.textContent = '';
      var rows = Array.isArray(snippets) ? snippets : [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var item = document.createElement('li');
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(row.snippet || row.label || 'Match');
        button.title = button.textContent;
        button.onclick = (function (resultId) {
          return function () { api.navigateResult(resultId); };
        })(row.id);
        item.appendChild(button);
        snippetsEl.appendChild(item);
      }
      snippetsEl.hidden = rows.length === 0;
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
    setIndexing(false);
    renderSnippets([]);
    setStatus('No active search', '');
    api.clear();
  };
  document.getElementById('close').onclick = function () { api.close(); };
  cancelEl.onclick = function () {
    setIndexing(false);
    setStatus('Indexing cancelled', 'none');
    api.cancelIndexing();
  };

  termEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitFind(e.shiftKey ? 'prev' : 'next');
    if (e.key === 'Escape') {
      if (cancelEl && !cancelEl.hidden) {
        setIndexing(false);
        setStatus('Indexing cancelled', 'none');
        api.cancelIndexing();
        return;
      }
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
      setIndexing(false);
      renderSnippets([]);
      setStatus('No active search', '');
      return;
    }
    if (result.kind === 'indexing') {
      setIndexing(result.cancellable !== false);
      setStatus('Indexing conversation…', 'searching');
      return;
    }
    setIndexing(false);
    if (result.kind === 'cancelled') {
      setStatus(result.message || 'Indexing cancelled', 'none');
      return;
    }
    if (result.kind === 'error') {
      setStatus(result.message || 'Find failed', 'none');
      return;
    }
    if (result.kind === 'searching') {
      setStatus('Searching...', 'searching');
      return;
    }
    renderSnippets(result.snippets);
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
