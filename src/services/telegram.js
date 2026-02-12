const axios = require('axios');
const config = require('../config');

const API_BASE = 'https://api.telegram.org/bot';

class TelegramService {
  constructor() {
    this.enabled = !!(config.telegram.botToken && config.telegram.chatId);
    if (!this.enabled) {
      console.warn('[telegram] Bot token or chat ID not configured. Alerts disabled.');
    }
  }

  async sendMessage(text) {
    if (!this.enabled) return;

    try {
      await axios.post(`${API_BASE}${config.telegram.botToken}/sendMessage`, {
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error('[telegram] Failed to send message:', err.message);
    }
  }

  formatSimpleAlert(opp) {
    return [
      `🔔 *ARBITRAGE SIMPLE*`,
      ``,
      `*Paire:* \`${opp.pair}\``,
      `*Acheter sur:* ${opp.buyExchange} @ \`${opp.buyPrice}\``,
      `*Vendre sur:* ${opp.sellExchange} @ \`${opp.sellPrice}\``,
      `*Profit brut:* ${opp.grossProfitPercent.toFixed(3)}%`,
      `*Profit net:* ${opp.netProfitPercent.toFixed(3)}%`,
      `*Frais:* ${opp.buyFeePercent}% (achat) + ${opp.sellFeePercent}% (vente)`,
      `*Heure:* ${opp.timestamp}`,
    ].join('\n');
  }

  formatTriangularAlert(opp) {
    const legsStr = opp.legs
      .map((l) => `  ${l.action.toUpperCase()} \`${l.pair}\` @ \`${l.price}\``)
      .join('\n');

    return [
      `🔺 *ARBITRAGE TRIANGULAIRE*`,
      ``,
      `*Exchange:* ${opp.exchange}`,
      `*Direction:* ${opp.direction}`,
      `*Étapes:*`,
      legsStr,
      `*Frais totaux:* ${opp.totalFeesPercent.toFixed(2)}%`,
      `*Profit net:* ${opp.netProfitPercent.toFixed(3)}%`,
      `*Heure:* ${opp.timestamp}`,
    ].join('\n');
  }

  async sendAlerts(opportunities, minProfit) {
    const filtered = opportunities.filter((o) => o.netProfitPercent >= minProfit);
    for (const opp of filtered) {
      const text =
        opp.type === 'simple'
          ? this.formatSimpleAlert(opp)
          : this.formatTriangularAlert(opp);
      await this.sendMessage(text);
    }
    return filtered.length;
  }
}

module.exports = TelegramService;
