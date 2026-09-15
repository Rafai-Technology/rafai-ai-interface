/*
 * The tab title and icon, before the app has loaded.
 *
 * Runs straight after /brand.js and before first paint, so a customer's tab
 * never shows the default name and never fetches the default icon. It is
 * deliberately NOT a second copy of the brand rules: it reads only the identity
 * fields, and src/brand.ts re-applies everything properly — including the
 * generated monogram icon — the moment the app starts.
 *
 * ES5, and an external file rather than an inline script, so it survives an old
 * browser and a Content-Security-Policy of script-src 'self'.
 */
(function () {
  var b = window.__BRAND__;
  if (!b || typeof b !== 'object') return;

  function str(v) { return typeof v === 'string' ? v.replace(/^ +| +$/g, '') : ''; }

  var name = str(b.name);
  var company = str(b.company);
  var icon = str(b.favicon) || str(b.logo);
  var customised = !!(name || company || str(b.logo) || str(b.logoDark) || str(b.favicon));
  if (!customised) return;

  document.title = name || company || 'AI Assistant';

  var link = document.querySelector('link[rel="icon"]');
  var safe = /^(https:\/\/|\/[^\/]|data:image\/)/.test(icon) && !/["\\ ]/.test(icon);
  if (icon && safe) {
    if (link) link.href = icon;
  } else if (link && link.parentNode) {
    /* No icon of their own: better no icon for a moment than Rafai's. */
    link.parentNode.removeChild(link);
  }
})();
