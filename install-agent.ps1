#############################################################
# Printer Monitor Agent - Interactive Installer (Windows)
#############################################################
# Installer interattivo che:
# - Rileva automaticamente l'eseguibile agent nella directory
# - Valida la configurazione embedded
# - Scarica NSSM se necessario
# - Installa come Windows Service
# - Configura auto-start
# - Fornisce comandi per gestione
#
# Usage:
#   .\install-agent.ps1
#   .\install-agent.ps1 -AgentPath ".\custom-agent.exe"
#   .\install-agent.ps1 -Uninstall
#############################################################

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false, HelpMessage="Path dell'eseguibile agent")]
    [string]$AgentPath = "",
    
    [Parameter(Mandatory=$false)]
    [switch]$Uninstall,
    
    [Parameter(Mandatory=$false)]
    [switch]$Silent
)

# Configurazione
$ServiceName = "PrinterMonitor"
$ServiceDisplayName = "Printer Monitor Agent"
$ServiceDescription = "Servizio di monitoraggio stampanti SNMP per NextOffices"
$InstallDir = "C:\Program Files\PrinterMonitor"
$LogDir = "$InstallDir\logs"
$NssmPath = "$InstallDir\nssm.exe"
$NssmUrl = "https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip"

#############################################################
# Funzioni Helper
#############################################################

function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White",
        [switch]$Bold
    )
    
    $colorMap = @{
        "Red" = "Red"
        "Green" = "Green"
        "Yellow" = "Yellow"
        "Blue" = "Cyan"
        "Cyan" = "Cyan"
        "White" = "White"
    }
    
    if ($Bold) {
        Write-Host $Message -ForegroundColor $colorMap[$Color] -NoNewline
        Write-Host ""
    } else {
        Write-Host $Message -ForegroundColor $colorMap[$Color]
    }
}

function Write-Header {
    Write-Host ""
    Write-ColorOutput "═══════════════════════════════════════════════════════════" "Blue" -Bold
    Write-ColorOutput "  Printer Monitor Agent - Interactive Installer" "Blue" -Bold
    Write-ColorOutput "═══════════════════════════════════════════════════════════" "Blue" -Bold
    Write-Host ""
}

function Write-Step {
    param(
        [int]$Step,
        [int]$Total,
        [string]$Message
    )
    Write-ColorOutput "[${Step}/${Total}] ${Message}" "Green" -Bold
}

function Write-Success {
    param([string]$Message)
    Write-ColorOutput "   ✓ $Message" "Green"
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-ColorOutput "❌ ERRORE: $Message" "Red" -Bold
}

function Write-Warning {
    param([string]$Message)
    Write-ColorOutput "⚠️  ATTENZIONE: $Message" "Yellow"
}

function Write-Info {
    param([string]$Message)
    Write-ColorOutput "ℹ️  $Message" "Cyan"
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-AgentExecutable {
    param([string]$ProvidedPath)
    
    # Se specificato, usa quello
    if ($ProvidedPath -and (Test-Path $ProvidedPath)) {
        return (Resolve-Path $ProvidedPath).Path
    }
    
    # Cerca nella directory corrente
    $candidates = @(
        ".\printer-monitor.exe",
        ".\printer-monitor-win.exe",
        ".\printer-monitor-windows.exe",
        ".\printer-monitor-win-x64.exe"
    )
    
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }
    
    # Cerca qualsiasi exe che inizi con printer-monitor
    $found = Get-ChildItem -Path "." -Filter "printer-monitor*.exe" -File | Select-Object -First 1
    if ($found) {
        return $found.FullName
    }
    
    return $null
}

function Extract-EmbeddedConfig {
    param([string]$AgentFile)
    
    try {
        # Leggi il file come bytes
        $bytes = [System.IO.File]::ReadAllBytes($AgentFile)
        $text = [System.Text.Encoding]::ASCII.GetString($bytes)
        
        # Cerca pattern JSON con company_id
        if ($text -match '"company_id"\s*:\s*"[^"]+') {
            # Estrai una sezione più ampia
            $startIndex = $text.IndexOf('"company_id"')
            if ($startIndex -gt 0) {
                $startIndex = [Math]::Max(0, $startIndex - 500)
                $length = [Math]::Min(2000, $text.Length - $startIndex)
                $section = $text.Substring($startIndex, $length)
                return $section
            }
        }
        
        return $null
    } catch {
        return $null
    }
}

function Test-EmbeddedConfig {
    param([string]$AgentFile)
    
    Write-Info "Validazione configurazione embedded..."
    
    $config = Extract-EmbeddedConfig -AgentFile $AgentFile
    
    if (-not $config) {
        Write-Warning "Impossibile estrarre configurazione embedded"
        Write-Warning "L'agent potrebbe non essere stato generato correttamente"
        
        Write-Host ""
        $response = Read-Host "Vuoi continuare comunque? [y/N]"
        if ($response -notmatch "^[yY]") {
            exit 1
        }
        return
    }
    
    # Validazione
    $hasCompanyId = $config -match '"company_id"\s*:'
    $hasApiKey = $config -match '"api_key"\s*:'
    $hasBackend = $config -match '"backend_url"\s*:'
    $hasPrinters = $config -match '"printers"\s*:'
    $hasTenantId = $config -match '"tenant_id"\s*:'
    
    Write-Host ""
    Write-ColorOutput "Configurazione trovata:" "White" -Bold
    
    # Backend URL
    if ($hasBackend) {
        if ($config -match '"backend_url"\s*:\s*"([^"]+)"') {
            $backendUrl = $matches[1]
            Write-Host "  🔗 Backend: " -NoNewline
            Write-ColorOutput $backendUrl "Green"
        }
    } else {
        Write-Host "  🔗 Backend: " -NoNewline
        Write-ColorOutput "MANCANTE" "Red"
    }
    
    # Company ID
    if ($hasCompanyId) {
        if ($config -match '"company_id"\s*:\s*"([^"]+)"') {
            $companyId = $matches[1]
            Write-Host "  🏢 Company: " -NoNewline
            Write-ColorOutput $companyId "Green"
        }
    } else {
        Write-Host "  🏢 Company: " -NoNewline
        Write-ColorOutput "MANCANTE" "Red"
    }
    
    # API Key
    if ($hasApiKey) {
        if ($config -match '"api_key"\s*:\s*"([^"]+)"') {
            $apiKey = $matches[1]
            $preview = $apiKey.Substring(0, [Math]::Min(15, $apiKey.Length)) + "..."
            Write-Host "  🔑 API Key: " -NoNewline
            Write-ColorOutput $preview "Green"
        }
    } else {
        Write-Host "  🔑 API Key: " -NoNewline
        Write-ColorOutput "MANCANTE" "Red"
    }
    
    # Printers
    if ($hasPrinters) {
        Write-Host "  🖨️  Printers: " -NoNewline
        Write-ColorOutput "Configurate" "Green"
    } else {
        Write-Host "  🖨️  Printers: " -NoNewline
        Write-ColorOutput "Non rilevate" "Yellow"
    }
    
    # Warning per tenant_id
    if ($hasTenantId) {
        Write-Host ""
        Write-Warning "Trovato 'tenant_id' (DEPRECATO). Usa 'company_id'"
    }
    
    # Errori critici
    $errors = @()
    
    if (-not $hasCompanyId) {
        $errors += "company_id"
    }
    if (-not $hasApiKey) {
        $errors += "api_key"
    }
    if (-not $hasBackend) {
        $errors += "backend_url"
    }
    
    if ($errors.Count -gt 0) {
        Write-Host ""
        Write-ErrorMsg "Configurazione mancante: $($errors -join ', ')"
        Write-Host ""
        Write-Host "Rigenera l'agent dall'Agent Builder con tutti i parametri richiesti."
        exit 1
    }
    
    Write-Success "Configurazione valida"
    Write-Host ""
}

function Install-Nssm {
    Write-Info "Download NSSM in corso..."
    
    try {
        $tempZip = "$env:TEMP\nssm.zip"
        $tempExtract = "$env:TEMP\nssm_extract"
        
        # Download
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $NssmUrl -OutFile $tempZip -UseBasicParsing
        
        # Extract
        Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
        
        # Find nssm.exe (dovrebbe essere in win64 subfolder)
        $nssmExe = Get-ChildItem -Path $tempExtract -Recurse -Filter "nssm.exe" | 
                   Where-Object { $_.FullName -like "*win64*" } | 
                   Select-Object -First 1
        
        if (-not $nssmExe) {
            throw "nssm.exe non trovato nell'archivio"
        }
        
        # Crea directory se non esiste
        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }
        
        # Copia nssm.exe
        Copy-Item -Path $nssmExe.FullName -Destination $NssmPath -Force
        
        # Cleanup
        Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
        
        Write-Success "NSSM scaricato e installato"
        return $true
        
    } catch {
        Write-ErrorMsg "Impossibile scaricare NSSM: $_"
        Write-Host ""
        Write-Host "Scaricalo manualmente da: https://nssm.cc/download"
        Write-Host "Estrai nssm.exe e posizionalo in: $NssmPath"
        return $false
    }
}

function Test-Nssm {
    # Controlla se NSSM è in PATH
    $nssmInPath = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssmInPath) {
        $script:NssmPath = $nssmInPath.Source
        return $true
    }
    
    # Controlla se è nella directory di installazione
    if (Test-Path $NssmPath) {
        return $true
    }
    
    return $false
}

function Install-Service {
    param([string]$AgentExePath)
    
    Write-Step 5 7 "Installazione servizio..."
    
    # Installa servizio
    & $NssmPath install $ServiceName "$AgentExePath" "--daemon" 2>&1 | Out-Null
    Write-Success "Servizio installato"
    
    Write-Step 6 7 "Configurazione servizio..."
    
    # Configurazione
    & $NssmPath set $ServiceName DisplayName "$ServiceDisplayName" | Out-Null
    & $NssmPath set $ServiceName Description "$ServiceDescription" | Out-Null
    & $NssmPath set $ServiceName AppDirectory "$InstallDir" | Out-Null
    & $NssmPath set $ServiceName AppStdout "$LogDir\output.log" | Out-Null
    & $NssmPath set $ServiceName AppStderr "$LogDir\error.log" | Out-Null
    & $NssmPath set $ServiceName AppRestartDelay 10000 | Out-Null
    & $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
    & $NssmPath set $ServiceName AppEnvironmentExtra "NODE_ENV=production" | Out-Null
    
    Write-Success "Servizio configurato"
}

function Show-ManagementCommands {
    Write-Host ""
    Write-ColorOutput "═══════════════════════════════════════════════════════════" "Blue" -Bold
    Write-ColorOutput "  Comandi di Gestione" "Blue" -Bold
    Write-ColorOutput "═══════════════════════════════════════════════════════════" "Blue" -Bold
    Write-Host ""
    
    Write-ColorOutput "Gestione Servizio (PowerShell):" "Yellow" -Bold
    Write-Host "  Start-Service $ServiceName         # Avvia agent"
    Write-Host "  Stop-Service $ServiceName          # Ferma agent"
    Write-Host "  Restart-Service $ServiceName       # Riavvia agent"
    Write-Host "  Get-Service $ServiceName           # Stato agent"
    Write-Host ""
    
    Write-ColorOutput "Logs:" "Yellow" -Bold
    Write-Host "  Get-Content `"$LogDir\output.log`" -Tail 50 -Wait"
    Write-Host "  Get-Content `"$LogDir\error.log`" -Tail 50 -Wait"
    Write-Host ""
    
    Write-ColorOutput "Gestione Avanzata (NSSM):" "Yellow" -Bold
    Write-Host "  `"$NssmPath`" edit $ServiceName        # GUI configurazione"
    Write-Host "  `"$NssmPath`" status $ServiceName      # Stato dettagliato"
    Write-Host ""
    
    Write-ColorOutput "Disinstallazione:" "Yellow" -Bold
    Write-Host "  Stop-Service $ServiceName"
    Write-Host "  `"$NssmPath`" remove $ServiceName confirm"
    Write-Host "  Remove-Item -Recurse -Force `"$InstallDir`""
    Write-Host ""
}

function Uninstall-Service {
    Write-Header
    Write-ColorOutput "DISINSTALLAZIONE IN CORSO" "Yellow" -Bold
    Write-Host ""
    
    # Controlla se servizio esiste
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    
    if ($service) {
        if ($service.Status -eq "Running") {
            Write-Info "Arresto servizio..."
            Stop-Service -Name $ServiceName -Force
            Write-Success "Servizio fermato"
        }
        
        Write-Info "Rimozione servizio..."
        
        if (Test-Nssm) {
            & $NssmPath remove $ServiceName confirm | Out-Null
            Write-Success "Servizio rimosso"
        } else {
            Write-Warning "NSSM non trovato, usa 'sc delete $ServiceName'"
        }
    } else {
        Write-Info "Nessun servizio da rimuovere"
    }
    
    if (Test-Path $InstallDir) {
        Write-Info "Rimozione directory..."
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Success "Directory rimossa: $InstallDir"
    }
    
    Write-Host ""
    Write-ColorOutput "✅ DISINSTALLAZIONE COMPLETATA" "Green" -Bold
    Write-Host ""
}

#############################################################
# Main Installation Flow
#############################################################

function Main-Install {
    param([string]$ProvidedAgentPath)
    
    Write-Header
    
    # Step 0: Validazioni preliminari
    if (-not (Test-Administrator)) {
        Write-ErrorMsg "Questo script richiede permessi di Amministratore"
        Write-Host ""
        Write-Host "Fare clic destro su PowerShell e selezionare 'Esegui come amministratore'"
        exit 1
    }
    
    Write-Info "Sistema: Windows ($env:PROCESSOR_ARCHITECTURE)"
    Write-Host ""
    
    # Step 1: Trova eseguibile
    Write-Step 1 7 "Ricerca eseguibile agent..."
    
    $agentExe = Find-AgentExecutable -ProvidedPath $ProvidedAgentPath
    
    if (-not $agentExe) {
        Write-ErrorMsg "Nessun eseguibile agent trovato"
        Write-Host ""
        Write-Host "Posiziona l'eseguibile nella directory corrente o specifica il path:"
        Write-Host "  .\install-agent.ps1 -AgentPath `"C:\path\to\agent.exe`""
        Write-Host ""
        exit 1
    }
    
    Write-Success "Agent trovato: $agentExe"
    
    # Step 2: Valida configurazione
    Write-Step 2 7 "Validazione configurazione..."
    Test-EmbeddedConfig -AgentFile $agentExe
    
    # Step 3: Verifica/Installa NSSM
    Write-Step 3 7 "Verifica NSSM..."
    
    if (-not (Test-Nssm)) {
        Write-Info "NSSM non trovato. Installazione in corso..."
        
        if (-not (Install-Nssm)) {
            exit 1
        }
    } else {
        Write-Success "NSSM trovato: $NssmPath"
    }
    
    # Step 4: Controlla servizio esistente
    Write-Step 4 7 "Controllo servizio esistente..."
    
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    
    if ($existingService) {
        Write-Warning "Servizio '$ServiceName' già esistente"
        Write-Host ""
        $response = Read-Host "Vuoi reinstallarlo? [y/N]"
        
        if ($response -match "^[yY]") {
            Write-Info "Rimozione servizio esistente..."
            Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
            & $NssmPath remove $ServiceName confirm | Out-Null
            Start-Sleep -Seconds 2
            Write-Success "Servizio rimosso"
        } else {
            Write-ErrorMsg "Installazione annullata"
            exit 1
        }
    } else {
        Write-Success "Nessun servizio esistente"
    }
    
    # Crea directories
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    
    # Copia eseguibile
    $destExe = "$InstallDir\printer-monitor.exe"
    Copy-Item -Path $agentExe -Destination $destExe -Force
    Write-Success "Eseguibile copiato: $destExe"
    
    # Installa e configura servizio
    Install-Service -AgentExePath $destExe
    
    # Step 7: Finalizzazione
    Write-Step 7 7 "Finalizzazione..."
    Write-Success "Installazione completata"
    
    Write-Host ""
    Write-ColorOutput "✅ INSTALLAZIONE COMPLETATA CON SUCCESSO" "Green" -Bold
    
    # Mostra comandi
    Show-ManagementCommands
    
    # Chiedi se avviare
    if (-not $Silent) {
        Write-ColorOutput "Vuoi avviare l'agent ora? [Y/n]" "Green" -Bold
        $response = Read-Host
        
        if ($response -eq "" -or $response -match "^[yY]") {
            Write-Host ""
            Write-Info "Avvio servizio in corso..."
            
            try {
                Start-Service -Name $ServiceName
                Start-Sleep -Seconds 2
                
                $service = Get-Service -Name $ServiceName
                
                if ($service.Status -eq "Running") {
                    Write-Host ""
                    Write-ColorOutput "✅ Agent avviato con successo!" "Green" -Bold
                    Write-Host ""
                    Write-Info "Controlla i logs:"
                    Write-Host "  Get-Content `"$LogDir\output.log`" -Tail 50 -Wait"
                } else {
                    Write-Warning "Agent non avviato. Stato: $($service.Status)"
                    Write-Host "  Controlla i logs in: $LogDir\error.log"
                }
                
            } catch {
                Write-Warning "Errore avvio: $_"
                Write-Host "  Avvialo manualmente con: Start-Service $ServiceName"
            }
        } else {
            Write-Host ""
            Write-Info "Agent non avviato."
            Write-Host "  Avvialo con: Start-Service $ServiceName"
        }
    }
    
    Write-Host ""
}

#############################################################
# Entry Point
#############################################################

if ($Uninstall) {
    if (-not (Test-Administrator)) {
        Write-ErrorMsg "Richiesti permessi di Amministratore"
        exit 1
    }
    
    if (Test-Nssm) {
        # NSSM disponibile
    } else {
        # Cerca NSSM installato
        if (Test-Path "$InstallDir\nssm.exe") {
            $script:NssmPath = "$InstallDir\nssm.exe"
        }
    }
    
    Uninstall-Service
    exit 0
}

# Run installation
Main-Install -ProvidedAgentPath $AgentPath
