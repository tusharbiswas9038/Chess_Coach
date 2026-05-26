import { createDomCache } from '../dom.js';

export function createNavigationView({
  onBeforeEnter,
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

  function routeForView(name, routeMode = 'path') {
    return routeMode === 'hash' ? `#/${name}` : `/${name}`;
  }

  function parseRoute(hash, pathname = '/') {
    const fromPath = String(pathname || '/').trim();
    if (fromPath && fromPath !== '/') {
      const pathSeg = fromPath.replace(/^\/+/, '').split('/')[0];
      if (validViews.has(pathSeg)) return pathSeg;
    }
    const raw = String(hash || '').trim();
    if (!raw || raw === '#') return 'dashboard';
    const normalized = raw.replace(/^#\/?/, '').replace(/^\/+/, '').split('?')[0];
    return validViews.has(normalized) ? normalized : 'dashboard';
  }

  async function showView(name, options = {}) {
    const { updateRoute = true, routeMode = 'path' } = options;
    const safeName = validViews.has(name) ? name : 'dashboard';
    const previousView = currentView;
    if (typeof onBeforeEnter === 'function') {
      await onBeforeEnter(safeName);
    }

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
    const topbarMain = document.querySelector('.topbar-main');
    if (topbarMain) {
      topbarMain.classList.remove('is-view-changing');
      requestAnimationFrame(() => topbarMain.classList.add('is-view-changing'));
    }
    updateTopbarActionsForView(safeName);
    currentView = safeName;

    const savedScroll = scrollByView.get(safeName);
    window.scrollTo({ top: savedScroll ?? 0, behavior: 'auto' });

    if (updateRoute) {
      const nextUrl = routeForView(safeName, routeMode);
      const currentCombined = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (routeMode === 'hash') {
        if (window.location.hash !== nextUrl) window.location.hash = nextUrl;
      } else if (currentCombined !== nextUrl) {
        window.history.pushState({ view: safeName }, '', nextUrl);
      }
    }

    if (safeName === 'games') onEnterGames();
    if (safeName === 'mistakes') onEnterMistakes();
    if (safeName === 'openings') onEnterOpenings();
    if (safeName === 'coach') onEnterCoach();
    if (safeName === 'drills') onEnterDrills();
  }

  function syncFromRoute() {
    const nextView = parseRoute(window.location.hash, window.location.pathname);
    showView(nextView, { updateRoute: false });
  }

  function bindEvents() {
    const shortcutTitles = {
      dashboard: 'Dashboard (Alt+1)',
      games: 'Games (Alt+2)',
      mistakes: 'Mistakes (Alt+3)',
      openings: 'Openings (Alt+4)',
      drills: 'Drills (Alt+5)',
      coach: 'Coach (Alt+6, /)',
    };
    dom.queryAll('.nav-item[data-view]').forEach((btn) => {
      const view = btn.dataset.view;
      if (shortcutTitles[view]) btn.setAttribute('title', shortcutTitles[view]);
    });
    dom.query('.sidebar-nav')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.nav-item[data-view]');
      if (!btn) return;
      showView(btn.dataset.view);
    });
    window.addEventListener('hashchange', syncFromRoute);
    window.addEventListener('popstate', syncFromRoute);

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
    window.addEventListener('keydown', handleGlobalShortcuts);
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!target.closest?.('[contenteditable="true"]');
  }

  function handleGlobalShortcuts(event) {
    if (isTypingTarget(event.target)) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const map = {
        '1': 'dashboard',
        '2': 'games',
        '3': 'mistakes',
        '4': 'openings',
        '5': 'drills',
        '6': 'coach',
      };
      const view = map[event.key];
      if (view) {
        event.preventDefault();
        showView(view);
        return;
      }
      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        document.getElementById('btn-toggle-motion')?.click();
        return;
      }
    }
    if (event.key === '/' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      showView('coach');
      const coachInput = document.getElementById('coach-input');
      coachInput?.focus();
    }
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
