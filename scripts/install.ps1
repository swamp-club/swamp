#Requires -Version 5.1

<#
.SYNOPSIS
    Installs the swamp CLI binary for Windows.

.DESCRIPTION
    Downloads and installs the swamp CLI binary release for Windows x86_64.
    Automatically detects system architecture, follows S3 redirects for version
    resolution, verifies SHA-256 checksums, and handles installation.

.PARAMETER Destination
    Destination directory for installation. Default: $env:SWAMP_HOME\bin when SWAMP_HOME is set, otherwise C:\Program Files\swamp (admin) or $env:LOCALAPPDATA\swamp (user)

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

    # Install to $env:SWAMP_HOME\bin
    $env:SWAMP_HOME = "C:\swamp"; .\install.ps1

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

# The documented install is `irm https://swamp-club.com/install.ps1 | iex`,
# which runs this text inside the caller's own PowerShell session. Everything
# below runs in a child scope so the error preference, functions and variables
# it sets stay out of that session, and failures throw instead of calling
# `exit`, which would close the caller's window. The parameters above are read
# from that child scope.
& {

$ErrorActionPreference = "Stop"

# Script configuration
$BinName = "swamp"
$BinExe = "$BinName.exe"
$ArtifactOrigin = if ($env:SWAMP_ARTIFACTS_URL) { $env:SWAMP_ARTIFACTS_URL } else { "https://artifacts.swamp-club.com" }
if ($ArtifactOrigin -cnotin @("https://artifacts.swamp-club.com", "https://artifacts-b.swamp-club.com")) {
    throw "Untrusted artifact origin: $ArtifactOrigin"
}
$TrustedArtifactHost = "$ArtifactOrigin/$BinName/"

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
    if ($env:SWAMP_HOME) {
        return Join-Path $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:SWAMP_HOME) "bin"
    }

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

    $url = "$ArtifactOrigin/$BinName/$Version/$type"
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
        [string]$DestinationFile
    )

    Write-Info "Extracting archive..."

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        # .NET resolves relative paths against the process directory, not the
        # PowerShell location, so hand it a full path.
        $fullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationFile)
        $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
        try {
            $entry = $archive.GetEntry($BinExe)
            if (-not $entry) {
                throw "Failed to extract binary '$BinExe' from archive"
            }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $fullPath)
        } finally {
            $archive.Dispose()
        }
    } catch {
        throw "Failed to extract archive: $_"
    }
}

function Install-Binary {
    param(
        [string]$TmpFile,
        [string]$DestinationDir
    )

    Write-Info "Installing '$BinExe' to '$DestinationDir'"

    $destFile = Join-Path $DestinationDir $BinExe
    $oldFile = "$destFile.old"

    # Windows refuses to delete or overwrite a running exe but allows renaming
    # it, so the old binary is renamed aside and only then replaced. If the new
    # one cannot be put in place, the old one is renamed back.
    $hadOld = Test-Path -LiteralPath $destFile
    try {
        if ($hadOld) {
            if (Test-Path -LiteralPath $oldFile) {
                Remove-Item -LiteralPath $oldFile -Force -ErrorAction SilentlyContinue
            }
            Move-Item -LiteralPath $destFile -Destination $oldFile
        }
    } catch {
        throw "Failed to install binary: could not replace '$destFile', which is left in place. Close any running swamp processes and try again. ($_)"
    }

    try {
        Move-Item -LiteralPath $tmpFile -Destination $destFile
    } catch {
        $placeError = $_
        if (-not $hadOld) {
            throw "Failed to install binary: $placeError"
        }
        Move-Item -LiteralPath $oldFile -Destination $destFile -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $destFile)) {
            throw "Failed to install binary: could not replace '$destFile'. The previous binary is at '$oldFile'; rename it back to '$BinExe'. ($placeError)"
        }
        throw "Failed to install binary: could not replace '$destFile', which is left in place. Close any running swamp processes and try again. ($placeError)"
    }

    if ($hadOld) {
        try {
            Remove-Item -LiteralPath $oldFile -Force
        } catch {
            Write-Info "The previous '$BinExe' is still running; it is removed the next time swamp starts"
        }
    }

    Write-Success "Installed to $destFile"
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
    # $PSCommandPath is empty when the script is not run from a file.
    if ($PSCommandPath) {
        Get-Help $PSCommandPath -Detailed
        return
    }

    Write-Host "Installs the swamp CLI binary for Windows."
    Write-Host ""
    Write-Host "Parameters:"
    Write-Host "  -Destination <dir>   Installation directory. Default: %SWAMP_HOME%\bin when SWAMP_HOME is set, otherwise C:\Program Files\swamp (admin) or %LOCALAPPDATA%\swamp (user)"
    Write-Host "  -Version <version>   Release version to install. Default: stable"
    Write-Host "  -AddToPath <bool>    Add the installation directory to the PATH. Default: `$true"
    Write-Host "  -Help                Show this help message."
    Write-Host ""
    Write-Host "To pass parameters to the downloaded script:"
    Write-Host "  & ([scriptblock]::Create((irm https://swamp-club.com/install.ps1))) -Version stable"
}

function Main {
    if ($Help) {
        Show-Help
        return
    }

    Write-Header "Installing '$BinName' for Windows"

    # Detect platform
    $osType = "windows"
    $cpuType = if ([Environment]::Is64BitOperatingSystem) { "x86_64" } else { "x86" }

    if ($cpuType -ne "x86_64") {
        Write-Err "Unsupported architecture: $cpuType. Only x86_64 is supported."
        throw "swamp installation failed"
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
    $binaryPath = $null
    $createdDestination = $false
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

        # Extract the binary straight into the destination under a temporary
        # name; it is renamed into place once verified. A file created there
        # inherits the destination's permissions, and no second copy of the
        # binary is made. The names are the ones `swamp update` uses: it sweeps
        # abandoned `.swamp.tmp.` files, and swamp removes a leftover `.old`
        # binary when it starts.
        Write-Header "Extracting archive"
        if (-not (Test-Path $Destination)) {
            try {
                New-Item -ItemType Directory -Path $Destination -Force | Out-Null
            } catch {
                throw "Failed to install binary: $_"
            }
            $createdDestination = $true
        }
        $binaryPath = Join-Path $Destination ".swamp.tmp.$([guid]::NewGuid()).exe"
        Extract-Archive -ArchivePath $zipFile -DestinationFile $binaryPath
        # The archive was verified before extraction and is not needed again.
        # Removing it now keeps it off disk while the binary is put in place.
        Remove-Item -LiteralPath $zipFile, $checksumFile -Force -ErrorAction SilentlyContinue
        Write-Success "Extracted successfully"

        # Archive SHA-256 was verified against the immutable GCP object.
        $reportedVersion = & $binaryPath --version
        if ($LASTEXITCODE -ne 0 -or $reportedVersion -cne "swamp $releaseVersion") {
            throw "Downloaded binary version mismatch: $reportedVersion"
        }

        # Install binary
        Write-Header "Installing binary"
        Install-Binary -TmpFile $binaryPath -DestinationDir $Destination

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

            # An earlier install elsewhere on PATH would keep running the old version.
            $resolved = Get-Command $BinExe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($resolved -and $resolved.Source -ne $installedBinary) {
                Write-Warn "'$($resolved.Source)' comes before '$installedBinary' on PATH, so '$BinName' runs that copy. Remove it, or put '$Destination' earlier on PATH."
            }

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
        throw "swamp installation failed"
    } finally {
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        # A binary that failed verification or was never put in place.
        if ($binaryPath -and (Test-Path -LiteralPath $binaryPath)) {
            Remove-Item -LiteralPath $binaryPath -Force -ErrorAction SilentlyContinue
        }
        if ($createdDestination -and -not (Get-ChildItem -LiteralPath $Destination -Force -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
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

    # `swamp start` signs the user in to swamp-club.com, so it is the one step
    # a new user needs; sign-in is not prompted for or listed separately.
    Write-Info "Next steps:"
    Write-Info ""
    Write-Info "  1. Get started (signs you in to swamp-club.com and opens your browser):"
    Write-Info "       swamp start"
    Write-Info "     In CI or for daemons, set SWAMP_API_KEY and SWAMP_SIGNIN_TOKEN instead:"
    Write-Info "       https://swamp-club.com/manual/reference/swamp-account-requirement"
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

}
