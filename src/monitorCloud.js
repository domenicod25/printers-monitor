#!/usr/bin/env node
/**
 * Printer Monitor - Sistema di Monitoraggio Stampanti (Cloud Version)
 * 
 * Questo script rileva automaticamente il modello della stampante,
 * carica il mapping appropriato ed invia i dati al backend cloud.
 * 
 * Usage: 
 *   node src/monitor.js --host <IP> [options]
 *   node src/monitor.js --host 192.168.180.141 --api-endpoint http://localhost:3000/v1
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const argv = require('minimist')(process.argv.slice(2));
const { SNMPManager, MappingManager, Utils } = require('../utils/snmp-utils');

class PrinterMonitorCloud {
    constructor(host, options = {}) {
        this.host = host;
        this.options = {
            community: options.community || 'public',
            timeout: options.timeout || 10000,
            retries: options.retries || 2,
            format: options.format || 'summary',
            save: options.save || false,
            outputDir: options.outputDir || './output',
            // Cloud API options
            apiEndpoint: options.apiEndpoint || 'http://localhost:3000/v1',
            apiKey: options.apiKey || process.env.PRINTER_MONITOR_API_KEY,
            tenantId: options.tenantId || process.env.PRINTER_MONITOR_TENANT_ID,
            sendToCloud: options.sendToCloud !== false, // Default true
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
        console.log(`🚀 Inizializzazione Printer Monitor Cloud per ${this.host}...`);
        
        // Verifica configurazione cloud
        if (this.options.sendToCloud) {
            if (!this.options.apiKey) {
                console.warn('⚠️  API Key mancante - i dati non saranno inviati al cloud');
                this.options.sendToCloud = false;
            } else if (!this.options.tenantId) {
                console.warn('⚠️  Tenant ID mancante - i dati non saranno inviati al cloud');
                this.options.sendToCloud = false;
            } else {
                console.log(`☁️  Cloud API: ${this.options.apiEndpoint}`);
                console.log(`🏢 Tenant: ${this.options.tenantId}`);
            }
        }
        
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
     * Converte i dati in formato API compatibile
     */
    formatForAPI() {
        const now = new Date().toISOString();
        
        // Device info
        const deviceInfo = {
            ip_address: this.host,
            model: this.printerInfo.sysDescr || this.model.displayName,
            vendor: this.model.vendor
        };

        // Aggiungi serial number se disponibile
        if (this.printerInfo.prtGeneralSerialNumber) {
            deviceInfo.serial_number = this.printerInfo.prtGeneralSerialNumber;
        }

        // Telemetry data
        const telemetryData = {};

        // Toner levels
        if (this.data.toner && Object.keys(this.data.toner).length > 0) {
            const tonerLevels = {};
            Object.entries(this.data.toner).forEach(([color, info]) => {
                if (info.percentage !== undefined) {
                    tonerLevels[color] = info.percentage;
                }
            });
            if (Object.keys(tonerLevels).length > 0) {
                telemetryData.toner_levels = tonerLevels;
            }
        }

        // Paper levels
        if (this.data.paper && Object.keys(this.data.paper).length > 0) {
            const paperLevels = {};
            Object.entries(this.data.paper).forEach(([tray, info]) => {
                if (info.current !== undefined) {
                    paperLevels[tray] = {
                        current: info.current,
                        capacity: info.capacity
                    };
                }
            });
            if (Object.keys(paperLevels).length > 0) {
                telemetryData.paper_levels = paperLevels;
            }
        }

        // Status info
        if (this.data.status && Object.keys(this.data.status).length > 0) {
            const statusInfo = {};
            Object.entries(this.data.status).forEach(([key, info]) => {
                if (!info.error) {
                    statusInfo[key] = info.displayValue || info.value;
                }
            });
            if (Object.keys(statusInfo).length > 0) {
                telemetryData.status_info = statusInfo;
            }
        }

        // Counters
        if (this.data.counters && Object.keys(this.data.counters).length > 0) {
            const counters = {};
            Object.entries(this.data.counters).forEach(([key, info]) => {
                if (!info.error && info.value !== undefined) {
                    counters[key] = info.value;
                }
            });
            if (Object.keys(counters).length > 0) {
                telemetryData.counters = counters;
            }
        }

        // Collection metadata
        const collectionMetadata = {
            successful_oids: this.data.metadata.successful_oids,
            total_oids: this.data.metadata.total_oids,
            collection_duration_ms: Date.now() - new Date(this.data.metadata.timestamp).getTime(),
            errors: []
        };

        return {
            device: deviceInfo,
            telemetry: telemetryData,
            collection_metadata: collectionMetadata,
            collected_at: now
        };
    }

    /**
     * Invia dati al backend cloud
     */
    async sendToCloudAPI() {
        if (!this.options.sendToCloud) {
            console.log('⏭️  Invio al cloud disabilitato');
            return null;
        }

        console.log('☁️  Invio dati al backend cloud...');

        try {
            const payload = this.formatForAPI();
            
            const response = await axios.post(
                `${this.options.apiEndpoint}/telemetry`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.options.apiKey}`,
                        'X-Tenant-ID': this.options.tenantId,
                        'X-Agent-Version': '1.0.0',
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 seconds timeout
                }
            );

            console.log(`✅ Dati inviati con successo al cloud`);
            console.log(`   Device ID: ${response.data.device_id}`);
            console.log(`   Telemetry ID: ${response.data.telemetry_id}`);
            
            if (response.data.alerts_generated > 0) {
                console.log(`   🚨 Alert generati: ${response.data.alerts_generated}`);
            }

            return response.data;

        } catch (error) {
            console.error('❌ Errore invio al cloud:', error.message);
            
            if (error.response) {
                console.error(`   Status: ${error.response.status}`);
                console.error(`   Message: ${error.response.data?.message || 'Unknown error'}`);
                
                // Log dettagli per debug
                if (error.response.status === 400) {
                    console.error('   Validation errors:', error.response.data?.details);
                }
            }
            
            throw error;
        }
    }

    /**
     * Salva i risultati localmente (backup)
     */
    async saveResultsLocally() {
        if (!this.options.save) return null;

        // Crea directory di output se non esiste
        if (!fs.existsSync(this.options.outputDir)) {
            fs.mkdirSync(this.options.outputDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${Utils.normalizeModelName(this.model.name)}_${this.host.replace(/\./g, '_')}_${timestamp}.json`;
        const filepath = path.join(this.options.outputDir, filename);

        // Aggiungi info API response se disponibile
        const outputData = {
            ...this.data,
            api_payload: this.formatForAPI(),
            api_endpoint: this.options.apiEndpoint,
            cloud_status: 'sent' // Will be updated if cloud fails
        };

        fs.writeFileSync(filepath, JSON.stringify(outputData, null, 2));
        
        console.log(`💾 Backup locale salvato in: ${filename}`);
        return filepath;
    }

    // Mantieni i metodi di processing originali
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

    calculateTonerPercentage(level, capacity) {
        if (typeof level === 'number') {
            if (level >= 0 && level <= 100) {
                return level;
            }
            if (capacity && capacity > 0) {
                return Utils.calculatePercentage(level, capacity);
            }
        }
        return null;
    }

    getTonerStatus(level) {
        if (typeof level !== 'number') return 'unknown';
        
        if (level <= 5) return 'critical';
        if (level <= 15) return 'low';
        if (level <= 30) return 'medium';
        return 'good';
    }

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
     * Formatta l'output per la console (mantenuto per compatibilità)
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
        
        return JSON.stringify(this.data, null, 2);
    }

    formatSummary() {
        const lines = [];
        
        lines.push(`\n${'='.repeat(60)}`);
        lines.push(`📊 RIEPILOGO STAMPANTE (CLOUD ENABLED)`);
        lines.push(`${'='.repeat(60)}`);
        
        lines.push(`🖨️  Modello: ${this.data.metadata.model.name}`);
        lines.push(`🏢 Vendor: ${this.data.metadata.model.vendor}`);
        lines.push(`🌐 Host: ${this.host}`);
        
        if (this.data.basic?.serialNumber?.value) {
            lines.push(`🔢 Seriale: ${this.data.basic.serialNumber.value}`);
        }

        if (this.data.status?.printerStatus?.displayValue) {
            lines.push(`📋 Stato: ${this.data.status.printerStatus.displayValue}`);
        }

        lines.push(`\n🎨 TONER:`);
        for (const [color, info] of Object.entries(this.data.toner || {})) {
            if (info.percentage !== undefined) {
                const status = info.status === 'critical' ? '🔴' : 
                             info.status === 'low' ? '🟡' : '🟢';
                lines.push(`   ${status} ${color}: ${info.percentage}%`);
            }
        }

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

        // Cloud info
        if (this.options.sendToCloud) {
            lines.push(`\n☁️  CLOUD STATUS:`);
            lines.push(`   🔗 Endpoint: ${this.options.apiEndpoint}`);
            lines.push(`   🏢 Tenant: ${this.options.tenantId}`);
        }

        lines.push(`\n⏰ Aggiornato: ${new Date(this.data.metadata.timestamp).toLocaleString()}`);
        lines.push(`${'='.repeat(60)}`);
        
        return lines.join('\n');
    }

    formatDetailed() {
        return JSON.stringify(this.data, null, 2);
    }

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
        console.log('Uso: node src/monitor.js --host 192.168.180.141 [options]');
        console.log('');
        console.log('Opzioni Cloud:');
        console.log('  --api-endpoint http://localhost:3000/v1    Backend API endpoint');
        console.log('  --api-key KEY                             API key per autenticazione');
        console.log('  --tenant-id ID                            Tenant ID');
        console.log('  --no-cloud                                Disabilita invio al cloud');
        console.log('');
        console.log('Variabili Ambiente:');
        console.log('  PRINTER_MONITOR_API_KEY                   API key');
        console.log('  PRINTER_MONITOR_TENANT_ID                 Tenant ID');
        process.exit(1);
    }

    if (!Utils.isValidIP(host)) {
        console.error(`❌ Errore: IP non valido ${host}`);
        process.exit(1);
    }

    const monitor = new PrinterMonitorCloud(host, {
        community: argv.community || 'public',
        format: argv.format || 'summary',
        save: argv.save || false,
        timeout: argv.timeout || 10000,
        retries: argv.retries || 2,
        // Cloud options
        apiEndpoint: argv['api-endpoint'] || process.env.PRINTER_MONITOR_API_ENDPOINT || 'http://localhost:3000/v1',
        apiKey: argv['api-key'] || process.env.PRINTER_MONITOR_API_KEY,
        tenantId: argv['tenant-id'] || process.env.PRINTER_MONITOR_TENANT_ID,
        sendToCloud: !argv['no-cloud']
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

        // 5. Invia al cloud (prioritario)
        let cloudResult = null;
        try {
            cloudResult = await monitor.sendToCloudAPI();
        } catch (cloudError) {
            console.error('⚠️  Fallback: continuo con salvataggio locale');
        }

        // 6. Salva backup locale
        await monitor.saveResultsLocally();

        // 7. Output console
        console.log(monitor.formatOutput());

        // 8. Exit con codice appropriato
        process.exit(cloudResult ? 0 : 1);

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

module.exports = { PrinterMonitorCloud };