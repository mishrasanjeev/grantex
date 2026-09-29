#!/usr/bin/env bash
set -eu
bash /source/tests/sdk-authority/run-python.sh
python -m pip install build 'twine>=6,<8'
mkdir -p /results/pypi
for package in sdk-py crewai openai-agents google-adk strands-py fastapi a2a-py; do
  cd "/audit/packages/$package"
  python -m mypy --strict src
  python -m build --outdir /results/pypi
done
python -m twine check /results/pypi/*
python -m venv /wheel-consumer
/wheel-consumer/bin/python -m pip install /results/pypi/*.whl pytest pytest-asyncio pytest-mock respx pg8000 redis fastapi pydantic strands-agents
for package in sdk-py crewai openai-agents google-adk strands-py fastapi a2a-py; do
  cd /tmp
  /wheel-consumer/bin/python -m pytest "/audit/packages/$package/tests" --junitxml="/results/wheel-$package.xml"
done
cd /tmp
/wheel-consumer/bin/python /audit/tests/sdk-authority/verify_python.py
