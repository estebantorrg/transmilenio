#!/usr/bin/env bash
# One attempt at creating the Always Free relay VM in Bogotá (spec §5.2.2a).
#
# Bogotá offers this tenancy a single Always Free compute shape —
# VM.Standard.A1.Flex (Ampere); the AMD E2.1.Micro is not available in the
# region — and it is usually "Out of host capacity". Capacity frees up at
# random, so a workflow (.github/workflows/oci-free-vm.yml) calls this about once
# a minute until one launch succeeds. Oracle's own error says "try again later";
# the API is rate-limited, and a 429 is answered by slowing down.
#
# Exit codes: 0 = launched (or it already exists) · 10 = no capacity (try again
# shortly) · 11 = throttled (pause before asking again) · anything else = an
# error that waiting won't fix, unless it was a blip.
#
# Needs: an OCI CLI config for a principal allowed to launch instances
# (IAM policy `transmi-ci-launch-relay-vm`), SUBNET_ID, and the tenancy OCID.
set -u

COMPARTMENT="${OCI_TENANCY_OCID:?OCI_TENANCY_OCID is required}"
SUBNET="${SUBNET_ID:?SUBNET_ID is required}"
AD="${AVAILABILITY_DOMAIN:-OMLP:SA-BOGOTA-1-AD-1}"
NAME="transmi-relay"
# Alternate sizes between rounds: a smaller machine sometimes fits where the
# bigger one doesn't. Both are inside the Always Free 2 OCPU / 12 GB.
MEMS=(6 2)
MEM=${MEMS[$(( ${ROUND:-0} % ${#MEMS[@]} ))]}
# Public half only; the private key never leaves the maintainer's machine.
SSH_PUBLIC_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBLmk666G716DTUh2g3kYzISOxlpY5lJ+znSZYv07TQC transmi-relay"

summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY"; echo "$*"; }

# Every call is --no-retry: the CLI otherwise retries a 5xx on its own with
# growing pauses, and "Out of host capacity" IS a 5xx — one "attempt" became
# several requests over ~100 s. One attempt here is exactly one request.
#
# Each OCI CLI call still costs some interpreter start-up on a runner, so the two
# lookups below run once per workflow run, not once per attempt: the first
# attempt does them and leaves the answers in STATE_FILE, and later attempts
# (SKIP_LOOKUPS=1) go straight to the launch — one call each.
if [ "${SKIP_LOOKUPS:-0}" != 1 ]; then
  existing=$(oci --no-retry compute instance list --compartment-id "$COMPARTMENT" --display-name "$NAME" \
    --query "data[?\"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output 2>/dev/null)
  if [[ "$existing" == ocid1.instance* ]]; then
    summary "Instance already exists: \`$existing\`"
    exit 0
  fi

  # The newest Ubuntu 24.04 Minimal image for Ampere, so a retired image never
  # turns into a "real error".
  IMAGE=$(oci --no-retry compute image list --compartment-id "$COMPARTMENT" \
    --operating-system "Canonical Ubuntu" --shape VM.Standard.A1.Flex \
    --sort-by TIMECREATED --sort-order DESC \
    --query "data[?contains(\"display-name\", '24.04-Minimal-aarch64')].id | [0]" --raw-output 2>/dev/null)
  if [[ "$IMAGE" != ocid1.image* ]]; then
    summary "Could not find an Ubuntu 24.04 Minimal aarch64 image."
    exit 3
  fi
  [ -n "${STATE_FILE:-}" ] && printf 'IMAGE=%s\nSKIP_LOOKUPS=1\n' "$IMAGE" > "$STATE_FILE"
fi
IMAGE="${IMAGE:?IMAGE is required when SKIP_LOOKUPS=1}"

KEYFILE=$(mktemp)
printf '%s\n' "$SSH_PUBLIC_KEY" > "$KEYFILE"
out=$(oci --no-retry compute instance launch \
  --availability-domain "$AD" --compartment-id "$COMPARTMENT" \
  --shape VM.Standard.A1.Flex --shape-config "{\"ocpus\":1,\"memoryInGBs\":$MEM}" \
  --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
  --display-name "$NAME" --boot-volume-size-in-gbs 50 \
  --ssh-authorized-keys-file "$KEYFILE" 2>&1)
rm -f "$KEYFILE"

if grep -q '"lifecycle-state"' <<<"$out"; then
  id=$(grep -oE 'ocid1\.instance\.[^"]+' <<<"$out" | head -1)
  summary "Launched \`$NAME\` (1 OCPU, ${MEM} GB): \`$id\`"
  exit 0
fi

reason=$(grep -oE '"message": "[^"]{0,160}' <<<"$out" | head -1 | sed 's/"message": "//')
if grep -qiE 'TooManyRequests|"status": 429' <<<"$out"; then
  summary "Throttled by OCI (1 OCPU, ${MEM} GB): ${reason:-TooManyRequests}"
  exit 11
fi
if grep -qiE 'capacity|InternalError|timed out' <<<"$out"; then
  # A plain "no capacity" is a clean no. A timeout or an internal error is not:
  # the VM may have been created anyway, so the next attempt must look first
  # instead of launching a second one.
  grep -qi 'capacity' <<<"$out" || rm -f "${STATE_FILE:-}"
  summary "No VM this round (1 OCPU, ${MEM} GB): ${reason:-no clear answer}"
  exit 10
fi
[ -n "${STATE_FILE:-}" ] && rm -f "$STATE_FILE"
summary "Launch failed with an error that waiting won't fix: ${reason:-$(tail -c 300 <<<"$out")}"
exit 1
