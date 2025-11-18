/**
 * SNMP Utilities per Printer Monitor
 */

const snmp = require("net-snmp");
const fs = require('fs');
const path = require('path');

/**
 * Classe per gestire connessioni SNMP
 */
class SNMPManager {
    constructor(host, community = 'public', options = {}) {
        this.host = host;
        this.community = community;
        this.options = {
            port: 161,
            retries: 2,
            timeout: 10000,
            version: snmp.Version1,
            ...options
        };
        this.session = null;
        this.isConnected = false;
    }

    /**
     * Crea e configura una sessione SNMP
     */
    connect() {
        if (this.session) {
            this.close();
        }

        this.session = snmp.createSession(this.host, this.community, this.options);
        
        this.session.on('error', (error) => {
            console.error(`SNMP Session Error: ${error.message}`);
            this.isConnected = false;
        });

        this.isConnected = true;
        return this.session;
    }

    /**
     * Test di connessione con un OID semplice
     */
    async testConnection(testOid = "1.3.6.1.2.1.1.1.0") {
        if (!this.session) {
            this.connect();
        }

        return new Promise((resolve, reject) => {
            this.session.get([testOid], (error, varbinds) => {
                if (error) {
                    this.isConnected = false;
                    reject(new Error(`Connection test failed: ${error.message}`));
                    return;
                }

                if (snmp.isVarbindError(varbinds[0])) {
                    this.isConnected = false;
                    reject(new Error(`SNMP Error: ${snmp.varbindError(varbinds[0])}`));
                    return;
                }

                this.isConnected = true;
                resolve(true);
            });
        });
    }

    /**
     * GET di uno o più OID
     */
    async get(oids) {
        if (!Array.isArray(oids)) {
            oids = [oids];
        }

        if (!this.session) {
            this.connect();
        }

        return new Promise((resolve, reject) => {
            this.session.get(oids, (error, varbinds) => {
                if (error) {
                    reject(new Error(`SNMP GET failed: ${error.message}`));
                    return;
                }

                const results = {};
                varbinds.forEach((vb, index) => {
                    const oid = oids[index];
                    
                    if (snmp.isVarbindError(vb)) {
                        results[oid] = {
                            error: snmp.varbindError(vb),
                            success: false
                        };
                    } else {
                        results[oid] = {
                            value: this.parseValue(vb.value),
                            rawValue: vb.value,
                            success: true
                        };
                    }
                });

                resolve(results);
            });
        });
    }

    /**
     * Walk di un OID - restituisce tutti gli OID sotto il root specificato
     */
    async walk(rootOid) {
        if (!this.session) {
            this.connect();
        }

        return new Promise((resolve, reject) => {
            const results = {};
            let count = 0;

            this.session.subtree(
                rootOid,
                (varbindArray) => {
                    if (!varbindArray || varbindArray.length === 0) return;

                    const vb = varbindArray[0];
                    count++;

                    if (snmp.isVarbindError(vb)) {
                        results[vb.oid] = {
                            type: 'ERROR',
                            value: null,
                            description: snmp.varbindError(vb)
                        };
                        return;
                    }

                    // Determina tipo
                    let type = 'STRING';
                    if (typeof vb.value === 'number') {
                        type = 'INTEGER';
                    } else if (Buffer.isBuffer(vb.value)) {
                        type = 'OCTET_STRING';
                    }

                    results[vb.oid] = {
                        type: type,
                        value: this.parseValue(vb.value),
                        description: null // Può essere arricchito in seguito
                    };
                },
                (error) => {
                    if (error) {
                        console.error(`Walk error: ${error.message}`);
                        reject(error);
                    } else {
                        console.log(`✅ Walk completed: ${count} OIDs collected`);
                        resolve(results);
                    }
                }
            );
        });
    }

    /**
     * Parser intelligente per valori
     */
    parseValue(value) {
        if (value === null || value === undefined) {
            return null;
        }

        if (Buffer.isBuffer(value)) {
            const stringValue = value.toString('utf8');
            
            // Se è una stringa printable, restituiscila
            if (/^[\x20-\x7E\s]*$/.test(stringValue) && stringValue.trim().length > 0) {
                return stringValue.trim();
            }
            
            // Altrimenti restituisci hex
            return `[HEX]${value.toString('hex')}`;
        }

        if (typeof value === 'number') {
            return value;
        }

        return value.toString();
    }

    /**
     * Chiude la sessione
     */
    close() {
        if (this.session) {
            this.session.close();
            this.session = null;
            this.isConnected = false;
        }
    }
}

/**
 * Classe per gestire i mapping delle stampanti
 */
class MappingManager {
    constructor(mappingsDir = './mappings', configDir = './configs') {
        this.mappingsDir = path.resolve(mappingsDir);
        this.configDir = path.resolve(configDir);
        this.config = null;
        this.mappings = new Map();
        this.cacheTTL = 3600000; // 1 ora in millisecondi
        this.cacheTimestamps = new Map();
        
        this.loadConfig();
    }

    /**
     * Carica la configurazione generale
     * Usa ConfigLoader per schema unificato
     */
    loadConfig() {
        try {
            // Usa ConfigLoader unificato
            const ConfigLoader = require('../src/config-loader');
            this.config = ConfigLoader.load();
            
            // Mantieni solo le proprietà necessarie per mappings
            this.config = {
                supported_models: this.config.supported_models || this.getDefaultModels(),
                identification_oids: this.config.identification_oids || this.getDefaultIdentificationOids(),
                backend: {
                    enabled: !!this.config.backend_url,
                    url: this.config.backend_url,
                    api_key: this.config.api_key,
                    company_id: this.config.company_id
                }
            };
        } catch (error) {
            console.warn('⚠️  Failed to load config via ConfigLoader, using defaults');
            this.config = {
                supported_models: this.getDefaultModels(),
                identification_oids: this.getDefaultIdentificationOids(),
                backend: { enabled: false }
            };
        }
    }
    
    /**
     * Default models configuration
     */
    getDefaultModels() {
        return [
            {
                name: "develop_ineo_250i",
                file: "develop_ineo_250i.json",
                patterns: ["Develop.*ineo.*250i", "Develop ineo\\+ 250i"],
                vendor: "Develop",
                priority: 10
            },
            {
                name: "generic_printer",
                file: "generic_printer.json",
                patterns: [".*"],
                vendor: "Generic",
                priority: 1,
                fallback: true
            }
        ];
    }
    
    /**
     * Default identification OIDs
     */
    getDefaultIdentificationOids() {
        return {
            sysDescr: "1.3.6.1.2.1.1.1.0",
            sysName: "1.3.6.1.2.1.1.5.0",
            prtGeneralPrinterName: "1.3.6.1.2.1.43.5.1.1.16.1",
            prtGeneralSerialNumber: "1.3.6.1.2.1.43.5.1.1.17.1"
        };
    }

    /**
     * Identifica il modello della stampante
     */
    identifyPrinter(sysDescr) {
        if (!sysDescr) return null;

        // Ordina i modelli per priorità
        const models = [...this.config.supported_models].sort((a, b) => (b.priority || 0) - (a.priority || 0));

        for (const model of models) {
            if (model.fallback) continue; // Skip fallback per ora
            
            for (const pattern of model.patterns) {
                const regex = new RegExp(pattern, 'i');
                if (regex.test(sysDescr)) {
                    return model;
                }
            }
        }

        // Se nessun match, usa il fallback
        return models.find(m => m.fallback) || null;
    }

    /**
     * Verifica se la cache è valida per un mapping
     */
    isCacheValid(modelName) {
        if (!this.cacheTimestamps.has(modelName)) {
            return false;
        }
        
        const timestamp = this.cacheTimestamps.get(modelName);
        const now = Date.now();
        return (now - timestamp) < this.cacheTTL;
    }

    /**
     * Invalida la cache per un mapping specifico o per tutti
     */
    invalidateCache(modelName = null) {
        if (modelName) {
            this.mappings.delete(modelName);
            this.cacheTimestamps.delete(modelName);
            console.log(`🗑️  Cache invalidated for: ${modelName}`);
        } else {
            this.mappings.clear();
            this.cacheTimestamps.clear();
            console.log(`🗑️  All cache cleared`);
        }
    }

    /**
     * Carica il mapping per un modello specifico con cache TTL
     * Cache valida per 1 ora, riduce I/O disco del ~90%
     */
    loadMapping(modelName) {
        // Check cache validità
        if (this.mappings.has(modelName) && this.isCacheValid(modelName)) {
            console.log(`📦 Cache hit: ${modelName}`);
            return this.mappings.get(modelName);
        }

        // Cache miss o scaduta - carica da disco
        const mappingPath = path.join(this.mappingsDir, `${modelName}.json`);
        
        if (!fs.existsSync(mappingPath)) {
            throw new Error(`Mapping file not found: ${mappingPath}`);
        }

        try {
            const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
            
            // Aggiorna cache e timestamp
            this.mappings.set(modelName, mapping);
            this.cacheTimestamps.set(modelName, Date.now());
            
            console.log(`✅ Loaded mapping: ${modelName} (cached for 1h)`);
            return mapping;
        } catch (error) {
            throw new Error(`Failed to load mapping ${modelName}: ${error.message}`);
        }
    }

    /**
     * Ottiene tutti gli OID necessari per un mapping
     */
    getAllOids(mapping) {
        const oids = new Set();
        
        function extractOids(obj) {
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'object' && value !== null) {
                    if (value.oid) {
                        oids.add(value.oid);
                    }
                    if (value.level_oid) {
                        oids.add(value.level_oid);
                    }
                    if (value.capacity_oid) {
                        oids.add(value.capacity_oid);
                    }
                    if (value.current_oid) {
                        oids.add(value.current_oid);
                    }
                    extractOids(value);
                }
            }
        }

        extractOids(mapping.mappings || {});
        return Array.from(oids).filter(oid => oid && oid !== 'TBD');
    }
}

/**
 * Utilities varie
 */
class Utils {
    /**
     * Normalizza il nome di un modello per i file
     */
    static normalizeModelName(modelName) {
        return modelName
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
    }

    /**
     * Formatta i bytes in formato leggibile
     */
    static formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Calcola la percentuale
     */
    static calculatePercentage(current, max) {
        if (!max || max === 0) return 0;
        return Math.round((current / max) * 100);
    }

    /**
     * Valida un indirizzo IP
     */
    static isValidIP(ip) {
        const regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        return regex.test(ip);
    }

    /**
     * Crea timestamp formattato
     */
    static timestamp() {
        return new Date().toISOString();
    }

    /**
     * Sleep utility
     */
    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = {
    SNMPManager,
    // MappingManager, // DEPRECATED: Removed in v2.0 (Backend is Single Source of Truth)
    Utils
};