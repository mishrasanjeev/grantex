import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

const helm = process.env.HELM_BIN || 'helm';
function render(...settings) {
  return parseAllDocuments(execFileSync(helm, ['template', 'synthetic', 'deploy/helm/grantex',
    '--namespace', 'fixture', '--set', 'existingSecret=synthetic-only',
    ...settings.flatMap((setting) => ['--set', setting])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    .map((document) => document.toJSON());
}

test('compatibility default emits no network policy', () => {
  const objects = render();
  assert.equal(objects.filter((object) => object.kind === 'NetworkPolicy').length, 0);
});

test('restricted profile defaults to no ingress, DNS-only egress and no automounted workload credential', () => {
  const objects = render('networkPolicy.enabled=true');
  const policy = objects.find((object) => object.kind === 'NetworkPolicy').spec;
  assert.deepEqual(policy.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(policy.ingress, []);
  assert.equal(policy.egress.length, 1);
  assert.equal(policy.egress[0].to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'kube-system');
  assert.equal(policy.egress[0].to[0].podSelector.matchLabels['k8s-app'], 'kube-dns');
  assert.deepEqual(policy.egress[0].ports.map((port) => port.port), [53, 53]);
  assert.equal(objects.find((object) => object.kind === 'Deployment').spec.template.spec.automountServiceAccountToken, false);
});

test('operator can close DNS too or explicitly open one namespace and destination/port', () => {
  const closed = render('networkPolicy.enabled=true', 'networkPolicy.allowClusterDns=false');
  assert.deepEqual(closed.find((object) => object.kind === 'NetworkPolicy').spec.egress, []);
  const objects = render('networkPolicy.enabled=true', 'networkPolicy.allowClusterDns=false',
    'networkPolicy.ingressNamespaces[0]=gateway', 'networkPolicy.allowedEgress[0].cidr=192.0.2.10/32',
    'networkPolicy.allowedEgress[0].ports[0].port=443');
  const policy = objects.find((object) => object.kind === 'NetworkPolicy').spec;
  assert.equal(policy.egress[0].to[0].ipBlock.cidr, '192.0.2.10/32');
  assert.deepEqual(policy.egress[0].ports, [{ port: 443, protocol: 'TCP' }]);
  assert.equal(policy.ingress[0].from[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'], 'gateway');
});

test('malformed flags, broad destinations, missing ports and invalid port/protocol values fail rendering', () => {
  for (const settings of [
    ['networkPolicy.enabled=not-a-boolean'],
    ['networkPolicy.allowedEgress[0].cidr=0.0.0.0/0', 'networkPolicy.allowedEgress[0].ports[0].port=443'],
    ['networkPolicy.allowedEgress[0].cidr=0:0:0:0:0:0:0:0/0', 'networkPolicy.allowedEgress[0].ports[0].port=443'],
    ['networkPolicy.allowedEgress[0].cidr=192.0.2.10/32'],
    ['networkPolicy.allowedEgress[0].cidr=192.0.2.10/32', 'networkPolicy.allowedEgress[0].ports[0].port=0'],
    ['networkPolicy.allowedEgress[0].cidr=192.0.2.10/32', 'networkPolicy.allowedEgress[0].ports[0].port=65536'],
    ['networkPolicy.allowedEgress[0].cidr=192.0.2.10/32', 'networkPolicy.allowedEgress[0].ports[0].port=443',
      'networkPolicy.allowedEgress[0].ports[0].protocol=ANY'],
  ]) assert.throws(() => render('networkPolicy.enabled=true', ...settings));
});
