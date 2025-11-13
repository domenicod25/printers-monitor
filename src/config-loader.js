/**
 * Config Loader - Sistema Unificato di Configurazione
 * 
 * Priorità (dal più alto al più basso):
 * 1. Environment Variables (BACKEND_URL, API_KEY, COMPANY_ID, PRINTERS)
 * 2. embedded-config.json (produzione - embedded in nexe)
 * 3. configs/config.json (development fallback)
 * 
 * Schema Unificato (FLAT):
 * {
 *   backend_url: string,
 *   api_key: string,
 *   company_id: string,
 *   printers: Array<{ip, community, enabled}>,
 *   schedule: {interval_minutes, walk_on_unknown, upload_walks}
 * }
 */

const fs = require('fs');
const path = require('path');

class ConfigLoader {
  /**
   * Carica configurazione con priorità chiara
   */
  static load() {
    console.log('🔧 Loading configuration...');
    
    // 1. Tenta caricamento da varie sorgenti
    let config = this.loadEmbedded() || this.loadFromFile();
    
    if (!config) {
      throw new Error('❌ No configuration found! Expected embedded-config.json or configs/config.json');
    }
    
    // 2. Applica override da environment variables
    config = this.applyEnvOverrides(config);
    
    // 3. Normalizza schema (supporta backward compatibility)
    config = this.normalizeSchema(config);
    
    // 4. Valida configurazione
    this.validateConfig(config);
    
    console.log('✅ Configuration loaded successfully');
    this.logConfigSummary(config);
    
    return config;
  }
  
  /**
   * Carica embedded-config.json (produzione)
   */
  static loadEmbedded() {
    try {
      const embeddedPath = path.join(__dirname, 'embedded-config.json');
      
      if (!fs.existsSync(embeddedPath)) {
        return null;
      }
      
      const configContent = fs.readFileSync(embeddedPath, 'utf-8');
      const config = JSON.parse(configContent);
      
      console.log('   📦 Loaded: embedded-config.json');
      return config;
    } catch (error) {
      console.warn(`   ⚠️  Failed to load embedded config: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Carica configs/config.json (development fallback)
   */
  static loadFromFile() {
    try {
      const configPath = path.join(__dirname, '../configs/config.json');
      
      if (!fs.existsSync(configPath)) {
        return null;
      }
      
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      
      console.log('   📄 Loaded: configs/config.json (development)');
      return config;
    } catch (error) {
      console.warn(`   ⚠️  Failed to load file config: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Applica override da environment variables
   */
  static applyEnvOverrides(config) {
    const overrides = {};
    let hasOverrides = false;
    
    // Backend URL
    if (process.env.BACKEND_URL) {
      overrides.backend_url = process.env.BACKEND_URL;
      hasOverrides = true;
      console.log('   🔀 Override: BACKEND_URL from env');
    }
    
    // API Key
    if (process.env.API_KEY) {
      overrides.api_key = process.env.API_KEY;
      hasOverrides = true;
      console.log('   🔀 Override: API_KEY from env');
    }
    
    // Company ID
    if (process.env.COMPANY_ID) {
      overrides.company_id = process.env.COMPANY_ID;
      hasOverrides = true;
      console.log('   🔀 Override: COMPANY_ID from env');
    }
    
    // Printers (JSON string)
    if (process.env.PRINTERS) {
      try {
        overrides.printers = JSON.parse(process.env.PRINTERS);
        hasOverrides = true;
        console.log('   🔀 Override: PRINTERS from env');
      } catch (error) {
        console.warn('   ⚠️  Invalid PRINTERS env var (expected JSON)');
      }
    }
    
    // Interval Minutes (FLAT schema)
    if (process.env.INTERVAL_MINUTES) {
      overrides.interval_minutes = parseInt(process.env.INTERVAL_MINUTES, 10);
      hasOverrides = true;
      console.log('   🔀 Override: INTERVAL_MINUTES from env');
    }
    
    return hasOverrides ? { ...config, ...overrides } : config;
  }
  
  /**
   * Normalizza schema SEMPLIFICATO
   * Backend genera solo: backend_url, api_key, company_id, printers[], interval_minutes
   * Agent aggiunge defaults intelligenti
   */
  static normalizeSchema(config) {
    const normalized = {};
    
    // === Dati OBBLIGATORI dal backend ===
    normalized.backend_url = config.backend_url || config.backend?.url;
    normalized.api_key = config.api_key || config.backend?.api_key;
    normalized.company_id = config.company_id || config.backend?.company_id || config.backend?.tenant_id;
    
    // Printers (normalizza con defaults)
    normalized.printers = (config.printers || []).map(p => ({
      ip: p.ip,
      community: p.community || 'public', // Default SNMP community
      enabled: p.enabled !== false // Default: tutte abilitate se non esplicitamente false
    }));
    
    // === Configurazione AGENT (defaults) ===
    normalized.interval_minutes = config.interval_minutes || config.schedule?.interval_minutes || 5;
    normalized.retry_attempts = config.retry_attempts || 3;
    normalized.retry_delay = config.retry_delay || 5000;
    
    // Features agent (sempre abilitate, non configurabili da UI)
    normalized.walk_on_unknown = true;  // Auto-discovery stampanti sconosciute
    normalized.upload_walks = true;     // Upload walk data per mapping
    normalized.check_new_mappings = true; // Check periodico nuovi mapping
    
    return normalized;
  }
  
  /**
   * Valida configurazione
   */
  static validateConfig(config) {
    const errors = [];
    
    // Backend URL
    if (!config.backend_url) {
      errors.push('backend_url is required');
    } else if (!this.isValidUrl(config.backend_url)) {
      errors.push(`backend_url is not a valid URL: ${config.backend_url}`);
    }
    
    // API Key
    if (!config.api_key) {
      errors.push('api_key is required');
    } else if (config.api_key.length < 10) {
      errors.push('api_key is too short (minimum 10 characters)');
    }
    
    // Company ID
    if (!config.company_id) {
      errors.push('company_id is required');
    } else if (!this.isValidUUID(config.company_id)) {
      console.warn(`   ⚠️  company_id is not a valid UUID: ${config.company_id}`);
    }
    
    // Printers
    if (!Array.isArray(config.printers)) {
      errors.push('printers must be an array');
    } else if (config.printers.length === 0) {
      errors.push('printers array is empty - at least one printer required');
    } else {
      config.printers.forEach((printer, index) => {
        if (!printer.ip) {
          errors.push(`printers[${index}] missing ip address`);
        } else if (!this.isValidIP(printer.ip)) {
          errors.push(`printers[${index}] invalid IP: ${printer.ip}`);
        }
      });
    }
    
    // Interval Minutes (FLAT schema)
    if (!config.interval_minutes || config.interval_minutes < 1) {
      errors.push('interval_minutes must be >= 1');
    }
    
    if (errors.length > 0) {
      console.error('❌ Configuration validation failed:');
      errors.forEach(err => console.error(`   - ${err}`));
      throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
  }
  
  /**
   * Log summary configurazione
   */
  static logConfigSummary(config) {
    console.log('');
    console.log('📋 Configuration Summary:');
    console.log(`   Backend: ${config.backend_url}`);
    console.log(`   Company: ${config.company_id}`);
    console.log(`   API Key: ${config.api_key.substring(0, 15)}...`);
    console.log(`   Printers: ${config.printers.length} configured`);
    
    const enabledCount = config.printers.filter(p => p.enabled !== false).length;
    console.log(`   Enabled: ${enabledCount}/${config.printers.length}`);
    
    console.log(`   Interval: ${config.interval_minutes} minutes`);
    console.log('');
  }
  
  /**
   * Valida URL
   */
  static isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }
  
  /**
   * Valida UUID
   */
  static isValidUUID(string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(string);
  }
  
  /**
   * Valida IP address
   */
  static isValidIP(ip) {
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipRegex.test(ip);
  }
}

module.exports = ConfigLoader;
