import { mountChrome, getConfig } from './ui.js';

mountChrome('/');
document.getElementById('year').textContent = String(new Date().getFullYear());

// Optional hero portrait: put a licensed photo at public/brand/hero.jpg to show it.
getConfig().then((cfg) => {
  if (!cfg.heroImage) return;
  document.getElementById('hero-portrait-img').src = cfg.heroImage;
  document.getElementById('hero-portrait').hidden = false;
});
