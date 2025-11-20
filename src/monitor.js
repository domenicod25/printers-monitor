#!/usr/bin/env node
/**
 * Printer Monitor - REFACTORED VERSION v3.0
 * 
 * NEW ARCHITECTURE (v3.0):
 * - Backend is SINGLE SOURCE OF TRUTH
 * - Agent calls /agent/scan-config at startup (bootstrap with cache)
 * - Backend determines device status: discovered, operational, walk_requested
 * - Walk is "one-shot": executed ONLY when status requires it
 * - Walk UNA VOLTA in discovered (automatico), poi walk_enabled=false
 * - Walk UNA VOLTA in walk_requested (richiesto dealer), poi walk_enabled=false
 * - NO walk in operational (stato normale, 99% del tempo)
 * - Bootstrap cache TTL: 5 minuti
 */

const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));
const { SNMPManager, Utils } = require('../utils/snmp-utils');
const APIClient = require('./api-client');
const ConfigLoader = require('./config-loader');

// ============================================
// CONFIGURATION LOADING
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
console.log('🎯 Architecture: Backend as Single Source of Truth\n');

// ============================================
// BOOTSTRAP CACHE (NEW ARCHITECTURE v3.0)
// ============================================
let SCAN_CONFIG_CACHE = null;
let SCAN_CONFIG_TIMESTAMP = null;
const SCAN_CONFIG_TTL = 0; //5 * 60 * 1000; Cache disabilitata - fetch fresca ogni ciclo

/**
 * Bootstrap: Get scan configuration for all devices (with cache)
 * Replaces per-device mapping-strategy calls
 */
async function bootstrapScanConfig(devices) {
    const now = Date.now();
    
    // Return cached config if still valid
    if (SCAN_CONFIG_CACHE && SCAN_CONFIG_TIMESTAMP && (now - SCAN_CONFIG_TIMESTAMP < SCAN_CONFIG_TTL)) {
        console.log('📦 Usando configurazione cache (età: ' + Math.floor((now - SCAN_CONFIG_TIMESTAMP) / 1000) + 's)');
        return SCAN_CONFIG_CACHE;
    }
    
    console.log('🔄 Richiesta nuova configurazione al backend...');
    
    try {
        const payload = {
            company_id: config.company_id,
            api_key: config.api_key,
            devices: devices.map(d => ({
                ip: d.ip,
                last_walk_at: undefined, // TODO: potremmo tracciare localmente
            }))
        };
        
        const response = await apiClient.post('/agent/scan-config', payload);
        
        // Cache response
        SCAN_CONFIG_CACHE = response.devices;
        SCAN_CONFIG_TIMESTAMP = now;
        
        console.log(`✅ Configurazione ricevuta per ${response.devices.length} devices`);
        
        // Log stats
        const statusCounts = {};
        response.devices.forEach(d => {
            statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
        });
        console.log('   Status:', JSON.stringify(statusCounts));
        
        return SCAN_CONFIG_CACHE;
        
    } catch (error) {
        console.error('❌ Errore bootstrap config:', error.message);
        // Fallback: use old cache if available
        if (SCAN_CONFIG_CACHE) {
            console.warn('⚠️  Usando cache obsoleta come fallback');
            return SCAN_CONFIG_CACHE;
        }
        throw error;
    }
}

/**
 * Get device configuration from cache
 */
function getDeviceConfig(ip) {
    if (!SCAN_CONFIG_CACHE) {
        throw new Error('Scan config not loaded - call bootstrapScanConfig first');
    }
    
    const config = SCAN_CONFIG_CACHE.find(d => d.ip === ip);
    if (!config) {
        throw new Error(`Device ${ip} not found in scan config`);
    }
    
    return config;
}
// ============================================


class PrinterMonitor {
    constructor(host, options = {}) {
        this.host = host;
        this.config = config;
        this.options = {
            community: options.community || 'public',
            timeout: options.timeout || 10000,
            retries: options.retries || 2,
            save: options.save || false,
            outputDir: options.outputDir || './output'
        };
        
        this.snmp = null;
        this.printerInfo = {};
        this.model = null;
        this.vendor = null;
        this.mapping = null; // Received from backend
        this.data = {};
        this.apiClient = options.apiClient || null;
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

        // Test connessione
        await this.snmp.testConnection();
        console.log('✅ Connessione SNMP stabilita');
    }

    /**
     * Get basic printer identification (model, vendor, sysDescr)
     * Used to request mapping strategy from backend
     */
    async getBasicIdentification() {
        console.log('🔍 Raccolta informazioni base stampante...');
        
        const identificationOids = {
            sysDescr: '1.3.6.1.2.1.1.1.0',
            sysObjectID: '1.3.6.1.2.1.1.2.0',
            prtGeneralSerialNumber: '1.3.6.1.2.1.43.5.1.1.17.1',
        };
        
        const results = await this.snmp.get(Object.values(identificationOids));
        
        // Estrai informazioni base
        this.printerInfo = {};
        for (const [key, oid] of Object.entries(identificationOids)) {
            const result = results[oid];
            if (result && result.success) {
                this.printerInfo[key] = result.value;
            }
        }

        const sysDescr = this.printerInfo.sysDescr;
        
        // Extract model and vendor from sysDescr (basic parsing)
        this.model = this.extractModel(sysDescr);
        this.vendor = this.extractVendor(sysDescr);

        console.log(`📋 Info stampante:`);
        console.log(`   Model: ${this.model || 'Unknown'}`);
        console.log(`   Vendor: ${this.vendor || 'Unknown'}`);
        console.log(`   SysDescr: ${sysDescr}`);
        
        if (this.printerInfo.prtGeneralSerialNumber) {
            console.log(`   Seriale: ${this.printerInfo.prtGeneralSerialNumber}`);
        }
        
        return {
            model: this.model,
            vendor: this.vendor,
            sys_descr: sysDescr,
        };
    }

    /**
     * Extract model from sysDescr (basic parsing)
     */
    extractModel(sysDescr) {
        if (!sysDescr) return null;
        
        // Try to extract model name (e.g., "Develop ineo+ 250i" from description)
        const patterns = [
            /(?:Model|MODELO|model)[\s:]+([^,;\n]+)/i,
            /(ineo\+\s+\d+i)/i,  // Develop ineo+ 250i, ineo+ 450i, etc.
            /(ineo[+\s]+[^\s,;]+)/i,  // Generic ineo models
            /(MFC-[^\s,;]+)/i,
            /(OfficeJet[^\s,;]+)/i,
        ];
        
        for (const pattern of patterns) {
            const match = sysDescr.match(pattern);
            if (match) {
                return match[1].trim();
            }
        }
        
        // Fallback: first part of sysDescr
        return sysDescr.split(',')[0].split(';')[0].trim();
    }

    /**
     * Extract vendor from sysDescr
     */
    extractVendor(sysDescr) {
        if (!sysDescr) return 'Unknown';
        
        const vendors = ['Develop', 'HP', 'Canon', 'Brother', 'Epson', 'Xerox', 'Samsung', 'Ricoh', 'Konica Minolta', 'Lexmark'];
        
        for (const vendor of vendors) {
            if (sysDescr.toLowerCase().includes(vendor.toLowerCase())) {
                return vendor;
            }
        }
        
        return 'Unknown';
    }

    /**
     * Perform full SNMP walk and upload to backend
     * @param {Object} identification - Device identification info
     * @param {string[]} rootOids - Array of root OIDs to walk (optional)
     */
    async performWalkAndUpload(identification, rootOids = null) {
        console.log('🚶 Esecuzione walk OID...');
        
        const { PrinterOidWalker } = require('./walkOids');
        
        const walker = new PrinterOidWalker(this.host, this.options.community);
        walker.createSession();

        try {
            // 1. Test connessione
            await walker.testConnection();

            // 2. Walk OIDs (multi-root support)
            let walkResults;
            if (rootOids && rootOids.length > 0) {
                console.log(`   Walking ${rootOids.length} root OIDs: ${rootOids.join(', ')}`);
                walkResults = await walker.walkMultipleRoots(rootOids);
            } else {
                console.log('   Walking default Printer MIB');
                walkResults = await walker.walkPrinterMib();
            }
            
            console.log(`✅ Walk completato: ${Object.keys(walkResults).length} OID`);

            // 3. Upload al backend
            console.log('☁️  Caricamento walk sul backend...');
            
            const payload = {
                device_ip: this.host,
                model: identification.model || 'Unknown',
                vendor: identification.vendor || 'Unknown',
                sys_descr: identification.sys_descr,
                walk_data: walkResults,
            };

            const response = await this.apiClient.post('/telemetry/walks', payload);
            console.log('✅ Walk caricato con successo');
            console.log(`   Walk ID: ${response.walk_id}`);
            console.log(`   Device status: ${response.status}`);

            return response.walk_id;
            
        } catch (error) {
            console.error('❌ Errore durante walk:', error.message);
            throw error;
        } finally {
            walker.close();
        }
    }

    /**
     * Raccoglie tutti i dati secondo il mapping ricevuto dal backend
     */
    async collectData() {
        console.log('📊 Raccolta dati in corso...');
        
        if (!this.mapping) {
            throw new Error('No mapping available - cannot collect data');
        }
        
        const { DataCollector } = require('./data-processors');
        
        // Adatta mapping format per DataCollector
        const mappingFormat = {
            metadata: {
                name: this.model || 'unknown',
                displayName: this.model || 'Unknown Printer',
                vendor: this.vendor || 'Unknown',
            },
            mappings: this.mapping,
        };
        
        const collector = new DataCollector(this.snmp, mappingFormat);
        
        // Raccoglie e processa dati
        const collectedData = await collector.collect();
        
        // Aggiungi metadata host e model
        this.data = {
            metadata: {
                ...collectedData.metadata,
                host: this.host,
                model: this.model,
                vendor: this.vendor,
            },
            basic: collectedData.basic,
            status: collectedData.status,
            toner: collectedData.toner,
            paper: collectedData.paper,
            counters: collectedData.counters,
        };

        return this.data;
    }

    /**
     * Submit telemetry data to backend API
     */
    async submitToBackend() {
        console.log(`📤 Invio telemetry al backend...`);

        // Prepare payload matching SubmitTelemetryDto
        const payload = {
            device: {
                ip_address: this.host,
                serial_number: this.printerInfo.prtGeneralSerialNumber || undefined,
                model: this.model || 'Unknown',
                vendor: this.vendor || 'Unknown',
                mac_address: undefined,
            },
            telemetry: {
                toner_levels: this.extractTonerLevels(),
                paper_levels: this.extractPaperLevels(),
                status_info: this.extractStatusInfo(),
                counters: this.extractCounters(),
            },
            collection_metadata: {
                successful_oids: this.data.metadata?.successful_oids,
                total_oids: this.data.metadata?.total_oids
            },
            collected_at: new Date().toISOString()
        };

        try {
            const response = await this.apiClient.post('/telemetry', payload);
            console.log('✅ Telemetry inviato con successo');
            return response;
        } catch (error) {
            console.error('❌ Errore invio telemetry:', error.message);
            throw error;
        }
    }

    /**
     * Extract toner levels from collected data
     */
    extractTonerLevels() {
        if (!this.data.toner) {
            return {};
        }

        const levels = {};
        // DataCollector returns toner directly with colors (not nested in .supplies)
        for (const [color, supply] of Object.entries(this.data.toner)) {
            if (supply && supply.level !== undefined) {
                levels[color] = {
                    level: supply.level,
                    max_capacity: supply.capacity,
                    percentage: supply.percentage,
                    status: supply.status,
                };
            }
        }
        return levels;
    }

    /**
     * Extract paper levels from collected data
     */
    extractPaperLevels() {
        if (!this.data.paper) {
            return {};
        }

        const levels = {};
        // DataCollector returns paper directly with trays (not nested in .trays)
        for (const [tray, info] of Object.entries(this.data.paper)) {
            if (info && info.current !== undefined) {
                levels[tray] = {
                    capacity: info.capacity,
                    current_level: info.current,
                    media_type: info.media_type,
                    status: info.status,
                };
            }
        }
        return levels;
    }

    /**
     * Extract status info from collected data
     */
    extractStatusInfo() {
        if (!this.data.status) {
            return {};
        }

        return {
            device_status: this.data.status.device_status,
            device_errors: this.data.status.device_errors || [],
            printer_status: this.data.status.printer_status,
            detailed_status: this.data.status.detailed_status,
        };
    }

    /**
     * Extract counters from collected data
     */
    extractCounters() {
        if (!this.data.counters) {
            return {};
        }

        return {
            total_pages: this.data.counters.total_pages,
            black_pages: this.data.counters.black_pages,
            color_pages: this.data.counters.color_pages,
            total_impressions: this.data.counters.total_impressions,
        };
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        if (this.snmp) {
            this.snmp.close();
        }
    }
}


/**
 * Monitora una singola stampante con nuova architettura v3.0
 * Uses device config from bootstrap cache (no per-device API calls)
 */
async function monitorPrinter(printerConfig) {
    const monitor = new PrinterMonitor(printerConfig.ip, {
        community: printerConfig.community || 'public',
        timeout: 10000,
        retries: 2,
        apiClient: apiClient,
    });

    try {
        // 1. Inizializza connessione SNMP
        await monitor.initialize();

        // 2. Get device configuration from cache
        const deviceConfig = getDeviceConfig(printerConfig.ip);
        console.log(`📋 Device status: ${deviceConfig.status}`);

        // 3. Ottieni identificazione base (sempre necessaria per telemetry)
        const identification = await monitor.getBasicIdentification();

        // 4. Switch su device status (NEW ARCHITECTURE v3.0 - REFACTORED)
        switch (deviceConfig.status) {
            case 'discovered':
                // New device: walk UNA VOLTA + telemetry with generic_printer
                console.log('🆕 DISCOVERED - Device nuovo, walk automatico');
                
                // 1. Perform walk (UNA VOLTA, solo Printer MIB standard)
                if (deviceConfig.walk_config.enabled) {
                    console.log('   🚶 Walk automatico abilitato (OID: 1.3.6.1.2.1.43)');
                    await monitor.performWalkAndUpload(identification, deviceConfig.walk_config.root_oids);
                    console.log('   ✅ Walk completato e caricato');
                } else {
                    console.warn('   ⚠️  Walk config disabled (anomalo per discovered)');
                }
                
                // 2. Load generic_printer mapping
                const { MappingLoader } = require('./data-processors');
                const genericMapping = MappingLoader.load('generic_printer');
                monitor.mapping = genericMapping.mappings;
                
                // 3. Collect and send telemetry
                await monitor.collectData();
                await monitor.submitToBackend();
                
                console.log('✅ Telemetry inviato (generic_printer)');
                console.log('   → Device creato nel DB, prossimo ciclo sarà OPERATIONAL');
                return { success: true, ip: printerConfig.ip, status: 'discovered', telemetry_sent: true, walk_performed: true };

            case 'walk_requested':
                // Walk richiesto da dealer via frontend (UNA VOLTA)
                console.log('🚶 WALK_REQUESTED - Walk richiesto dal dealer');
                
                // Check if walk is actually enabled
                if (!deviceConfig.walk_config.enabled) {
                    console.warn('⚠️  Walk config disabled - skip walk');
                    return { success: true, ip: printerConfig.ip, status: 'walk_requested', telemetry_sent: false, walk_performed: false };
                }
                
                console.log(`   Root OIDs custom: ${deviceConfig.walk_config.root_oids.join(', ')}`);
                
                // Perform walk with custom OIDs
                await monitor.performWalkAndUpload(identification, deviceConfig.walk_config.root_oids);
                
                console.log('✅ Walk completato e caricato');
                console.log('   → Backend resetterà walk_enabled=false');
                console.log('   → Prossimo ciclo: OPERATIONAL');
                
                // Continue with normal telemetry (usa mapping se disponibile)
                if (deviceConfig.mapping) {
                    console.log('   📤 Telemetria con mapping specifico');
                    monitor.mapping = deviceConfig.mapping;
                } else {
                    console.log('   📤 Telemetria con generic_printer');
                    const { MappingLoader } = require('./data-processors');
                    const genericMapping = MappingLoader.load('generic_printer');
                    monitor.mapping = genericMapping.mappings;
                }
                
                await monitor.collectData();
                await monitor.submitToBackend();
                
                console.log('✅ Telemetry inviato');
                return { success: true, ip: printerConfig.ip, status: 'walk_requested', telemetry_sent: true, walk_performed: true };

            case 'operational':
                // Device operativo - monitoraggio normale (NO walk)
                console.log('✅ OPERATIONAL - Monitoraggio normale');
                
                // Usa mapping specifico SE disponibile, altrimenti generic_printer
                if (deviceConfig.mapping) {
                    console.log('   📋 Uso mapping specifico');
                    monitor.mapping = deviceConfig.mapping;
                } else {
                    console.log('   📋 Uso generic_printer (no mapping assegnato)');
                    const { MappingLoader } = require('./data-processors');
                    const genericMapping = MappingLoader.load('generic_printer');
                    monitor.mapping = genericMapping.mappings;
                }
                
                // Collect and send telemetry (NO walk)
                await monitor.collectData();
                await monitor.submitToBackend();
                
                console.log('✅ Telemetry inviato');
                return { success: true, ip: printerConfig.ip, status: 'operational', telemetry_sent: true, walk_performed: false };

            default:
                console.error(`❌ Unknown device status: ${deviceConfig.status}`);
                throw new Error(`Unknown device status: ${deviceConfig.status}`);
        }

    } catch (error) {
        console.error(`❌ Error monitoring ${printerConfig.ip}:`, error.message);
        throw error;
    } finally {
        monitor.cleanup();
    }
}

/**
 * Monitora tutte le stampanti configurate
 */
async function monitorAllPrinters() {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🖨️  PRINTER MONITORING CYCLE - ${new Date().toLocaleString('it-IT')}`);
    console.log(`${'='.repeat(80)}\n`);

    let printersToMonitor = [];

    // 1. Se backend ha agent config, usa quella (priorità)
    if (config.agent_id) {
        try {
            console.log(`📡 Fetch configurazione agent dal backend (ID: ${config.agent_id})...`);
            const agentConfig = await apiClient.get(`/agents/${config.agent_id}/printers`);
            printersToMonitor = agentConfig.printers || [];
            console.log(`✅ Ricevute ${printersToMonitor.length} stampanti dal backend`);
        } catch (error) {
            console.warn(`⚠️  Impossibile recuperare config da backend: ${error.message}`);
            console.log('   → Fallback a config embedded\n');
        }
    }

    // 2. Se nessuna stampante da backend, usa config embedded
    if (printersToMonitor.length === 0) {
        if (!config.printers || config.printers.length === 0) {
            console.error('❌ Nessuna stampante configurata');
            throw new Error('No printers configured');
        }
        
        printersToMonitor = config.printers.filter(p => p.enabled !== false);
        console.log(`📋 Trovate ${printersToMonitor.length} stampanti abilitate (embedded config)`);
    }

    // 3. Bootstrap: Get scan configuration for all devices (NEW v3.0)
    try {
        await bootstrapScanConfig(printersToMonitor);
    } catch (error) {
        console.error('❌ Errore bootstrap config:', error.message);
        throw new Error('Cannot proceed without scan configuration');
    }

    // 4. Monitora stampanti in parallelo (max 3 contemporanee)
    const results = {
        success: 0,
        failed: 0,
        walks_performed: 0,
        telemetry_sent: 0,
        errors: [],
        total: printersToMonitor.length,
        duration: 0
    };

    const startTime = Date.now();
    const MAX_CONCURRENT = 3;
    
    // Esegui in batch paralleli
    for (let i = 0; i < printersToMonitor.length; i += MAX_CONCURRENT) {
        const batch = printersToMonitor.slice(i, i + MAX_CONCURRENT);
        const batchNumber = Math.floor(i / MAX_CONCURRENT) + 1;
        const totalBatches = Math.ceil(printersToMonitor.length / MAX_CONCURRENT);
        
        console.log(`\n📦 Batch ${batchNumber}/${totalBatches} - Stampanti: ${batch.map(p => p.ip).join(', ')}`);
        
        const batchPromises = batch.map(async (printerConfig) => {
            try {
                console.log(`🖨️  [${printerConfig.ip}] Avvio monitoraggio...`);
                const result = await monitorPrinter(printerConfig);
                console.log(`✅ [${printerConfig.ip}] Completato`);
                return { success: true, ip: printerConfig.ip, ...result };
            } catch (error) {
                console.error(`❌ [${printerConfig.ip}] Errore: ${error.message}`);
                return { success: false, ip: printerConfig.ip, error: error.message };
            }
        });
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Elabora risultati batch
        batchResults.forEach((result) => {
            if (result.status === 'fulfilled') {
                if (result.value.success) {
                    results.success++;
                    if (result.value.walk_performed) results.walks_performed++;
                    if (result.value.telemetry_sent) results.telemetry_sent++;
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
    console.log(`   🚶 Walk eseguiti: ${results.walks_performed}`);
    console.log(`   📤 Telemetry inviati: ${results.telemetry_sent}`);
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
 * Daemon mode - monitoring loop
 */
async function runDaemon() {
    const intervalMinutes = parseInt(process.env.INTERVAL_MINUTES || '5', 10);
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔄 DAEMON MODE - Printer Monitoring Service (v3.0 Refactored)`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   🕐 Intervallo: ${intervalMinutes} minuti (${intervalMs}ms)`);
    console.log(`   🏢 Company ID: ${config.company_id}`);
    console.log(`   🆔 Agent ID: ${config.agent_id || 'Non configurato'}`);
    console.log(`   🔗 Backend: ${config.backend_url}`);
    console.log(`   🎯 Architecture: Backend as Single Source of Truth (v3.0)`);
    console.log(`   🚶 Walk: One-shot (discovered + walk_requested)`);
    console.log(`${'='.repeat(80)}\n`);

    let intervalId = null;
    let isShuttingDown = false;

    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log(`\n⚠️  Ricevuto segnale ${signal} - Arresto in corso...`);
        
        if (intervalId) {
            clearInterval(intervalId);
        }

        console.log('✅ Daemon arrestato correttamente');
        process.exit(0);
    };

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

/**
 * Funzione principale (single-run mode)
 */
async function main() {
    console.log('🎯 Modalità SINGLE-RUN\n');
    await monitorAllPrinters();
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
        main().catch((error) => {
            console.error('❌ Error:', error);
            process.exit(1);
        });
    }
}

module.exports = { PrinterMonitor, monitorPrinter, monitorAllPrinters };
