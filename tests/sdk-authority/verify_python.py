"""Real signed-token/JWKS/issuer checks; optional framework objects are local doubles."""
import importlib
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import ModuleType

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from grantex import Grantex

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
jwk.update(kid="audit-key", alg="RS256", use="sig")
mode = "active"
authority_calls = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, data, status=200):
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        self.respond({"keys": [jwk]})

    def do_POST(self):
        global authority_calls
        authority_calls += 1
        assert self.path == "/v1/grants/verify"
        assert self.headers["Authorization"] == "Bearer synthetic-audit-key"
        request = json.loads(self.rfile.read(int(self.headers["content-length"])))
        claims = jwt.decode(request["token"], options={"verify_signature": False})
        if mode == "outage":
            return self.respond({}, 503)
        if mode == "revoked":
            return self.respond({"active": False})
        if mode == "malformed":
            return self.respond({"active": "false", "claims": claims})
        if mode == "principal":
            claims["sub"] = "another-human"
        if mode == "agent":
            claims["urn:grantex:grant"]["agent_did"] = "did:grantex:other"
        if mode == "tenant":
            claims["urn:grantex:grant"]["developer_id"] = "another-tenant"
        if mode == "issuer":
            claims["iss"] = "https://other-issuer.example"
        if mode == "audience":
            claims["aud"] = "other-service"
        self.respond({"active": True, "claims": claims})


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"
client = Grantex(api_key="synthetic-audit-key", base_url=base, max_retries=0)
token = jwt.encode({"iss": base, "aud": "calendar-service", "sub": "human-audit", "jti": "token-audit",
    "iat": int(time.time()), "exp": int(time.time()) + 3600, "scope": "calendar:read",
    "urn:grantex:grant": {"grant_id": "grant-audit", "agent_did": "did:grantex:agent-audit", "developer_id": "tenant-audit"}},
    key, algorithm="RS256", headers={"kid": "audit-key", "typ": "at+jwt"})
common = dict(name="calendar_read", description="Synthetic calendar read", grant_token=token,
    required_scope="calendar:read", jwks_uri=f"{base}/.well-known/jwks.json", audience="calendar-service",
    current_authority=client.grants.verify, expected_principal_id="human-audit", expected_agent_did="did:grantex:agent-audit")

# Isolate optional vendor SDK objects: these are boundary tests, not vendor-runtime certification.
agents = ModuleType("agents")
agents.function_tool = lambda function: function
sys.modules["agents"] = agents
crewai = ModuleType("crewai")
tools = ModuleType("crewai.tools")


class BaseTool:
    def run(self, **kwargs):
        return self._run(**kwargs)


tools.BaseTool = BaseTool
sys.modules["crewai"], sys.modules["crewai.tools"] = crewai, tools
checks = 0
try:
    for package in ["grantex_crewai", "grantex_openai_agents", "grantex_adk", "grantex_strands", "grantex_a2a", "grantex_fastapi"]:
        module = importlib.import_module(package)
        executions = [0]

        def execute(**kwargs):
            executions[0] += 1
            return "ok"

        mode = "active"
        if package == "grantex_a2a":
            from grantex_a2a import A2AAuthMiddlewareOptions
            options = {k: v for k, v in common.items() if k in ("jwks_uri", "audience", "current_authority", "expected_principal_id", "expected_agent_did")}
            guard = module.create_a2a_auth_middleware(A2AAuthMiddlewareOptions(**options))

            def invoke():
                guard({"authorization": f"Bearer {token}"})
                return execute()

        elif package == "grantex_fastapi":
            from starlette.requests import Request
            options = {k: v for k, v in common.items() if k in ("jwks_uri", "audience", "current_authority", "expected_principal_id", "expected_agent_did")}
            guard = module.GrantexAuth(**options)
            request = Request({"type": "http", "headers": [(b"authorization", f"Bearer {token}".encode())]})

            def invoke():
                guard._verify(request)
                return execute()

        else:
            tool = module.create_grantex_tool(**common, func=execute)
            invoke = (lambda: tool.run()) if package == "grantex_crewai" else tool
        assert invoke() == "ok"
        checks += 1
        initial = executions[0]
        before = authority_calls
        for mode in ["revoked", "outage", "malformed", "principal", "agent", "tenant", "issuer", "audience"]:
            try:
                invoke()
            except Exception:
                pass
            else:
                raise AssertionError(f"{package}: {mode} was accepted")
            assert executions[0] == initial, f"{package}: denied callback executed"
            checks += 1
        assert authority_calls - before == 8, f"{package}: authority check cached or absent"
        print(f"PASS {package}: active, revoked, outage, malformed authority, human/agent/tenant substitution")
    print(f"PASS {checks} signed-token / HTTP authority Python boundary checks")
finally:
    server.shutdown()
    server.server_close()
