#!/usr/bin/env node
/**
 * Printer Monitor - Sistema di Monitoraggio Stampanti
 * 
 * Questo script rileva automaticamente il modello della stampante,
 * carica il mapping appropriato ed estrae i dati specifici.
 * 
 * Usage: 
 *   node src/monitor.js --host <IP> [options]
 *   node src/monitor.js --host 192.168.180.141 --output json
 *   node src/monitor.js --host 192.168.180.141 --format detailed --save
 */

const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));
const { SNMPManager, MappingManager, Utils } = require('../utils/snmp-utils');

class PrinterMonitor {
    constructor(host, options = {}) {
        this.host = host;
        this.options = {
            community: options.community || 'public',
            timeout: options.timeout || 10000,
            retries: options.retries || 2,
            format: options.format || 'summary', // summary, detailed, raw
            save: options.save || false,
            outputDir: options.outputDir || './output'
        };
        
        this.snmp = null;
        this.mappingManager = null;
        this.printerInfo = {};
        this.model = null;
        this.mapping = null;
        this.data = {};
    }

    /**
     * Inizializza il monitor
     */
    async initialize() {
        console.log(`🚀 Inizializzazione Printer Monitor per ${this.host}...`);
        
        // Inizializza SNMP
        this.snmp = new SNMPManager(this.host, this.options.community, {
            timeout: this.options.timeout,
            retries: this.options.retries
        });

        // Inizializza Mapping Manager
        this.mappingManager = new MappingManager();

        // Test connessione
        await this.snmp.testConnection();
        console.log('✅ Connessione SNMP stabilita');
    }

    /**
     * Identifica la stampante
     */
    async identifyPrinter() {
        console.log('🔍 Identificazione stampante in corso...');
        
        const identificationOids = this.mappingManager.config.identification_oids;
        const results = await this.snmp.get(Object.values(identificationOids));
        
        // Estrai informazioni base
        this.printerInfo = {};
        for (const [key, oid] of Object.entries(identificationOids)) {
            const result = results[oid];
            if (result && result.success) {
                this.printerInfo[key] = result.value;
            }
        }

        // Identifica modello
        const sysDescr = this.printerInfo.sysDescr;
        this.model = this.mappingManager.identifyPrinter(sysDescr);
        
        if (!this.model) {
            throw new Error(`Unable to identify printer model from: ${sysDescr}`);
        }

        console.log(`📋 Stampante identificata: ${this.model.name} (${this.model.vendor})`);
        console.log(`   Descrizione: ${sysDescr}`);
        
        if (this.printerInfo.prtGeneralSerialNumber) {
            console.log(`   Seriale: ${this.printerInfo.prtGeneralSerialNumber}`);
        }
        
        return this.model;
    }

    /**
     * Carica il mapping per il modello identificato
     */
    loadMapping() {
        console.log(`📁 Caricamento mapping per ${this.model.name}...`);
        
        this.mapping = this.mappingManager.loadMapping(this.model.name);
        
        if (!this.mapping) {
            throw new Error(`Failed to load mapping for ${this.model.name}`);
        }

        console.log(`✅ Mapping caricato: ${this.mapping.metadata.displayName}`);
        return this.mapping;
    }

    /**
     * Raccoglie tutti i dati secondo il mapping
     */
    async collectData() {
        console.log('📊 Raccolta dati in corso...');
        
        const oids = this.mappingManager.getAllOids(this.mapping);
        
        if (oids.length === 0) {
            throw new Error('No valid OIDs found in mapping');
        }

        console.log(`   Interrogando ${oids.length} OID...`);
        
        // Interroga gli OID uno alla volta per gestire meglio gli errori
        const snmpResults = {};
        let successCount = 0;
        
        for (const oid of oids) {
            try {
                const result = await this.snmp.get([oid]);
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
        
        // Struttura i dati secondo il mapping
        this.data = {
            metadata: {
                timestamp: Utils.timestamp(),
                host: this.host,
                model: this.model,
                mapping_version: this.mapping.metadata.version,
                successful_oids: successCount,
                total_oids: oids.length
            },
            basic: this.processSection(this.mapping.mappings.basic, snmpResults),
            status: this.processSection(this.mapping.mappings.status, snmpResults),
            toner: this.processTonerSection(this.mapping.mappings.toner, snmpResults),
            paper: this.processPaperSection(this.mapping.mappings.paper, snmpResults),
            counters: this.processSection(this.mapping.mappings.counters, snmpResults),
            raw: this.options.format === 'raw' ? snmpResults : undefined
        };

        // Pulisci undefined
        Object.keys(this.data).forEach(key => {
            if (this.data[key] === undefined) {
                delete this.data[key];
            }
        });

        return this.data;
    }

    /**
     * Processa una sezione generica del mapping
     */
    processSection(sectionMapping, snmpResults) {
        if (!sectionMapping) return {};

        const result = {};
        
        for (const [key, config] of Object.entries(sectionMapping)) {
            if (config.oid && config.oid !== 'TBD') {
                const snmpResult = snmpResults[config.oid];
                
                if (snmpResult && snmpResult.success) {
                    result[key] = {
                        value: snmpResult.value,
                        description: config.description,
                        unit: config.unit,
                        type: config.type
                    };

                    // Applica valori mappati se presenti
                    if (config.values && result[key].value in config.values) {
                        result[key].displayValue = config.values[result[key].value];
                    }
                } else {
                    result[key] = {
                        error: snmpResult ? snmpResult.error : 'OID not found',
                        description: config.description
                    };
                }
            } else {
                result[key] = {
                    error: 'OID not configured (TBD)',
                    description: config.description
                };
            }
        }

        return result;
    }

    /**
     * Processa la sezione toner con calcoli percentuali
     */
    processTonerSection(tonerMapping, snmpResults) {
        if (!tonerMapping) return {};

        const result = {};
        
        for (const [color, config] of Object.entries(tonerMapping)) {
            const levelResult = snmpResults[config.level_oid];
            const capacityResult = snmpResults[config.capacity_oid];
            
            if (levelResult && levelResult.success) {
                result[color] = {
                    level: levelResult.value,
                    capacity: capacityResult && capacityResult.success ? capacityResult.value : null,
                    percentage: this.calculateTonerPercentage(levelResult.value, capacityResult?.value),
                    unit: config.unit,
                    description: config.description,
                    status: this.getTonerStatus(levelResult.value)
                };
            } else {
                result[color] = {
                    error: levelResult ? levelResult.error : 'Level OID not found',
                    description: config.description
                };
            }
        }

        return result;
    }

    /**
     * Processa la sezione carta con calcoli
     */
    processPaperSection(paperMapping, snmpResults) {
        if (!paperMapping) return {};

        const result = {};
        
        for (const [tray, config] of Object.entries(paperMapping)) {
            const currentResult = snmpResults[config.current_oid];
            const capacityResult = snmpResults[config.capacity_oid];
            
            if (currentResult && currentResult.success) {
                const current = currentResult.value;
                const capacity = capacityResult && capacityResult.success ? capacityResult.value : null;
                
                result[tray] = {
                    current: current,
                    capacity: capacity,
                    percentage: capacity ? Utils.calculatePercentage(current, capacity) : null,
                    unit: config.unit,
                    description: config.description,
                    status: this.getPaperStatus(current, capacity)
                };
            } else {
                result[tray] = {
                    error: currentResult ? currentResult.error : 'Current level OID not found',
                    description: config.description
                };
            }
        }

        return result;
    }

    /**
     * Calcola percentuale toner
     */
    calculateTonerPercentage(level, capacity) {
        if (typeof level === 'number') {
            // Se level è già una percentuale (0-100)
            if (level >= 0 && level <= 100) {
                return level;
            }
            // Se abbiamo capacità, calcola percentuale
            if (capacity && capacity > 0) {
                return Utils.calculatePercentage(level, capacity);
            }
        }
        return null;
    }

    /**
     * Determina stato toner
     */
    getTonerStatus(level) {
        if (typeof level !== 'number') return 'unknown';
        
        if (level <= 5) return 'critical';
        if (level <= 15) return 'low';
        if (level <= 30) return 'medium';
        return 'good';
    }

    /**
     * Determina stato carta
     */
    getPaperStatus(current, capacity) {
        if (typeof current !== 'number') return 'unknown';
        
        if (current === 0) return 'empty';
        
        if (capacity) {
            const percentage = Utils.calculatePercentage(current, capacity);
            if (percentage <= 10) return 'low';
            if (percentage <= 30) return 'medium';
            return 'good';
        }
        
        return current > 0 ? 'has_paper' : 'empty';
    }

    /**
     * Salva i risultati
     */
    async saveResults() {
        if (!this.options.save) return null;

        // Crea directory di output se non esiste
        if (!fs.existsSync(this.options.outputDir)) {
            fs.mkdirSync(this.options.outputDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${Utils.normalizeModelName(this.model.name)}_${this.host.replace(/\./g, '_')}_${timestamp}.json`;
        const filepath = path.join(this.options.outputDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(this.data, null, 2));
        
        console.log(`💾 Risultati salvati in: ${filename}`);
        return filepath;
    }

    /**
     * Formatta l'output per la console
     */
    formatOutput() {
        const format = this.options.format;
        
        if (format === 'raw') {
            return JSON.stringify(this.data, null, 2);
        }
        
        if (format === 'summary') {
            return this.formatSummary();
        }
        
        if (format === 'detailed') {
            return this.formatDetailed();
        }
        
        // Default: JSON pretty
        return JSON.stringify(this.data, null, 2);
    }

    /**
     * Formato summary per console
     */
    formatSummary() {
        const lines = [];
        
        lines.push(`\n${'='.repeat(60)}`);
        lines.push(`📊 RIEPILOGO STAMPANTE`);
        lines.push(`${'='.repeat(60)}`);
        
        // Info base
        lines.push(`🖨️  Modello: ${this.data.metadata.model.name}`);
        lines.push(`🏢 Vendor: ${this.data.metadata.model.vendor}`);
        lines.push(`🌐 Host: ${this.host}`);
        
        if (this.data.basic?.serialNumber?.value) {
            lines.push(`🔢 Seriale: ${this.data.basic.serialNumber.value}`);
        }

        // Status
        if (this.data.status?.printerStatus?.displayValue) {
            lines.push(`📋 Stato: ${this.data.status.printerStatus.displayValue}`);
        }

        // Toner
        lines.push(`\n🎨 TONER:`);
        for (const [color, info] of Object.entries(this.data.toner || {})) {
            if (info.percentage !== undefined) {
                const status = info.status === 'critical' ? '🔴' : 
                             info.status === 'low' ? '🟡' : '🟢';
                lines.push(`   ${status} ${color}: ${info.percentage}%`);
            }
        }

        // Carta
        lines.push(`\n📄 CARTA:`);
        for (const [tray, info] of Object.entries(this.data.paper || {})) {
            if (info.current !== undefined) {
                const status = info.status === 'empty' ? '🔴' : 
                             info.status === 'low' ? '🟡' : '🟢';
                const display = info.capacity ? 
                    `${info.current}/${info.capacity} (${info.percentage}%)` : 
                    `${info.current}`;
                lines.push(`   ${status} ${tray}: ${display}`);
            }
        }

        lines.push(`\n⏰ Aggiornato: ${new Date(this.data.metadata.timestamp).toLocaleString()}`);
        lines.push(`${'='.repeat(60)}`);
        
        return lines.join('\n');
    }

    /**
     * Formato dettagliato per console
     */
    formatDetailed() {
        return JSON.stringify(this.data, null, 2);
    }

    /**
     * Cleanup
     */
    cleanup() {
        if (this.snmp) {
            this.snmp.close();
        }
    }
}

/**
 * Funzione principale
 */
async function main() {
    const host = argv.host || process.env.PRINTER_HOST;
    
    if (!host) {
        console.error('❌ Errore: specificare --host <IP>');
        console.log('Uso: node src/monitor.js --host 192.168.180.141');
        process.exit(1);
    }

    if (!Utils.isValidIP(host)) {
        console.error(`❌ Errore: IP non valido ${host}`);
        process.exit(1);
    }

    const monitor = new PrinterMonitor(host, {
        community: argv.community || 'public',
        format: argv.format || 'summary',
        save: argv.save || false,
        timeout: argv.timeout || 10000,
        retries: argv.retries || 2
    });

    try {
        // 1. Inizializza
        await monitor.initialize();

        // 2. Identifica stampante
        await monitor.identifyPrinter();

        // 3. Carica mapping
        monitor.loadMapping();

        // 4. Raccoglie dati
        await monitor.collectData();

        // 5. Salva se richiesto
        await monitor.saveResults();

        // 6. Output
        console.log(monitor.formatOutput());

    } catch (error) {
        console.error(`❌ Errore: ${error.message}`);
        process.exit(1);
    } finally {
        monitor.cleanup();
    }
}

// Esegui solo se chiamato direttamente
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { PrinterMonitor };