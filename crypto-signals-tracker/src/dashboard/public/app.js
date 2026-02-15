// ============================================================
// app.js - Frontend simplifie du dashboard
// ============================================================

// ---- Initialisation ----
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  setInterval(loadDashboard, 30000);
});

// ============================================================
// CHARGEMENT PRINCIPAL
// ============================================================

async function loadDashboard() {
  try {
    await Promise.all([
      loadBalance(),
      loadStats(),
      loadPositions(),
      loadRecentTrades(),
      loadTradingMode(),
    ]);
  } catch (err) {
    console.error('Erreur rafraichissement :', err);
  }
}

// ============================================================
// BALANCE BINANCE
// ============================================================

async function loadBalance() {
  try {
    const res = await fetch('/api/binance/balance');
    if (res.status === 401) return;
    const data = await res.json();

    const balanceEl = document.getElementById('balance');
    if (data.totalBalance != null) {
      balanceEl.textContent = data.totalBalance.toFixed(2) + ' USDT';
    } else if (data.balance != null) {
      balanceEl.textContent = data.balance.toFixed(2) + ' USDT';
    }
  } catch (err) {
    console.error('Erreur balance :', err);
  }
}

// ============================================================
// STATS DU JOUR
// ============================================================

async function loadStats() {
  try {
    const res = await fetch('/api/stats/today');
    if (res.status === 401) return;
    const stats = await res.json();

    document.getElementById('totalTrades').textContent = stats.totalTrades;
    document.getElementById('openPositions').textContent = stats.openPositions;
    document.getElementById('winRate').textContent = stats.winRate + '%';
    document.getElementById('avgReaction').textContent = stats.avgReactionTime;

    const pnlEl = document.getElementById('pnlToday');
    const pnl = stats.pnlToday || 0;
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$';
    pnlEl.className = 'info-value ' + (pnl >= 0 ? 'positive' : 'negative');

    // Warning banner si trop de positions
    var banner = document.getElementById('warningBanner');
    var maxPos = stats.maxPositions || 20;
    if (stats.openPositions > maxPos * 0.75) {
      banner.textContent = 'ATTENTION : ' + stats.openPositions + ' positions ouvertes (max : ' + maxPos + ')';
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
    }
  } catch (err) {
    console.error('Erreur stats :', err);
  }
}

// ============================================================
// POSITIONS OUVERTES
// ============================================================

async function loadPositions() {
  try {
    const res = await fetch('/api/positions/open');
    if (res.status === 401) return;
    const positions = await res.json();

    const table = document.getElementById('positionsTable');
    const empty = document.getElementById('noPositions');
    const tbody = document.getElementById('positionsList');
    const count = document.getElementById('countOpen');

    count.textContent = '(' + positions.length + ')';

    if (positions.length === 0) {
      table.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    table.style.display = 'table';
    empty.style.display = 'none';

    tbody.innerHTML = positions.map(function(p) {
      var pnl = p.pnl || 0;
      var pnlClass = pnl >= 0 ? 'positive' : 'negative';
      var sideClass = (p.side === 'LONG' || p.side === 'BUY') ? 'long' : 'short';
      var sideLabel = (p.side === 'BUY') ? 'LONG' : (p.side === 'SELL') ? 'SHORT' : p.side;

      return '<tr>' +
        '<td><strong>' + p.symbol + '</strong></td>' +
        '<td class="' + sideClass + '">' + sideLabel + '</td>' +
        '<td>X' + p.leverage + '</td>' +
        '<td>' + formatPrice(p.entryPrice) + '</td>' +
        '<td>' + (p.currentPrice ? formatPrice(p.currentPrice) : '--') + '</td>' +
        '<td class="' + pnlClass + '">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$</td>' +
        '<td><button class="btn-close" onclick="closePosition(\'' + p.symbol + '\')">Fermer</button></td>' +
        '</tr>';
    }).join('');
  } catch (err) {
    console.error('Erreur positions :', err);
  }
}

// ============================================================
// DERNIERS TRADES FERMES
// ============================================================

async function loadRecentTrades() {
  try {
    const res = await fetch('/api/trades/recent');
    if (res.status === 401) return;
    const trades = await res.json();

    const table = document.getElementById('tradesTable');
    const empty = document.getElementById('noTrades');
    const tbody = document.getElementById('closedTrades');

    if (trades.length === 0) {
      table.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    table.style.display = 'table';
    empty.style.display = 'none';

    tbody.innerHTML = trades.map(function(t) {
      var statusMap = {
        'closed': 'TP',
        'manual_close': 'Manuel',
        'stopped': 'SL',
        'liquidated': 'Liquide'
      };
      var statusLabel = statusMap[t.status] || t.status;

      var pnl = t.pnl_total;
      var pnlText = pnl != null ? ((pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$') : '--';
      var pnlClass = pnl != null ? (pnl >= 0 ? 'positive' : 'negative') : '';

      var sideClass = t.direction === 'LONG' ? 'long' : 'short';

      var dateStr = '--';
      if (t.created_at) {
        var d = new Date(t.created_at);
        dateStr = d.toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
      }

      return '<tr>' +
        '<td>' + dateStr + '</td>' +
        '<td><strong>' + t.pair + '</strong></td>' +
        '<td class="' + sideClass + '">' + t.direction + '</td>' +
        '<td>' + statusLabel + '</td>' +
        '<td class="' + pnlClass + '">' + pnlText + '</td>' +
        '</tr>';
    }).join('');
  } catch (err) {
    console.error('Erreur trades recents :', err);
  }
}

// ============================================================
// TRADING MODE
// ============================================================

async function loadTradingMode() {
  try {
    const res = await fetch('/api/trading/status');
    if (res.status === 401) return;
    const status = await res.json();

    var badge = document.getElementById('modeBadge');
    var mode = status.mode || 'simulation';
    badge.textContent = mode.toUpperCase();
    badge.className = 'mode-badge ' + mode;

    // Kill switch visibility
    var killBtn = document.getElementById('killSwitchBtn');
    if (mode === 'simulation' || !status.killSwitchEnabled) {
      killBtn.style.display = 'none';
    } else {
      killBtn.style.display = 'inline-block';
      if (status.killSwitchActive) {
        killBtn.textContent = 'KILL ACTIVE';
        killBtn.disabled = true;
      }
    }
  } catch (err) {
    console.error('Erreur trading mode :', err);
  }
}

// ============================================================
// ACTIONS
// ============================================================

async function closePosition(symbol) {
  if (!confirm('Fermer la position ' + symbol + ' ?')) return;

  try {
    // Chercher le signal correspondant via Binance positions
    var res = await fetch('/api/binance/positions');
    var data = await res.json();
    var position = data.positions.find(function(p) {
      return p.symbol === symbol || (p.pair && p.pair.replace('/', '') === symbol);
    });

    if (position && position.id) {
      // Mode simulation : fermeture via API trades
      var closeRes = await fetch('/api/trades/' + position.id + '/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent: 100 }),
      });
      var result = await closeRes.json();
      if (result.success) {
        alert('Position fermee !');
      } else {
        alert('Erreur: ' + (result.error || 'Erreur inconnue'));
      }
    } else {
      // Mode trading reel : fermeture via trading engine (emergency close sur le symbole)
      var closeRes = await fetch('/api/emergency/close-all', { method: 'POST' });
      var result = await closeRes.json();
      alert(result.message || 'Positions fermees');
    }

    loadDashboard();
  } catch (err) {
    alert('Erreur: ' + err.message);
  }
}

async function emergencyClose() {
  if (!confirm('FERMER TOUTES LES POSITIONS ?\n\nCette action est irreversible.')) return;
  if (!confirm('CONFIRMATION FINALE\n\nActiver le KILL SWITCH ?')) return;

  try {
    var res = await fetch('/api/emergency/close-all', { method: 'POST' });
    var data = await res.json();

    if (data.success) {
      alert('Kill switch active.\n' + data.message);
      loadDashboard();
    } else {
      alert('Erreur: ' + (data.error || 'Erreur inconnue'));
    }
  } catch (err) {
    alert('Erreur: ' + err.message);
  }
}

// ============================================================
// UTILITAIRES
// ============================================================

function formatPrice(price) {
  if (price == null) return '--';
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}
