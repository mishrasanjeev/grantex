#!/usr/bin/env bash
set -eu
mkdir -p /audit /results
cp -a /source/. /audit/
cd /audit/packages/go-sdk
go test -json ./... > /results/go-sdk.jsonl
go vet ./...
cd /audit/packages/terraform-provider-grantex
go test -json ./... > /results/terraform-provider.jsonl
go vet ./...
