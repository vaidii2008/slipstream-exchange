#!/usr/bin/env bash
# Builds the API and terminal images for the VM, copies them into k3s over SSH, and applies
# the manifests with every image pinned to this commit.
#
# There is no registry. One node needs no image distribution, so the images travel as a
# `docker save` stream into k3s's containerd, and the pods never pull (imagePullPolicy: Never).
# Needs: gcloud signed in, the SSH tunnel to the cluster open, and the slipstream context.
set -euo pipefail
cd "$(dirname "$0")/.."

vm=slipstream
zone=europe-west1-b
# The API's public address. The terminal's bundle has it written in at build time.
api_url=https://api.slipstream-exchange.duckdns.org

kube() { kubectl --context slipstream "$@"; }

# The tag names a commit, so the images must be built from exactly that commit's sources.
image_sources=('*.ts' package.json package-lock.json drizzle Dockerfile .dockerignore web)
if [ -n "$(git status --porcelain -- "${image_sources[@]}")" ]; then
  echo "image sources have uncommitted changes; commit them first so the tag names them" >&2
  exit 1
fi
tag=$(git rev-parse --short HEAD)
api_image=slipstream-api:$tag
web_image=slipstream-web:$tag

# The VM is x86-64; a Mac builds arm64 unless told otherwise.
docker buildx build --platform linux/amd64 --load -t "$api_image" .
docker buildx build --platform linux/amd64 --load -t "$web_image" \
  --build-arg NEXT_PUBLIC_API_URL="$api_url" -f web/Dockerfile .

on_vm() { gcloud compute ssh "$vm" --zone "$zone" --quiet --command "$1"; }

# Imported images are named as docker.io/library/<name>, which is what a bare name in a pod
# spec resolves to. Skip the upload when the node already has both.
present=$(on_vm "sudo k3s ctr images ls -q | grep -cE '/(slipstream-api|slipstream-web):$tag\$' || true")
if [ "$present" != 2 ]; then
  docker save "$api_image" "$web_image" | gzip | on_vm 'gunzip | sudo k3s ctr images import -'
fi

# A throwaway overlay sets the tag, so the committed manifests never change per deploy. It
# sits in the repo because kustomize refuses an absolute path to its base, and beside k8s/
# rather than in it because a base may not contain its own overlay.
overlay=$(mktemp -d .deploy.XXXXXX)
trap 'rm -rf "$overlay"' EXIT
cat >"$overlay/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../k8s
images:
  - name: slipstream-api
    newTag: "$tag"
  - name: slipstream-web
    newTag: "$tag"
EOF
kube apply -k "$overlay"

for workload in $(kube -n slipstream get deployments,statefulsets -o name); do
  kube -n slipstream rollout status "$workload" --timeout=300s
done
echo "deployed $tag"
