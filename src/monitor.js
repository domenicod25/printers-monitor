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
const ConfigLoader = require('./config-loader');

// ============================================
// CONFIGURATION LOADING (UNIFIED)
// ============================================
let config;
try {
    config = ConfigLoader.load();
} catch (error) {
    console.error('❌ Failed to load configuration:', error.message);
    process.exit(1);
}

// Inizializza API Client
const apiClient = new APIClient({
    backend_url: config.backend_url,
    api_key: config.api_key,
    company_id: config.company_id,
    retry_attempts: config.retry_attempts,
    retry_delay: config.retry_delay,
});

console.log('🔗 API Client initialized');
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
     * Usa DataCollector per separazione responsabilità
     */
    async collectData() {
        console.log('📊 Raccolta dati in corso...');
        
        const { DataCollector } = require('./data-processors');
        const collector = new DataCollector(this.snmp, this.mapping);
        
        // Raccoglie e processa dati
        const collectedData = await collector.collect();
        
        // Aggiungi metadata host e model
        this.data = {
            metadata: {
                ...collectedData.metadata,
                host: this.host,
                model: this.model
            },
            basic: collectedData.basic,
            status: collectedData.status,
            toner: collectedData.toner,
            paper: collectedData.paper,
            counters: collectedData.counters,
            raw: this.options.format === 'raw' ? collectedData.raw : undefined
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
                        'x-company-id': backendConfig.company_id,
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
            const os = require('os');
            const payload = {
                device: {
                    ip_address: this.host,
                    model: this.model.name,
                    vendor: this.model.vendor,
                    serial_number: this.printerInfo.prtGeneralSerialNumber || null,
                    mac_address: null, // TODO: Extract from SNMP if available
                },
                telemetry: {
                    toner_levels: this.extractTonerLevels(),
                    paper_levels: this.extractPaperLevels(),
                    counters: this.extractCounters(),
                    status_info: this.extractStatus(),
                },
                collection_metadata: {
                    successful_oids: this.data.metadata?.successful_oids,
                    total_oids: this.data.metadata?.total_oids,
                },
                // Metadata agent (consolidato da ex-heartbeat)
                agent: {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    os_version: os.release(),
                    agent_version: '1.0.0',
                    uptime_seconds: Math.floor(process.uptime()),
                    memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                },
                collected_at: new Date().toISOString(),
            };

            // Debug: log payload in development
            if (process.env.DEBUG_TELEMETRY) {
                console.log('📋 Telemetry payload:', JSON.stringify(payload, null, 2));
            }

            await this.apiClient.post('/telemetry', payload);
            console.log('✅ Telemetry submitted (includes agent metadata)');
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

    // ==================== PHASE 2: MAPPING MANAGEMENT ====================

    /**
     * Verifica se sta usando il mapping generico (fallback)
     */
    isUsingGenericMapping() {
        return this.mapping?.metadata?.name === 'generic_printer' || this.model?.fallback === true;
    }

    /**
     * Esegue walk OID completo e lo carica al backend
     */
    async walkAndUploadOids() {
        if (!this.apiClient) {
            console.log('⚠️  No API client configured, cannot upload walk');
            return null;
        }

        console.log('🚶 Executing OID walk for unknown printer...');
        console.log(`   Model: ${this.model?.name || 'Unknown'}`);
        console.log(`   Vendor: ${this.model?.vendor || 'Unknown'}`);

        try {
            // Esegui walk del Printer MIB (1.3.6.1.2.1.43)
            const walkData = await this.snmp.walk('1.3.6.1.2.1.43');
            
            if (!walkData || Object.keys(walkData).length === 0) {
                console.log('⚠️  No data collected from walk');
                return null;
            }

            console.log(`✅ Walk completed: ${Object.keys(walkData).length} OIDs collected`);

            // Prepara payload per backend
            const payload = {
                device_ip: this.host,
                model: this.model?.name || 'Unknown',
                vendor: this.model?.vendor || 'Unknown',
                sys_descr: this.printerInfo.sysDescr || '',
                walk_data: walkData,
            };

            // Upload al backend
            console.log('☁️  Uploading walk to backend...');
            const response = await this.apiClient.post('/telemetry/walks', payload);
            console.log('✅ Walk uploaded successfully');
            console.log(`   Walk ID: ${response.walk_id}`);

            return response.walk_id;

        } catch (error) {
            console.error('❌ Failed to walk and upload OIDs:', error.message);
            return null;
        }
    }

    /**
     * Marca il device come "needs_mapping" nel backend
     */
    async markAsUnmapped(walkId) {
        if (!this.apiClient) {
            console.log('⚠️  No API client configured, cannot mark as unmapped');
            return;
        }

        try {
            console.log('📝 Marking device as needs_mapping...');
            
            const payload = {
                walk_id: walkId,
                needs_mapping: true,
                mapping_name: 'generic_printer',
            };

            // POST /agent/devices/:ip/mark-unmapped (public endpoint for agents)
            await this.apiClient.post(`/agent/devices/${this.host}/mark-unmapped`, payload);
            
            console.log('✅ Device marked as needs_mapping');
            console.log('   Super admin can now create specific mapping from walk data');

        } catch (error) {
            // Non bloccare l'agent se fallisce
            console.error('⚠️  Failed to mark device as unmapped:', error.message);
        }
    }

    /**
     * Verifica se esistono nuovi mappings disponibili sul backend
     */
    async checkForNewMapping() {
        if (!this.apiClient) {
            return null;
        }

        try {
            // Tenta di scaricare mapping specifico per questo modello
            const modelName = this.model?.name || this.printerInfo.sysDescr;
            if (!modelName) return null;

            console.log(`🔍 Checking for mapping: ${modelName}`);
            
            // GET /agent/mappings/:name (public endpoint for agents)
            const mapping = await this.apiClient.get(`/agent/mappings/${encodeURIComponent(modelName)}`);
            
            if (mapping && mapping.is_active) {
                console.log(`✅ New mapping found: ${mapping.display_name}`);
                console.log(`   Version: ${mapping.version}`);
                
                // Salva mapping in locale per cache
                this.saveMapping(modelName, mapping.mappings);
                
                return mapping;
            }

        } catch (error) {
            // 404 è normale se il mapping non esiste ancora
            if (error.response?.status !== 404) {
                console.error('⚠️  Failed to check for new mapping:', error.message);
            }
        }

        return null;
    }

    /**
     * Salva mapping scaricato dal backend in locale
     */
    saveMapping(modelName, mappingData) {
        try {
            const mappingsDir = path.join(__dirname, '../mappings');
            if (!fs.existsSync(mappingsDir)) {
                fs.mkdirSync(mappingsDir, { recursive: true });
            }

            const filepath = path.join(mappingsDir, `${modelName}.json`);
            fs.writeFileSync(filepath, JSON.stringify(mappingData, null, 2));
            
            console.log(`💾 Mapping saved locally: ${filepath}`);

        } catch (error) {
            console.error('⚠️  Failed to save mapping locally:', error.message);
        }
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
    });

    try {
        // 1. Inizializza
        await monitor.initialize();

        // 2. Identifica stampante
        await monitor.identifyPrinter();

        // 3. Carica mapping
        monitor.loadMapping();

        // 4. Gestione intelligente mapping
        const usingGeneric = monitor.isUsingGenericMapping();
        
        if (usingGeneric) {
            console.log('⚠️  Stampante sconosciuta - uso mapping generico');
            
            // Step 1: Check se esiste già mapping specifico sul backend
            const newMapping = await monitor.checkForNewMapping();
            if (newMapping) {
                console.log('🎉 Trovato mapping specifico! Ricarico...');
                monitor.mapping = newMapping.mappings;
                monitor.model.name = newMapping.name;
            } else {
                // Step 2: Walk OID e upload automatico (background per non bloccare)
                console.log('🔍 Eseguo walk OID in background...');
                monitor.walkAndUploadOids()
                    .then(walkId => {
                        if (walkId) {
                            monitor.markAsUnmapped(walkId);
                            console.log(`✅ [${printerConfig.ip}] Walk completato (ID: ${walkId})`);
                        }
                    })
                    .catch(err => console.warn(`⚠️  [${printerConfig.ip}] Walk fallito: ${err.message}`));
                
                // Continua con mapping generico (non aspetta walk)
                console.log('   → Procedo con dati limitati (mapping generico)');
            }
        } else {
            console.log('✅ Mapping specifico:', monitor.mapping.metadata.name);
        }

        // 5. Raccolta dati + invio backend
        await monitor.collectData();
        await monitor.submitToBackend();

        return { success: true, ip: printerConfig.ip, using_generic: usingGeneric };

    } catch (error) {
        console.error(`❌ Error monitoring ${printerConfig.ip}:`, error.message);
        throw error;
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

        // 4. Upload al backend (sempre abilitato)
        if (apiClient && config.upload_walks) {
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

    // 3. Monitora tutte le stampanti in parallelo (max 3 contemporanee)
    const results = {
        success: 0,
        failed: 0,
        skipped: 0,
        errors: [],
        total: printersToMonitor.length,
        duration: 0
    };

    const startTime = Date.now();
    const MAX_CONCURRENT = 3; // Massimo 3 stampanti simultanee
    
    // Esegui in batch paralleli
    for (let i = 0; i < printersToMonitor.length; i += MAX_CONCURRENT) {
        const batch = printersToMonitor.slice(i, i + MAX_CONCURRENT);
        const batchNumber = Math.floor(i / MAX_CONCURRENT) + 1;
        const totalBatches = Math.ceil(printersToMonitor.length / MAX_CONCURRENT);
        
        console.log(`\n� Batch ${batchNumber}/${totalBatches} - Stampanti: ${batch.map(p => p.ip).join(', ')}`);
        
        // Monitora batch in parallelo
        const batchPromises = batch.map(async (printerConfig) => {
            try {
                console.log(`🖨️  [${printerConfig.ip}] Avvio monitoraggio...`);
                await monitorPrinter(printerConfig);
                console.log(`✅ [${printerConfig.ip}] Completato`);
                return { success: true, ip: printerConfig.ip };
            } catch (error) {
                console.error(`❌ [${printerConfig.ip}] Errore: ${error.message}`);
                return { success: false, ip: printerConfig.ip, error: error.message };
            }
        });
        
        // Attendi completamento batch
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Elabora risultati batch
        batchResults.forEach((result) => {
            if (result.status === 'fulfilled') {
                if (result.value.success) {
                    results.success++;
                } else {
                    results.failed++;
                    results.errors.push({ 
                        ip: result.value.ip, 
                        error: result.value.error 
                    });
                }
            } else {
                results.failed++;
                results.errors.push({ 
                    ip: 'unknown', 
                    error: result.reason?.message || 'Unknown error' 
                });
            }
        });
    }
    
    results.duration = Date.now() - startTime;

    // 4. Summary con metriche
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 RIEPILOGO CICLO`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   📋 Totale: ${results.total} stampanti`);
    console.log(`   ✅ Successi: ${results.success} (${Math.round(results.success/results.total*100)}%)`);
    console.log(`   ❌ Errori: ${results.failed} (${Math.round(results.failed/results.total*100)}%)`);
    console.log(`   ⏱️  Durata: ${(results.duration / 1000).toFixed(2)}s`);
    console.log(`   🚀 Velocità: ${(results.duration / results.total / 1000).toFixed(2)}s/stampante (media)`);
    
    if (results.errors.length > 0) {
        console.log(`\n   ❌ Dettaglio errori:`);
        results.errors.forEach(e => {
            console.log(`      • ${e.ip}: ${e.error}`);
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

    // Esegui un ciclo completo
    await monitorAllPrinters();
    
    console.log('\n✅ Ciclo monitoraggio completato');
}

/**
 * Modalità Daemon - Esegue monitoring continuo
 */
async function runDaemon() {
    const intervalMinutes = config.interval_minutes;
    const intervalMs = intervalMinutes * 60 * 1000;
    
    console.log('� MODALITÀ DAEMON ATTIVATA');
    console.log(`   Intervallo: ${intervalMinutes} minuti`);
    console.log(`   Stampanti configurate: ${config.printers?.length || 0}`);
    console.log(`   Backend: ${config.backend_url || 'disabled'}`);
    console.log('');

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