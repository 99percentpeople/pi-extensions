# Pi Extensions Installation Script
# This script helps install and test Pi extensions

param(
    [switch]$Global,
    [switch]$Test,
    [switch]$Help
)

if ($Help) {
    Write-Host "Pi Extensions Installation Script"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\scripts\install.ps1              # Install to current project"
    Write-Host "  .\scripts\install.ps1 -Global      # Install globally"
    Write-Host "  .\scripts\install.ps1 -Test        # Test extensions"
    Write-Host "  .\scripts\install.ps1 -Help        # Show this help"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\scripts\install.ps1 -Global      # Install globally for all projects"
    Write-Host "  .\scripts\install.ps1 -Test        # Test all extensions"
    exit 0
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir

if ($Test) {
    Write-Host "Testing Pi extensions..." -ForegroundColor Cyan
    
    $extensions = Get-ChildItem -Path "$rootDir\extensions" -Directory
    
    foreach ($ext in $extensions) {
        $indexPath = Join-Path $ext.FullName "index.ts"
        if (Test-Path $indexPath) {
            Write-Host "Testing $($ext.Name)..." -ForegroundColor Yellow
            try {
                pi -e $indexPath --help 2>&1 | Out-Null
                Write-Host "  ✓ $($ext.Name) loaded successfully" -ForegroundColor Green
            } catch {
                Write-Host "  ✗ $($ext.Name) failed to load" -ForegroundColor Red
                Write-Host "    Error: $_" -ForegroundColor Red
            }
        }
    }
    
    Write-Host ""
    Write-Host "Test completed!" -ForegroundColor Cyan
    exit 0
}

if ($Global) {
    Write-Host "Installing Pi extensions globally..." -ForegroundColor Cyan
    
    # Check if pi is installed
    try {
        $piVersion = pi --version 2>&1
        Write-Host "Found Pi: $piVersion" -ForegroundColor Green
    } catch {
        Write-Host "Error: Pi is not installed or not in PATH" -ForegroundColor Red
        Write-Host "Please install Pi first: https://github.com/badlogic/pi-mono" -ForegroundColor Yellow
        exit 1
    }
    
    # Install globally
    Write-Host "Installing to global Pi directory..." -ForegroundColor Yellow
    pi install $rootDir
    
    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host "Restart Pi to load the extensions." -ForegroundColor Cyan
} else {
    Write-Host "Installing Pi extensions to current project..." -ForegroundColor Cyan
    
    # Check if we're in a project directory
    if (-not (Test-Path ".pi")) {
        Write-Host "Creating .pi directory..." -ForegroundColor Yellow
        New-Item -ItemType Directory -Path ".pi" -Force | Out-Null
    }
    
    # Install to current project
    Write-Host "Installing to project..." -ForegroundColor Yellow
    pi install -l $rootDir
    
    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host "Restart Pi to load the extensions." -ForegroundColor Cyan
}
