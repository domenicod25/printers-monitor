#!/usr/bin/env node
/**
 * OID Walker per Stampanti - Focus sul Printer MIB (.43)
 * 
 * Questo script fa un walk completo del ramo 1.3.6.1.2.1.43 (Printer MIB)
 * e salva i risultati in walks/ con il nome del modello della stampante
 * 
 * Usage: node src/walkOids.js --host <IP> [--community public]
 */

const snmp = require("net-snmp");
const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));

// Configurazione
const config = {
    host: argv.host || process.env.PRINTER_HOST || '192.168.180.141',
    community: argv.community || 'public',
    timeout: 10000,
    retries: 2
};

// OID per identificare la stampante
const IDENTIFICATION_OIDS = {
    sysDescr: "1.3.6.1.2.1.1.1.0",        // Descrizione del sistema
    sysName: "1.3.6.1.2.1.1.5.0",         // Nome del sistema
    prtGeneralPrinterName: "1.3.6.1.2.1.43.5.1.1.16.1", // Nome della stampante
    prtGeneralSerialNumber: "1.3.6.1.2.1.43.5.1.1.17.1"  // Numero seriale
};

// Root OID del Printer MIB
const PRINTER_MIB_ROOT = "1.3.6.1.2.1.43";

class PrinterOidWalker {
    constructor(host, community = 'public') {
        this.host = host;
        this.community = community;
        this.session = null;
        this.printerInfo = {};
    }

    /**
     * Crea una sessione SNMP
     */
    createSession() {
        this.session = snmp.createSession(this.host, this.community, {
            port: 161,
            retries: config.retries,
            timeout: config.timeout,
            version: snmp.Version1
        });

        this.session.on('error', (error) => {
            console.error(`❌ Errore sessione SNMP: ${error.message}`);
        });
    }

    /**
     * Test di connessione
     */
    async testConnection() {
        return new Promise((resolve, reject) => {
            console.log(`🔍 Test connessione SNMP a ${this.host}...`);

            this.session.get([IDENTIFICATION_OIDS.sysDescr], (error, varbinds) => {
                if (error) {
                    reject(new Error(`Connessione fallita: ${error.message}`));
                    return;
                }

                if (snmp.isVarbindError(varbinds[0])) {
                    reject(new Error(`Errore SNMP: ${snmp.varbindError(varbinds[0])}`));
                    return;
                }

                console.log("✅ Connessione SNMP riuscita");
                resolve(true);
            });
        });
    }

    /**
     * Recupera informazioni di base della stampante
     */
    async getPrinterInfo() {
        return new Promise((resolve, reject) => {
            console.log("📄 Recupero informazioni stampante...");

            const oids = Object.values(IDENTIFICATION_OIDS);

            this.session.get(oids, (error, varbinds) => {
                if (error) {
                    reject(new Error(`Errore recupero info: ${error.message}`));
                    return;
                }

                const info = {};
                const keys = Object.keys(IDENTIFICATION_OIDS);

                varbinds.forEach((vb, index) => {
                    const key = keys[index];
                    if (snmp.isVarbindError(vb)) {
                        info[key] = null;
                    } else {
                        let value = '';
                        if (Buffer.isBuffer(vb.value)) {
                            value = vb.value.toString('utf8').trim();
                        } else if (vb.value !== null && vb.value !== undefined) {
                            value = vb.value.toString();
                        }
                        info[key] = value;
                    }
                });

                // Estrai modello dalla descrizione
                info.model = this.extractModel(info.sysDescr);
                
                console.log("📋 Stampante identificata:");
                console.log(`  Modello: ${info.model}`);
                console.log(`  Descrizione: ${info.sysDescr}`);
                console.log(`  Seriale: ${info.prtGeneralSerialNumber || 'N/A'}`);

                this.printerInfo = info;
                resolve(info);
            });
        });
    }

    /**
     * Estrae il modello dalla descrizione del sistema
     */
    extractModel(sysDescr) {
        if (!sysDescr) return 'Unknown';
        
        // Rimuovi caratteri speciali e normalizza
        const cleanModel = sysDescr
            .replace(/[^a-zA-Z0-9\s\-_+]/g, '')
            .replace(/\s+/g, '_')
            .trim();
        
        return cleanModel || 'Unknown';
    }

    /**
     * Esegue il walk del Printer MIB (.43)
     */
    async walkPrinterMib() {
        return new Promise((resolve, reject) => {
            console.log("🚶 Inizio walk del Printer MIB (1.3.6.1.2.1.43)...");

            const results = {};
            let count = 0;
            let hasError = false;

            this.session.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error(`❌ Errore durante walk: ${error.message}`);
                    resolve({ results, error: error.message, count });
                }
            });

            this.session.subtree(
                PRINTER_MIB_ROOT,
                (varbindArray) => {
                    if (!varbindArray || varbindArray.length === 0 || hasError) return;

                    const vb = varbindArray[0];
                    count++;

                    if (count % 50 === 0) {
                        console.log(`📊 Processati ${count} OID...`);
                    }

                    if (snmp.isVarbindError(vb)) {
                        results[vb.oid] = {
                            error: snmp.varbindError(vb),
                            type: 'error'
                        };
                        return;
                    }

                    try {
                        const parsedValue = this.parseOidValue(vb);
                        results[vb.oid] = parsedValue;
                    } catch (err) {
                        results[vb.oid] = {
                            error: err.message,
                            type: 'parse_error'
                        };
                    }
                },
                (error) => {
                    if (!hasError) {
                        if (error) {
                            console.log(`⚠️  Walk completato con errori: ${error.message}`);
                            console.log(`📊 OID processati: ${count}`);
                        } else {
                            console.log(`✅ Walk completato con successo!`);
                            console.log(`📊 Totale OID trovati: ${count}`);
                        }
                        resolve({ results, error: error ? error.message : null, count });
                    }
                }
            );
        });
    }

    /**
     * Parser intelligente per i valori OID
     */
    parseOidValue(vb) {
        let value, rawValue, type;

        if (Buffer.isBuffer(vb.value)) {
            rawValue = vb.value;
            // Prova a decodificare come stringa
            const stringValue = vb.value.toString('utf8');
            
            if (/^[\x20-\x7E\s]*$/.test(stringValue) && stringValue.trim().length > 0) {
                value = stringValue.trim();
                type = 'string';
            } else {
                value = vb.value.toString('hex');
                type = 'hex';
            }
        } else if (typeof vb.value === 'number') {
            value = vb.value;
            type = 'integer';
            rawValue = vb.value;
        } else if (vb.value === null || vb.value === undefined) {
            value = null;
            type = 'null';
            rawValue = null;
        } else {
            value = vb.value.toString();
            type = 'string';
            rawValue = vb.value;
        }

        return {
            value,
            type,
            rawValue,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Salva i risultati su file
     */
    async saveResults(walkResults) {
        const walksDir = path.join(__dirname, '..', 'walks');
        
        // Assicurati che la directory esista
        if (!fs.existsSync(walksDir)) {
            fs.mkdirSync(walksDir, { recursive: true });
        }

        const filename = `${this.printerInfo.model}_${this.host.replace(/\./g, '_')}_${Date.now()}.json`;
        const filepath = path.join(walksDir, filename);

        const outputData = {
            metadata: {
                timestamp: new Date().toISOString(),
                host: this.host,
                community: this.community,
                walkStatus: walkResults.error ? 'partial' : 'complete',
                totalOids: walkResults.count,
                rootOid: PRINTER_MIB_ROOT
            },
            printerInfo: this.printerInfo,
            oids: walkResults.results
        };

        fs.writeFileSync(filepath, JSON.stringify(outputData, null, 2));
        console.log(`💾 Risultati salvati in: ${filename}`);
        
        return filepath;
    }

    /**
     * Chiude la sessione
     */
    close() {
        if (this.session) {
            this.session.close();
        }
    }
}

/**
 * Funzione principale
 */
async function main() {
    if (!config.host) {
        console.error("❌ Errore: specificare --host <IP>");
        process.exit(1);
    }

    const walker = new PrinterOidWalker(config.host, config.community);

    try {
        // 1. Crea sessione
        walker.createSession();

        // 2. Test connessione
        await walker.testConnection();

        // 3. Identifica stampante
        await walker.getPrinterInfo();

        // 4. Walk del Printer MIB
        const walkResults = await walker.walkPrinterMib();

        // 5. Salva risultati
        const filepath = await walker.saveResults(walkResults);

        console.log("\n" + "=".repeat(60));
        console.log("✅ WALK COMPLETATO");
        console.log("=".repeat(60));
        console.log(`📄 File salvato: ${path.basename(filepath)}`);
        console.log(`📊 OID trovati: ${walkResults.count}`);
        console.log(`🖨️  Modello: ${walker.printerInfo.model}`);
        
        if (walkResults.error) {
            console.log(`⚠️  Stato: Parziale (${walkResults.error})`);
        } else {
            console.log(`✅ Stato: Completo`);
        }

    } catch (error) {
        console.error(`❌ Errore: ${error.message}`);
        process.exit(1);
    } finally {
        walker.close();
    }
}

// Esegui solo se chiamato direttamente
if (require.main === module) {
    main();
}

module.exports = { PrinterOidWalker };