#!/usr/bin/env bash
set -eu
python -m venv /public-consumer
install_releases() {
/public-consumer/bin/python -m pip install --index-url https://pypi.org/simple \
  grantex==0.7.1 grantex-crewai==0.1.8 grantex-openai-agents==0.1.7 \
  grantex-adk==0.1.7 grantex-strands==0.2.1 grantex-fastapi==0.1.6 grantex-a2a==0.1.5 \
  pytest pytest-asyncio pytest-mock respx pg8000 redis
}
attempt=0
until install_releases; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 8 ]; then exit 1; fi
  echo 'Waiting for public-index propagation before retrying pinned releases.'
  sleep 30
done
for package in sdk-py crewai openai-agents google-adk strands-py fastapi a2a-py; do
  cd /tmp
  /public-consumer/bin/python -m pytest "/source/packages/$package/tests" --junitxml="/results/registry-$package.xml"
done
cd /tmp
/public-consumer/bin/python /source/tests/sdk-authority/verify_python.py
