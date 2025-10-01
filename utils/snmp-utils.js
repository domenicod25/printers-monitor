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
     * Walk di un OID
     */
    async walk(rootOid) {
        if (!this.session) {
            this.connect();
        }

        return new Promise((resolve, reject) => {
            const results = {};
            let count = 0;
            let hasError = false;

            this.session.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    resolve({ results, error: error.message, count, success: false });
                }
            });

            this.session.subtree(
                rootOid,
                (varbindArray) => {
                    if (!varbindArray || varbindArray.length === 0 || hasError) return;

                    const vb = varbindArray[0];
                    count++;

                    if (snmp.isVarbindError(vb)) {
                        results[vb.oid] = {
                            error: snmp.varbindError(vb),
                            success: false
                        };
                        return;
                    }

                    results[vb.oid] = {
                        value: this.parseValue(vb.value),
                        rawValue: vb.value,
                        success: true,
                        timestamp: new Date().toISOString()
                    };
                },
                (error) => {
                    if (!hasError) {
                        resolve({
                            results,
                            error: error ? error.message : null,
                            count,
                            success: !error
                        });
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
        
        this.loadConfig();
    }

    /**
     * Carica la configurazione generale
     */
    loadConfig() {
        const configPath = path.join(this.configDir, 'config.json');
        
        if (!fs.existsSync(configPath)) {
            throw new Error(`Configuration file not found: ${configPath}`);
        }

        try {
            this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (error) {
            throw new Error(`Failed to load config: ${error.message}`);
        }
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
     * Carica il mapping per un modello specifico
     */
    loadMapping(modelName) {
        if (this.mappings.has(modelName)) {
            return this.mappings.get(modelName);
        }

        const mappingPath = path.join(this.mappingsDir, `${modelName}.json`);
        
        if (!fs.existsSync(mappingPath)) {
            throw new Error(`Mapping file not found: ${mappingPath}`);
        }

        try {
            const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
            this.mappings.set(modelName, mapping);
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
    MappingManager,
    Utils
};