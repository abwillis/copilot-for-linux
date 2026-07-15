'use strict';

(function () {
  var api  = window.appPrompt;
  var term = document.getElementById('term');
  var lbl  = document.getElementById('lbl');
  var ok   = document.getElementById('ok');
  var can  = document.getElementById('cancel');

  if (!api) {
    if (lbl) lbl.textContent = 'Prompt preload missing.';
    return;
  }

  var initialValue = '';

  function submit() {
    var v = (term.value || '').trim();
    if (!v) { cancel(); return; }
    api.submit({ name: v });
  }

  function cancel() {
    api.submit(null);
  }

  ok.addEventListener('click', submit);
  can.addEventListener('click', cancel);

  term.addEventListener('keydown', function (e) {
    if (e.key === 'Enter')  { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  api.onInit(function (payload) {
    if (payload.title)      { try { document.title = String(payload.title); } catch {} }
    if (payload.label)      { lbl.textContent = String(payload.label); }
    if (payload.okText)     { ok.textContent  = String(payload.okText); }
    if (payload.cancelText) { can.textContent = String(payload.cancelText); }

    if (typeof payload.value === 'string') {
      initialValue = payload.value;
      term.value   = payload.value;
    }

    try { term.focus(); term.select(); } catch {}
  });
})();
