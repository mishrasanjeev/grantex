export const PASSKEY_ENROLLMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export const PASSKEY_ENROLLMENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Register a passkey - Grantex</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #f5f7f8; color: #152329; font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(100%, 440px); padding: 28px; background: white; border: 1px solid #d9e1e2; border-radius: 8px; }
  h1 { margin: 0 0 12px; font-size: 24px; }
  p { margin: 0 0 20px; color: #43545b; }
  button { width: 100%; min-height: 44px; padding: 10px 14px; color: white; background: #115d62; border: 0; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  #status { margin: 16px 0 0; min-height: 24px; }
  #status.error { color: #a32222; }
</style>
</head>
<body>
<main>
  <h1>Register a passkey</h1>
  <p>Use the enrollment link provided by your application. Your device will ask you to create a passkey for Grantex.</p>
  <button id="register" disabled>Register passkey</button>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script>
(() => {
  const button = document.getElementById('register');
  const status = document.getElementById('status');
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
  history.replaceState(null, '', location.pathname);

  function setStatus(message, error) {
    status.textContent = message;
    status.className = error ? 'error' : '';
  }
  function decode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }
  function encode(buffer) {
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  }
  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Passkey enrollment failed.');
    return result;
  }

  if (!ticket) setStatus('This page needs a fresh enrollment link from your application.', true);
  else if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    setStatus('This browser does not support passkeys.', true);
  } else button.disabled = false;

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Follow your device prompt to create a passkey.', false);
    try {
      const options = await post('/v1/webauthn/enroll/options', { ticket });
      const publicKey = options.publicKey;
      const browserOptions = {
        ...publicKey,
        challenge: decode(publicKey.challenge),
        user: { ...publicKey.user, id: decode(publicKey.user.id) },
        excludeCredentials: (publicKey.excludeCredentials || []).map(item => ({
          ...item, id: decode(item.id),
        })),
      };
      const credential = await navigator.credentials.create({ publicKey: browserOptions });
      if (!credential) throw new Error('Passkey registration was cancelled.');
      const response = {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: encode(credential.response.clientDataJSON),
          attestationObject: encode(credential.response.attestationObject),
          transports: credential.response.getTransports?.() || [],
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      };
      const result = await post('/v1/webauthn/enroll/verify', {
        ticket, challengeId: options.challengeId, response,
      });
      setStatus('Passkey registered. Returning to consent...', false);
      if (result.returnTo && result.returnTo.startsWith('/consent?req=')) {
        location.assign(result.returnTo);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Passkey registration failed.', true);
      button.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
