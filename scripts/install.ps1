#Requires -Version 5.1

<#
.SYNOPSIS
    Installs the swamp CLI binary for Windows.

.DESCRIPTION
    Downloads and installs the swamp CLI binary release for Windows x86_64.
    Automatically detects system architecture, follows S3 redirects for version
    resolution, verifies SHA-256 checksums, and handles installation.

.PARAMETER Destination
    Destination directory for installation. Default: C:\Program Files\swamp (admin) or $env:LOCALAPPDATA\swamp (user)

.PARAMETER Version
    Release version to install. Default: stable
    Examples: stable, 20250218.210911.0-sha.bda1ce6ea

.PARAMETER AddToPath
    Add the installation directory to the system PATH. Default: $true

.PARAMETER Help
    Show this help message.

.EXAMPLE
    # Install to default location (user-specific)
    .\install.ps1

    # Install system-wide (requires admin)
    .\install.ps1

    # Install to custom location
    .\install.ps1 -Destination "C:\Tools\swamp"

    # Install specific version
    .\install.ps1 -Version "stable"

.NOTES
    Requires PowerShell 5.1 or later
#>

[CmdletBinding()]
param(
    [Parameter()]
    [string]$Destination,

    [Parameter()]
    [string]$Version = "stable",

    [Parameter()]
    [bool]$AddToPath = $true,

    [Parameter()]
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# Script configuration
$BinName = "swamp"
$BinExe = "$BinName.exe"
$TrustedArtifactHost = "https://artifacts.swamp-club.com/$BinName/"

function Write-Header {
    param([string]$Message)
    Write-Host "--- $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "  - $Message" -ForegroundColor White
}

function Write-Success {
    param([string]$Message)
    Write-Host "  + $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "!!! $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "xxx $Message" -ForegroundColor Red
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DefaultDestination {
    $isAdmin = Test-Administrator

    if ($isAdmin) {
        return "C:\Program Files\$BinName"
    } else {
        return Join-Path $env:LOCALAPPDATA $BinName
    }
}

function Assert-TrustedUrl {
    param([string]$Url)

    if (-not $Url.StartsWith($TrustedArtifactHost)) {
        throw "Untrusted artifact URL: $Url"
    }
}

function Get-AssetUrl {
    param(
        [string]$Version,
        [string]$OsType,
        [string]$CpuType
    )

    $type = "binary"
    $platform = "$OsType-$CpuType"
    $extension = "zip"

    $url = "https://artifacts.swamp-club.com/$BinName/$Version/$type"
    $url = "$url/$OsType/$CpuType/$BinName-$Version-$type-$platform.$extension"

    return $url
}

function Resolve-S3Redirect {
    param([string]$Url)

    Assert-TrustedUrl $Url

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -ErrorAction Stop
        $redirectHeader = $null

        if ($response.Headers -and $response.Headers.ContainsKey("x-amz-meta-x-amz-website-redirect-location")) {
            $redirectHeader = $response.Headers["x-amz-meta-x-amz-website-redirect-location"]
            if ($redirectHeader -is [array]) {
                $redirectHeader = $redirectHeader[0]
            }
        }

        if ($redirectHeader) {
            $redirectHeader = $redirectHeader.Trim()
            Assert-TrustedUrl $redirectHeader
            Write-Info "Following S3 redirect to $redirectHeader"
            return $redirectHeader
        }
    } catch {
        Write-Info "HEAD request failed, proceeding with original URL"
    }

    return $Url
}

function Get-ReleaseVersion {
    param([string]$ResolvedUrl)

    Assert-TrustedUrl $ResolvedUrl

    $path = $ResolvedUrl.Substring($TrustedArtifactHost.Length)
    $version = $path.Split("/")[0]

    if (-not $version -or $version -eq "stable") {
        throw "Could not determine the release version for checksum verification"
    }

    if ($version -notmatch '^[0-9A-Za-z._-]+$') {
        throw "Invalid release version: $version"
    }

    return $version
}

function Download-File {
    param(
        [string]$Url,
        [string]$Destination
    )

    Write-Info "Downloading $Url"

    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -ErrorAction Stop
    } catch {
        throw "Failed to download file: $_"
    }
}

function Assert-Sha256 {
    param(
        [string]$FilePath,
        [string]$ExpectedHash,
        [string]$Label
    )

    $actualHash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToLower()
    $expectedLower = $ExpectedHash.ToLower()

    if ($actualHash -ne $expectedLower) {
        throw "SHA-256 checksum verification failed for '$Label' (expected: $expectedLower, actual: $actualHash)"
    }

    Write-Info "Verified SHA-256 checksum for '$Label'"
}

function Test-Sha256Format {
    param(
        [string]$Hash,
        [string]$Label
    )

    if ($Hash.Length -ne 64) {
        throw "Invalid SHA-256 checksum for '$Label'"
    }
    if ($Hash -notmatch '^[0-9a-f]+$') {
        throw "Invalid SHA-256 checksum for '$Label'"
    }
}

function Get-ChecksumForAsset {
    param(
        [string]$ChecksumFile,
        [string]$AssetName
    )

    $content = Get-Content -Path $ChecksumFile
    $found = $null

    foreach ($line in $content) {
        $parts = $line -split '\s+', 2
        if ($parts.Length -eq 2 -and $parts[1].Trim() -eq $AssetName) {
            if ($null -ne $found) {
                throw "Duplicate checksum for '$AssetName'"
            }
            $found = $parts[0].Trim()
        }
    }

    if (-not $found) {
        throw "No checksum found for '$AssetName'"
    }

    Test-Sha256Format $found $AssetName
    return $found
}

function Confirm-ArchiveContents {
    param(
        [string]$ArchivePath,
        [string]$ExpectedEntry
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName })

        if ($entries.Count -ne 1 -or $entries[0] -ne $ExpectedEntry) {
            throw "Downloaded archive contains unexpected entries: $($entries -join ', ')"
        }
    } finally {
        $archive.Dispose()
    }
}

function Extract-Archive {
    param(
        [string]$ArchivePath,
        [string]$DestinationPath
    )

    Write-Info "Extracting archive..."

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationPath)

        $extractedBinary = Join-Path $DestinationPath $BinExe
        if (-not (Test-Path $extractedBinary)) {
            throw "Failed to extract binary '$BinExe' from archive"
        }
    } catch {
        throw "Failed to extract archive: $_"
    }
}

function Install-Binary {
    param(
        [string]$SourcePath,
        [string]$DestinationDir
    )

    Write-Info "Installing '$BinExe' to '$DestinationDir'"

    try {
        if (-not (Test-Path $DestinationDir)) {
            New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
        }

        $destFile = Join-Path $DestinationDir $BinExe

        if (Test-Path $destFile) {
            Remove-Item $destFile -Force
        }

        Copy-Item -Path $SourcePath -Destination $destFile -Force

        Write-Success "Installed to $destFile"
    } catch {
        throw "Failed to install binary: $_"
    }
}

function Add-ToPath {
    param(
        [string]$Directory
    )

    $isAdmin = Test-Administrator
    $target = if ($isAdmin) { "Machine" } else { "User" }

    $currentPath = [Environment]::GetEnvironmentVariable("Path", $target)

    $pathEntries = $currentPath -split ";" | ForEach-Object { $_.Trim() }
    if ($pathEntries -contains $Directory) {
        Write-Info "Directory already in PATH"
        return
    }

    Write-Info "Adding directory to $target PATH"

    try {
        $newPath = "$currentPath;$Directory"
        [Environment]::SetEnvironmentVariable("Path", $newPath, $target)

        $env:Path = "$env:Path;$Directory"

        Write-Success "Added to $target PATH"
        Write-Warn "You may need to restart your terminal for PATH changes to take effect"
    } catch {
        Write-Warn "Failed to add to PATH: $_"
        Write-Info "You can manually add '$Directory' to your PATH"
    }
}

function Show-Help {
    Get-Help $PSCommandPath -Detailed
}

function Main {
    if ($Help) {
        Show-Help
        exit 0
    }

    Write-Header "Installing '$BinName' for Windows"

    # Detect platform
    $osType = "windows"
    $cpuType = if ([Environment]::Is64BitOperatingSystem) { "x86_64" } else { "x86" }

    if ($cpuType -ne "x86_64") {
        Write-Err "Unsupported architecture: $cpuType. Only x86_64 is supported."
        exit 1
    }

    $platform = "$osType-$cpuType"
    Write-Info "Detected platform: $platform"

    # Determine destination
    if (-not $Destination) {
        $Destination = Get-DefaultDestination
    }

    $isAdmin = Test-Administrator
    if ($isAdmin) {
        Write-Info "Running with administrator privileges"
    } else {
        Write-Info "Running without administrator privileges (user install)"
    }

    Write-Info "Installation directory: $Destination"
    Write-Info "Version: $Version"

    # Create temp directory
    $tempDir = Join-Path $env:TEMP "swamp-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        # Build download URL and resolve S3 redirect
        Write-Header "Downloading '$BinName' release '$Version'"
        $assetUrl = Get-AssetUrl -Version $Version -OsType $osType -CpuType $cpuType
        Write-Info "URL: $assetUrl"

        $resolvedUrl = Resolve-S3Redirect $assetUrl

        # Extract the pinned release version from the resolved URL
        $releaseVersion = Get-ReleaseVersion $resolvedUrl
        Write-Info "Resolved release version: $releaseVersion"

        # Download the zip from the resolved URL
        $zipFile = Join-Path $tempDir "swamp.zip"
        Download-File -Url $resolvedUrl -Destination $zipFile
        Write-Success "Downloaded successfully"

        # Download and verify SHA-256 from S3 sidecar (resolved URL, not alias)
        Write-Header "Verifying checksums"
        $checksumFile = Join-Path $tempDir "swamp.zip.sha256"
        Download-File -Url "$resolvedUrl.sha256" -Destination $checksumFile

        $checksumContent = (Get-Content -Path $checksumFile -Raw).Trim()
        $expectedHash = ($checksumContent -split '\s+')[0]
        Test-Sha256Format $expectedHash "$(Split-Path $zipFile -Leaf)"
        Assert-Sha256 $zipFile $expectedHash (Split-Path $zipFile -Leaf)

        # Validate archive contents before extraction
        Write-Header "Validating archive"
        Confirm-ArchiveContents $zipFile $BinExe
        Write-Success "Archive contains expected binary"

        # Extract archive
        Write-Header "Extracting archive"
        $extractDir = Join-Path $tempDir "extract"
        Extract-Archive -ArchivePath $zipFile -DestinationPath $extractDir
        Write-Success "Extracted successfully"

        # Cross-verify extracted binary against GitHub release checksums
        Write-Header "Verifying release binary"
        $releaseAsset = "$BinName-$osType-$cpuType"
        $releaseChecksumsFile = Join-Path $tempDir "checksums-$releaseVersion.txt"
        Download-File `
            -Url "https://github.com/swamp-club/swamp/releases/download/v$releaseVersion/checksums.txt" `
            -Destination $releaseChecksumsFile

        $expectedBinaryHash = Get-ChecksumForAsset $releaseChecksumsFile $releaseAsset
        $binaryPath = Join-Path $extractDir $BinExe
        Assert-Sha256 $binaryPath $expectedBinaryHash $releaseAsset
        Write-Success "Verified GitHub release checksum for '$releaseAsset'"

        # Install binary
        Write-Header "Installing binary"
        Install-Binary -SourcePath $binaryPath -DestinationDir $Destination

        # Add to PATH
        if ($AddToPath) {
            Write-Header "Configuring PATH"
            Add-ToPath -Directory $Destination
        }

        # Verify installation
        Write-Header "Verifying installation"
        $installedBinary = Join-Path $Destination $BinExe
        if (Test-Path $installedBinary) {
            Write-Success "Installation complete: $installedBinary"

            try {
                $versionOutput = & $installedBinary --version 2>&1
                Write-Info "Version: $versionOutput"
            } catch {
                Write-Info "Binary installed successfully"
            }
        } else {
            throw "Installation verification failed"
        }

    } catch {
        Write-Err "Installation failed: $_"
        Write-Info ""
        Write-Warn "If you need help, please join us on our Discord!"
        Write-Warn "    https://discord.gg/swamp-club"
        exit 1
    } finally {
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Header "Installation of '$BinName' release '$Version' complete"
    Write-Info ""

    Write-Info "By using Swamp you agree to its software license and extension"
    Write-Info "registry terms."
    Write-Info ""
    Write-Info "  Software License:     https://swamp-club.com/software-license-agreement"
    Write-Info "  Extension Registry:   https://swamp-club.com/extension-registry-terms"
    Write-Host ""

    # Prompt to connect to SWAMP CLUB when running interactively
    if ([Environment]::UserInteractive -and [Console]::KeyAvailable -ne $null) {
        Write-Host ""
        Write-Header "Swamp is better with SWAMP CLUB (swamp-club.com)"
        Write-Info ""
        Write-Info "Connect your account to unlock:"
        Write-Info "  - Submit bug reports and feature requests"
        Write-Info "  - Publish extensions to share with the community"
        Write-Info "  - Higher rate limits on CLI usage"
        Write-Info ""
        $answer = Read-Host "  Set up your SWAMP CLUB account now? [Y/n]"
        if ($answer -match '^[nN]') {
            Write-Info ""
            Write-Info "No problem! You can connect later: swamp auth login"
        } else {
            Write-Host ""
            $installedBinary = Join-Path $Destination $BinExe
            try {
                & $installedBinary auth login
                if ($LASTEXITCODE -ne 0) { throw "auth login exited with code $LASTEXITCODE" }
            } catch {
                Write-Warn ""
                Write-Warn "Account setup didn't finish - no worries!"
                Write-Warn "Run this when you're ready to pick up where you left off:"
                Write-Warn ""
                Write-Warn "    swamp auth login"
                Write-Warn ""
            }
        }
        Write-Host ""
    }

    Write-Info "Next steps:"
    Write-Info ""
    Write-Info "  1. Initialize a swamp repository:"
    Write-Info "       cd your-project; swamp repo init"
    Write-Info ""
    Write-Info "  2. Set up shell completions (optional):"
    Write-Info "       swamp completions --help"
    Write-Info ""
    Write-Info "  3. Join the community:"
    Write-Info "       https://discord.gg/swamp-club"
    Write-Info ""
    Write-Info "Learn more: https://github.com/swamp-club/swamp"

    if (-not $AddToPath) {
        $binaryLocation = Join-Path $Destination $BinExe
        Write-Info "Binary location: $binaryLocation"
    }
}

# Run main function
Main
