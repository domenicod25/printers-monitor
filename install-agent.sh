#!/bin/bash

#############################################################
# Printer Monitor Agent - Interactive Installer (Linux/macOS)
#############################################################
# Installer interattivo che:
# - Rileva automaticamente l'eseguibile agent nella directory
# - Valida la configurazione embedded
# - Installa come servizio systemd (Linux) o LaunchDaemon (macOS)
# - Configura auto-start
# - Fornisce comandi per gestione
#
# Usage:
#   sudo ./install-agent.sh
#   sudo ./install-agent.sh --agent-path ./custom-agent
#   sudo ./install-agent.sh --uninstall
#############################################################

set -e

# Colori
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Configurazione
SERVICE_NAME="printer-monitor"
INSTALL_DIR="/opt/printer-monitor"
SERVICE_USER="printer-monitor"
EXECUTABLE_NAME="printer-monitor"
LOG_FILE="/var/log/printer-monitor.log"
ERROR_LOG="/var/log/printer-monitor.error.log"

# Variabili globali
AGENT_PATH=""
OS_TYPE=""
INIT_SYSTEM=""

#############################################################
# Funzioni Helper
#############################################################

print_header() {
    echo ""
    echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}${BOLD}  Printer Monitor Agent - Interactive Installer${NC}"
    echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_step() {
    local step=$1
    local total=$2
    local message=$3
    echo -e "${GREEN}${BOLD}[${step}/${total}]${NC} ${message}"
}

print_success() {
    echo -e "   ${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}${BOLD}❌ ERRORE:${NC} $1" >&2
}

print_warning() {
    echo -e "${YELLOW}⚠️  ATTENZIONE:${NC} $1"
}

print_info() {
    echo -e "${CYAN}ℹ️  ${NC}$1"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then 
        print_error "Questo script deve essere eseguito come root"
        echo ""
        echo "Esegui: ${BOLD}sudo $0${NC}"
        exit 1
    fi
}

remove_macos_quarantine() {
    local file=$1
    
    # Controlla se il file ha l'attributo di quarantena
    if xattr "$file" 2>/dev/null | grep -q "com.apple.quarantine"; then
        print_info "Rimozione attributo quarantena macOS..."
        xattr -d com.apple.quarantine "$file" 2>/dev/null || {
            print_warning "Impossibile rimuovere quarantena automaticamente"
            echo ""
            echo "Se macOS blocca l'eseguibile, esegui manualmente:"
            echo "  ${BOLD}xattr -d com.apple.quarantine $file${NC}"
            echo ""
            echo "Oppure:"
            echo "  1. Vai in Impostazioni Sistema > Privacy e Sicurezza"
            echo "  2. Cerca il messaggio su 'printer-monitor'"
            echo "  3. Clicca 'Consenti comunque'"
            echo ""
            return 1
        }
        print_success "Quarantena rimossa"
        return 0
    fi
    
    return 0
}

detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS_TYPE="linux"
        if command -v systemctl &> /dev/null; then
            INIT_SYSTEM="systemd"
        else
            print_error "Systemd non trovato. Questo script richiede systemd."
            exit 1
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        OS_TYPE="macos"
        INIT_SYSTEM="launchd"
        SERVICE_NAME="com.nextoffices.printer-monitor"
    else
        print_error "Sistema operativo non supportato: $OSTYPE"
        exit 1
    fi
}

find_agent_executable() {
    # Se specificato come argomento
    if [ -n "$1" ]; then
        if [ -f "$1" ]; then
            AGENT_PATH="$1"
            return 0
        else
            print_error "File non trovato: $1"
            exit 1
        fi
    fi
    
    # Cerca nella directory corrente
    local candidates=(
        "./printer-monitor"
        "./printer-monitor-linux"
        "./printer-monitor-macos"
        "./printer-monitor-linux-x64"
        "./printer-monitor-macos-x64"
    )
    
    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate" ] && [ -x "$candidate" ]; then
            AGENT_PATH="$candidate"
            return 0
        fi
    done
    
    # Cerca nella directory corrente (qualsiasi file eseguibile)
    # Compatibile con Linux e macOS
    local found=""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: usa find senza -executable e controlla permessi con test
        for file in ./printer-monitor*; do
            if [ -f "$file" ] && [ -x "$file" ]; then
                found="$file"
                break
            fi
        done
    else
        # Linux: usa find con -executable
        found=$(find . -maxdepth 1 -type f -executable -name "printer-monitor*" 2>/dev/null | head -n 1)
    fi
    
    if [ -n "$found" ]; then
        AGENT_PATH="$found"
        return 0
    fi
    
    return 1
}

extract_embedded_config() {
    local agent_file=$1
    
    # Tenta di estrarre il config embedded dall'eseguibile
    # Il config è incluso come JSON nel bundle nexe
    
    # Usa strings per cercare pattern JSON con company_id
    local config=$(strings "$agent_file" 2>/dev/null | grep -A 20 '"company_id"' | head -n 30)
    
    if [ -z "$config" ]; then
        return 1
    fi
    
    echo "$config"
    return 0
}

validate_embedded_config() {
    local agent_file=$1
    
    print_info "Validazione configurazione embedded..."
    
    # Estrai config
    local config=$(extract_embedded_config "$agent_file")
    
    if [ -z "$config" ]; then
        print_warning "Impossibile estrarre configurazione con 'strings'"
        print_info "Questo è normale per eseguibili nexe compilati"
        print_info "La configurazione è embedded nel binario e sarà accessibile all'agent"
        echo ""
        print_success "Validazione saltata (configurazione embedded presente)"
        return 0
    fi
    
    # Validazione base
    local has_company_id=$(echo "$config" | grep -c '"company_id"')
    local has_api_key=$(echo "$config" | grep -c '"api_key"')
    local has_backend=$(echo "$config" | grep -c '"backend_url"')
    local has_printers=$(echo "$config" | grep -c '"printers"')
    
    local has_tenant_id=$(echo "$config" | grep -c '"tenant_id"')
    
    echo ""
    echo -e "${BOLD}Configurazione trovata:${NC}"
    
    if [ "$has_backend" -gt 0 ]; then
        local backend_url=$(echo "$config" | grep '"backend_url"' | sed 's/.*"backend_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
        echo -e "  🔗 Backend: ${GREEN}${backend_url}${NC}"
    else
        echo -e "  🔗 Backend: ${RED}MANCANTE${NC}"
    fi
    
    if [ "$has_company_id" -gt 0 ]; then
        local company_id=$(echo "$config" | grep '"company_id"' | sed 's/.*"company_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
        echo -e "  🏢 Company: ${GREEN}${company_id}${NC}"
    else
        echo -e "  🏢 Company: ${RED}MANCANTE${NC}"
    fi
    
    if [ "$has_api_key" -gt 0 ]; then
        local api_key=$(echo "$config" | grep '"api_key"' | sed 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
        local api_key_preview="${api_key:0:15}..."
        echo -e "  🔑 API Key: ${GREEN}${api_key_preview}${NC}"
    else
        echo -e "  🔑 API Key: ${RED}MANCANTE${NC}"
    fi
    
    if [ "$has_printers" -gt 0 ]; then
        echo -e "  🖨️  Printers: ${GREEN}Configurate${NC}"
    else
        echo -e "  🖨️  Printers: ${YELLOW}Non rilevate${NC}"
    fi
    
    # Warning per tenant_id deprecato
    if [ "$has_tenant_id" -gt 0 ]; then
        echo ""
        print_warning "Trovato 'tenant_id' (DEPRECATO). Usa 'company_id'"
    fi
    
    # Validazione errori critici
    local errors=0
    
    if [ "$has_company_id" -eq 0 ]; then
        print_error "Configurazione mancante: company_id"
        errors=$((errors + 1))
    fi
    
    if [ "$has_api_key" -eq 0 ]; then
        print_error "Configurazione mancante: api_key"
        errors=$((errors + 1))
    fi
    
    if [ "$has_backend" -eq 0 ]; then
        print_error "Configurazione mancante: backend_url"
        errors=$((errors + 1))
    fi
    
    if [ $errors -gt 0 ]; then
        echo ""
        print_error "Configurazione non valida. Rigenera l'agent dall'Agent Builder."
        exit 1
    fi
    
    print_success "Configurazione valida"
    echo ""
}

install_systemd_service() {
    print_step 5 7 "Creazione systemd service..."
    
    cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Printer Monitor Agent
Documentation=https://github.com/domenicod25/printers-monitor
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/$EXECUTABLE_NAME --daemon
Restart=always
RestartSec=10
StandardOutput=append:$LOG_FILE
StandardError=append:$ERROR_LOG

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/logs /var/log

# Environment
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
EOF
    
    print_success "Service unit creato: /etc/systemd/system/$SERVICE_NAME.service"
}

install_launchd_service() {
    print_step 5 7 "Creazione LaunchDaemon..."
    
    cat > "/Library/LaunchDaemons/$SERVICE_NAME.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE_NAME</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/$EXECUTABLE_NAME</string>
        <string>--daemon</string>
    </array>
    
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    
    <key>StandardOutPath</key>
    <string>$LOG_FILE</string>
    
    <key>StandardErrorPath</key>
    <string>$ERROR_LOG</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
EOF
    
    chmod 644 "/Library/LaunchDaemons/$SERVICE_NAME.plist"
    print_success "LaunchDaemon creato: /Library/LaunchDaemons/$SERVICE_NAME.plist"
}

enable_service() {
    print_step 6 7 "Abilitazione servizio..."
    
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        systemctl daemon-reload
        systemctl enable "$SERVICE_NAME" 2>&1 | grep -v "Created symlink" || true
        print_success "Servizio abilitato (auto-start al boot)"
        
    elif [ "$INIT_SYSTEM" = "launchd" ]; then
        launchctl load "/Library/LaunchDaemons/$SERVICE_NAME.plist"
        print_success "LaunchDaemon caricato (auto-start al boot)"
    fi
}

start_service() {
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        systemctl start "$SERVICE_NAME"
        sleep 2
        
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            return 0
        else
            return 1
        fi
        
    elif [ "$INIT_SYSTEM" = "launchd" ]; then
        launchctl start "$SERVICE_NAME"
        sleep 2
        
        if launchctl list | grep -q "$SERVICE_NAME"; then
            return 0
        else
            return 1
        fi
    fi
}

show_management_commands() {
    echo ""
    echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}${BOLD}  Comandi di Gestione${NC}"
    echo -e "${BLUE}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        echo -e "${YELLOW}${BOLD}Gestione Servizio:${NC}"
        echo "  sudo systemctl start $SERVICE_NAME      # Avvia agent"
        echo "  sudo systemctl stop $SERVICE_NAME       # Ferma agent"
        echo "  sudo systemctl restart $SERVICE_NAME    # Riavvia agent"
        echo "  sudo systemctl status $SERVICE_NAME     # Stato agent"
        echo ""
        echo -e "${YELLOW}${BOLD}Logs:${NC}"
        echo "  sudo journalctl -u $SERVICE_NAME -f    # Real-time"
        echo "  sudo journalctl -u $SERVICE_NAME --since today"
        echo "  sudo tail -f $LOG_FILE"
        echo ""
        echo -e "${YELLOW}${BOLD}Disinstallazione:${NC}"
        echo "  sudo systemctl stop $SERVICE_NAME"
        echo "  sudo systemctl disable $SERVICE_NAME"
        echo "  sudo rm /etc/systemd/system/$SERVICE_NAME.service"
        echo "  sudo rm -rf $INSTALL_DIR"
        echo "  sudo userdel $SERVICE_USER"
        echo "  sudo systemctl daemon-reload"
        
    elif [ "$INIT_SYSTEM" = "launchd" ]; then
        echo -e "${YELLOW}${BOLD}Gestione Servizio:${NC}"
        echo "  sudo launchctl start $SERVICE_NAME     # Avvia agent"
        echo "  sudo launchctl stop $SERVICE_NAME      # Ferma agent"
        echo "  sudo launchctl list | grep printer     # Stato agent"
        echo ""
        echo -e "${YELLOW}${BOLD}Logs:${NC}"
        echo "  tail -f $LOG_FILE"
        echo "  tail -f $ERROR_LOG"
        echo ""
        echo -e "${YELLOW}${BOLD}Disinstallazione:${NC}"
        echo "  sudo launchctl unload /Library/LaunchDaemons/$SERVICE_NAME.plist"
        echo "  sudo rm /Library/LaunchDaemons/$SERVICE_NAME.plist"
        echo "  sudo rm -rf $INSTALL_DIR"
    fi
    
    echo ""
}

uninstall_service() {
    print_header
    echo -e "${YELLOW}${BOLD}DISINSTALLAZIONE IN CORSO${NC}"
    echo ""
    
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            print_info "Arresto servizio..."
            systemctl stop "$SERVICE_NAME"
            print_success "Servizio fermato"
        fi
        
        if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
            print_info "Disabilitazione servizio..."
            systemctl disable "$SERVICE_NAME"
            print_success "Servizio disabilitato"
        fi
        
        if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
            rm "/etc/systemd/system/$SERVICE_NAME.service"
            systemctl daemon-reload
            print_success "Service unit rimosso"
        fi
        
    elif [ "$INIT_SYSTEM" = "launchd" ]; then
        if launchctl list | grep -q "$SERVICE_NAME"; then
            print_info "Arresto servizio..."
            launchctl stop "$SERVICE_NAME"
            launchctl unload "/Library/LaunchDaemons/$SERVICE_NAME.plist"
            print_success "Servizio fermato"
        fi
        
        if [ -f "/Library/LaunchDaemons/$SERVICE_NAME.plist" ]; then
            rm "/Library/LaunchDaemons/$SERVICE_NAME.plist"
            print_success "LaunchDaemon rimosso"
        fi
    fi
    
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        print_success "Directory rimossa: $INSTALL_DIR"
    fi
    
    if [ "$OS_TYPE" = "linux" ] && id "$SERVICE_USER" &>/dev/null; then
        userdel "$SERVICE_USER" 2>/dev/null || true
        print_success "User rimosso: $SERVICE_USER"
    fi
    
    echo ""
    echo -e "${GREEN}${BOLD}✅ DISINSTALLAZIONE COMPLETATA${NC}"
    echo ""
}

#############################################################
# Main Installation Flow
#############################################################

main_install() {
    print_header
    
    # Step 0: Validazioni preliminari
    check_root
    detect_os
    
    print_info "Sistema: $OS_TYPE ($INIT_SYSTEM)"
    echo ""
    
    # Step 1: Trova eseguibile
    print_step 1 7 "Ricerca eseguibile agent..."
    
    if ! find_agent_executable "$1"; then
        print_error "Nessun eseguibile agent trovato"
        echo ""
        echo "Posiziona l'eseguibile agent nella directory corrente o specifica il path:"
        echo "  ${BOLD}sudo $0 --agent-path /path/to/agent${NC}"
        echo ""
        exit 1
    fi
    
    print_success "Agent trovato: $AGENT_PATH"
    
    # Step 1.5: Rimuovi quarantena macOS (se presente)
    if [ "$OS_TYPE" = "macos" ]; then
        remove_macos_quarantine "$AGENT_PATH"
    fi
    
    # Step 2: Valida configurazione embedded
    print_step 2 7 "Validazione configurazione..."
    validate_embedded_config "$AGENT_PATH"
    
    # Step 3: Crea user (solo Linux)
    if [ "$OS_TYPE" = "linux" ]; then
        print_step 3 7 "Creazione user dedicato..."
        if id "$SERVICE_USER" &>/dev/null; then
            print_success "User '$SERVICE_USER' già esistente"
        else
            useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
            print_success "User '$SERVICE_USER' creato"
        fi
    else
        print_step 3 7 "Preparazione ambiente..."
        print_success "Ambiente macOS configurato"
    fi
    
    # Step 4: Crea directory e copia eseguibile
    print_step 4 7 "Installazione eseguibile..."
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR/logs"
    
    cp "$AGENT_PATH" "$INSTALL_DIR/$EXECUTABLE_NAME"
    chmod +x "$INSTALL_DIR/$EXECUTABLE_NAME"
    
    # Rimuovi quarantena anche dal file installato (macOS)
    if [ "$OS_TYPE" = "macos" ]; then
        remove_macos_quarantine "$INSTALL_DIR/$EXECUTABLE_NAME"
    fi
    
    if [ "$OS_TYPE" = "linux" ]; then
        chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
    fi
    
    print_success "Eseguibile installato: $INSTALL_DIR/$EXECUTABLE_NAME"
    
    # Step 5: Crea servizio
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        install_systemd_service
    elif [ "$INIT_SYSTEM" = "launchd" ]; then
        install_launchd_service
    fi
    
    # Step 6: Abilita servizio
    enable_service
    
    # Step 7: Completamento
    print_step 7 7 "Finalizzazione..."
    print_success "Installazione completata"
    
    echo ""
    echo -e "${GREEN}${BOLD}✅ INSTALLAZIONE COMPLETATA CON SUCCESSO${NC}"
    
    # Mostra comandi gestione
    show_management_commands
    
    # Chiedi se avviare
    echo -e "${GREEN}${BOLD}Vuoi avviare l'agent ora? [Y/n]${NC}"
    read -r response
    
    if [[ -z "$response" || "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo ""
        print_info "Avvio servizio in corso..."
        
        if start_service; then
            echo ""
            echo -e "${GREEN}${BOLD}✅ Agent avviato con successo!${NC}"
            echo ""
            print_info "Controlla i logs:"
            
            if [ "$INIT_SYSTEM" = "systemd" ]; then
                echo "  sudo journalctl -u $SERVICE_NAME -f"
            else
                echo "  tail -f $LOG_FILE"
            fi
        else
            echo ""
            print_warning "Avvio fallito. Controlla i logs:"
            
            if [ "$INIT_SYSTEM" = "systemd" ]; then
                echo "  sudo journalctl -u $SERVICE_NAME -n 50"
            else
                echo "  tail -f $ERROR_LOG"
            fi
        fi
    else
        echo ""
        print_info "Agent non avviato."
        
        if [ "$INIT_SYSTEM" = "systemd" ]; then
            echo "  Avvialo con: sudo systemctl start $SERVICE_NAME"
        else
            echo "  Avvialo con: sudo launchctl start $SERVICE_NAME"
        fi
    fi
    
    echo ""
}

#############################################################
# Entry Point
#############################################################

# Parse arguments
AGENT_ARG=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --uninstall)
            check_root
            detect_os
            uninstall_service
            exit 0
            ;;
        --agent-path)
            AGENT_ARG="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: sudo $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --agent-path PATH    Specifica path dell'eseguibile agent"
            echo "  --uninstall          Disinstalla il servizio"
            echo "  -h, --help           Mostra questo messaggio"
            echo ""
            exit 0
            ;;
        *)
            print_error "Opzione non riconosciuta: $1"
            echo "Usa --help per vedere le opzioni disponibili"
            exit 1
            ;;
    esac
done

# Run installation
main_install "$AGENT_ARG"
