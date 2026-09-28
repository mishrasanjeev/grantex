# Developer entry points. CI runs the same targets (.github/workflows/ci.yml, job "make").
#
#   make install   install dependencies for the packages below
#   make check     documentation integrity, vendor denylist, lint and type checks
#   make test      unit tests
#
# Scope: the core protocol packages - the Python SDK, the TypeScript SDK,
# @grantex/mcp-auth, the auth service, the agent request signing libraries
# (@grantex/agent-httpsig, grantex-agent-httpsig), the Agent Passport libraries
# (@grantex/agent-passport, grantex-agent-passport), the mock accredited
# issuer (@grantex/mock-issuer, which uses the local @grantex/agent-passport
# build) and the relying-party verifier (grantex-verifier, which uses the
# local grantex-agent-passport and grantex-agent-httpsig) - plus the
# repository-wide documentation and vendor-denylist checks and the tests of
# those scripts.
# Other packages keep their own commands (see CONTRIBUTING.md) and CI jobs.

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
PY_HTTPSIG := packages/agent-httpsig-py
TS_PACKAGES := packages/sdk-ts packages/mcp-auth apps/auth-service packages/agent-httpsig packages/agent-passport packages/mock-issuer
PY_AGENT_PASSPORT := packages/agent-passport-py
PY_VERIFIER := packages/verifier-py

.PHONY: help install check test check-docs check-denylist check-py check-ts test-py test-scripts test-ts

help:
	@echo "make install   install dependencies"
	@echo "make check     documentation integrity, vendor denylist, lint and type checks"
	@echo "make test      unit tests"

install:
	$(NPM) ci --no-audit --no-fund
	@for pkg in $(TS_PACKAGES); do \
	  echo "==> $(NPM) ci ($$pkg)"; \
	  $(NPM) --prefix "$$pkg" ci --no-audit --no-fund; \
	done
	# @grantex/mcp-auth resolves @grantex/sdk from the local build.
	$(NPM) --prefix packages/sdk-ts run build
	# @grantex/mock-issuer resolves @grantex/agent-passport from the local build.
	$(NPM) --prefix packages/agent-passport run build
	$(PYTHON) -m pip install --disable-pip-version-check -e "$(PY_SDK)[dev]" -e "$(PY_HTTPSIG)[dev]" ruff
	$(PYTHON) -m pip install --disable-pip-version-check -e "$(PY_SDK)[dev]" -e "$(PY_AGENT_PASSPORT)[dev]" ruff
	$(PYTHON) -m pip install --disable-pip-version-check -e "$(PY_AGENT_PASSPORT)" -e "$(PY_HTTPSIG)" -e "$(PY_VERIFIER)[dev]"

check: check-docs check-denylist check-py check-ts

check-docs:
	node scripts/check-docs-integrity.mjs

# Vendor names in every tracked file; house-terminology matches only warn.
# Needs Python 3.9+ and git. The Vendor Denylist workflow also scans each
# change's commit messages, branch name and pull request text.
check-denylist:
	$(PYTHON) scripts/check_denylist.py audit

check-py:
	cd $(PY_SDK) && $(PYTHON) -m ruff check src tests
	cd $(PY_SDK) && $(PYTHON) -m mypy --strict src/grantex
	cd $(PY_HTTPSIG) && $(PYTHON) -m ruff check src tests
	cd $(PY_HTTPSIG) && $(PYTHON) -m mypy --strict src
	cd $(PY_AGENT_PASSPORT) && $(PYTHON) -m ruff check src tests
	cd $(PY_AGENT_PASSPORT) && $(PYTHON) -m mypy --strict src
	cd $(PY_VERIFIER) && $(PYTHON) -m ruff check src tests
	cd $(PY_VERIFIER) && $(PYTHON) -m mypy --strict src

check-ts:
	@for pkg in $(TS_PACKAGES); do \
	  echo "==> typecheck ($$pkg)"; \
	  $(NPM) --prefix "$$pkg" run typecheck; \
	done

test: test-py test-scripts test-ts

test-py:
	cd $(PY_SDK) && $(PYTHON) -m pytest -q
	cd $(PY_HTTPSIG) && $(PYTHON) -m pytest -q
	cd $(PY_AGENT_PASSPORT) && $(PYTHON) -m pytest -q
	cd $(PY_VERIFIER) && $(PYTHON) -m pytest -q

# Tests of the repository scripts (the vendor denylist check).
test-scripts:
	$(PYTHON) -m pytest -q tests/scripts

test-ts:
	@for pkg in $(TS_PACKAGES); do \
	  echo "==> test ($$pkg)"; \
	  $(NPM) --prefix "$$pkg" test; \
	done
