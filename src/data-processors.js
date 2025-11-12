/**
 * Data Processors - Classi Specializzate per Processare Dati SNMP
 * 
 * Separazione responsabilità per ogni tipo di dato:
 * - BasicDataProcessor: Informazioni base (model, serial, name)
 * - TonerDataProcessor: Livelli toner con calcoli percentuali
 * - PaperDataProcessor: Livelli carta con calcoli
 * - CountersDataProcessor: Contatori pagine
 * - StatusDataProcessor: Stati stampante
 */

const { Utils } = require('../utils/snmp-utils');

/**
 * Base Processor - Classe astratta
 */
class BaseDataProcessor {
  /**
   * Processa una sezione del mapping
   * @param {Object} sectionMapping - Mapping per questa sezione
   * @param {Object} snmpResults - Risultati SNMP raw
   * @returns {Object} Dati processati
   */
  process(sectionMapping, snmpResults) {
    throw new Error('process() must be implemented by subclass');
  }
  
  /**
   * Estrae valore da risultato SNMP
   */
  extractValue(snmpResult) {
    if (!snmpResult || !snmpResult.success) {
      return null;
    }
    return snmpResult.value;
  }
  
  /**
   * Crea oggetto errore
   */
  createError(snmpResult, description) {
    return {
      error: snmpResult ? snmpResult.error : 'OID not found',
      description: description
    };
  }
}

/**
 * Basic Data Processor
 * Processa: model, serial number, printer name, etc.
 */
class BasicDataProcessor extends BaseDataProcessor {
  process(sectionMapping, snmpResults) {
    if (!sectionMapping) return {};
    
    const result = {};
    
    for (const [key, config] of Object.entries(sectionMapping)) {
      if (!config.oid || config.oid === 'TBD') {
        result[key] = {
          error: 'OID not configured (TBD)',
          description: config.description
        };
        continue;
      }
      
      const snmpResult = snmpResults[config.oid];
      const value = this.extractValue(snmpResult);
      
      if (value !== null) {
        result[key] = {
          value: value,
          description: config.description,
          unit: config.unit,
          type: config.type
        };
        
        // Applica mapping valori se presenti
        if (config.values && value in config.values) {
          result[key].display_value = config.values[value];
        }
      } else {
        result[key] = this.createError(snmpResult, config.description);
      }
    }
    
    return result;
  }
}

/**
 * Toner Data Processor
 * Processa: livelli toner con calcoli percentuali e stati
 */
class TonerDataProcessor extends BaseDataProcessor {
  process(tonerMapping, snmpResults) {
    if (!tonerMapping) return {};
    
    const result = {};
    
    for (const [color, config] of Object.entries(tonerMapping)) {
      const levelResult = snmpResults[config.level_oid];
      const capacityResult = snmpResults[config.capacity_oid];
      
      const level = this.extractValue(levelResult);
      
      if (level !== null) {
        const capacity = this.extractValue(capacityResult);
        const percentage = this.calculatePercentage(level, capacity);
        
        result[color] = {
          level: level,
          capacity: capacity,
          percentage: percentage,
          unit: config.unit,
          description: config.description,
          status: this.determineStatus(percentage)
        };
      } else {
        result[color] = this.createError(levelResult, config.description);
      }
    }
    
    return result;
  }
  
  /**
   * Calcola percentuale toner
   */
  calculatePercentage(level, capacity) {
    if (typeof level !== 'number') return null;
    
    // Se level è già una percentuale (0-100)
    if (level >= 0 && level <= 100) {
      return level;
    }
    
    // Se abbiamo capacità, calcola percentuale
    if (capacity && capacity > 0) {
      return Utils.calculatePercentage(level, capacity);
    }
    
    return null;
  }
  
  /**
   * Determina stato toner basato su percentuale
   */
  determineStatus(percentage) {
    if (percentage === null || typeof percentage !== 'number') {
      return 'unknown';
    }
    
    if (percentage <= 5) return 'critical';
    if (percentage <= 15) return 'low';
    if (percentage <= 30) return 'medium';
    return 'good';
  }
}

/**
 * Paper Data Processor
 * Processa: livelli carta con calcoli e stati
 */
class PaperDataProcessor extends BaseDataProcessor {
  process(paperMapping, snmpResults) {
    if (!paperMapping) return {};
    
    const result = {};
    
    for (const [tray, config] of Object.entries(paperMapping)) {
      const currentResult = snmpResults[config.current_oid];
      const capacityResult = snmpResults[config.capacity_oid];
      
      const current = this.extractValue(currentResult);
      
      if (current !== null) {
        const capacity = this.extractValue(capacityResult);
        const percentage = capacity ? Utils.calculatePercentage(current, capacity) : null;
        
        result[tray] = {
          current: current,
          capacity: capacity,
          percentage: percentage,
          unit: config.unit,
          description: config.description,
          status: this.determineStatus(current, capacity, percentage)
        };
      } else {
        result[tray] = this.createError(currentResult, config.description);
      }
    }
    
    return result;
  }
  
  /**
   * Determina stato carta
   */
  determineStatus(current, capacity, percentage) {
    if (typeof current !== 'number') return 'unknown';
    
    if (current === 0) return 'empty';
    
    if (percentage !== null) {
      if (percentage <= 10) return 'low';
      if (percentage <= 30) return 'medium';
      return 'good';
    }
    
    return current > 0 ? 'has_paper' : 'empty';
  }
}

/**
 * Counters Data Processor
 * Processa: contatori pagine (totali, colore, b/n)
 */
class CountersDataProcessor extends BaseDataProcessor {
  process(countersMapping, snmpResults) {
    if (!countersMapping) return {};
    
    const result = {};
    
    for (const [key, config] of Object.entries(countersMapping)) {
      if (!config.oid || config.oid === 'TBD') {
        result[key] = {
          error: 'OID not configured (TBD)',
          description: config.description
        };
        continue;
      }
      
      const snmpResult = snmpResults[config.oid];
      const value = this.extractValue(snmpResult);
      
      if (value !== null) {
        // Converti a numero intero
        const numValue = typeof value === 'number' ? value : parseInt(value, 10);
        
        result[key] = {
          value: isNaN(numValue) ? value : numValue,
          description: config.description,
          unit: config.unit || 'pages',
          type: 'counter'
        };
      } else {
        result[key] = this.createError(snmpResult, config.description);
      }
    }
    
    return result;
  }
}

/**
 * Status Data Processor
 * Processa: stati stampante e device status
 */
class StatusDataProcessor extends BaseDataProcessor {
  process(statusMapping, snmpResults) {
    if (!statusMapping) return {};
    
    const result = {};
    
    for (const [key, config] of Object.entries(statusMapping)) {
      if (!config.oid || config.oid === 'TBD') {
        result[key] = {
          error: 'OID not configured (TBD)',
          description: config.description
        };
        continue;
      }
      
      const snmpResult = snmpResults[config.oid];
      const value = this.extractValue(snmpResult);
      
      if (value !== null) {
        result[key] = {
          value: value,
          description: config.description,
          type: config.type
        };
        
        // Applica mapping valori se presenti (es. 1 = "Idle", 2 = "Printing")
        if (config.values && value in config.values) {
          result[key].display_value = config.values[value];
        }
        
        // Aggiungi severity se è uno stato di errore
        if (this.isErrorStatus(value, config)) {
          result[key].severity = this.determineSeverity(value, config);
        }
      } else {
        result[key] = this.createError(snmpResult, config.description);
      }
    }
    
    return result;
  }
  
  /**
   * Verifica se è uno stato di errore
   */
  isErrorStatus(value, config) {
    if (config.error_values && config.error_values.includes(value)) {
      return true;
    }
    return false;
  }
  
  /**
   * Determina severity errore
   */
  determineSeverity(value, config) {
    if (config.critical_values && config.critical_values.includes(value)) {
      return 'critical';
    }
    if (config.warning_values && config.warning_values.includes(value)) {
      return 'warning';
    }
    return 'info';
  }
}

/**
 * Data Collector - Coordina tutti i processors
 */
class DataCollector {
  constructor(snmpManager, mapping) {
    this.snmpManager = snmpManager;
    this.mapping = mapping;
    
    // Inizializza processors specializzati
    this.processors = {
      basic: new BasicDataProcessor(),
      toner: new TonerDataProcessor(),
      paper: new PaperDataProcessor(),
      counters: new CountersDataProcessor(),
      status: new StatusDataProcessor()
    };
  }
  
  /**
   * Raccoglie tutti i dati
   */
  async collect() {
    // 1. Ottieni tutti gli OID necessari
    const oids = this.getAllOids();
    
    if (oids.length === 0) {
      throw new Error('No valid OIDs found in mapping');
    }
    
    console.log(`   Interrogando ${oids.length} OID...`);
    
    // 2. Interroga SNMP
    const snmpResults = await this.queryOids(oids);
    
    // 3. Processa ogni sezione con il processor appropriato
    const data = {
      metadata: this.buildMetadata(snmpResults, oids),
      basic: this.processors.basic.process(this.mapping.mappings.basic, snmpResults),
      status: this.processors.status.process(this.mapping.mappings.status, snmpResults),
      toner: this.processors.toner.process(this.mapping.mappings.toner, snmpResults),
      paper: this.processors.paper.process(this.mapping.mappings.paper, snmpResults),
      counters: this.processors.counters.process(this.mapping.mappings.counters, snmpResults)
    };
    
    return data;
  }
  
  /**
   * Ottieni tutti gli OID dal mapping
   */
  getAllOids() {
    const oids = new Set();
    
    const extractOids = (obj) => {
      for (const value of Object.values(obj)) {
        if (typeof value === 'object' && value !== null) {
          if (value.oid && value.oid !== 'TBD') {
            oids.add(value.oid);
          }
          if (value.level_oid && value.level_oid !== 'TBD') {
            oids.add(value.level_oid);
          }
          if (value.capacity_oid && value.capacity_oid !== 'TBD') {
            oids.add(value.capacity_oid);
          }
          if (value.current_oid && value.current_oid !== 'TBD') {
            oids.add(value.current_oid);
          }
          extractOids(value);
        }
      }
    };
    
    extractOids(this.mapping.mappings || {});
    return Array.from(oids);
  }
  
  /**
   * Interroga gli OID uno alla volta (gestione errori granulare)
   */
  async queryOids(oids) {
    const snmpResults = {};
    let successCount = 0;
    
    for (const oid of oids) {
      try {
        const result = await this.snmpManager.get([oid]);
        snmpResults[oid] = result[oid];
        if (result[oid] && result[oid].success) {
          successCount++;
        }
      } catch (error) {
        console.log(`   ⚠️  OID ${oid}: ${error.message}`);
        snmpResults[oid] = {
          error: error.message,
          success: false
        };
      }
    }
    
    console.log(`   ✅ OID riusciti: ${successCount}/${oids.length}`);
    return snmpResults;
  }
  
  /**
   * Costruisce metadata
   */
  buildMetadata(snmpResults, oids) {
    const successCount = Object.values(snmpResults).filter(r => r.success).length;
    
    return {
      timestamp: Utils.timestamp(),
      mapping_version: this.mapping.metadata.version,
      successful_oids: successCount,
      total_oids: oids.length,
      success_rate: Math.round((successCount / oids.length) * 100)
    };
  }
}

module.exports = {
  DataCollector,
  BasicDataProcessor,
  TonerDataProcessor,
  PaperDataProcessor,
  CountersDataProcessor,
  StatusDataProcessor
};
