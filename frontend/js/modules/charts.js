const palette = {
  text: '#f0f6fc',
  muted: '#8b949e',
  grid: 'rgba(255,255,255,0.06)',
  primary: '#3fb950',
  primarySoft: 'rgba(63,185,80,0.22)',
  analytics: '#a855f7',
  analyticsSoft: 'rgba(168,85,247,0.2)',
  blue: '#58a6ff',
  blueSoft: 'rgba(88,166,255,0.24)',
  warning: '#d29922',
  warningSoft: 'rgba(210,153,34,0.24)',
  error: '#f85149',
  errorSoft: 'rgba(248,81,73,0.24)',
  surface: 'rgba(22,27,34,0.95)',
  border: 'rgba(255,255,255,0.1)',
};

function comma(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-IN');
}

export function initChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = palette.text;
  Chart.defaults.font.family = 'Manrope, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.font.weight = '500';
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.events = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'];
  Chart.defaults.interaction = {
    mode: 'nearest',
    intersect: false,
    axis: 'x',
  };
  Object.assign(Chart.defaults.animation, {
    duration: 500,
    easing: 'easeOutQuart',
  });
  Object.assign(Chart.defaults.plugins.legend.labels, {
    color: palette.muted,
    usePointStyle: true,
    pointStyle: 'circle',
    boxWidth: 8,
    boxHeight: 8,
    padding: 14,
    font: {
      size: 11,
      weight: '600',
    },
  });
  const defaultTooltipCallbacks = Chart.defaults.plugins.tooltip.callbacks || {};
  Object.assign(Chart.defaults.plugins.tooltip, {
    enabled: true,
    mode: 'nearest',
    intersect: false,
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    titleColor: palette.text,
    bodyColor: palette.text,
    padding: 10,
    displayColors: true,
    cornerRadius: 10,
    titleFont: { size: 12, weight: '700' },
    bodyFont: { size: 11, weight: '500' },
    callbacks: {
      ...defaultTooltipCallbacks,
      label(context) {
        const label = context.dataset?.label ? `${context.dataset.label}: ` : '';
        return `${label}${comma(context.parsed?.y ?? context.parsed)}`;
      },
    },
  });
}

export function baseCartesianOptions({ min = null, max = null, percent = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false } },
    events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
    scales: {
      x: {
        grid: { color: palette.grid, drawBorder: false },
        ticks: {
          color: palette.muted,
          maxRotation: 0,
          autoSkipPadding: 12,
          font: { size: 11, weight: '500' },
          padding: 6,
        },
      },
      y: {
        grid: { color: palette.grid, drawBorder: false },
        ticks: {
          color: palette.muted,
          font: { size: 11, weight: '500' },
          padding: 6,
          callback(value) {
            const raw = Number(value);
            if (!Number.isFinite(raw)) return value;
            return percent ? `${raw}%` : comma(raw);
          },
        },
        min,
        max,
      },
    },
  };
}

export function doughnutOptions({ legendPosition = 'bottom' } = {}) {
  const defaultTooltipCallbacks =
    (typeof Chart !== 'undefined' && Chart.defaults?.plugins?.tooltip?.callbacks) || {};
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '66%',
    plugins: {
      legend: {
        position: legendPosition,
      },
      tooltip: {
        enabled: true,
        callbacks: {
          ...defaultTooltipCallbacks,
          label(context) {
            const label = context.label || '';
            const value = Number(context.parsed || 0);
            return `${label}: ${comma(value)}`;
          },
        },
      },
    },
    animation: {
      animateScale: true,
      duration: 560,
      easing: 'easeOutQuart',
    },
  };
}

export const chartPalette = palette;
