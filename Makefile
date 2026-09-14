# Developer entry points. CI runs the same targets (.github/workflows/ci.yml, job "make").
#
#   make install   install dependencies for the packages below
#   make check     documentation integrity, lint and type checks
#   make test      unit tests
#
# Scope: the core protocol packages - the Python SDK, the TypeScript SDK,
# @grantex/mcp-auth and the auth service. Other packages keep their own
# commands (see CONTRIBUTING.md) and CI jobs.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

ifeq ($(OS),Windows_NT)
PYTHON ?= python
else
PYTHON ?= python3
endif
NPM ?= npm

PY_SDK := packages/sdk-py
TS_PACKAGES := packages/sdk-ts packages/mcp-auth apps/auth-service

.PHONY: help install check test check-docs check-py check-ts test-py test-ts

help:
	@echo "make install   install dependencies"
	@echo "make check     documentation integrity, lint and type checks"
	@echo "make test      unit tests"

install:
	$(NPM) ci --no-audit --no-fund
	@for pkg in $(TS_PACKAGES); do \
	  echo "==> $(NPM) ci ($$pkg)"; \
	  $(NPM) --prefix "$$pkg" ci --no-audit --no-fund; \
	done
	# @grantex/mcp-auth resolves @grantex/sdk from the local build.
	$(NPM) --prefix packages/sdk-ts run build
	$(PYTHON) -m pip install --disable-pip-version-check -e "$(PY_SDK)[dev]" ruff

check: check-docs check-py check-ts

check-docs:
	node scripts/check-docs-integrity.mjs

check-py:
	cd $(PY_SDK) && $(PYTHON) -m ruff check src tests
	cd $(PY_SDK) && $(PYTHON) -m mypy --strict src/grantex

check-ts:
	@for pkg in $(TS_PACKAGES); do \
	  echo "==> typecheck ($$pkg)"; \
	  $(NPM) --prefix "$$pkg" run typecheck; \
	done

test: test-py test-ts

test-py:
	cd $(PY_SDK) && $(PYTHON) -m pytest -q

test-ts:
	@for pkg in $(TS_PACKAGES); do \
	  echo "==> test ($$pkg)"; \
	  $(NPM) --prefix "$$pkg" test; \
	done
