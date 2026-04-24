export function createNavigationView({
  onEnterCoach,
  onEnterDrills,
  onEnterGames,
  onEnterMistakes,
  onEnterOpenings,
}) {
  function showView(name) {
    document
      .querySelectorAll('.view')
      .forEach((v) => v.classList.remove('active'));
    document
      .querySelectorAll('.nav-item')
      .forEach((n) => n.classList.remove('active'));

    const viewEl = document.getElementById(`view-${name}`);
    if (viewEl) viewEl.classList.add('active');

    const navEl = document.querySelector(`[data-view="${name}"]`);
    if (navEl) navEl.classList.add('active');

    const titles = {
      dashboard: 'Dashboard',
      games: 'All Games',
      'game-detail': 'Game Analysis',
      mistakes: 'Mistake Analysis',
      openings: 'Opening Report',
      drills: 'Daily Drills',
      coach: 'Ask Coach',
    };
    document.getElementById('topbar-title').textContent = titles[name] || name;

    if (name === 'games') onEnterGames();
    if (name === 'mistakes') onEnterMistakes();
    if (name === 'openings') onEnterOpenings();
    if (name === 'coach') onEnterCoach();
    if (name === 'drills') onEnterDrills();
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
  }

  return {
    bindEvents,
    showView,
  };
}
