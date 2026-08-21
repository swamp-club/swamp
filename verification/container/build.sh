#!/usr/bin/env bash
# Builds the verification sandbox container as an OCI image.
#
# Usage:
#   ./verification/container/build.sh                     Build for local arch, load into Docker
#   ./verification/container/build.sh --export             Also export OCI tarball
#   ./verification/container/build.sh --platform linux/arm64,linux/amd64  Multi-arch
#   ./verification/container/build.sh --tag v1.0           Custom tag
#
# Environment:
#   DENO_VERSION  Deno version to use (default: 2.8.3)
#   IMAGE_NAME    Image name (default: swamp-club/verify)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DENO_VERSION="${DENO_VERSION:-2.8.3}"
IMAGE_NAME="${IMAGE_NAME:-swamp-club/verify}"
IMAGE_TAG="deno-${DENO_VERSION}"
PLATFORM=""
EXPORT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)  PLATFORM="$2"; shift 2 ;;
    --export)    EXPORT=true; shift ;;
    --tag)       IMAGE_TAG="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^$/s/^# //p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Pick a container builder
if command -v docker &>/dev/null; then
  BUILDER="docker"
elif command -v podman &>/dev/null; then
  BUILDER="podman"
else
  echo "Error: docker or podman required" >&2
  exit 1
fi

echo "Building verification sandbox"
echo "  Builder:  ${BUILDER}"
echo "  Deno:     ${DENO_VERSION}"
echo "  Image:    ${IMAGE_NAME}:${IMAGE_TAG}"
[[ -n "${PLATFORM}" ]] && echo "  Platform: ${PLATFORM}"
echo ""

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

BUILD_ARGS=(
  --build-arg "DENO_VERSION=${DENO_VERSION}"
  --file "${SCRIPT_DIR}/Containerfile"
  --tag "${IMAGE_NAME}:${IMAGE_TAG}"
  --tag "${IMAGE_NAME}:latest"
  --label "org.opencontainers.image.created=${CREATED}"
  --label "org.opencontainers.image.revision=${GIT_SHA}"
  --label "org.opencontainers.image.version=${IMAGE_TAG}"
)

[[ -n "${PLATFORM}" ]] && BUILD_ARGS+=(--platform "${PLATFORM}")

# Use .containerignore from the container dir.
# Docker needs .dockerignore at the build context root — copy it temporarily.
DOCKERIGNORE="${REPO_ROOT}/.dockerignore"
CLEANUP_DOCKERIGNORE=false
if [[ "${BUILDER}" == "docker" && ! -f "${DOCKERIGNORE}" ]]; then
  cp "${SCRIPT_DIR}/.containerignore" "${DOCKERIGNORE}"
  CLEANUP_DOCKERIGNORE=true
fi

cleanup() {
  if [[ "${CLEANUP_DOCKERIGNORE}" == true ]]; then
    rm -f "${DOCKERIGNORE}"
  fi
}
trap cleanup EXIT

# Export OCI tarball if requested
if [[ "${EXPORT}" == true ]]; then
  OCI_TAR="${SCRIPT_DIR}/verify-${IMAGE_TAG}.tar"
  echo "Exporting OCI tarball → ${OCI_TAR}"

  if [[ "${BUILDER}" == "docker" ]]; then
    docker buildx build "${BUILD_ARGS[@]}" \
      --output "type=oci,dest=${OCI_TAR}" \
      "${REPO_ROOT}"
  else
    podman build "${BUILD_ARGS[@]}" \
      --format oci \
      "${REPO_ROOT}"
    podman save --format oci-archive -o "${OCI_TAR}" "${IMAGE_NAME}:${IMAGE_TAG}"
  fi

  echo "OCI tarball: ${OCI_TAR}"
  echo ""
fi

# Load into local container runtime
echo "Loading image..."
if [[ "${BUILDER}" == "docker" ]]; then
  docker buildx build "${BUILD_ARGS[@]}" --load "${REPO_ROOT}"
else
  podman build "${BUILD_ARGS[@]}" "${REPO_ROOT}"
fi

echo ""
echo "Done: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "Run a verification workflow:"
echo "  ${BUILDER} run --rm \\"
echo "    -v \$(pwd):/workspace \\"
echo "    ${IMAGE_NAME}:${IMAGE_TAG} \\"
echo "    workflow run verify-changes"
echo ""
echo "Interactive shell:"
echo "  ${BUILDER} run --rm -it \\"
echo "    -v \$(pwd):/workspace \\"
echo "    --entrypoint /bin/bash \\"
echo "    ${IMAGE_NAME}:${IMAGE_TAG}"
