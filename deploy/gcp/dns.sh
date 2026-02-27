#!/usr/bin/env bash
# deploy/gcp/dns.sh
# Create Cloud DNS records for grantex.dev.
# Run AFTER setup.sh and after Firebase Hosting is provisioned.
# Usage: bash deploy/gcp/dns.sh
set -euo pipefail

PROJECT_ID="grantex-prod"
REGION="us-central1"
DNS_ZONE_NAME="grantex-dev"
DNS_DOMAIN="grantex.dev."
CR_SERVICE="grantex-auth"

echo "==> [1/6] Fetching Cloud Run URL..."
CR_URL=$(gcloud run services describe "${CR_SERVICE}" \
  --region="${REGION}" \
  --format='value(status.url)' \
  --project="${PROJECT_ID}")

# Strip https:// prefix
CR_HOST="${CR_URL#https://}"
echo "    Cloud Run host: ${CR_HOST}"

echo ""
echo "==> [2/6] Creating Cloud DNS managed zone for ${DNS_DOMAIN}..."
gcloud dns managed-zones create "${DNS_ZONE_NAME}" \
  --dns-name="${DNS_DOMAIN}" \
  --description="Grantex production DNS zone" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "    Zone may already exist, continuing."

echo ""
echo "==> [3/6] Fetching nameservers (you must set these at your registrar)..."
NS_RECORDS=$(gcloud dns managed-zones describe "${DNS_ZONE_NAME}" \
  --format='value(nameServers)' \
  --project="${PROJECT_ID}")
echo ""
echo "┌────────────────────────────────────────────────────────────────────────┐"
echo "│  ACTION REQUIRED: Update your domain registrar's nameservers           │"
echo "│                                                                        │"
echo "│  Set the following nameservers for grantex.dev at your registrar:     │"
echo "│                                                                        │"
echo "${NS_RECORDS}" | tr ';' '\n' | while read -r ns; do
  printf "│    %-68s│\n" "  ${ns}"
done
echo "│                                                                        │"
echo "│  DNS propagation can take up to 48 hours.                             │"
echo "└────────────────────────────────────────────────────────────────────────┘"
echo ""
echo "    Press ENTER to continue adding DNS records."
read -r

echo ""
echo "==> [4/6] Adding CNAME record: api.grantex.dev → Cloud Run..."
# Cloud Run requires a CNAME pointing to ghs.googlehosted.com for custom domains,
# but for api subdomain we use the Cloud Run URL directly as a CNAME target.
# NOTE: Cloud Run custom domains are managed via `gcloud run domain-mappings create`.
# The CNAME below points at the Cloud Run service host for reference in the zone.
gcloud dns record-sets transaction start \
  --zone="${DNS_ZONE_NAME}" \
  --project="${PROJECT_ID}" 2>/dev/null || true

gcloud dns record-sets transaction add \
  --zone="${DNS_ZONE_NAME}" \
  --name="api.${DNS_DOMAIN}" \
  --type=CNAME \
  --ttl=300 \
  "${CR_HOST}." \
  --project="${PROJECT_ID}" 2>/dev/null || echo "    CNAME may already exist."

echo ""
echo "==> [5/6] Adding Firebase Hosting A/AAAA records for grantex.dev..."
echo "    Firebase Hosting IPs (as of 2026):"
echo "    A     151.101.1.195"
echo "    A     151.101.65.195"

gcloud dns record-sets transaction add \
  --zone="${DNS_ZONE_NAME}" \
  --name="${DNS_DOMAIN}" \
  --type=A \
  --ttl=300 \
  "151.101.1.195" "151.101.65.195" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "    A records may already exist."

# www redirect → apex
gcloud dns record-sets transaction add \
  --zone="${DNS_ZONE_NAME}" \
  --name="www.${DNS_DOMAIN}" \
  --type=CNAME \
  --ttl=300 \
  "${DNS_DOMAIN}" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "    www CNAME may already exist."

echo ""
echo "==> [6/6] Committing DNS transaction..."
gcloud dns record-sets transaction execute \
  --zone="${DNS_ZONE_NAME}" \
  --project="${PROJECT_ID}" || echo "    Transaction execute failed — records may already exist. Use describe to verify."

echo ""
echo "==> Mapping Cloud Run custom domain api.grantex.dev..."
echo "    Run the following to create the Cloud Run domain mapping:"
echo ""
echo "    gcloud run domain-mappings create \\"
echo "      --service=${CR_SERVICE} \\"
echo "      --domain=api.grantex.dev \\"
echo "      --region=${REGION} \\"
echo "      --project=${PROJECT_ID}"
echo ""
echo "    After mapping, a new CNAME value will be shown — update the DNS record if different."
echo ""
echo "==> Firebase Hosting custom domain:"
echo "    Run the following after 'firebase deploy --only hosting':"
echo ""
echo "    firebase hosting:sites:create grantex-prod   # if not already created"
echo "    # Then add grantex.dev as a custom domain in the Firebase console:"
echo "    # https://console.firebase.google.com/project/grantex-prod/hosting"
echo ""
echo "==> DNS setup complete. Verify propagation with:"
echo "    dig grantex.dev A"
echo "    dig api.grantex.dev CNAME"
