#!/bin/bash

set -euo pipefail

# Script to upload swamp binaries to S3
# Usage: ./upload-binaries.sh <version> [bucket]
#
# Example: ./upload-binaries.sh v20260204.165928.0-sha.06db816c si-artifacts-prod

VERSION="${1:-}"
BUCKET="${2:-si-artifacts-prod}"

if [[ -z "$VERSION" ]]; then
    echo "Error: Version parameter is required"
    echo "Usage: $0 <version> [bucket]"
    echo "Example: $0 v20260204.165928.0-sha.06db816c si-artifacts-prod"
    exit 1
fi

# Remove 'v' prefix if present for consistency
VERSION_CLEAN="${VERSION#v}"

# Define the binary mappings (compatible with older bash)
BINARIES="swamp-darwin-aarch64:darwin/aarch64 swamp-darwin-x86_64:darwin/x86_64 swamp-linux-x86_64:linux/x86_64 swamp-linux-aarch64:linux/aarch64"

# Base directory where binaries are expected to be
BINARIES_DIR="${BINARIES_DIR:-./dist}"

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
    echo "Error: AWS CLI not found. Please install it first."
    exit 1
fi

echo "Uploading swamp binaries for version: $VERSION_CLEAN to bucket: $BUCKET"
echo "Looking for binaries in: $BINARIES_DIR"

# Create temporary directory for packaging
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Process each binary mapping
for mapping in $BINARIES; do
    binary_name=$(echo "$mapping" | cut -d':' -f1)
    os_arch=$(echo "$mapping" | cut -d':' -f2)
    os=$(echo "$os_arch" | cut -d'/' -f1)
    arch=$(echo "$os_arch" | cut -d'/' -f2)
    
    binary_path="$BINARIES_DIR/$binary_name"
    
    if [[ ! -f "$binary_path" ]]; then
        echo "Warning: Binary not found: $binary_path - skipping"
        continue
    fi
    
    # Create the expected filename for S3
    s3_filename="swamp-${VERSION_CLEAN}-binary-${os}-${arch}.tar.gz"
    
    # Create tar.gz with the binary
    temp_binary="$TEMP_DIR/swamp"
    cp "$binary_path" "$temp_binary"
    chmod +x "$temp_binary"
    
    # Create tar.gz in temp directory
    (cd "$TEMP_DIR" && tar -czf "$s3_filename" swamp)
    
    # Define S3 path
    s3_path="s3://$BUCKET/swamp/$VERSION_CLEAN/binary/$os/$arch/$s3_filename"
    
    echo "Uploading $binary_name -> $s3_path"
    
    # Upload to S3
    aws s3 cp "$TEMP_DIR/$s3_filename" "$s3_path"
    
    # Create stable pointer with redirect metadata
    stable_path="s3://$BUCKET/swamp/stable/binary/$os/$arch/swamp-stable-binary-${os}-${arch}.tar.gz"
    redirect_url="https://artifacts.systeminit.com/swamp/$VERSION_CLEAN/binary/$os/$arch/$s3_filename"
    
    echo "Creating stable pointer: $stable_path -> $redirect_url"
    
    # Create empty file with redirect metadata
    echo "" | aws s3 cp - "$stable_path" \
        --content-type "binary/octet-stream" \
        --metadata-directive REPLACE \
        --metadata "x-amz-website-redirect-location=$redirect_url"
    
    # Clean up temp file
    rm -f "$temp_binary" "$TEMP_DIR/$s3_filename"
done

echo "✅ Upload complete!"
echo ""
echo "Binaries are now available at:"
for mapping in $BINARIES; do
    binary_name=$(echo "$mapping" | cut -d':' -f1)
    os_arch=$(echo "$mapping" | cut -d':' -f2)
    os=$(echo "$os_arch" | cut -d'/' -f1)
    arch=$(echo "$os_arch" | cut -d'/' -f2)
    s3_filename="swamp-${VERSION_CLEAN}-binary-${os}-${arch}.tar.gz"
    echo "  Versioned: https://$BUCKET.s3.amazonaws.com/swamp/$VERSION_CLEAN/binary/$os/$arch/$s3_filename"
    echo "  Stable:    https://artifacts.systeminit.com/swamp/stable/binary/$os/$arch/swamp-stable-binary-${os}-${arch}.tar.gz"
done