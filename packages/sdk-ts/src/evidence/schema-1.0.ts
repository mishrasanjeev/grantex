// Generated from spec/evidence-package-1.0.schema.json. Do not edit by hand:
// tests/evidence-package.test.ts fails when the two differ.
export const EVIDENCE_SCHEMA_1_0: Readonly<Record<string, unknown>> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://grantex.dev/spec/evidence-package-1.0.schema.json",
  "title": "Grantex evidence package 1.0",
  "description": "Structure of a per-case evidence package. Structure alone is not verification: see spec/evidence-package.md for canonical form, the hash chain, cross-entry rules, anchoring and signatures. The verifiers in the Python and TypeScript SDKs interpret this file directly, using only the keywords listed in the specification. `format: date-time` is asserted by those verifiers (calendar-valid UTC timestamps with millisecond precision).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case",
    "chain",
    "entries",
    "format",
    "privacy",
    "version"
  ],
  "properties": {
    "anchor": {
      "$ref": "#/$defs/anchor"
    },
    "case": {
      "$ref": "#/$defs/case"
    },
    "chain": {
      "$ref": "#/$defs/chain"
    },
    "entries": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100000,
      "items": {
        "$ref": "#/$defs/entry"
      }
    },
    "format": {
      "const": "grantex-evidence-package"
    },
    "privacy": {
      "$ref": "#/$defs/privacy"
    },
    "signature": {
      "$ref": "#/$defs/signature"
    },
    "version": {
      "const": "1.0"
    }
  },
  "$defs": {
    "token": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "pattern": "^[!-~]+$"
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "digest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "auditHash": {
      "type": "string",
      "pattern": "^[0-9a-f]{64}$"
    },
    "actionHash": {
      "type": "string",
      "pattern": "^sha256:[A-Za-z0-9_-]{43}$"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$"
    },
    "uint": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "identifier": {
      "description": "A person, subject or record identifier. Where its class is not listed in privacy.disclosed it must be a pseudonym (pz:...).",
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "scalar": {
      "type": [
        "string",
        "number",
        "boolean",
        "null"
      ],
      "maxLength": 256
    },
    "ext": {
      "type": "object",
      "maxProperties": 64,
      "propertyNames": {
        "pattern": "^x-[a-z0-9-]+\\.[A-Za-z0-9_.-]+$"
      }
    },
    "tier": {
      "enum": [
        "low",
        "medium",
        "high",
        "blocked"
      ]
    },
    "case": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "case_id",
        "exported_at",
        "issuer",
        "state",
        "tenant_id"
      ],
      "properties": {
        "case_id": {
          "$ref": "#/$defs/token"
        },
        "exported_at": {
          "$ref": "#/$defs/timestamp"
        },
        "ext": {
          "$ref": "#/$defs/ext"
        },
        "issuer": {
          "$ref": "#/$defs/token"
        },
        "state": {
          "enum": [
            "open",
            "decided",
            "closed"
          ]
        },
        "subject": {
          "$ref": "#/$defs/identifier"
        },
        "tenant_id": {
          "$ref": "#/$defs/token"
        }
      }
    },
    "privacy": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "disclosed",
        "scheme"
      ],
      "properties": {
        "disclosed": {
          "type": "array",
          "maxItems": 5,
          "uniqueItems": true,
          "items": {
            "enum": [
              "approver",
              "content",
              "principal",
              "record",
              "subject"
            ]
          }
        },
        "key_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9._:-]+$"
        },
        "scheme": {
          "enum": [
            "hmac-sha256-v1",
            "none"
          ]
        }
      }
    },
    "chain": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "alg",
        "canonicalization",
        "genesis",
        "head",
        "length",
        "root"
      ],
      "properties": {
        "alg": {
          "const": "sha256"
        },
        "canonicalization": {
          "const": "RFC8785"
        },
        "genesis": {
          "$ref": "#/$defs/digest"
        },
        "head": {
          "$ref": "#/$defs/digest"
        },
        "length": {
          "$ref": "#/$defs/uint"
        },
        "root": {
          "$ref": "#/$defs/digest"
        }
      }
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "authority",
        "recorded_at"
      ],
      "properties": {
        "audit_entry_id": {
          "$ref": "#/$defs/token"
        },
        "audit_hash": {
          "$ref": "#/$defs/auditHash"
        },
        "authority": {
          "enum": [
            "platform",
            "tenant"
          ]
        },
        "late": {
          "const": true
        },
        "recorded_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    },
    "entry": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "at",
        "data",
        "hash",
        "prev",
        "seq",
        "source",
        "type"
      ],
      "properties": {
        "at": {
          "$ref": "#/$defs/timestamp"
        },
        "data": {
          "type": "object"
        },
        "ext": {
          "$ref": "#/$defs/ext"
        },
        "hash": {
          "$ref": "#/$defs/digest"
        },
        "prev": {
          "$ref": "#/$defs/digest"
        },
        "seq": {
          "$ref": "#/$defs/uint"
        },
        "source": {
          "$ref": "#/$defs/source"
        },
        "type": {
          "enum": [
            "decision",
            "decision_consumption",
            "disposition",
            "grant",
            "policy_evaluation",
            "recommendation",
            "revocation",
            "run_context",
            "tool_call",
            "void"
          ]
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                "const": "grant"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/grant"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "run_context"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/runContext"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "tool_call"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/toolCall"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "policy_evaluation"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/policyEvaluation"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "recommendation"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/recommendation"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "decision"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/decision"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "decision_consumption"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/decisionConsumption"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "revocation"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/revocation"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "disposition"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/disposition"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "type": {
                "const": "void"
              }
            }
          },
          "then": {
            "properties": {
              "data": {
                "$ref": "#/$defs/void"
              }
            }
          }
        }
      ]
    },
    "toolsAuthorization": {
      "type": "object",
      "required": [
        "type"
      ],
      "properties": {
        "caps": {
          "type": "object",
          "maxProperties": 256,
          "additionalProperties": {
            "type": "object",
            "maxProperties": 16,
            "additionalProperties": {
              "$ref": "#/$defs/uint"
            }
          }
        },
        "connector": {
          "$ref": "#/$defs/token"
        },
        "data_region": {
          "$ref": "#/$defs/token"
        },
        "purpose": {
          "$ref": "#/$defs/token"
        },
        "tools": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/token"
          }
        },
        "type": {
          "$ref": "#/$defs/token"
        }
      }
    },
    "grant": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "agent_id",
        "authorization_details",
        "depth",
        "expires_at",
        "grant_id",
        "issued_at",
        "parent_grant_id",
        "principal",
        "purpose",
        "revoked_at",
        "scopes",
        "status"
      ],
      "properties": {
        "agent_id": {
          "$ref": "#/$defs/token"
        },
        "authorization_details": {
          "type": "array",
          "maxItems": 32,
          "items": {
            "$ref": "#/$defs/toolsAuthorization"
          }
        },
        "depth": {
          "type": "integer",
          "minimum": 0,
          "maximum": 32
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "grant_id": {
          "$ref": "#/$defs/token"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "parent_grant_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1,
          "maxLength": 256,
          "pattern": "^[!-~]+$"
        },
        "principal": {
          "$ref": "#/$defs/identifier"
        },
        "purpose": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1,
          "maxLength": 256,
          "pattern": "^[!-~]+$"
        },
        "revoked_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$"
        },
        "scopes": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/token"
          }
        },
        "status": {
          "enum": [
            "active",
            "revoked",
            "expired"
          ]
        }
      }
    },
    "versionRef": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "digest",
        "id",
        "version"
      ],
      "properties": {
        "digest": {
          "$ref": "#/$defs/digest"
        },
        "id": {
          "$ref": "#/$defs/token"
        },
        "version": {
          "$ref": "#/$defs/token"
        }
      }
    },
    "runContext": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "agent_id",
        "model",
        "policies",
        "prompts",
        "run_id",
        "schemas"
      ],
      "properties": {
        "agent_id": {
          "$ref": "#/$defs/token"
        },
        "model": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "name",
            "provider",
            "version"
          ],
          "properties": {
            "name": {
              "$ref": "#/$defs/token"
            },
            "provider": {
              "$ref": "#/$defs/token"
            },
            "version": {
              "$ref": "#/$defs/token"
            }
          }
        },
        "policies": {
          "type": "array",
          "maxItems": 16,
          "items": {
            "$ref": "#/$defs/versionRef"
          }
        },
        "prompts": {
          "type": "array",
          "maxItems": 64,
          "items": {
            "$ref": "#/$defs/versionRef"
          }
        },
        "run_id": {
          "$ref": "#/$defs/token"
        },
        "schemas": {
          "type": "array",
          "maxItems": 64,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "version"
            ],
            "properties": {
              "id": {
                "$ref": "#/$defs/token"
              },
              "version": {
                "$ref": "#/$defs/token"
              }
            }
          }
        }
      }
    },
    "upstreamRecord": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "record_id",
        "retrieved_at"
      ],
      "properties": {
        "record_id": {
          "$ref": "#/$defs/identifier"
        },
        "record_type": {
          "$ref": "#/$defs/token"
        },
        "retrieved_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    },
    "toolCall": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "call_id",
        "connector",
        "grant_id",
        "input_hash",
        "outcome",
        "output_hash",
        "provider",
        "purpose",
        "started_at",
        "tool",
        "upstream_records"
      ],
      "properties": {
        "call_id": {
          "$ref": "#/$defs/token"
        },
        "completed_at": {
          "$ref": "#/$defs/timestamp"
        },
        "connector": {
          "$ref": "#/$defs/token"
        },
        "cost_units": {
          "$ref": "#/$defs/uint"
        },
        "denial": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "reason"
          ],
          "properties": {
            "reason": {
              "$ref": "#/$defs/token"
            },
            "sub_reason": {
              "$ref": "#/$defs/token"
            }
          }
        },
        "grant_id": {
          "$ref": "#/$defs/token"
        },
        "input_hash": {
          "$ref": "#/$defs/contentHash"
        },
        "outcome": {
          "enum": [
            "allowed",
            "denied",
            "error"
          ]
        },
        "output_hash": {
          "type": [
            "string",
            "null"
          ],
          "pattern": "^(sha256|hmac-sha256):[0-9a-f]{64}$"
        },
        "provider": {
          "$ref": "#/$defs/token"
        },
        "purpose": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1,
          "maxLength": 256,
          "pattern": "^[!-~]+$"
        },
        "run_id": {
          "$ref": "#/$defs/token"
        },
        "started_at": {
          "$ref": "#/$defs/timestamp"
        },
        "tool": {
          "$ref": "#/$defs/token"
        },
        "upstream_records": {
          "type": "array",
          "maxItems": 1024,
          "items": {
            "$ref": "#/$defs/upstreamRecord"
          }
        }
      }
    },
    "evidenceRef": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "call_id",
        "provider",
        "record_id",
        "retrieved_at"
      ],
      "properties": {
        "call_id": {
          "$ref": "#/$defs/token"
        },
        "excerpt_ref": {
          "$ref": "#/$defs/identifier"
        },
        "field": {
          "$ref": "#/$defs/token"
        },
        "provider": {
          "$ref": "#/$defs/token"
        },
        "record_id": {
          "$ref": "#/$defs/identifier"
        },
        "retrieved_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    },
    "policyEvaluation": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "evaluation_id",
        "fired_rules",
        "inputs",
        "policy",
        "score",
        "tier"
      ],
      "properties": {
        "evaluation_id": {
          "$ref": "#/$defs/token"
        },
        "fired_rules": {
          "type": "array",
          "maxItems": 1024,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "reason_code",
              "rule_id",
              "tier"
            ],
            "properties": {
              "reason_code": {
                "$ref": "#/$defs/token"
              },
              "reason_digest": {
                "$ref": "#/$defs/digest"
              },
              "rule_id": {
                "$ref": "#/$defs/token"
              },
              "tier": {
                "$ref": "#/$defs/tier"
              }
            }
          }
        },
        "inputs": {
          "type": "array",
          "maxItems": 4096,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "evidence",
              "path",
              "value"
            ],
            "properties": {
              "evidence": {
                "type": "array",
                "maxItems": 256,
                "items": {
                  "$ref": "#/$defs/evidenceRef"
                }
              },
              "path": {
                "$ref": "#/$defs/token"
              },
              "unsourced": {
                "const": true
              },
              "value": {
                "$ref": "#/$defs/scalar"
              }
            }
          }
        },
        "policy": {
          "$ref": "#/$defs/versionRef"
        },
        "run_id": {
          "$ref": "#/$defs/token"
        },
        "score": {
          "type": "number",
          "minimum": -1000000000,
          "maximum": 1000000000
        },
        "tier": {
          "$ref": "#/$defs/tier"
        }
      }
    },
    "recommendation": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "evaluation_ids",
        "memo_digest",
        "outcome",
        "recommendation_id",
        "sections"
      ],
      "properties": {
        "evaluation_ids": {
          "type": "array",
          "minItems": 1,
          "maxItems": 64,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/token"
          }
        },
        "memo_digest": {
          "$ref": "#/$defs/digest"
        },
        "missing_items": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "$ref": "#/$defs/token"
          }
        },
        "outcome": {
          "enum": [
            "approve",
            "decline",
            "refer",
            "request_information"
          ]
        },
        "recommendation_id": {
          "$ref": "#/$defs/token"
        },
        "run_id": {
          "$ref": "#/$defs/token"
        },
        "sections": {
          "type": "array",
          "minItems": 1,
          "maxItems": 256,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "evidence",
              "section",
              "status"
            ],
            "properties": {
              "evidence": {
                "type": "array",
                "maxItems": 1024,
                "items": {
                  "$ref": "#/$defs/evidenceRef"
                }
              },
              "section": {
                "$ref": "#/$defs/token"
              },
              "status": {
                "enum": [
                  "complete",
                  "issues_found",
                  "not_available"
                ]
              }
            }
          }
        }
      }
    },
    "decision": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "action",
        "approval_position",
        "approvals_required",
        "approver",
        "approver_auth",
        "dwell_ms",
        "expires_at",
        "issued_at",
        "issuer",
        "jti"
      ],
      "properties": {
        "action": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "case_id",
            "decision",
            "subject"
          ],
          "properties": {
            "action": {
              "$ref": "#/$defs/token"
            },
            "amount": {
              "type": [
                "number",
                "string"
              ],
              "minLength": 1,
              "maxLength": 64,
              "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$"
            },
            "case_id": {
              "$ref": "#/$defs/token"
            },
            "decision": {
              "$ref": "#/$defs/token"
            },
            "subject": {
              "$ref": "#/$defs/identifier"
            }
          }
        },
        "action_hash": {
          "$ref": "#/$defs/actionHash"
        },
        "action_ref": {
          "$ref": "#/$defs/actionRef"
        },
        "approval_position": {
          "enum": [
            1,
            2
          ]
        },
        "approvals_required": {
          "enum": [
            1,
            2
          ]
        },
        "approver": {
          "$ref": "#/$defs/identifier"
        },
        "approver_auth": {
          "$ref": "#/$defs/token"
        },
        "dwell_ms": {
          "$ref": "#/$defs/uint"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "first_jti": {
          "$ref": "#/$defs/token"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "issuer": {
          "$ref": "#/$defs/token"
        },
        "jti": {
          "$ref": "#/$defs/token"
        },
        "request_id": {
          "$ref": "#/$defs/token"
        }
      }
    },
    "decisionConsumption": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "consumed_at",
        "jtis"
      ],
      "properties": {
        "action_hash": {
          "$ref": "#/$defs/actionHash"
        },
        "action_ref": {
          "$ref": "#/$defs/actionRef"
        },
        "call_id": {
          "$ref": "#/$defs/token"
        },
        "consumed_at": {
          "$ref": "#/$defs/timestamp"
        },
        "jtis": {
          "type": "array",
          "minItems": 1,
          "maxItems": 2,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/token"
          }
        }
      }
    },
    "revocation": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "grant_id",
        "revoked_at"
      ],
      "properties": {
        "cascade": {
          "type": "boolean"
        },
        "event_id": {
          "$ref": "#/$defs/token"
        },
        "grant_id": {
          "$ref": "#/$defs/token"
        },
        "reason": {
          "$ref": "#/$defs/token"
        },
        "revoked_at": {
          "$ref": "#/$defs/timestamp"
        },
        "trigger": {
          "enum": [
            "admin",
            "api",
            "cascade",
            "event",
            "expiry"
          ]
        }
      }
    },
    "anchor": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "audit_entry",
        "type"
      ],
      "properties": {
        "audit_entry": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "agentDid",
            "agentId",
            "developerId",
            "grantId",
            "hash",
            "id",
            "metadata",
            "prevHash",
            "principalId",
            "status",
            "timestamp"
          ],
          "properties": {
            "action": {
              "const": "evidence.package_exported"
            },
            "agentDid": {
              "const": ""
            },
            "agentId": {
              "const": ""
            },
            "developerId": {
              "$ref": "#/$defs/token"
            },
            "grantId": {
              "const": ""
            },
            "hash": {
              "$ref": "#/$defs/auditHash"
            },
            "id": {
              "$ref": "#/$defs/token"
            },
            "metadata": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "case_id",
                "entry_count",
                "format",
                "grantex:platform",
                "package_root",
                "version"
              ],
              "properties": {
                "case_id": {
                  "$ref": "#/$defs/token"
                },
                "entry_count": {
                  "$ref": "#/$defs/uint"
                },
                "format": {
                  "const": "grantex-evidence-package"
                },
                "grantex:platform": {
                  "const": true
                },
                "package_root": {
                  "$ref": "#/$defs/digest"
                },
                "version": {
                  "const": "1.0"
                }
              }
            },
            "prevHash": {
              "type": [
                "string",
                "null"
              ],
              "pattern": "^[0-9a-f]{64}$"
            },
            "principalId": {
              "const": "platform"
            },
            "status": {
              "const": "success"
            },
            "timestamp": {
              "$ref": "#/$defs/timestamp"
            }
          }
        },
        "type": {
          "const": "grantex-audit-entry"
        }
      }
    },
    "signature": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "alg",
        "jws",
        "kid"
      ],
      "properties": {
        "alg": {
          "enum": [
            "ES256",
            "RS256"
          ]
        },
        "jws": {
          "type": "string",
          "maxLength": 4096,
          "pattern": "^[A-Za-z0-9_-]+\\.\\.[A-Za-z0-9_-]+$"
        },
        "kid": {
          "$ref": "#/$defs/token"
        }
      }
    },
    "contentHash": {
      "type": "string",
      "pattern": "^(sha256|hmac-sha256):[0-9a-f]{64}$"
    },
    "actionRef": {
      "type": "string",
      "pattern": "^ak:[A-Za-z0-9_-]{43}$"
    },
    "disposition": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "comparisons",
        "confidence_band",
        "disposition_id",
        "hit",
        "outcome",
        "rationale_digest"
      ],
      "properties": {
        "comparisons": {
          "type": "array",
          "maxItems": 64,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "evidence",
              "identifier",
              "result"
            ],
            "properties": {
              "evidence": {
                "type": "array",
                "maxItems": 256,
                "items": {
                  "$ref": "#/$defs/evidenceRef"
                }
              },
              "identifier": {
                "enum": [
                  "address",
                  "associated_entities",
                  "date_of_birth",
                  "name",
                  "nationality",
                  "registration_number"
                ]
              },
              "result": {
                "enum": [
                  "match",
                  "mismatch",
                  "not_available",
                  "partial"
                ]
              }
            }
          }
        },
        "confidence_band": {
          "enum": [
            "high",
            "low",
            "medium"
          ]
        },
        "disposition_id": {
          "$ref": "#/$defs/token"
        },
        "hit": {
          "$ref": "#/$defs/evidenceRef"
        },
        "outcome": {
          "enum": [
            "escalate",
            "false_positive",
            "inconclusive",
            "true_match"
          ]
        },
        "rationale_digest": {
          "$ref": "#/$defs/digest"
        },
        "run_id": {
          "$ref": "#/$defs/token"
        }
      }
    },
    "void": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason_code",
        "target_id",
        "target_type",
        "voided_at"
      ],
      "properties": {
        "reason_code": {
          "$ref": "#/$defs/token"
        },
        "target_id": {
          "$ref": "#/$defs/token"
        },
        "target_type": {
          "enum": [
            "disposition",
            "policy_evaluation",
            "recommendation",
            "run_context",
            "tool_call"
          ]
        },
        "voided_at": {
          "$ref": "#/$defs/timestamp"
        }
      }
    }
  }
};
