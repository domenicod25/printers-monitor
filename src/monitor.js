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
const axios = require('axios');
const argv = require('minimist')(process.argv.slice(2));
const { SNMPManager, MappingManager, Utils } = require('../utils/snmp-utils');
const APIClient = require('./api-client');
const HeartbeatManager = require('./heartbeat');

// ============================================
// CONFIGURATION LOADING
// ============================================
/**
 * Carica configurazione: prima tenta embedded config (produzione),
 * poi fallback a config.json (development)
 */
let config;
try {
    // In produzione (nexe), config è embedded come risorsa
    const embeddedPath = path.join(__dirname, 'embedded-config.json');
    const configContent = fs.readFileSync(embeddedPath, 'utf-8');
    config = JSON.parse(configContent);
    console.log('✅ Loaded embedded configuration');
    console.log('   Backend:', config.backend_url);
    console.log('   Tenant:', config.tenant_id);
} catch (error) {
    // Fallback per development
    try {
        config = require('../configs/config.json');
        console.log('⚠️  Using development config (fallback)');
        console.log('   Backend:', config.backend?.url || 'not configured');
    } catch (fallbackError) {
        console.error('❌ Failed to load configuration:', fallbackError.message);
        process.exit(1);
    }
}

// Inizializza API Client (se backend configurato)
let apiClient = null;
let heartbeatManager = null;

if (config.backend_url || config.backend?.enabled) {
    const backendConfig = {
        backend_url: config.backend_url || config.backend?.url,
        api_key: config.api_key || config.backend?.api_key,
        tenant_id: config.tenant_id || config.backend?.tenant_id,
        retry_attempts: config.backend?.retry_attempts || 3,
        retry_delay: config.backend?.retry_delay || 5000,
    };
    
    apiClient = new APIClient(backendConfig);
    heartbeatManager = new HeartbeatManager({ ...config, ...backendConfig, printers: config.printers }, apiClient);
    
    console.log('🔗 API Client initialized');
}
// ============================================


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
        this.apiClient = options.apiClient || null; // API Client per backend
        this.heartbeatManager = options.heartbeatManager || null; // Heartbeat manager
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
     * Salva i risultati su file
     */
    async saveResults() {
        if (!this.options.save) {
            return null;
        }

        const filename = `${this.model.name}_${this.host.replace(/\./g, '_')}_${Utils.timestamp()}.json`;
        const filepath = path.join(this.options.outputDir, filename);

        // Crea directory se non esiste
        if (!fs.existsSync(this.options.outputDir)) {
            fs.mkdirSync(this.options.outputDir, { recursive: true });
        }

        fs.writeFileSync(filepath, JSON.stringify(this.data, null, 2));
        console.log(`💾 Dati salvati in: ${filepath}`);

        return filepath;
    }

    /**
     * Submit telemetry data to backend API
     */
    async submitToBackend() {
        // Check if backend integration is enabled
        const backendConfig = this.mappingManager.config.backend;
        if (!backendConfig || !backendConfig.enabled) {
            console.log('ℹ️  Backend integration disabled');
            return null;
        }

        console.log(`📤 Submitting telemetry to backend...`);

        const url = `${backendConfig.url}/telemetry`;
        
        // Prepare payload matching SubmitTelemetryDto
        const payload = {
            device: {
                ip_address: this.host,
                serial_number: this.printerInfo.prtGeneralSerialNumber || undefined,
                model: this.model.name,
                vendor: this.model.vendor,
                mac_address: undefined // TODO: Extract from SNMP if available
            },
            telemetry: {
                toner_levels: this.extractTonerLevels(),
                paper_levels: this.extractPaperLevels(),
                status_info: this.extractStatusInfo(),
                counters: this.extractCounters(),
                raw_snmp_data: this.options.format === 'raw' ? this.data : undefined
            },
            collection_metadata: {
                successful_oids: this.data.metadata?.successful_oids,
                total_oids: this.data.metadata?.total_oids
            },
            collected_at: new Date().toISOString()
        };

        // Retry logic
        let lastError;
        for (let attempt = 1; attempt <= backendConfig.retry_attempts; attempt++) {
            try {
                const response = await axios.post(url, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-tenant-id': backendConfig.tenant_id,
                        'x-agent-version': backendConfig.agent_version,
                        'Authorization': `Bearer ${backendConfig.api_key}`
                    },
                    timeout: 30000,
                    validateStatus: () => true // Non lanciare errore automaticamente
                });

                if (response.status >= 400) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText || 'Error'}`);
                }

                const result = response.data;
                console.log(`✅ Telemetry submitted successfully`);
                console.log(`   Device ID: ${result.device_id}`);
                console.log(`   Telemetry ID: ${result.telemetry_id}`);
                if (result.alerts_generated > 0) {
                    console.log(`   ⚠️  Alerts generated: ${result.alerts_generated}`);
                }

                return result;

            } catch (error) {
                lastError = error;
                console.log(`   ⚠️  Attempt ${attempt}/${backendConfig.retry_attempts} failed: ${error.message}`);
                
                if (attempt < backendConfig.retry_attempts) {
                    console.log(`   ⏳ Retrying in ${backendConfig.retry_delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backendConfig.retry_delay));
                }
            }
        }

        console.error(`❌ Failed to submit telemetry after ${backendConfig.retry_attempts} attempts`);
        console.error(`   Last error: ${lastError.message}`);
        return null;
    }

    /**
     * Extract toner levels from collected data
     */
    extractTonerLevels() {
        const toner = {};
        if (this.data.toner) {
            for (const [color, info] of Object.entries(this.data.toner)) {
                if (info.percentage !== undefined) {
                    toner[color.toLowerCase()] = Math.round(info.percentage);
                }
            }
        }
        return Object.keys(toner).length > 0 ? toner : undefined;
    }

    /**
     * Extract paper levels from collected data
     */
    extractPaperLevels() {
        const paper = {};
        if (this.data.paper) {
            for (const [tray, info] of Object.entries(this.data.paper)) {
                if (info.current !== undefined) {
                    paper[tray] = {
                        current: info.current,
                        capacity: info.capacity || 0
                    };
                }
            }
        }
        return Object.keys(paper).length > 0 ? paper : undefined;
    }

    /**
     * Extract status info from collected data
     */
    extractStatusInfo() {
        const status = {};
        if (this.data.status) {
            status.printer_status = this.data.status.printer_status?.value || 'unknown';
            if (this.data.status.printer_status?.displayValue) {
                status.detailed_status = this.data.status.printer_status.displayValue;
            }
        }
        return Object.keys(status).length > 0 ? status : undefined;
    }

    /**
     * Extract counters from collected data
     */
    extractCounters() {
        const counters = {};
        if (this.data.counters) {
            if (this.data.counters.total_pages?.value !== undefined) {
                counters.total_pages = parseInt(this.data.counters.total_pages.value);
            }
            if (this.data.counters.color_pages?.value !== undefined) {
                counters.color_pages = parseInt(this.data.counters.color_pages.value);
            }
            if (this.data.counters.mono_pages?.value !== undefined) {
                counters.mono_pages = parseInt(this.data.counters.mono_pages.value);
            }
        }
        return Object.keys(counters).length > 0 ? counters : undefined;
    }

    /**
     * Salva i risultati su file
     */
    async saveResults_OLD() {
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

    /**
     * Invia dati raccolti al backend
     */
    async submitToBackend() {
        if (!this.apiClient) {
            console.log('⚠️  No API client configured, skipping backend submission');
            return;
        }

        console.log('📤 Submitting telemetry to backend...');

        try {
            const payload = {
                device_info: {
                    ip_address: this.host,
                    model: this.model.name,
                    vendor: this.model.vendor,
                    serial_number: this.printerInfo.prtGeneralSerialNumber || null,
                    sys_descr: this.printerInfo.sysDescr || '',
                },
                telemetry_data: {
                    toner_levels: this.extractTonerLevels(),
                    paper_levels: this.extractPaperLevels(),
                    counters: this.extractCounters(),
                    status_info: this.extractStatus(),
                },
                collected_at: new Date().toISOString(),
            };

            await this.apiClient.post('/telemetry', payload);
            console.log('✅ Telemetry submitted successfully');
            
            // Incrementa contatore heartbeat se disponibile
            if (this.heartbeatManager) {
                this.heartbeatManager.incrementTelemetry();
            }
        } catch (error) {
            console.error('❌ Failed to submit telemetry:', error.message);
            // Non blocca l'agent, continua
        }
    }

    /**
     * Estrae livelli toner per il backend
     */
    extractTonerLevels() {
        const toner = this.data.toner || {};
        return Object.entries(toner).reduce((acc, [color, data]) => {
            if (data.percentage !== undefined) {
                acc[color] = data.percentage;
            }
            return acc;
        }, {});
    }

    /**
     * Estrae livelli carta per il backend
     */
    extractPaperLevels() {
        const paper = this.data.paper || {};
        return Object.entries(paper).reduce((acc, [tray, data]) => {
            if (data.current !== undefined) {
                acc[tray] = {
                    current: data.current,
                    capacity: data.capacity || null,
                };
            }
            return acc;
        }, {});
    }

    /**
     * Estrae contatori per il backend
     */
    extractCounters() {
        const counters = this.data.counters || {};
        return Object.entries(counters).reduce((acc, [key, data]) => {
            if (data.value !== undefined) {
                acc[key] = data.value;
            }
            return acc;
        }, {});
    }

    /**
     * Estrae status per il backend
     */
    extractStatus() {
        const status = this.data.status || {};
        return {
            printer_status: status.printerStatus?.displayValue || 'unknown',
            detailed_status: status.hrDeviceStatus?.value || '',
        };
    }
}

/**
 * Monitora una singola stampante
 */
async function monitorPrinter(printerConfig) {
    const monitor = new PrinterMonitor(printerConfig.ip, {
        community: printerConfig.community || 'public',
        timeout: 10000,
        retries: 2,
        apiClient: apiClient,
        heartbeatManager: heartbeatManager,
    });

    try {
        // 1. Inizializza
        await monitor.initialize();

        // 2. Identifica stampante
        await monitor.identifyPrinter();

        // 3. Carica mapping
        monitor.loadMapping();

        // 4. Se mapping non esiste E walk_on_unknown=true
        if (!monitor.mapping && config.schedule?.walk_on_unknown) {
            console.log('⚠️  Mapping non trovato, eseguo walk OID...');
            await walkAndUpload(printerConfig.ip, printerConfig.community);
            throw new Error('Mapping non disponibile, walk eseguito e caricato. Riprova dopo creazione mapping.');
        }

        // 5. Raccoglie dati
        await monitor.collectData();

        // 6. Submit to backend
        await monitor.submitToBackend();

        return { success: true, ip: printerConfig.ip };

    } finally {
        monitor.cleanup();
    }
}

/**
 * Esegue walk OID e lo carica sul backend
 */
async function walkAndUpload(host, community) {
    console.log('🚶 Eseguendo walk OID completo...');
    
    // Import dinamico per evitare circular dependency
    const { PrinterOidWalker } = require('./walkOids');
    
    const walker = new PrinterOidWalker(host, community);
    walker.createSession();

    try {
        // 1. Test connessione
        await walker.testConnection();

        // 2. Ottieni info stampante
        const info = await walker.getPrinterInfo();
        console.log('📋 Info:', info.sysDescr);

        // 3. Walk Printer MIB
        const walkResults = await walker.walkPrinterMib();
        console.log(`✅ Walk completato: ${Object.keys(walkResults).length} OID`);

        // 4. Upload al backend (se config.schedule.upload_walks)
        if (apiClient && config.schedule?.upload_walks) {
            console.log('☁️  Caricamento walk sul backend...');
            
            const payload = {
                device_ip: host,
                model: walker.extractModel(info.sysDescr),
                vendor: 'Unknown',
                sys_descr: info.sysDescr,
                walk_data: walkResults,
            };

            await apiClient.post('/telemetry/walks', payload);
            console.log('✅ Walk caricato con successo');
        } else {
            console.log('⏭️  Upload walk disabilitato o backend non configurato');
        }

        // 5. Salva anche in locale (backup)
        await walker.saveResults(walkResults);
        
    } finally {
        walker.session.close();
    }
}

/**
 * Monitora tutte le stampanti configurate (un ciclo)
 */
async function monitorAllPrinters() {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔄 CICLO MONITORAGGIO - ${new Date().toISOString()}`);
    console.log(`${'='.repeat(80)}`);
    
    // 1. Verifica CLI override (per testing manuale)
    const cliHost = argv.host;
    let printersToMonitor = [];
    
    if (cliHost) {
        console.log('⚠️  CLI override: monitoraggio singola stampante', cliHost);
        printersToMonitor = [{ 
            ip: cliHost, 
            community: argv.community || 'public', 
            enabled: true 
        }];
    } else {
        // 2. Usa stampanti da config embedded
        if (!config.printers || config.printers.length === 0) {
            console.error('❌ Nessuna stampante configurata in embedded config');
            throw new Error('No printers configured');
        }
        
        // Filtra stampanti abilitate
        printersToMonitor = config.printers.filter(p => p.enabled !== false);
        console.log(`📋 Trovate ${printersToMonitor.length} stampanti abilitate (${config.printers.length} totali)`);
    }

    // 3. Loop su tutte le stampanti
    const results = {
        success: 0,
        failed: 0,
        skipped: 0,
        errors: []
    };

    for (const printerConfig of printersToMonitor) {
        try {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🖨️  Monitoraggio stampante: ${printerConfig.ip}`);
            console.log(`${'='.repeat(60)}`);

            await monitorPrinter(printerConfig);

            console.log(`✅ Monitoraggio completato per ${printerConfig.ip}`);
            results.success++;

        } catch (error) {
            console.error(`❌ Errore monitoraggio ${printerConfig.ip}:`, error.message);
            results.failed++;
            results.errors.push({ ip: printerConfig.ip, error: error.message });
            // Continua con prossima stampante (non bloccare)
        }
    }

    // 4. Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 RIEPILOGO CICLO`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   ✅ Successi: ${results.success}`);
    console.log(`   ❌ Errori: ${results.failed}`);
    console.log(`   ⏭️  Saltate: ${results.skipped}`);
    if (results.errors.length > 0) {
        console.log(`\n   Dettaglio errori:`);
        results.errors.forEach(e => {
            console.log(`   • ${e.ip}: ${e.error}`);
        });
    }
    console.log(`${'='.repeat(80)}\n`);

    return results;
}

/**
 * Funzione principale (single-run mode)
 */
async function main() {
    console.log('🎯 Modalità SINGLE-RUN\n');
    
    // Avvia heartbeat se configurato (lo fermeremo alla fine)
    let heartbeatStarted = false;
    if (heartbeatManager && !argv['no-heartbeat']) {
        heartbeatManager.start();
        heartbeatStarted = true;
    }

    try {
        // Esegui un ciclo completo
        await monitorAllPrinters();
        
        console.log('\n✅ Ciclo monitoraggio completato');
        
    } finally {
        // Cleanup
        if (heartbeatStarted && heartbeatManager) {
            heartbeatManager.stop();
        }
    }
}

/**
 * Modalità Daemon - Esegue monitoring continuo
 */
async function runDaemon() {
    const intervalMinutes = config.schedule?.interval_minutes || 5;
    const intervalMs = intervalMinutes * 60 * 1000;
    
    console.log('� MODALITÀ DAEMON ATTIVATA');
    console.log(`   Intervallo: ${intervalMinutes} minuti`);
    console.log(`   Stampanti configurate: ${config.printers?.length || 0}`);
    console.log(`   Backend: ${config.backend_url || 'disabled'}`);
    console.log('');

    // Avvia heartbeat manager (continuo)
    if (heartbeatManager) {
        heartbeatManager.start();
    }

    // Graceful shutdown handlers
    let isShuttingDown = false;
    let intervalId = null;
    
    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log(`\n⚠️  Ricevuto ${signal}, arresto in corso...`);
        
        // Stop interval
        if (intervalId) {
            clearInterval(intervalId);
        }
        
        // Stop heartbeat
        if (heartbeatManager) {
            heartbeatManager.stop();
        }
        
        console.log('✅ Agent arrestato correttamente');
        process.exit(0);
    };

    // Registra signal handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Esegui primo ciclo immediatamente
    try {
        await monitorAllPrinters();
    } catch (error) {
        console.error('❌ Errore nel primo ciclo:', error.message);
        console.log('🔄 Continuo con i cicli successivi...');
    }

    // Loop infinito con setInterval
    console.log(`💤 Attesa ${intervalMinutes} minuti prima del prossimo ciclo...\n`);
    
    intervalId = setInterval(async () => {
        if (isShuttingDown) return;
        
        try {
            const startTime = Date.now();
            await monitorAllPrinters();
            const elapsed = Date.now() - startTime;
            
            console.log(`⏱️  Ciclo completato in ${(elapsed / 1000).toFixed(2)}s`);
            console.log(`💤 Attesa ${intervalMinutes} minuti prima del prossimo ciclo...\n`);
            
        } catch (error) {
            console.error('❌ Errore nel ciclo:', error.message);
            console.log('🔄 Ritento al prossimo intervallo...\n');
        }
    }, intervalMs);

    console.log('✅ Daemon avviato con successo');
    console.log('   Premi Ctrl+C per arrestare\n');
}

// Esegui solo se chiamato direttamente
if (require.main === module) {
    const isDaemon = argv.daemon || process.env.DAEMON_MODE === 'true';
    
    if (isDaemon) {
        runDaemon().catch((error) => {
            console.error('❌ Fatal error in daemon:', error);
            process.exit(1);
        });
    } else {
        // Esecuzione singola (testing o CLI override)
        main().catch((error) => {
            console.error('❌ Error:', error);
            process.exit(1);
        });
    }
}

module.exports = { PrinterMonitor };