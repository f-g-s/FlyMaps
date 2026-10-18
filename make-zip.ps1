<#
.SYNOPSIS
  Packt index.html, src/ und functions/ in flymaps.zip (im Projektordner).

.DESCRIPTION
  Legt die ZIP-Datei neben dieses Skript (Projekt-Root). Eine vorhandene
  flymaps.zip wird überschrieben. Ordner wie node_modules, .git, .wrangler und
  .vite sowie Systemdateien (.DS_Store, Thumbs.db) werden ausgelassen.
  Pfade im Archiv verwenden Schrägstriche (/), damit es auch unter Linux/macOS
  sauber entpackt wird (Compress-Archive aus Windows PowerShell 5.1 schreibt
  Backslashes, deshalb hier direkt System.IO.Compression).

.EXAMPLE
  .\make-zip.ps1

  Falls die Ausführung von Skripten gesperrt ist:
  powershell -ExecutionPolicy Bypass -File .\make-zip.ps1
#>
param(
    [string]$OutFile = 'flymaps.zip',
    [string[]]$Items = @('index.html', 'src', 'functions')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd('\', '/')
$zipPath = Join-Path $root $OutFile

$skipDirs = @('node_modules', '.git', '.wrangler', '.vite')
$skipFiles = @('.DS_Store', 'Thumbs.db', 'desktop.ini')

function Get-RelativePath([string]$fullName) {
    return $fullName.Substring($root.Length).TrimStart('\', '/')
}

function Test-Skip([System.IO.FileInfo]$file) {
    if ($skipFiles -contains $file.Name) { return $true }
    $parts = @((Get-RelativePath $file.FullName) -split '[\\/]')
    # Alle Teile außer dem Dateinamen sind Ordner.
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        if ($skipDirs -contains $parts[$i]) { return $true }
    }
    return $false
}

# Dateien einsammeln
$files = @()
foreach ($item in $Items) {
    $path = Join-Path $root $item
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Warning "Nicht gefunden, übersprungen: $item"
        continue
    }
    if (Test-Path -LiteralPath $path -PathType Container) {
        $files += Get-ChildItem -LiteralPath $path -Recurse -File -Force
    }
    else {
        $files += Get-Item -LiteralPath $path
    }
}
$files = @($files | Where-Object { -not (Test-Skip $_) })

if ($files.Count -eq 0) {
    throw "Keine Dateien zum Packen gefunden (Skript im Projektordner ausführen?)."
}

# ZIP schreiben
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $entryName = (Get-RelativePath $file.FullName) -replace '\\', '/'
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $zip.Dispose()
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
Write-Host "$OutFile erstellt: $($files.Count) Dateien, $sizeMb MB" -ForegroundColor Green
foreach ($item in $Items) {
    $prefix = $item.TrimEnd('\', '/')
    $count = @($files | Where-Object {
            $rel = (Get-RelativePath $_.FullName) -replace '\\', '/'
            $rel -eq $prefix -or $rel.StartsWith("$prefix/")
        }).Count
    Write-Host ("  {0,-12} {1} Dateien" -f $item, $count)
}
