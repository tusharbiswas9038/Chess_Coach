import { createDomCache } from '../dom.js';

export function createNavigationView({
  onEnterCoach,
  onEnterDrills,
  onEnterGames,
  onEnterMistakes,
  onEnterOpenings,
}) {
  const dom = createDomCache();
  const SIDEBAR_PREF_KEY = 'cc.sidebar.collapsed';
  const validViews = new Set([
    'dashboard',
    'games',
    'game-detail',
    'mistakes',
    'openings',
    'drills',
    'coach',
  ]);
  const scrollByView = new Map();
  let currentView = 'dashboard';
  let sidebarCollapsed = false;
  let sidebarTabletOpen = false;

  function routeForView(name) {
    return `#/${name}`;
  }

  function parseRoute(hash) {
    const raw = String(hash || '').trim();
    if (!raw || raw === '#') return 'dashboard';
    const normalized = raw.replace(/^#\/?/, '').split('?')[0];
    return validViews.has(normalized) ? normalized : 'dashboard';
  }

  function showView(name, options = {}) {
    const { updateRoute = true } = options;
    const safeName = validViews.has(name) ? name : 'dashboard';
    const previousView = currentView;

    if (previousView) {
      scrollByView.set(previousView, window.scrollY || 0);
    }

    dom.queryAll('.view').forEach((v) => v.classList.remove('active'));
    dom.queryAll('.nav-item').forEach((n) => {
      n.classList.remove('active');
      n.removeAttribute('aria-current');
    });

    const viewEl = dom.byId(`view-${safeName}`);
    if (viewEl) viewEl.classList.add('active');

    const navEl = dom.query(`[data-view="${safeName}"]`);
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
    const breadcrumbs = {
      dashboard: 'Workspace / Dashboard',
      games: 'Workspace / Games',
      'game-detail': 'Workspace / Games / Analysis',
      mistakes: 'Insights / Mistakes',
      openings: 'Insights / Openings',
      drills: 'Training / Drills',
      coach: 'Training / Coach',
    };
    dom.byId('topbar-title').textContent = titles[safeName] || safeName;
    const breadcrumbEl = dom.byId('topbar-breadcrumb');
    if (breadcrumbEl) breadcrumbEl.textContent = breadcrumbs[safeName] || 'Workspace';
    updateTopbarActionsForView(safeName);
    currentView = safeName;

    const savedScroll = scrollByView.get(safeName);
    window.scrollTo({ top: savedScroll ?? 0, behavior: 'auto' });

    if (updateRoute && window.location.hash !== routeForView(safeName)) {
      window.location.hash = routeForView(safeName);
    }

    if (safeName === 'games') onEnterGames();
    if (safeName === 'mistakes') onEnterMistakes();
    if (safeName === 'openings') onEnterOpenings();
    if (safeName === 'coach') onEnterCoach();
    if (safeName === 'drills') onEnterDrills();
  }

  function syncFromRoute() {
    const nextView = parseRoute(window.location.hash);
    showView(nextView, { updateRoute: false });
  }

  function bindEvents() {
    dom.query('.sidebar-nav')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.nav-item[data-view]');
      if (!btn) return;
      showView(btn.dataset.view);
    });
    window.addEventListener('hashchange', syncFromRoute);

    const toggleBtn = dom.byId('btn-sidebar-toggle');
    toggleBtn?.addEventListener('click', () => {
      if (isMobileViewport()) return;
      if (isTabletViewport()) {
        setSidebarTabletOpen(!sidebarTabletOpen);
        return;
      }
      setSidebarCollapsed(!sidebarCollapsed, { persist: true });
    });

    window.addEventListener('resize', handleViewportMode);
  }

  function setSidebarCollapsed(collapsed, options = {}) {
    const { persist = false } = options;
    const enabled = !!collapsed;
    sidebarCollapsed = enabled;
    document.body.classList.toggle('sidebar-collapsed', enabled);
    const toggleBtn = dom.byId('btn-sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(!enabled));
      toggleBtn.setAttribute('aria-label', enabled ? 'Expand sidebar' : 'Collapse sidebar');
      toggleBtn.title = enabled ? 'Expand sidebar' : 'Collapse sidebar';
    }
    if (persist) {
      try {
        window.localStorage.setItem(SIDEBAR_PREF_KEY, enabled ? '1' : '0');
      } catch (_) {
        // ignore storage errors
      }
    }
  }

  function setSidebarTabletOpen(open) {
    const enabled = !!open;
    sidebarTabletOpen = enabled;
    document.body.classList.toggle('sidebar-tablet-open', enabled);
    const toggleBtn = dom.byId('btn-sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(enabled));
      toggleBtn.setAttribute('aria-label', enabled ? 'Collapse navigation' : 'Expand navigation');
      toggleBtn.title = enabled ? 'Collapse navigation' : 'Expand navigation';
    }
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function isTabletViewport() {
    return window.matchMedia('(max-width: 900px)').matches && !isMobileViewport();
  }

  function handleViewportMode() {
    if (isMobileViewport()) {
      setSidebarTabletOpen(false);
      return;
    }
    if (isTabletViewport()) {
      setSidebarCollapsed(false);
      return;
    }
    setSidebarTabletOpen(false);
  }

  function restoreSidebarPreference() {
    try {
      const value = window.localStorage.getItem(SIDEBAR_PREF_KEY);
      setSidebarCollapsed(value === '1');
    } catch (_) {
      setSidebarCollapsed(false);
    }
    handleViewportMode();
  }

  function updateTopbarActionsForView(viewName) {
    const btnSync = dom.byId('btn-sync');
    const btnAnalyze = dom.byId('btn-analyze');
    const btnDb = dom.byId('btn-db-maintenance');
    const visibleByView = {
      dashboard: ['sync', 'analyze', 'db'],
      games: ['sync', 'analyze', 'db'],
      openings: ['sync', 'analyze', 'db'],
      mistakes: ['analyze', 'db'],
      drills: ['db'],
      coach: ['db'],
      'game-detail': ['analyze', 'db'],
    };
    const visible = new Set(visibleByView[viewName] || ['sync', 'analyze', 'db']);
    const apply = (el, key) => {
      if (!el) return;
      const show = visible.has(key);
      el.hidden = !show;
      el.setAttribute('aria-hidden', String(!show));
    };
    apply(btnSync, 'sync');
    apply(btnAnalyze, 'analyze');
    apply(btnDb, 'db');
  }

  return {
    bindEvents,
    showView,
    syncFromRoute,
    restoreSidebarPreference,
    setSidebarCollapsed,
  };
}
