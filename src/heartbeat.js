/**
 * Heartbeat Manager - Gestione Heartbeat Agent
 * 
 * Invia heartbeat periodici al backend per segnalare che l'agent è attivo.
 * Include metadata come hostname, devices_count, telemetry_sent.
 */

const os = require('os');

class HeartbeatManager {
  constructor(config, apiClient) {
    this.config = config;
    this.apiClient = apiClient;
    this.interval = 5 * 60 * 1000; // 5 minuti
    this.telemetrySent = 0;
    this.intervalId = null;
  }

  /**
   * Avvia il manager heartbeat
   */
  start() {
    console.log('💓 Heartbeat manager started (every 5 minutes)');
    
    // Invia heartbeat immediatamente
    this.sendHeartbeat();
    
    // Poi ogni 5 minuti
    this.intervalId = setInterval(() => this.sendHeartbeat(), this.interval);
  }

  /**
   * Ferma il manager heartbeat
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('💓 Heartbeat manager stopped');
    }
  }

  /**
   * Invia heartbeat al backend
   */
  async sendHeartbeat() {
    try {
      const payload = {
        hostname: os.hostname(),
        devices_count: this.config.printers?.length || 0,
        telemetry_sent: this.telemetrySent,
        platform: os.platform(),
        os_version: os.release(),
        agent_version: '1.0.0',
      };

      await this.apiClient.post('/agents/heartbeat', payload, {
        headers: {
          'x-agent-key': this.config.api_key,
        },
      });

      console.log('💓 Heartbeat sent successfully');
    } catch (error) {
      console.error('❌ Heartbeat failed:', error.message);
      // Non blocca l'agent se heartbeat fallisce
    }
  }

  /**
   * Incrementa contatore telemetry inviate
   */
  incrementTelemetry() {
    this.telemetrySent++;
  }

  /**
   * Reset contatore telemetry
   */
  resetTelemetry() {
    this.telemetrySent = 0;
  }

  /**
   * Ottieni statistiche
   */
  getStats() {
    return {
      telemetry_sent: this.telemetrySent,
      interval_minutes: this.interval / 60000,
      running: this.intervalId !== null,
    };
  }
}

module.exports = HeartbeatManager;
