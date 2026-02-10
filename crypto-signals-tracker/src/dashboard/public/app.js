// ============================================================
// app.js - Logique frontend du dashboard (pyramidal multi-TP)
// ============================================================

// ---- Variables globales ----
let currentPage = 1;
let currentSort = { column: 'created_at', direction: 'desc' };
let allTrades = [];
let charts = {};
let refreshInterval = null;
let closeModalTradeId = null;

// ---- Initialisation ----
document.addEventListener('DOMContentLoaded', () => {
  refreshAll();
  loadPairFilter();
  loadGroupFilter();
  refreshInterval = setInterval(refreshAll, 30000);
});

// ============================================================
// CHARGEMENT DES DONNEES
// ============================================================

async function refreshAll() {
  try {
    await Promise.all([
      loadStats(),
      loadTrades(),
      loadCharts(),
      loadPortfolio(),
      loadActivePositions(),
      checkHealth(),
      updateRealtimeIndicator(),
    ]);
    document.getElementById('lastRefresh').textContent =
      'Maj : ' + new Date().toLocaleTimeString('fr-FR');
  } catch (err) {
    console.error('Erreur rafraichissement :', err);
  }
}

async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    if (response.status === 401) return window.location.href = '/login';
    const data = await response.json();

    const profitEl = document.getElementById('kpiTotalProfit');
    profitEl.textContent = formatProfit(data.totalProfit);
    profitEl.className = 'kpi-value ' + (data.totalProfit >= 0 ? 'positive' : 'negative');
    document.getElementById('kpiTotalProfitSub').textContent =
      'Drawdown max : ' + data.maxDrawdown + '%';

    const wrEl = document.getElementById('kpiWinRate');
    wrEl.textContent = data.winRate + '%';
    wrEl.className = 'kpi-value ' + (data.winRate >= 50 ? 'positive' : data.winRate > 0 ? 'negative' : 'neutral');
    document.getElementById('kpiWinRateSub').textContent =
      data.counts.won + ' gagnants / ' + data.counts.lost + ' perdants';

    document.getElementById('kpiTotalTrades').textContent = data.counts.total;
    document.getElementById('kpiTotalTradesSub').textContent =
      data.counts.open + ' en cours | ' + data.counts.cancelled + ' annules';

    const avgEl = document.getElementById('kpiAvgProfit');
    avgEl.textContent = formatProfit(data.avgProfit);
    avgEl.className = 'kpi-value ' + (data.avgProfit >= 0 ? 'positive' : 'negative');

    const bestEl = document.getElementById('kpiBestTrade');
    if (data.bestTrade) {
      bestEl.textContent = '+' + data.bestTrade.profit + '%';
      document.getElementById('kpiBestTradeSub').textContent =
        data.bestTrade.pair + ' ' + data.bestTrade.direction;
    } else {
      bestEl.textContent = '--';
    }

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

async function loadTrades() {
  try {
    const group = document.getElementById('filterGroup').value;
    const status = document.getElementById('filterStatus').value;
    const pair = document.getElementById('filterPair').value;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;

    const params = new URLSearchParams();
    if (group) params.set('group', group);
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

    const { page, total, totalPages } = data.pagination;
    document.getElementById('paginationInfo').textContent =
      'Page ' + page + ' / ' + totalPages + ' (' + total + ' trades)';
    document.getElementById('prevBtn').disabled = page <= 1;
    document.getElementById('nextBtn').disabled = page >= totalPages;
  } catch (err) {
    console.error('Erreur chargement trades :', err);
  }
}

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

async function loadPairFilter() {
  try {
    const response = await fetch('/api/pairs');
    if (response.status === 401) return;
    const pairs = await response.json();

    const select = document.getElementById('filterPair');
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

async function loadGroupFilter() {
  try {
    const response = await fetch('/api/groups');
    if (response.status === 401) return;
    const groups = await response.json();

    const select = document.getElementById('filterGroup');
    while (select.options.length > 1) select.remove(1);
    groups.forEach(group => {
      const opt = document.createElement('option');
      opt.value = group;
      opt.textContent = group.replace('CryptoMau ', '').replace(' Trading Signals', '').replace(' Signals', '');
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Erreur chargement groupes :', err);
  }
}

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
// PORTEFEUILLE
// ============================================================

async function loadPortfolio() {
  try {
    const response = await fetch('/api/portfolio');
    if (response.status === 401) return;
    const data = await response.json();

    const capEl = document.getElementById('portfolioCapital');
    capEl.textContent = data.current.toFixed(2) + '$';
    capEl.className = 'stat-value ' + (data.current >= data.initial ? 'positive' : 'negative');
    document.getElementById('portfolioCapitalSub').textContent =
      'Initial : ' + data.initial.toFixed(2) + '$';

    const roiEl = document.getElementById('portfolioRoi');
    roiEl.textContent = (data.roi >= 0 ? '+' : '') + data.roi + '%';
    roiEl.className = 'stat-value ' + (data.roi >= 0 ? 'positive' : 'negative');

    const gainEl = document.getElementById('portfolioGain');
    gainEl.textContent = (data.totalGain >= 0 ? '+' : '') + data.totalGain.toFixed(2) + '$';
    gainEl.className = 'stat-value ' + (data.totalGain >= 0 ? 'positive' : 'negative');

    document.getElementById('portfolioFees').textContent = data.totalFees.toFixed(2) + '$';

    const wrEl = document.getElementById('portfolioWinRate');
    wrEl.textContent = data.winRate + '%';
    wrEl.className = 'stat-value ' + (data.winRate >= 50 ? 'positive' : data.winRate > 0 ? 'negative' : 'neutral');
    document.getElementById('portfolioWinRateSub').textContent =
      data.winCount + 'W / ' + data.lossCount + 'L';

    document.getElementById('portfolioMaxLosses').textContent = data.maxConsecutiveLosses;

    // Exposition
    const exposureEl = document.getElementById('portfolioExposure');
    const exposure = data.exposure || 0;
    exposureEl.textContent = exposure.toFixed(2) + '$';
    const latentTotal = data.latentTotal || 0;
    const capitalWithLatent = data.current + latentTotal;
    document.getElementById('portfolioExposureSub').textContent =
      'Dispo : ' + (data.current - exposure).toFixed(2) + '$' +
      (latentTotal !== 0 ? ' | Latent : ' + (latentTotal >= 0 ? '+' : '') + latentTotal.toFixed(2) + '$' : '');

    renderPortfolioChart(data.history);
  } catch (err) {
    console.error('Erreur chargement portfolio :', err);
  }
}

// ============================================================
// POSITIONS OUVERTES
// ============================================================

async function loadActivePositions() {
  try {
    const response = await fetch('/api/trades/active');
    if (response.status === 401) return;
    const positions = await response.json();

    const section = document.getElementById('activePositionsSection');
    const container = document.getElementById('activePositionsContainer');

    if (!positions || positions.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    container.innerHTML = positions.map(pos => {
      const closedPct = (100 - (pos.position_remaining_percent || 100)).toFixed(1);
      const tps = pos.targetsHitList ? pos.targetsHitList.join(', ') : '--';
      const realized = pos.profit_realized_total || 0;
      const latent = pos.profit_latent || 0;
      const pnl = pos.pnl_total || 0;
      const remaining = pos.position_remaining_size || 0;
      const currentPrice = pos.current_price;
      const lastUpdate = pos.last_price_update ? timeAgo(pos.last_price_update) : '--';

      let priceInfo = '';
      if (currentPrice) {
        const entryPrice = pos.entry_price_real;
        let pctChange = '';
        if (entryPrice) {
          const change = pos.direction === 'LONG'
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : ((entryPrice - currentPrice) / entryPrice * 100);
          pctChange = ' (' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%)';
        }
        priceInfo = '$' + formatPrice(currentPrice) + pctChange + ' - ' + lastUpdate;
      }

      return '<div class="active-position-card">' +
        '<div class="ap-header">' +
          '<strong>' + pos.pair + '</strong> ' +
          '<span class="direction-' + pos.direction.toLowerCase() + '">' + pos.direction + '</span> ' +
          'X' + pos.leverage +
          (priceInfo ? '<span class="ap-price">' + priceInfo + '</span>' : '') +
        '</div>' +
        '<div class="ap-body">' +
          '<div class="ap-row"><span>Position restante</span><span>' + (pos.position_remaining_percent || 0).toFixed(1) + '% (' + remaining.toFixed(2) + '$)</span></div>' +
          '<div class="ap-row"><span>Ferme</span><span>' + closedPct + '% (' + tps + ')</span></div>' +
          '<div class="ap-row"><span>Profit realise</span><span class="' + (realized >= 0 ? 'profit-positive' : 'profit-negative') + '">' + (realized >= 0 ? '+' : '') + realized.toFixed(2) + '$</span></div>' +
          '<div class="ap-row"><span>P&L latent</span><span class="' + (latent >= 0 ? 'profit-positive' : 'profit-negative') + '">' + (latent >= 0 ? '+' : '') + latent.toFixed(2) + '$</span></div>' +
          '<div class="ap-row ap-total"><span>P&L total</span><span class="' + (pnl >= 0 ? 'profit-positive' : 'profit-negative') + '">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$</span></div>' +
        '</div>' +
        '<div class="ap-actions">' +
          '<button class="btn btn-close-full" onclick="closeTrade(' + pos.id + ', 100)">Fermer 100%</button>' +
          '<button class="btn btn-close-partial" onclick="closeTrade(' + pos.id + ', 50)">Fermer 50%</button>' +
          '<button class="btn btn-close-custom" onclick="showCloseModal(' + pos.id + ')">Fermer %...</button>' +
          '<button class="btn btn-detail" onclick="showTradeDetail(' + pos.id + ')">Details</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    console.error('Erreur chargement positions actives :', err);
  }
}

// ============================================================
// MODAL DETAIL TRADE
// ============================================================

async function showTradeDetail(tradeId) {
  const modal = document.getElementById('tradeModal');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  modal.classList.add('visible');
  body.innerHTML = 'Chargement...';

  try {
    const response = await fetch('/api/trades/' + tradeId + '/executions');
    if (response.status === 401) return window.location.href = '/login';
    const data = await response.json();

    const sig = data.signal;
    const execs = data.executions || [];

    title.textContent = sig.pair + ' ' + sig.direction + ' X' + sig.leverage;

    let html = '<div class="modal-info">';
    html += '<div class="mi-row"><span>Position initiale</span><span>' + (sig.position_size_initial || 0).toFixed(2) + '$</span></div>';
    html += '<div class="mi-row"><span>Entree</span><span>$' + sig.entry_price_min + ' - $' + sig.entry_price_max + '</span></div>';
    if (sig.entry_price_real) {
      html += '<div class="mi-row"><span>Entree reelle</span><span>$' + formatPrice(sig.entry_price_real) + '</span></div>';
    }
    if (sig.current_price) {
      html += '<div class="mi-row"><span>Prix actuel</span><span>$' + formatPrice(sig.current_price) + (sig.last_price_update ? ' (' + timeAgo(sig.last_price_update) + ')' : '') + '</span></div>';
    }
    html += '<div class="mi-row"><span>Stop Loss</span><span>$' + sig.stop_loss + '</span></div>';
    html += '<div class="mi-row"><span>Statut</span><span>' + statusBadge(sig.status) + '</span></div>';
    html += '</div>';

    if (execs.length > 0) {
      html += '<h4 style="margin:16px 0 8px;color:var(--accent-blue);">Executions</h4>';
      html += '<table class="modal-table"><thead><tr><th>TP</th><th>Type</th><th>% Ferme</th><th>Taille</th><th>Profit %</th><th>Profit $</th></tr></thead><tbody>';

      let totalRealized = 0;
      for (const ex of execs) {
        const isSL = ex.target_number === 0;
        const isManual = ex.target_number === 999;
        const label = isSL ? 'SL' : isManual ? 'MANUAL' : 'TP' + ex.target_number;
        const execType = ex.execution_type || 'auto';
        const typeBadge = execType === 'manual' ? '<span class="badge badge-manual">Manuel</span>'
          : execType === 'stop_loss' ? '<span class="badge badge-lost">SL</span>'
          : '<span class="badge badge-open">Auto</span>';
        const profitClass = ex.profit_realized >= 0 ? 'profit-positive' : 'profit-negative';
        totalRealized += ex.profit_realized || 0;

        html += '<tr>';
        html += '<td><strong>' + label + '</strong></td>';
        html += '<td>' + typeBadge + '</td>';
        html += '<td>' + (ex.position_closed_percent || 0).toFixed(1) + '%</td>';
        html += '<td>' + (ex.position_closed_size || 0).toFixed(2) + '$</td>';
        html += '<td class="' + profitClass + '">' + (ex.profit_realized_percent || 0).toFixed(2) + '%</td>';
        html += '<td class="' + profitClass + '">' + (ex.profit_realized >= 0 ? '+' : '') + (ex.profit_realized || 0).toFixed(2) + '$</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';

      html += '<div class="modal-summary">';
      html += '<div class="mi-row"><span>Total realise</span><span class="' + (totalRealized >= 0 ? 'profit-positive' : 'profit-negative') + '">' + (totalRealized >= 0 ? '+' : '') + totalRealized.toFixed(2) + '$</span></div>';
      const remaining = sig.position_remaining_percent || 0;
      html += '<div class="mi-row"><span>Position restante</span><span>' + remaining.toFixed(1) + '%' + (remaining > 0 ? ' (' + (sig.position_remaining_size || 0).toFixed(2) + '$)' : '') + '</span></div>';
      if (sig.profit_latent && remaining > 0) {
        html += '<div class="mi-row"><span>P&L latent</span><span class="' + (sig.profit_latent >= 0 ? 'profit-positive' : 'profit-negative') + '">' + (sig.profit_latent >= 0 ? '+' : '') + sig.profit_latent.toFixed(2) + '$</span></div>';
      }
      const pnl = sig.pnl_total || totalRealized;
      html += '<div class="mi-row mi-total"><span>P&L Total</span><span class="' + (pnl >= 0 ? 'profit-positive' : 'profit-negative') + '">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$</span></div>';
      html += '</div>';
    } else {
      html += '<p style="color:var(--text-muted);margin-top:16px;">Aucune execution enregistree.</p>';
    }

    // Bouton fermeture manuelle si position ouverte
    if (['open', 'partial'].includes(sig.status) && sig.position_size_initial > 0) {
      html += '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">';
      html += '<button class="btn btn-close-full" onclick="closeModal();closeTrade(' + sig.id + ', 100)">Fermer 100%</button>';
      html += '<button class="btn btn-close-partial" onclick="closeModal();closeTrade(' + sig.id + ', 50)">Fermer 50%</button>';
      html += '<button class="btn btn-close-custom" onclick="closeModal();showCloseModal(' + sig.id + ')">Fermer %...</button>';
      html += '</div>';
    }

    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = '<p style="color:var(--accent-red);">Erreur chargement details.</p>';
    console.error('Erreur modal :', err);
  }
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('tradeModal').classList.remove('visible');
}

// ============================================================
// RENDU DES GRAPHIQUES
// ============================================================

const chartDefaults = {
  color: '#8b949e',
  borderColor: '#30363d',
  gridColor: 'rgba(48, 54, 61, 0.6)',
};

function renderPortfolioChart(history) {
  const ctx = document.getElementById('portfolioChart');
  if (charts.portfolio) charts.portfolio.destroy();

  if (!history || history.length === 0) {
    charts.portfolio = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: { plugins: { title: { display: true, text: 'Aucune donnee', color: '#8b949e' } } },
    });
    return;
  }

  const labels = history.map(h => h.trade ? formatDate(h.date) : 'Debut');
  const values = history.map(h => h.capital);
  const pointColors = history.map(h => {
    if (h.trade === null) return '#bc8cff';
    return h.profitNet >= 0 ? '#3fb950' : '#f85149';
  });

  charts.portfolio = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Capital ($)',
        data: values,
        borderColor: '#bc8cff',
        backgroundColor: 'rgba(188, 140, 255, 0.1)',
        fill: true, tension: 0.3, pointRadius: 4,
        pointBackgroundColor: pointColors, pointBorderColor: pointColors,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => 'Capital : ' + ctx.parsed.y.toFixed(2) + '$',
            afterLabel: (ctx) => {
              const h = history[ctx.dataIndex];
              if (h && h.trade) {
                const sign = h.profitNet >= 0 ? '+' : '';
                return h.trade + '\nP&L : ' + sign + h.profitNet.toFixed(2) + '$';
              }
              return '';
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: chartDefaults.color, maxTicksLimit: 15 }, grid: { color: chartDefaults.gridColor } },
        y: { ticks: { color: chartDefaults.color, callback: (v) => v + '$' }, grid: { color: chartDefaults.gridColor } },
      },
    },
  });
}

function renderProfitChart(profitData) {
  const ctx = document.getElementById('profitChart');
  if (charts.profit) charts.profit.destroy();

  if (!profitData || profitData.length === 0) {
    charts.profit = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [] },
      options: { plugins: { title: { display: true, text: 'Aucune donnee', color: '#8b949e' } } } });
    return;
  }

  const labels = profitData.map(d => formatDate(d.date));
  const values = profitData.map(d => d.profit);
  const pointColors = values.map(v => v >= 0 ? '#3fb950' : '#f85149');

  charts.profit = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Profit cumule (%)', data: values,
        borderColor: '#58a6ff', backgroundColor: 'rgba(88, 166, 255, 0.1)',
        fill: true, tension: 0.3, pointRadius: 4,
        pointBackgroundColor: pointColors, pointBorderColor: pointColors,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: {
          label: (ctx) => 'Profit cumule : ' + ctx.parsed.y + '%',
          afterLabel: (ctx) => profitData[ctx.dataIndex] ? profitData[ctx.dataIndex].pair : '',
        } },
      },
      scales: {
        x: { ticks: { color: chartDefaults.color, maxTicksLimit: 15 }, grid: { color: chartDefaults.gridColor } },
        y: { ticks: { color: chartDefaults.color, callback: (v) => v + '%' }, grid: { color: chartDefaults.gridColor } },
      },
    },
  });
}

function renderPairChart(byPair) {
  const ctx = document.getElementById('pairChart');
  if (charts.pair) charts.pair.destroy();
  if (!byPair || byPair.length === 0) { charts.pair = new Chart(ctx, { type: 'bar', data: { labels: [], datasets: [] } }); return; }

  const sorted = [...byPair].sort((a, b) => b.totalProfit - a.totalProfit);
  charts.pair = new Chart(ctx, {
    type: 'bar',
    data: { labels: sorted.map(p => p.pair),
      datasets: [{ label: 'Profit total (%)', data: sorted.map(p => p.totalProfit),
        backgroundColor: sorted.map(p => p.totalProfit >= 0 ? '#3fb950' : '#f85149'), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: chartDefaults.color }, grid: { display: false } },
        y: { ticks: { color: chartDefaults.color, callback: (v) => v + '%' }, grid: { color: chartDefaults.gridColor } } } },
  });
}

function renderDayChart(byDay) {
  const ctx = document.getElementById('dayChart');
  if (charts.day) charts.day.destroy();
  if (!byDay) return;

  charts.day = new Chart(ctx, {
    type: 'bar',
    data: { labels: byDay.map(d => d.day),
      datasets: [{ label: 'Profit total (%)', data: byDay.map(d => d.totalProfit),
        backgroundColor: byDay.map(d => d.totalProfit >= 0 ? '#3fb950' : '#f85149'), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: chartDefaults.color }, grid: { display: false } },
        y: { ticks: { color: chartDefaults.color, callback: (v) => v + '%' }, grid: { color: chartDefaults.gridColor } } } },
  });
}

function renderDistChart(distData) {
  const ctx = document.getElementById('distChart');
  if (charts.dist) charts.dist.destroy();
  if (!distData || distData.bins.length === 0) { charts.dist = new Chart(ctx, { type: 'bar', data: { labels: [], datasets: [] } }); return; }

  charts.dist = new Chart(ctx, {
    type: 'bar',
    data: { labels: distData.bins,
      datasets: [{ label: 'Nombre de trades', data: distData.counts, backgroundColor: '#bc8cff', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: chartDefaults.color, maxRotation: 45 }, grid: { display: false } },
        y: { ticks: { color: chartDefaults.color, stepSize: 1 }, grid: { color: chartDefaults.gridColor } } } },
  });
}

function renderPairStatsTable(byPair) {
  const tbody = document.getElementById('pairStatsBody');
  if (!byPair || byPair.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#656d76;">Aucune donnee</td></tr>';
    return;
  }

  const sorted = [...byPair].sort((a, b) => b.totalProfit - a.totalProfit);
  tbody.innerHTML = sorted.map(p =>
    '<tr><td><strong>' + p.pair + '</strong></td><td>' + p.trades + '</td>' +
    '<td class="' + (p.winRate >= 50 ? 'profit-positive' : 'profit-negative') + '">' + p.winRate + '%</td>' +
    '<td class="' + (p.totalProfit >= 0 ? 'profit-positive' : 'profit-negative') + '">' + formatProfit(p.totalProfit) + '</td></tr>'
  ).join('');
}

// ============================================================
// RENDU DU TABLEAU DES TRADES (PYRAMIDAL)
// ============================================================

function renderTrades(trades) {
  const tbody = document.getElementById('tradesBody');

  if (!trades || trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#656d76;padding:40px;">Aucun trade pour ces filtres.</td></tr>';
    return;
  }

  tbody.innerHTML = trades.map(trade => {
    const posInitial = trade.position_size_initial;
    const posText = posInitial ? posInitial.toFixed(2) + '$' : '--';

    const closedPct = posInitial ? (100 - (trade.position_remaining_percent || 100)).toFixed(1) + '%' : '--';

    // Prix actuel
    let priceText = '--';
    if (trade.current_price) {
      priceText = '$' + formatPrice(trade.current_price);
      if (trade.last_price_update) {
        priceText += '<br><span class="price-age">' + timeAgo(trade.last_price_update) + '</span>';
      }
    }

    const realized = trade.profit_realized_total;
    const realizedText = realized != null ? ((realized >= 0 ? '+' : '') + realized.toFixed(2) + '$') : '--';
    const realizedClass = realized != null ? (realized >= 0 ? 'profit-positive' : 'profit-negative') : '';

    const latent = trade.profit_latent;
    const latentText = latent != null && latent !== 0 ? ((latent >= 0 ? '+' : '') + latent.toFixed(2) + '$') : '--';
    const latentClass = latent != null ? (latent >= 0 ? 'profit-positive' : 'profit-negative') : '';

    const pnl = trade.pnl_total;
    const pnlText = pnl != null ? ((pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$') : '--';
    const pnlClass = pnl != null ? (pnl >= 0 ? 'profit-positive' : 'profit-negative') : '';

    const source = trade.source_group_name
      ? trade.source_group_name.replace('CryptoMau ', '').replace(' Trading Signals', '').replace(' Signals', '')
      : '--';

    // Actions : boutons de fermeture si position ouverte
    let actionsHtml = '';
    if (trade.id && ['open', 'partial'].includes(trade.status) && posInitial > 0) {
      actionsHtml =
        '<div class="trade-actions-compact">' +
          '<button class="btn btn-detail" onclick="showTradeDetail(' + trade.id + ')">Details</button>' +
          '<button class="btn btn-close-sm" onclick="showCloseModal(' + trade.id + ')">Fermer</button>' +
        '</div>';
    } else if (trade.id) {
      actionsHtml = '<button class="btn btn-detail" onclick="showTradeDetail(' + trade.id + ')">Details</button>';
    } else {
      actionsHtml = '--';
    }

    return '<tr>' +
      '<td>' + formatDate(trade.created_at) + '</td>' +
      '<td><strong>' + trade.pair + '</strong></td>' +
      '<td class="direction-' + trade.direction.toLowerCase() + '">' + trade.direction + '</td>' +
      '<td>X' + trade.leverage + '</td>' +
      '<td>' + posText + '</td>' +
      '<td>' + closedPct + '</td>' +
      '<td>' + priceText + '</td>' +
      '<td class="' + realizedClass + '">' + realizedText + '</td>' +
      '<td class="' + latentClass + '">' + latentText + '</td>' +
      '<td class="' + pnlClass + '">' + pnlText + '</td>' +
      '<td><span class="badge badge-source">' + source + '</span></td>' +
      '<td>' + statusBadge(trade.status) + '</td>' +
      '<td>' + actionsHtml + '</td>' +
      '</tr>';
  }).join('');
}

// ============================================================
// TRI ET PAGINATION
// ============================================================

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

function changePage(delta) {
  currentPage = Math.max(1, currentPage + delta);
  loadTrades();
}

// ============================================================
// UTILITAIRES
// ============================================================

function formatProfit(value) {
  if (value == null) return '--';
  const rounded = Math.round(value * 100) / 100;
  return (rounded >= 0 ? '+' : '') + rounded + '%';
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.substring(0, 16);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusBadge(status) {
  const map = {
    'open':       { label: 'En attente',  css: 'badge-open' },
    'pending':    { label: 'En attente',  css: 'badge-open' },
    'partial':    { label: 'Partiel',     css: 'badge-partial' },
    'closed':     { label: 'Ferme',       css: 'badge-won' },
    'stopped':    { label: 'Stoppe',      css: 'badge-lost' },
    'manual_close': { label: 'Ferme manuellement', css: 'badge-manual' },
    'tp_hit':     { label: 'TP Hit',      css: 'badge-won' },
    'all_tp_hit': { label: 'All TP',      css: 'badge-won' },
    'sl_hit':     { label: 'SL Hit',      css: 'badge-lost' },
    'cancelled':  { label: 'Annule',      css: 'badge-cancelled' },
  };
  const s = map[status] || { label: status, css: '' };
  return '<span class="badge ' + s.css + '">' + s.label + '</span>';
}

// ============================================================
// FERMETURE MANUELLE
// ============================================================

async function closeTrade(tradeId, percent) {
  if (!confirm('Fermer ' + percent + '% de la position ?')) return;

  try {
    const response = await fetch('/api/trades/' + tradeId + '/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent }),
    });

    if (response.status === 401) return window.location.href = '/login';
    const result = await response.json();

    if (result.success) {
      const sign = result.profit >= 0 ? '+' : '';
      alert('Position fermee ! Profit: ' + sign + result.profit.toFixed(2) + '$\nRestant: ' + result.remaining + '%');
      refreshAll();
    } else {
      alert('Erreur: ' + (result.error || 'Erreur inconnue'));
    }
  } catch (error) {
    alert('Erreur reseau: ' + error.message);
  }
}

function showCloseModal(tradeId) {
  closeModalTradeId = tradeId;
  const trade = allTrades.find(t => t.id === tradeId);

  const modal = document.getElementById('closeModal');
  const pairEl = document.getElementById('closeModalPair');
  const remainingEl = document.getElementById('closeModalRemaining');
  const priceEl = document.getElementById('closeModalPrice');
  const slider = document.getElementById('closePercent');
  const btn = document.getElementById('confirmCloseBtn');

  if (trade) {
    pairEl.textContent = trade.pair + ' ' + trade.direction + ' X' + trade.leverage;
    remainingEl.textContent = (trade.position_remaining_percent || 100).toFixed(1) + '% (' + (trade.position_remaining_size || 0).toFixed(2) + '$)';
    priceEl.textContent = trade.current_price ? '$' + formatPrice(trade.current_price) : 'N/A';
  } else {
    pairEl.textContent = 'Trade #' + tradeId;
    remainingEl.textContent = '--';
    priceEl.textContent = '--';
  }

  slider.value = 100;
  document.getElementById('closePercentVal').textContent = '100%';
  btn.onclick = () => confirmManualClose();
  modal.classList.add('visible');
}

function setClosePercent(pct) {
  const slider = document.getElementById('closePercent');
  slider.value = pct;
  document.getElementById('closePercentVal').textContent = pct + '%';
}

async function confirmManualClose() {
  if (!closeModalTradeId) return;
  const percent = parseInt(document.getElementById('closePercent').value, 10);
  document.getElementById('closeModal').classList.remove('visible');
  await closeTrade(closeModalTradeId, percent);
  closeModalTradeId = null;
}

function closeCloseModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('closeModal').classList.remove('visible');
  closeModalTradeId = null;
}

// ============================================================
// INDICATEUR TEMPS REEL
// ============================================================

async function updateRealtimeIndicator() {
  try {
    const response = await fetch('/api/prices/current');
    if (response.status === 401) return;
    const data = await response.json();

    const dot = document.getElementById('rtDot');
    const text = document.getElementById('rtText');

    if (data.priceUpdaterActive && data.count > 0) {
      dot.className = 'rt-dot active';
      text.textContent = 'LIVE | ' + data.count + ' position(s)';
    } else if (data.priceUpdaterActive) {
      dot.className = 'rt-dot active';
      text.textContent = 'LIVE | Aucune position';
    } else {
      dot.className = 'rt-dot';
      text.textContent = 'Prix hors-ligne';
    }
  } catch (err) {
    document.getElementById('rtDot').className = 'rt-dot';
    document.getElementById('rtText').textContent = '--';
  }
}

// ============================================================
// UTILITAIRES SUPPLEMENTAIRES
// ============================================================

function formatPrice(price) {
  if (price == null) return '--';
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}

function timeAgo(dateStr) {
  if (!dateStr) return '--';
  const now = new Date();
  const then = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return diffSec + 's';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + 'min';
  const diffH = Math.floor(diffMin / 60);
  return diffH + 'h' + (diffMin % 60) + 'min';
}

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {
    // Ignorer
  }
  window.location.href = '/login';
}
