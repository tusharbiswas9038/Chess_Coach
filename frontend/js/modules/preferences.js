import { createDomCache } from './dom.js';

const PREFS_KEY = 'ui.prefs.v1';

export function createPreferences({ toast }) {
  const dom = createDomCache();
  let prefs = {
    reduceMotion: false,
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

    const motionBtn = dom.byId('btn-toggle-motion');
    if (motionBtn) {
      motionBtn.setAttribute('aria-pressed', String(!!prefs.reduceMotion));
      motionBtn.textContent = prefs.reduceMotion ? 'Motion Reduced' : 'Reduce Motion';
    }
  }

  function toggleMotion() {
    prefs.reduceMotion = !prefs.reduceMotion;
    savePrefs();
    applyPrefs();
    toast?.(prefs.reduceMotion ? 'Motion reduced' : 'Motion restored');
  }

  function bindEvents() {
    dom.byId('btn-toggle-motion')?.addEventListener('click', toggleMotion);
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
