#!/usr/bin/env bash
set -eu
mkdir -p /audit /results
cp -a /source/. /audit/
python -m pip install -e '/audit/packages/sdk-py[dev]'
for package in sdk-py fastapi crewai openai-agents google-adk a2a-py; do
  cd "/audit/packages/$package"
  python -m pip install -e '.[dev]'
  python -m mypy --strict src
  python -m pytest --junitxml="/results/python39-$package.xml"
done
