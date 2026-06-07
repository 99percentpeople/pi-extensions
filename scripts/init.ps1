# Pi Extensions Initialization Script
# This script helps initialize a new Pi extensions project

param(
    [string]$Name,
    [switch]$Help
)

if ($Help) {
    Write-Host "Pi Extensions Initialization Script"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\scripts\init.ps1 -Name <project-name>"
    Write-Host ""
    Write-Host "Example:"
    Write-Host "  .\scripts\init.ps1 -Name my-pi-extensions"
    exit 0
}

if (-not $Name) {
    Write-Host "Error: Project name is required" -ForegroundColor Red
    Write-Host "Usage: .\scripts\init.ps1 -Name <project-name>" -ForegroundColor Yellow
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir

Write-Host "Initializing Pi extensions project: $Name" -ForegroundColor Cyan

# Create project directory
$projectDir = Join-Path (Get-Location) $Name
if (Test-Path $projectDir) {
    Write-Host "Error: Directory '$Name' already exists" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Path $projectDir -Force | Out-Null
Set-Location $projectDir

# Copy template files
Write-Host "Copying template files..." -ForegroundColor Yellow

# Copy essential files
$files = @(
    "package.json",
    "tsconfig.json",
    ".gitignore",
    "README.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE"
)

foreach ($file in $files) {
    $source = Join-Path $rootDir $file
    if (Test-Path $source) {
        Copy-Item -Path $source -Destination $file -Force
        Write-Host "  ✓ Copied $file" -ForegroundColor Green
    }
}

# Copy directories
$dirs = @(
    "extensions",
    "themes",
    "skills",
    "prompts",
    "scripts",
    "examples",
    "tests"
)

foreach ($dir in $dirs) {
    $source = Join-Path $rootDir $dir
    if (Test-Path $source) {
        Copy-Item -Path $source -Destination $dir -Recurse -Force
        Write-Host "  ✓ Copied $dir/" -ForegroundColor Green
    }
}

# Update package.json with project name
Write-Host "Updating package.json..." -ForegroundColor Yellow
$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
$packageJson.name = $Name
$packageJson | ConvertTo-Json -Depth 10 | Set-Content "package.json"
Write-Host "  ✓ Updated package name to '$Name'" -ForegroundColor Green

# Initialize git repository
Write-Host "Initializing git repository..." -ForegroundColor Yellow
git init 2>&1 | Out-Null
git add . 2>&1 | Out-Null
git commit -m "Initial commit: Pi extensions project" 2>&1 | Out-Null
Write-Host "  ✓ Git repository initialized" -ForegroundColor Green

Write-Host ""
Write-Host "Project initialized successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. cd $Name"
Write-Host "  2. Edit package.json to update project details"
Write-Host "  3. Create your extensions in extensions/"
Write-Host "  4. Test with: pi -e ./extensions/your-extension/index.ts"
Write-Host "  5. Push to GitHub and share with the community!"
