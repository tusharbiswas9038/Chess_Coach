import { createDomCache } from '../dom.js';

export function createNavigationView({
  onEnterCoach,
  onEnterDrills,
  onEnterGames,
  onEnterMistakes,
  onEnterOpenings,
}) {
  const dom = createDomCache();
  function showView(name) {
    dom.queryAll('.view').forEach((v) => v.classList.remove('active'));
    dom.queryAll('.nav-item').forEach((n) => {
      n.classList.remove('active');
      n.removeAttribute('aria-current');
    });

    const viewEl = dom.byId(`view-${name}`);
    if (viewEl) viewEl.classList.add('active');

    const navEl = dom.query(`[data-view="${name}"]`);
    if (navEl) {
      navEl.classList.add('active');
      navEl.setAttribute('aria-current', 'page');
    }

    const titles = {
      dashboard: 'Dashboard',
      games: 'All Games',
      'game-detail': 'Game Analysis',
      mistakes: 'Mistake Analysis',
      openings: 'Opening Report',
      drills: 'Daily Drills',
      coach: 'Ask Coach',
    };
    dom.byId('topbar-title').textContent = titles[name] || name;

    if (name === 'games') onEnterGames();
    if (name === 'mistakes') onEnterMistakes();
    if (name === 'openings') onEnterOpenings();
    if (name === 'coach') onEnterCoach();
    if (name === 'drills') onEnterDrills();
  }

  function bindEvents() {
    dom.query('.sidebar-nav')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.nav-item[data-view]');
      if (!btn) return;
      showView(btn.dataset.view);
    });
  }

  return {
    bindEvents,
    showView,
  };
}
