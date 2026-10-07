param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = (Get-Content -LiteralPath (Join-Path $project "package.json") -Raw | ConvertFrom-Json).version
}
$dist = Join-Path $project "dist"
$stage = Join-Path $dist (".inventory-stage-" + [guid]::NewGuid().ToString("N"))
$archive = Join-Path $dist "MeshCentral-Inventory-$Version.zip"
$latestArchive = Join-Path $dist "MeshCentral-Inventory.zip"

New-Item -ItemType Directory -Path (Join-Path $stage "lib") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "views") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $project "inventory.js") -Destination $stage
Copy-Item -LiteralPath (Join-Path $project "config.json") -Destination $stage
Copy-Item -LiteralPath (Join-Path $project "README.md") -Destination $stage
Copy-Item -LiteralPath (Join-Path $project "CHANGELOG.md") -Destination $stage
Copy-Item -LiteralPath (Join-Path $project "LICENSE") -Destination $stage
Copy-Item -LiteralPath (Join-Path $project "lib\model.js") -Destination (Join-Path $stage "lib")
Copy-Item -LiteralPath (Join-Path $project "views\inventory.handlebars") -Destination (Join-Path $stage "views")

if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}

# Compress-Archive stores Windows separators in entry names. MeshCentral runs
# on Linux in production, so create each entry explicitly with '/' separators.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($archive, [System.IO.FileMode]::CreateNew)
try {
    $zip = [System.IO.Compression.ZipArchive]::new(
        $stream,
        [System.IO.Compression.ZipArchiveMode]::Create,
        $false
    )
    try {
        Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
            $relative = 'inventory/' + $_.FullName.Substring($stage.Length).TrimStart([char[]]'\/').Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip,
                $_.FullName,
                $relative,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally {
        $zip.Dispose()
    }
} finally {
    $stream.Dispose()
}

$resolvedProject = (Resolve-Path -LiteralPath $project).Path.TrimEnd([char[]]'\/')
$resolvedDist = (Resolve-Path -LiteralPath $dist).Path.TrimEnd([char[]]'\/')
$resolvedStage = (Resolve-Path -LiteralPath $stage).Path
if (-not $resolvedDist.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    -not $resolvedStage.StartsWith($resolvedDist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package staging path is outside the project dist directory.'
}
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
Copy-Item -LiteralPath $archive -Destination $latestArchive -Force

Write-Output $archive
Write-Output $latestArchive
