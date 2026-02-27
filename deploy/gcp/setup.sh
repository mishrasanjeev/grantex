#!/usr/bin/env bash
# deploy/gcp/setup.sh
# One-time GCP infrastructure provisioning for Grantex production.
# Run this script once as a GCP project owner (or with sufficient IAM permissions).
# Usage: bash deploy/gcp/setup.sh
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_ID="grantex-prod"
PROJECT_NAME="Grantex"
REGION="us-central1"
VPC_NAME="grantex-vpc"
SUBNET_NAME="grantex-subnet"
SUBNET_RANGE="10.8.0.0/28"
CONNECTOR_NAME="grantex-connector"
CONNECTOR_RANGE="10.8.1.0/28"
SQL_INSTANCE="grantex-pg16"
SQL_DB="grantex"
SQL_USER="grantex"
REDIS_INSTANCE="grantex-redis"
AR_REPO="grantex-images"
SA_NAME="grantex-auth-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="us-central1-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/auth-service:latest"
CR_SERVICE="grantex-auth"

echo "==> [1/17] Creating GCP project ${PROJECT_ID}..."
gcloud projects create "${PROJECT_ID}" --name="${PROJECT_NAME}" || echo "Project may already exist, continuing."
gcloud config set project "${PROJECT_ID}"

echo ""
echo "==> [2/17] Enabling required APIs (this may take a minute)..."
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  dns.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}"

echo ""
echo "┌─────────────────────────────────────────────────────────────────────┐"
echo "│  MANUAL STEP REQUIRED: Billing                                      │"
echo "│                                                                     │"
echo "│  Cloud SQL, Memorystore, and Cloud Run require a billing account.   │"
echo "│  Link one now at:                                                   │"
echo "│  https://console.cloud.google.com/billing/projects                  │"
echo "│                                                                     │"
echo "│  Press ENTER once billing is linked to continue.                    │"
echo "└─────────────────────────────────────────────────────────────────────┘"
read -r

echo ""
echo "==> [3/17] Creating VPC network and subnet..."
gcloud compute networks create "${VPC_NAME}" \
  --subnet-mode=custom \
  --project="${PROJECT_ID}" || echo "VPC may already exist."

gcloud compute networks subnets create "${SUBNET_NAME}" \
  --network="${VPC_NAME}" \
  --region="${REGION}" \
  --range="${SUBNET_RANGE}" \
  --project="${PROJECT_ID}" || echo "Subnet may already exist."

echo ""
echo "==> [4/17] Configuring Private Services Access for Cloud SQL..."
gcloud compute addresses create google-managed-services-"${VPC_NAME}" \
  --global \
  --purpose=VPC_PEERING \
  --prefix-length=16 \
  --network="${VPC_NAME}" \
  --project="${PROJECT_ID}" || echo "Address may already exist."

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-"${VPC_NAME}" \
  --network="${VPC_NAME}" \
  --project="${PROJECT_ID}" || echo "Peering may already exist."

echo ""
echo "==> [5/17] Creating Cloud SQL instance (postgres16, private VPC only)..."
echo "    This can take 5-10 minutes..."
gcloud sql instances create "${SQL_INSTANCE}" \
  --database-version=POSTGRES_16 \
  --tier=db-g1-small \
  --region="${REGION}" \
  --no-assign-ip \
  --network="projects/${PROJECT_ID}/global/networks/${VPC_NAME}" \
  --storage-size=10GB \
  --storage-auto-increase \
  --project="${PROJECT_ID}" || echo "SQL instance may already exist."

echo ""
echo "==> [6/17] Creating database and user..."
gcloud sql databases create "${SQL_DB}" \
  --instance="${SQL_INSTANCE}" \
  --project="${PROJECT_ID}" || echo "Database may already exist."

SQL_PASSWORD=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
gcloud sql users create "${SQL_USER}" \
  --instance="${SQL_INSTANCE}" \
  --password="${SQL_PASSWORD}" \
  --project="${PROJECT_ID}" || echo "User may already exist; password not updated."

echo ""
echo "==> [7/17] Storing DB password in Secret Manager..."
SQL_INSTANCE_IP=$(gcloud sql instances describe "${SQL_INSTANCE}" \
  --format='value(ipAddresses[0].ipAddress)' --project="${PROJECT_ID}")
DB_URL="postgresql://${SQL_USER}:${SQL_PASSWORD}@${SQL_INSTANCE_IP}:5432/${SQL_DB}"

echo -n "${DB_URL}" | gcloud secrets create grantex-db-password \
  --replication-policy=automatic \
  --data-file=- \
  --project="${PROJECT_ID}" 2>/dev/null || \
  echo -n "${DB_URL}" | gcloud secrets versions add grantex-db-password \
    --data-file=- \
    --project="${PROJECT_ID}"

echo "    DATABASE_URL stored in Secret Manager: grantex-db-password"

echo ""
echo "==> [8/17] Creating Memorystore Redis (private, redis 7)..."
gcloud redis instances create "${REDIS_INSTANCE}" \
  --tier=BASIC \
  --size=1 \
  --region="${REGION}" \
  --redis-version=redis_7_0 \
  --connect-mode=PRIVATE_SERVICE_ACCESS \
  --network="projects/${PROJECT_ID}/global/networks/${VPC_NAME}" \
  --project="${PROJECT_ID}" || echo "Redis instance may already exist."

echo ""
echo "==> [9/17] Creating Serverless VPC Access Connector..."
gcloud compute networks vpc-access connectors create "${CONNECTOR_NAME}" \
  --network="${VPC_NAME}" \
  --region="${REGION}" \
  --range="${CONNECTOR_RANGE}" \
  --project="${PROJECT_ID}" || echo "Connector may already exist."

echo ""
echo "==> [10/17] Creating Artifact Registry repository..."
gcloud artifacts repositories create "${AR_REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" || echo "Registry may already exist."

echo ""
echo "==> [11/17] Creating Cloud Run service account..."
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="Grantex Auth Service" \
  --project="${PROJECT_ID}" || echo "Service account may already exist."

for ROLE in "roles/cloudsql.client" "roles/secretmanager.secretAccessor" "roles/artifactregistry.reader"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --quiet
done

echo ""
echo "==> [12/17] Creating placeholder secrets in Secret Manager..."
echo -n "REPLACE_ME" | gcloud secrets create grantex-rsa-private-key \
  --replication-policy=automatic \
  --data-file=- \
  --project="${PROJECT_ID}" 2>/dev/null || \
  echo "    Secret grantex-rsa-private-key already exists."

echo -n "REPLACE_ME" | gcloud secrets create grantex-stripe-secret-key \
  --replication-policy=automatic \
  --data-file=- \
  --project="${PROJECT_ID}" 2>/dev/null || \
  echo "    Secret grantex-stripe-secret-key already exists."

echo ""
echo "==> [13/17] Running DB migrations..."
REDIS_HOST=$(gcloud redis instances describe "${REDIS_INSTANCE}" \
  --region="${REGION}" \
  --format='value(host)' \
  --project="${PROJECT_ID}")
echo ""
echo "    Run migrations manually via Cloud SQL proxy:"
echo ""
echo "    cloud-sql-proxy ${PROJECT_ID}:${REGION}:${SQL_INSTANCE} &"
echo "    DATABASE_URL=postgresql://${SQL_USER}:<password>@127.0.0.1:5432/${SQL_DB} \\"
echo "      npx -y node-pg-migrate -d DATABASE_URL up"
echo ""
echo "    Or connect interactively:"
echo "    gcloud sql connect ${SQL_INSTANCE} --user=${SQL_USER} --project=${PROJECT_ID}"
echo ""
echo "    Press ENTER once migrations are complete (or skip for now)."
read -r

echo ""
echo "==> [14/17] Deploying initial Cloud Run service (placeholder image)..."
echo "    Note: First deploy uses :latest tag. GitHub Actions will update on push."

# Retrieve secret resource names
DB_SECRET_VERSION="projects/${PROJECT_ID}/secrets/grantex-db-password/versions/latest"
RSA_SECRET_VERSION="projects/${PROJECT_ID}/secrets/grantex-rsa-private-key/versions/latest"
STRIPE_SECRET_VERSION="projects/${PROJECT_ID}/secrets/grantex-stripe-secret-key/versions/latest"

gcloud run deploy "${CR_SERVICE}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --port=3001 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=1 \
  --max-instances=10 \
  --concurrency=80 \
  --service-account="${SA_EMAIL}" \
  --vpc-connector="${CONNECTOR_NAME}" \
  --vpc-egress=all-traffic \
  --set-env-vars="PORT=3001,HOST=0.0.0.0,JWT_ISSUER=https://grantex.dev,AUTO_GENERATE_KEYS=false,REDIS_URL=redis://${REDIS_HOST}:6379" \
  --set-secrets="DATABASE_URL=${DB_SECRET_VERSION},RSA_PRIVATE_KEY=${RSA_SECRET_VERSION},STRIPE_SECRET_KEY=${STRIPE_SECRET_VERSION}" \
  --allow-unauthenticated \
  --project="${PROJECT_ID}" || echo "Cloud Run deploy failed — image may not exist yet. Push a build via GitHub Actions first."

echo ""
echo "==> [15/17] Fetching Cloud Run service URL..."
CR_URL=$(gcloud run services describe "${CR_SERVICE}" \
  --region="${REGION}" \
  --format='value(status.url)' \
  --project="${PROJECT_ID}" 2>/dev/null || echo "NOT YET DEPLOYED")
echo "    Cloud Run URL: ${CR_URL}"

echo ""
echo "==> [16/17] Done provisioning."
echo ""
echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│  POST-PROVISIONING CHECKLIST                                            │"
echo "├─────────────────────────────────────────────────────────────────────────┤"
echo "│                                                                         │"
echo "│  1. Populate secrets (CRITICAL — service will not start without these): │"
echo "│     a) RSA private key:                                                 │"
echo "│        openssl genrsa -out rsa_private.pem 2048                        │"
echo "│        gcloud secrets versions add grantex-rsa-private-key \\           │"
echo "│          --data-file=rsa_private.pem --project=${PROJECT_ID}           │"
echo "│        rm rsa_private.pem                                               │"
echo "│     b) Stripe secret key (from dashboard.stripe.com):                  │"
echo "│        echo -n 'sk_live_...' | gcloud secrets versions add \\           │"
echo "│          grantex-stripe-secret-key --data-file=- --project=${PROJECT_ID}│"
echo "│                                                                         │"
echo "│  2. Run DB migrations (see step 13 above).                              │"
echo "│                                                                         │"
echo "│  3. Set up Workload Identity Federation for GitHub Actions:             │"
echo "│        bash deploy/gcp/setup-wif.sh                                    │"
echo "│                                                                         │"
echo "│  4. Push a commit touching apps/auth-service/ to trigger CI/CD.        │"
echo "│                                                                         │"
echo "│  5. Configure Firebase Hosting + DNS:                                   │"
echo "│        firebase deploy --only hosting                                   │"
echo "│        bash deploy/gcp/dns.sh                                           │"
echo "│                                                                         │"
echo "│  Cloud Run URL: ${CR_URL}                                               │"
echo "└─────────────────────────────────────────────────────────────────────────┘"
