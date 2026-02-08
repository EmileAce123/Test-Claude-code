// ============================================================
// app.js - Logique frontend du dashboard
// ============================================================
// Gere le chargement des donnees, les graphiques, les filtres,
// le tri et la pagination du tableau des trades.
// Rafraichissement automatique toutes les 30 secondes.
// ============================================================

// ---- Variables globales ----
let currentPage = 1;
let currentSort = { column: 'created_at', direction: 'desc' };
let allTrades = [];       // Tous les trades charges
let charts = {};          // Instances Chart.js
let refreshInterval = null;

// ---- Initialisation au chargement de la page ----
document.addEventListener('DOMContentLoaded', () => {
  refreshAll();
  loadPairFilter();

  // Rafraichissement automatique toutes les 30 secondes
  refreshInterval = setInterval(refreshAll, 30000);
});

// ============================================================
// CHARGEMENT DES DONNEES
// ============================================================

/**
 * Rafraichit toutes les donnees du dashboard.
 */
async function refreshAll() {
  try {
    await Promise.all([
      loadStats(),
      loadTrades(),
      loadCharts(),
      checkHealth(),
    ]);
    document.getElementById('lastRefresh').textContent =
      'Maj : ' + new Date().toLocaleTimeString('fr-FR');
  } catch (err) {
    console.error('Erreur rafraichissement :', err);
  }
}

/**
 * Charge les statistiques globales et met a jour les KPI.
 */
async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    if (response.status === 401) return window.location.href = '/login';
    const data = await response.json();

    // Profit cumule
    const profitEl = document.getElementById('kpiTotalProfit');
    profitEl.textContent = formatProfit(data.totalProfit);
    profitEl.className = 'kpi-value ' + (data.totalProfit >= 0 ? 'positive' : 'negative');
    document.getElementById('kpiTotalProfitSub').textContent =
      `Drawdown max : ${data.maxDrawdown}%`;

    // Win Rate
    const wrEl = document.getElementById('kpiWinRate');
    wrEl.textContent = data.winRate + '%';
    wrEl.className = 'kpi-value ' + (data.winRate >= 50 ? 'positive' : data.winRate > 0 ? 'negative' : 'neutral');
    document.getElementById('kpiWinRateSub').textContent =
      `${data.counts.won} gagnants / ${data.counts.lost} perdants`;

    // Total trades
    document.getElementById('kpiTotalTrades').textContent = data.counts.total;
    document.getElementById('kpiTotalTradesSub').textContent =
      `${data.counts.open} en cours | ${data.counts.cancelled} annules`;

    // Profit moyen
    const avgEl = document.getElementById('kpiAvgProfit');
    avgEl.textContent = formatProfit(data.avgProfit);
    avgEl.className = 'kpi-value ' + (data.avgProfit >= 0 ? 'positive' : 'negative');

    // Meilleur trade
    const bestEl = document.getElementById('kpiBestTrade');
    if (data.bestTrade) {
      bestEl.textContent = '+' + data.bestTrade.profit + '%';
      document.getElementById('kpiBestTradeSub').textContent =
        data.bestTrade.pair + ' ' + data.bestTrade.direction;
    } else {
      bestEl.textContent = '--';
    }

    // Pire trade
    const worstEl = document.getElementById('kpiWorstTrade');
    if (data.worstTrade) {
      worstEl.textContent = data.worstTrade.profit + '%';
      document.getElementById('kpiWorstTradeSub').textContent =
        data.worstTrade.pair + ' ' + data.worstTrade.direction;
    } else {
      worstEl.textContent = '--';
    }
  } catch (err) {
    console.error('Erreur chargement stats :', err);
  }
}

/**
 * Charge la liste des trades avec filtres et pagination.
 */
async function loadTrades() {
  try {
    const status = document.getElementById('filterStatus').value;
    const pair = document.getElementById('filterPair').value;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (pair) params.set('pair', pair);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('page', currentPage);
    params.set('limit', 50);

    const response = await fetch('/api/trades?' + params.toString());
    if (response.status === 401) return window.location.href = '/login';
    const data = await response.json();

    allTrades = data.trades;
    renderTrades(allTrades);

    // Pagination
    const { page, total, totalPages } = data.pagination;
    document.getElementById('paginationInfo').textContent =
      `Page ${page} / ${totalPages} (${total} trades)`;
    document.getElementById('prevBtn').disabled = page <= 1;
    document.getElementById('nextBtn').disabled = page >= totalPages;
  } catch (err) {
    console.error('Erreur chargement trades :', err);
  }
}

/**
 * Charge les donnees pour les graphiques.
 */
async function loadCharts() {
  try {
    const response = await fetch('/api/chart-data');
    if (response.status === 401) return window.location.href = '/login';
    const data = await response.json();

    renderProfitChart(data.profitOverTime);
    renderPairChart(data.byPair);
    renderDayChart(data.byDay);
    renderDistChart(data.profitDistribution);
    renderPairStatsTable(data.byPair);
  } catch (err) {
    console.error('Erreur chargement graphiques :', err);
  }
}

/**
 * Charge la liste des paires pour le filtre.
 */
async function loadPairFilter() {
  try {
    const response = await fetch('/api/pairs');
    if (response.status === 401) return;
    const pairs = await response.json();

    const select = document.getElementById('filterPair');
    // Garder seulement la premiere option "Toutes les paires"
    while (select.options.length > 1) select.remove(1);
    pairs.forEach(pair => {
      const opt = document.createElement('option');
      opt.value = pair;
      opt.textContent = pair;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Erreur chargement paires :', err);
  }
}

/**
 * Verifie l'etat de sante du systeme.
 */
async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();

    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');

    if (data.trackerActive) {
      dot.className = 'status-dot active';
      text.textContent = 'Bot actif | ' + data.signals + ' signaux';
    } else {
      dot.className = 'status-dot';
      text.textContent = 'Bot inactif | ' + data.signals + ' signaux';
    }
  } catch (err) {
    document.getElementById('statusDot').className = 'status-dot';
    document.getElementById('statusText').textContent = 'Erreur connexion';
  }
}

// ============================================================
// RENDU DES GRAPHIQUES
// ============================================================

// Couleurs communes pour Chart.js en dark mode
const chartDefaults = {
  color: '#8b949e',
  borderColor: '#30363d',
  gridColor: 'rgba(48, 54, 61, 0.6)',
};

/**
 * Graphique de profit cumule dans le temps.
 */
function renderProfitChart(profitData) {
  const ctx = document.getElementById('profitChart');
  if (charts.profit) charts.profit.destroy();

  if (!profitData || profitData.length === 0) {
    charts.profit = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: { plugins: { title: { display: true, text: 'Aucune donnee', color: '#8b949e' } } },
    });
    return;
  }

  const labels = profitData.map(d => formatDate(d.date));
  const values = profitData.map(d => d.profit);

  // Colorer en vert/rouge selon positif/negatif
  const pointColors = values.map(v => v >= 0 ? '#3fb950' : '#f85149');

  charts.profit = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Profit cumule (%)',
        data: values,
        borderColor: '#58a6ff',
        backgroundColor: 'rgba(88, 166, 255, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Profit cumule : ${ctx.parsed.y}%`,
            afterLabel: (ctx) => profitData[ctx.dataIndex] ? profitData[ctx.dataIndex].pair : '',
          },
        },
      },
      scales: {
        x: {
          ticks: { color: chartDefaults.color, maxTicksLimit: 15 },
          grid: { color: chartDefaults.gridColor },
        },
        y: {
          ticks: {
            color: chartDefaults.color,
            callback: (v) => v + '%',
          },
          grid: { color: chartDefaults.gridColor },
        },
      },
    },
  });
}

/**
 * Graphique a barres : profit par paire.
 */
function renderPairChart(byPair) {
  const ctx = document.getElementById('pairChart');
  if (charts.pair) charts.pair.destroy();

  if (!byPair || byPair.length === 0) {
    charts.pair = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [] },
    });
    return;
  }

  const sorted = [...byPair].sort((a, b) => b.totalProfit - a.totalProfit);
  const labels = sorted.map(p => p.pair);
  const values = sorted.map(p => p.totalProfit);
  const colors = values.map(v => v >= 0 ? '#3fb950' : '#f85149');

  charts.pair = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Profit total (%)',
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: chartDefaults.color },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: chartDefaults.color,
            callback: (v) => v + '%',
          },
          grid: { color: chartDefaults.gridColor },
        },
      },
    },
  });
}

/**
 * Graphique a barres : performance par jour.
 */
function renderDayChart(byDay) {
  const ctx = document.getElementById('dayChart');
  if (charts.day) charts.day.destroy();

  if (!byDay) return;

  const labels = byDay.map(d => d.day);
  const values = byDay.map(d => d.totalProfit);
  const colors = values.map(v => v >= 0 ? '#3fb950' : '#f85149');

  charts.day = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Profit total (%)',
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: chartDefaults.color },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: chartDefaults.color,
            callback: (v) => v + '%',
          },
          grid: { color: chartDefaults.gridColor },
        },
      },
    },
  });
}

/**
 * Histogramme de distribution des profits.
 */
function renderDistChart(distData) {
  const ctx = document.getElementById('distChart');
  if (charts.dist) charts.dist.destroy();

  if (!distData || distData.bins.length === 0) {
    charts.dist = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [] },
    });
    return;
  }

  charts.dist = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: distData.bins,
      datasets: [{
        label: 'Nombre de trades',
        data: distData.counts,
        backgroundColor: '#bc8cff',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: chartDefaults.color, maxRotation: 45 },
          grid: { display: false },
        },
        y: {
          ticks: { color: chartDefaults.color, stepSize: 1 },
          grid: { color: chartDefaults.gridColor },
        },
      },
    },
  });
}

/**
 * Tableau de stats par paire (dans le chart-card).
 */
function renderPairStatsTable(byPair) {
  const tbody = document.getElementById('pairStatsBody');
  if (!byPair || byPair.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#656d76;">Aucune donnee</td></tr>';
    return;
  }

  const sorted = [...byPair].sort((a, b) => b.totalProfit - a.totalProfit);
  tbody.innerHTML = sorted.map(p => `
    <tr>
      <td><strong>${p.pair}</strong></td>
      <td>${p.trades}</td>
      <td class="${p.winRate >= 50 ? 'profit-positive' : 'profit-negative'}">${p.winRate}%</td>
      <td class="${p.totalProfit >= 0 ? 'profit-positive' : 'profit-negative'}">${formatProfit(p.totalProfit)}</td>
    </tr>
  `).join('');
}

// ============================================================
// RENDU DU TABLEAU DES TRADES
// ============================================================

/**
 * Affiche les trades dans le tableau HTML.
 */
function renderTrades(trades) {
  const tbody = document.getElementById('tradesBody');

  if (!trades || trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#656d76;padding:40px;">Aucun trade pour ces filtres.</td></tr>';
    return;
  }

  tbody.innerHTML = trades.map(trade => {
    const targets = Array.isArray(trade.targets) ? trade.targets : [];
    const targetsHit = trade.last_target_hit || 0;

    return `
      <tr>
        <td>${formatDate(trade.created_at)}</td>
        <td><strong>${trade.pair}</strong></td>
        <td class="direction-${trade.direction.toLowerCase()}">${trade.direction}</td>
        <td>$${trade.entry_price_min} - $${trade.entry_price_max}</td>
        <td>X${trade.leverage}</td>
        <td>${targetsHit}/${targets.length}</td>
        <td class="${(trade.final_profit_pct || 0) >= 0 ? 'profit-positive' : 'profit-negative'}">
          ${trade.final_profit_pct != null ? formatProfit(trade.final_profit_pct) : '--'}
        </td>
        <td>$${trade.stop_loss}</td>
        <td>${statusBadge(trade.status)}</td>
      </tr>
    `;
  }).join('');
}

// ============================================================
// TRI ET PAGINATION
// ============================================================

/**
 * Trie les trades par colonne.
 */
function sortTrades(column) {
  if (currentSort.column === column) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.column = column;
    currentSort.direction = 'desc';
  }

  allTrades.sort((a, b) => {
    let valA = a[column];
    let valB = b[column];

    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();

    if (valA == null) valA = currentSort.direction === 'asc' ? Infinity : -Infinity;
    if (valB == null) valB = currentSort.direction === 'asc' ? Infinity : -Infinity;

    if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
    if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
    return 0;
  });

  renderTrades(allTrades);
}

/**
 * Change de page.
 */
function changePage(delta) {
  currentPage = Math.max(1, currentPage + delta);
  loadTrades();
}

// ============================================================
// UTILITAIRES
// ============================================================

/**
 * Formate un profit avec signe et %.
 */
function formatProfit(value) {
  if (value == null) return '--';
  const rounded = Math.round(value * 100) / 100;
  return (rounded >= 0 ? '+' : '') + rounded + '%';
}

/**
 * Formate une date en format lisible.
 */
function formatDate(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.substring(0, 16);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Retourne un badge HTML pour le statut.
 */
function statusBadge(status) {
  const map = {
    'open':       { label: 'En cours',   css: 'badge-open' },
    'tp_hit':     { label: 'TP Hit',     css: 'badge-won' },
    'all_tp_hit': { label: 'All TP',     css: 'badge-won' },
    'sl_hit':     { label: 'SL Hit',     css: 'badge-lost' },
    'cancelled':  { label: 'Annule',     css: 'badge-cancelled' },
  };
  const s = map[status] || { label: status, css: '' };
  return `<span class="badge ${s.css}">${s.label}</span>`;
}

/**
 * Deconnexion.
 */
async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {
    // Ignorer
  }
  window.location.href = '/login';
}
