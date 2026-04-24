import {
  colorBadge,
  esc,
  openingToneClass,
  openingToneTextClass,
  truncate,
} from '../ui.js';

export function createOpeningsView({ api, charts, destroyChart }) {
  let loaded = false;

  function renderOpeningChart(canvasId, data) {
    destroyChart(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');
    charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map((o) => o.eco),
        datasets: [
          {
            label: 'Games',
            data: data.map((o) => o.games),
            backgroundColor: 'rgba(88,166,255,0.5)',
            borderRadius: 3,
          },
          {
            label: 'Wins',
            data: data.map((o) => o.wins),
            backgroundColor: 'rgba(63,185,80,0.7)',
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#7d8590', font: { size: 11 } } },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590' },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#7d8590' },
          },
        },
      },
    });
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    let games;
    try {
      games = await api('/api/games?limit=100&offset=0');
    } catch (e) {
      return;
    }

    const openingMap = {};
    for (const g of games) {
      if (!g.opening_eco || !g.analyzed) continue;
      const key = `${g.opening_eco}|${g.color}`;
      if (!openingMap[key]) {
        openingMap[key] = {
          eco: g.opening_eco,
          name: g.opening_name,
          color: g.color,
          games: 0,
          wins: 0,
        };
      }
      openingMap[key].games++;
      if (g.result === 'win') openingMap[key].wins++;
    }

    const allOpenings = Object.values(openingMap).sort(
      (a, b) => b.games - a.games
    );

    const whiteTop = allOpenings.filter((o) => o.color === 'white').slice(0, 6);
    const blackTop = allOpenings.filter((o) => o.color === 'black').slice(0, 6);

    renderOpeningChart('chart-openings-white', whiteTop);
    renderOpeningChart('chart-openings-black', blackTop);

    const tbody = document.getElementById('openings-body');
    tbody.innerHTML = allOpenings
      .slice(0, 30)
      .map((o) => {
        const winPct = o.games > 0 ? ((o.wins / o.games) * 100).toFixed(0) : 0;
        return `
      <tr>
        <td class="cell-code-strong">${esc(o.eco)}</td>
        <td>${truncate(o.name, 40)}</td>
        <td>${colorBadge(o.color)}</td>
        <td>${o.games}</td>
        <td>${o.wins}</td>
        <td>
          <div class="bar-row">
            <span class="bar-label ${openingToneTextClass(Number(winPct))}">${winPct}%</span>
            <div class="progress-bar progress-bar-flex">
              <progress
                class="progress-meter ${openingToneClass(Number(winPct))}"
                max="100"
                value="${winPct}"
              ></progress>
            </div>
          </div>
        </td>
      </tr>
    `;
      })
      .join('');
  }

  return {
    load,
  };
}
