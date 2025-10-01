# Printer Monitor System

Sistema professionale di monitoraggio stampanti tramite SNMP con mappings configurabili per diversi modelli.

## 🎯 Caratteristiche

- **Identificazione automatica** del modello stampante
- **Mappings configurabili** per diversi vendor e modelli
- **Raccolta dati strutturata** (toner, carta, stato, contatori)
- **Walk completo OID** del Printer MIB (.43)
- **Output formattati** (summary, detailed, JSON, raw)
- **Salvataggio risultati** con timestamp
- **Gestione errori robusta** e logging

## 📁 Struttura Progetto

```
printers-monitor/
├── src/
│   ├── monitor.js          # Script principale di monitoraggio
│   ├── walkOids.js         # Walker OID per discovery
│   ├── indexScraping.js    # Web scraper (legacy)
│   └── index.js            # Script legacy SNMP
├── configs/
│   └── config.json         # Configurazione generale
├── mappings/
│   ├── develop_ineo_250i.json  # Mapping per Develop ineo+ 250i
│   └── generic_printer.json   # Mapping generico fallback
├── utils/
│   └── snmp-utils.js       # Utilities SNMP e mapping
├── walks/                  # Output walk OID completi
├── output/                 # Output dati monitoraggio
└── README.md
```

## 🚀 Installazione

```bash
# Clone repository
git clone <repository-url>
cd printers-monitor

# Install dependencies
npm install

# Verify installation
npm run monitor -- --help
```

## 💡 Utilizzo

### Monitoraggio Stampante

```bash
# Monitoraggio base con output summary
npm run monitor -- --host 192.168.180.141

# Output dettagliato JSON
npm run monitor -- --host 192.168.180.141 --format detailed

# Salva risultati su file
npm run monitor -- --host 192.168.180.141 --save

# Specifica community SNMP
npm run monitor -- --host 192.168.180.141 --community private
```

### Discovery OID (per nuovi modelli)

```bash
# Walk completo Printer MIB (.43)
npm run walk -- --host 192.168.180.141

# Con community specifica
npm run walk -- --host 192.168.180.141 --community private
```

### Script Legacy

```bash
# Web scraping Kyocera
npm run scrape -- --host 192.168.180.140

# SNMP walk legacy
npm run legacy
```
    ```

2. Installa le dipendenze:
    ```sh
    npm install
    ```

## Utilizzo

Per avviare l'applicazione, esegui il comando:
```sh
npm run dev
