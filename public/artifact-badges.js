(() => {
  'use strict';
  const items = [{"id": "2a7a58", "selector": ".site-header", "title": "Subnet-Registrierungspreis"}, {"id": "5ad24b", "selector": ".chart-panel", "title": "Preisverlauf und Projektion"}, {"id": "0b7787", "selector": ".metrics", "title": "Aktuelle Netzwerkwerte"}, {"id": "e294ab", "selector": ".explanation", "title": "Mechanik der Registrierung"}, {"id": "7dce61", "selector": ".page-footer", "title": "Datenquellen und Aktualität"}];
  function attach() {
    for (const item of items) {
      const host = document.querySelector(item.selector);
      if (!host || Array.from(host.children).some(n => n.dataset.aid === item.id)) continue;
      host.classList.add('aid-host');
      const badge = document.createElement('span');
      badge.className = 'aid'; badge.dataset.aid = item.id;
      badge.textContent = 'a#' + item.id; badge.title = 'Artefakt-ID – klicken zum Kopieren';
      badge.setAttribute('role', 'button'); badge.tabIndex = 0;
      badge.setAttribute('aria-label', item.title + ': a#' + item.id + ' kopieren');
      async function copy(event) {
        event.preventDefault(); event.stopPropagation();
        const text = 'a#' + item.id;
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else {
            const field = document.createElement('textarea');
            field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
            document.body.append(field); field.select();
            const ok = document.execCommand('copy'); field.remove(); badge.focus();
            if (!ok) throw new Error('copy failed');
          }
          badge.title = 'Kopiert: ' + text;
        } catch { badge.title = 'Kopieren nicht möglich: ' + text; }
      }
      badge.addEventListener('click', copy);
      badge.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') copy(event); });
      host.append(badge);
    }
  }
  let queued = false;
  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; attach(); }); }
  });
  attach(); observer.observe(document.body, {childList:true, subtree:true});
})();
