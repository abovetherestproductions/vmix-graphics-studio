<#
  vMix Graphics Studio — one-time installer for a vMix production machine.

  Installs Node.js and Git (via winget), clones the studio repo, installs
  dependencies, and registers the graphics server as a Windows service so it
  is running before anyone logs in and restarts itself after an update.

  RUN ONCE, AS ADMINISTRATOR:
      Right-click this file  ->  Run with PowerShell  (accept the UAC prompt)
  or from an elevated PowerShell:
      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\Install-VmixGraphics.ps1

  Nothing to sign in to — the repo is public, so there are no credentials to
  enter and nothing that expires later.
#>

[CmdletBinding()]
param(
    [string] $InstallPath = 'C:\vMixGraphics',
    [string] $RepoUrl     = 'https://github.com/abovetherestproductions/vmix-graphics-studio.git',
    [int]    $Port        = 3012,
    [string] $ServiceName = 'VmixGraphicsStudio'
)

$ErrorActionPreference = 'Stop'
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'

function Say  ($m) { Write-Host "  $m" }
function Step ($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "`nFAILED: $m" -ForegroundColor Red; Read-Host "`nPress Enter to close"; exit 1 }

Write-Host @"

  vMix Graphics Studio - Installer
  --------------------------------
  Install location : $InstallPath
  Service name     : $ServiceName
  Web address      : http://localhost:$Port/operator/

  No GitHub account or password is needed.

"@ -ForegroundColor White

# ---------------------------------------------------------------- privileges
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Die "This installer must run as Administrator (it registers a Windows service).`n         Right-click the file and choose 'Run with PowerShell', or open PowerShell as Administrator."
}

# ------------------------------------------------------------------- winget
Step "Checking prerequisites"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Die "winget is not available on this machine.`n         Install 'App Installer' from the Microsoft Store, then re-run this script.`n         (winget ships with Windows 10 21H1+ and Windows 11.)"
}
Say "winget found"

function Ensure-Tool {
    param($Command, $WingetId, $Label)
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        Say "$Label already installed"
        return
    }
    Say "Installing $Label ..."
    winget install --id $WingetId -e --source winget `
        --accept-package-agreements --accept-source-agreements | Out-Null
    # winget updates the machine PATH but not this already-running process.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Die "$Label was installed but '$Command' is still not on PATH.`n         Close this window, open a NEW PowerShell as Administrator, and re-run the script."
    }
    Say "$Label installed"
}

Ensure-Tool -Command 'git'  -WingetId 'Git.Git'           -Label 'Git'
Ensure-Tool -Command 'node' -WingetId 'OpenJS.NodeJS.LTS' -Label 'Node.js LTS'

$nodeMajor = (& node -p "process.versions.node.split('.')[0]") -as [int]
if ($nodeMajor -lt 20) { Die "Node 20 or newer is required (found v$nodeMajor). Update Node.js and re-run." }
Say "Node $(& node -v) / npm $(& npm -v)"

# ------------------------------------------------------------------- clone
# The repo is public, so there is no token to enter and nothing to expire.
# Updates keep working for the life of the machine.
Step "Installing the graphics studio"
if (Test-Path (Join-Path $InstallPath '.git')) {
    Say "Existing install found - updating instead of cloning"
    Push-Location $InstallPath
    try { git pull --ff-only } finally { Pop-Location }
} else {
    if (Test-Path $InstallPath) {
        $items = Get-ChildItem -Force $InstallPath -ErrorAction SilentlyContinue
        if ($items) { Die "$InstallPath already exists and is not empty. Move it aside and re-run." }
    }
    git clone $RepoUrl $InstallPath
    if ($LASTEXITCODE -ne 0) {
        Die "Clone failed. Check this machine's internet connection and that the repo URL is correct."
    }
}
Say "Source is in $InstallPath"

Push-Location $InstallPath
try {
    Step "Installing dependencies"
    if (Test-Path 'package-lock.json') { npm ci --omit=dev } else { npm install --omit=dev }
    if ($LASTEXITCODE -ne 0) { Die "npm install failed - check this machine's internet connection." }
    Say "Dependencies installed"
} finally { Pop-Location }

# ----------------------------------------------------------------- service
Step "Registering the Windows service"

$svcDir = Join-Path $InstallPath 'service'
New-Item -ItemType Directory -Force -Path $svcDir | Out-Null
$svcExe = Join-Path $svcDir "$ServiceName.exe"
$svcXml = Join-Path $svcDir "$ServiceName.xml"

if (-not (Test-Path $svcExe)) {
    Say "Downloading service wrapper (WinSW) ..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $WinSwUrl -OutFile $svcExe -UseBasicParsing
    } catch { Die "Could not download the service wrapper: $($_.Exception.Message)" }
}
Say "Service wrapper ready"

$nodePath = (Get-Command node).Source
$logDir   = Join-Path $InstallPath 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# onfailure/restart is what makes the in-app "Check & Update" button one-click:
# the server exits after pulling new code and Windows starts it again.
@"
<service>
  <id>$ServiceName</id>
  <name>vMix Graphics Studio</name>
  <description>Serves the vMix graphics templates and operator control pages on port $Port.</description>
  <executable>$nodePath</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$InstallPath</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <log mode="roll-by-size">
    <logpath>$logDir</logpath>
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <env name="NODE_ENV" value="production"/>
  <env name="PORT" value="$Port"/>
  <!-- Tells the server it is supervised, so "Check & Update" may exit after
       pulling and let Windows restart it on the new code. -->
  <env name="VMIX_SUPERVISED" value="1"/>
</service>
"@ | Set-Content -Path $svcXml -Encoding UTF8

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Say "Service already exists - reinstalling with current settings"
    & $svcExe stop      2>$null | Out-Null
    & $svcExe uninstall 2>$null | Out-Null
    Start-Sleep -Seconds 3
}
& $svcExe install
if ($LASTEXITCODE -ne 0) { Die "Could not register the service." }

# The service account needs to read/write config + uploads under the install dir.
& icacls $InstallPath /grant "*S-1-5-20:(OI)(CI)M" /T /Q 2>$null | Out-Null

& $svcExe start
Start-Sleep -Seconds 4
Say "Service '$ServiceName' registered and started"

# -------------------------------------------------------------- shortcuts
Step "Creating shortcuts"
$shell   = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')

$lnk = $shell.CreateShortcut((Join-Path $desktop 'vMix Graphics Studio.lnk'))
$lnk.TargetPath       = "http://localhost:$Port/operator/"
$lnk.Description      = 'Open the vMix Graphics operator page'
$lnk.Save()

$start = $shell.CreateShortcut((Join-Path $desktop 'Force Start Graphics.lnk'))
$start.TargetPath       = Join-Path $InstallPath 'deploy\Start-VmixGraphics.cmd'
$start.WorkingDirectory = $InstallPath
$start.Description      = 'Restart the graphics service if something is not responding'
$start.IconLocation     = 'shell32.dll,238'
$start.Save()
Say "Desktop shortcuts created"

# ------------------------------------------------------------------ verify
Step "Verifying"
$ok = $false
foreach ($i in 1..10) {
    try {
        $r = Invoke-WebRequest "http://localhost:$Port/api/config" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}

if ($ok) {
    Write-Host "`n  SUCCESS - the graphics studio is running." -ForegroundColor Green
    Say "Open it any time from the 'vMix Graphics Studio' desktop shortcut,"
    Say "or go to  http://localhost:$Port/operator/"
    Start-Process "http://localhost:$Port/operator/"
} else {
    Warn "The service was installed but did not answer on port $Port."
    Warn "Check the log:  $logDir\$ServiceName.err.log"
    Warn "Then double-click 'Force Start Graphics' on the desktop."
}

Write-Host ""
Read-Host "Press Enter to close"
