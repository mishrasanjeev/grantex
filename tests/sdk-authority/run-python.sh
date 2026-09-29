#!/usr/bin/env bash
set -eu
mkdir -p /audit /results
cp -a /source/. /audit/
cd /audit
python -m pip install --disable-pip-version-check -e 'packages/sdk-py[dev]' fastapi pydantic starlette strands-agents
failed=0
for package in sdk-py crewai openai-agents google-adk strands-py fastapi a2a-py agent-passport-py agent-httpsig-py gemma-py; do
  echo "VALIDATE $package"
  cd "/audit/packages/$package"
  if ! (python -m pip install -e '.[dev]' && python -m pytest --junitxml="/results/$package.xml") >"/results/$package.log" 2>&1; then
    tail -80 "/results/$package.log"
    failed=1
  fi
done
cd /audit/packages/sdk-py
python -m mypy src/grantex
python -m ruff check src tests
cd /audit
if ! python tests/sdk-authority/verify_python.py > /results/python-authority-boundaries.log 2>&1; then
  cat /results/python-authority-boundaries.log
  failed=1
fi
exit "$failed"
