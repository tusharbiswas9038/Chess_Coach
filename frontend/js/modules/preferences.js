import { createDomCache } from './dom.js';

const PREFS_KEY = 'ui.prefs.v1';

export function createPreferences({ toast }) {
  const dom = createDomCache();
  let prefs = {
    reduceMotion: false,
    compactDensity: false,
  };

  function readPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return;
      prefs = {
        ...prefs,
        ...parsed,
      };
    } catch {
      // ignore invalid storage content
    }
  }

  function savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  function applyPrefs() {
    document.body.classList.toggle('pref-reduce-motion', !!prefs.reduceMotion);
    document.body.classList.toggle('pref-compact-density', !!prefs.compactDensity);

    const motionBtn = dom.byId('btn-toggle-motion');
    const densityBtn = dom.byId('btn-toggle-density');
    if (motionBtn) {
      motionBtn.setAttribute('aria-pressed', String(!!prefs.reduceMotion));
      motionBtn.textContent = prefs.reduceMotion ? 'Motion Reduced' : 'Reduce Motion';
    }
    if (densityBtn) {
      densityBtn.setAttribute('aria-pressed', String(!!prefs.compactDensity));
      densityBtn.textContent = prefs.compactDensity ? 'Density Compact' : 'Compact Density';
    }
  }

  function toggleMotion() {
    prefs.reduceMotion = !prefs.reduceMotion;
    savePrefs();
    applyPrefs();
    toast?.(prefs.reduceMotion ? 'Motion reduced' : 'Motion restored');
  }

  function toggleDensity() {
    prefs.compactDensity = !prefs.compactDensity;
    savePrefs();
    applyPrefs();
    toast?.(prefs.compactDensity ? 'Compact density enabled' : 'Compact density disabled');
  }

  function bindEvents() {
    dom.byId('btn-toggle-motion')?.addEventListener('click', toggleMotion);
    dom.byId('btn-toggle-density')?.addEventListener('click', toggleDensity);
  }

  function init() {
    readPrefs();
    applyPrefs();
  }

  return {
    bindEvents,
    init,
  };
}
