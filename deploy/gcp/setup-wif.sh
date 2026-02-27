#!/usr/bin/env bash
# deploy/gcp/setup-wif.sh
# One-time setup: Workload Identity Federation for GitHub Actions.
# This removes the need for long-lived service account JSON keys.
# Run AFTER setup.sh (requires the grantex-auth-sa service account to exist).
# Usage: bash deploy/gcp/setup-wif.sh
set -euo pipefail

PROJECT_ID="grantex-prod"
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
SA_NAME="grantex-auth-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
GITHUB_ORG="mishrasanjeev"
GITHUB_REPO="grantex"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"
REPO_FULL="${GITHUB_ORG}/${GITHUB_REPO}"

echo "==> [1/6] Creating Workload Identity Pool: ${POOL_ID}..."
gcloud iam workload-identity-pools create "${POOL_ID}" \
  --location=global \
  --display-name="GitHub Actions Pool" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "    Pool may already exist."

echo ""
echo "==> [2/6] Creating OIDC provider: ${PROVIDER_ID}..."
gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
  --location=global \
  --workload-identity-pool="${POOL_ID}" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository=='${REPO_FULL}'" \
  --project="${PROJECT_ID}" 2>/dev/null || echo "    Provider may already exist."

echo ""
echo "==> [3/6] Binding GitHub Actions identity to service account..."
POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
MEMBER="principalSet://iam.googleapis.com/${POOL_RESOURCE}/attribute.repository/${REPO_FULL}"

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${MEMBER}" \
  --project="${PROJECT_ID}"

echo ""
echo "==> [4/6] Granting Cloud Run developer and Artifact Registry writer roles..."
for ROLE in "roles/run.developer" "roles/artifactregistry.writer"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --quiet
done

# Allow GitHub Actions to impersonate the service account
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet

echo ""
echo "==> [5/6] Fetching Workload Identity Provider resource name..."
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

echo ""
echo "==> [6/6] Done. Add the following as GitHub repository secrets:"
echo ""
echo "    Repository: https://github.com/${REPO_FULL}/settings/secrets/actions"
echo ""
echo "    Secret name:  GCP_WORKLOAD_IDENTITY_PROVIDER"
echo "    Secret value: ${WIF_PROVIDER}"
echo ""
echo "    Secret name:  GCP_SERVICE_ACCOUNT"
echo "    Secret value: ${SA_EMAIL}"
echo ""
echo "    After adding these secrets, push any commit touching apps/auth-service/"
echo "    to trigger the GitHub Actions deploy workflow."
