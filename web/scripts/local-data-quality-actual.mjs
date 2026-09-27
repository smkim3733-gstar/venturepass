import { createHash } from "node:crypto";
import { z } from "zod";
// Frozen archive format 1 schemas; parity-checked against TypeScript contracts.
export const actualArchiveJsonSchemas = {
  actualLedgerArtifactKeySchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "string",
    enum: [
      "generation-request",
      "generation-response",
      "generation-validated",
      "review-request",
      "review-response",
      "review-validated",
      "final-result",
    ],
  },
  actualLedgerArtifactSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      runId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      key: {
        type: "string",
        enum: [
          "generation-request",
          "generation-response",
          "generation-validated",
          "review-request",
          "review-response",
          "review-validated",
          "final-result",
        ],
      },
      body: {
        type: "string",
      },
      sha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      sizeBytes: {
        type: "integer",
        minimum: 0,
        maximum: 8388608,
      },
    },
    required: ["runId", "key", "body", "sha256", "sizeBytes"],
    additionalProperties: false,
  },
  actualLedgerArtifactRefSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      runId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      key: {
        type: "string",
        enum: [
          "generation-request",
          "generation-response",
          "generation-validated",
          "review-request",
          "review-response",
          "review-validated",
          "final-result",
        ],
      },
      sha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      sizeBytes: {
        type: "integer",
        minimum: 0,
        maximum: 8388608,
      },
    },
    required: ["runId", "key", "sha256", "sizeBytes"],
    additionalProperties: false,
  },
  actualLedgerPolicySchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      provenance: {
        type: "string",
        const: "synthetic-test",
      },
      currency: {
        type: "string",
        pattern: "^[A-Z]{3}$",
      },
      unitScale: {
        type: "integer",
        minimum: 0,
        maximum: 12,
      },
      capUnits: {
        type: "string",
        pattern: "^(0|[1-9]\\d{0,79})$",
      },
    },
    required: ["provenance", "currency", "unitScale", "capUnits"],
    additionalProperties: false,
  },
  actualLedgerApprovalSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      provenance: {
        type: "string",
        const: "synthetic-test",
      },
      approvedPreparationDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      acknowledgedSyntheticOnly: {
        type: "boolean",
        const: true,
      },
      approvedAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
      },
    },
    required: [
      "provenance",
      "approvedPreparationDigest",
      "acknowledgedSyntheticOnly",
      "approvedAt",
    ],
    additionalProperties: false,
  },
  actualLedgerStartSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      clientRequestId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      expectedBudgetRevision: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
      },
      expectedBudgetDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      expectedActualRunCount: {
        type: "integer",
        minimum: 0,
        maximum: 19,
      },
      preparation: {
        type: "object",
        properties: {
          schemaVersion: {
            type: "number",
            const: 1,
          },
          kind: {
            type: "string",
            const: "actual-ai-preparation-inspection",
          },
          environment: {
            type: "string",
            enum: ["production", "synthetic-test"],
          },
          preparedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          scope: {
            type: "object",
            properties: {
              setId: {
                type: "string",
                const: "ai-validation-candidates",
              },
              version: {
                type: "integer",
                minimum: 1,
                maximum: 20,
              },
              versionDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              registrySourceDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              manifestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              candidateId: {
                type: "string",
                maxLength: 120,
                pattern: "^validation-candidate-[a-z0-9-]+$",
              },
              label: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              sourceDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              candidateDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              modelInputDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "setId",
              "version",
              "versionDigest",
              "registrySourceDigest",
              "manifestDigest",
              "candidateId",
              "label",
              "sourceDigest",
              "candidateDigest",
              "modelInputDigest",
            ],
            additionalProperties: false,
          },
          model: {
            anyOf: [
              {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
              },
              {
                type: "null",
              },
            ],
          },
          provider: {
            type: "string",
            const: "OpenAI",
          },
          destination: {
            type: "string",
            const: "https://api.openai.com/v1",
          },
          purpose: {
            type: "string",
            const: "synthetic-candidate-generation-and-review",
          },
          engine: {
            type: "object",
            properties: {
              schemaVersion: {
                type: "number",
                const: 1,
              },
              engineVersion: {
                type: "string",
                const: "plan-observation-v1",
              },
              provider: {
                type: "string",
                const: "OpenAI",
              },
              endpoint: {
                type: "string",
                const: "https://api.openai.com/v1",
              },
              maxCalls: {
                type: "number",
                const: 2,
              },
              maxInputChars: {
                type: "number",
                const: 240000,
              },
              maxOutputTokens: {
                type: "number",
                const: 16000,
              },
              timeoutMs: {
                type: "number",
                const: 120000,
              },
              maxRetries: {
                type: "number",
                const: 0,
              },
              store: {
                type: "boolean",
                const: false,
              },
              repair: {
                type: "boolean",
                const: false,
              },
              phases: {
                minItems: 2,
                maxItems: 2,
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    phase: {
                      type: "string",
                      enum: ["generation", "review"],
                    },
                    name: {
                      type: "string",
                      minLength: 1,
                    },
                    systemDigest: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                    instructionDigest: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                    schemaDigest: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                  },
                  required: ["phase", "name", "systemDigest", "instructionDigest", "schemaDigest"],
                  additionalProperties: false,
                },
              },
              contractDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "schemaVersion",
              "engineVersion",
              "provider",
              "endpoint",
              "maxCalls",
              "maxInputChars",
              "maxOutputTokens",
              "timeoutMs",
              "maxRetries",
              "store",
              "repair",
              "phases",
              "contractDigest",
            ],
            additionalProperties: false,
          },
          requestEvidence: {
            anyOf: [
              {
                type: "object",
                properties: {
                  generation: {
                    type: "object",
                    properties: {
                      phase: {
                        type: "string",
                        const: "generation",
                      },
                      body: {
                        type: "object",
                        properties: {
                          model: {
                            type: "string",
                            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                          },
                          store: {
                            type: "boolean",
                            const: false,
                          },
                          max_output_tokens: {
                            type: "number",
                            const: 16000,
                          },
                          input: {
                            type: "array",
                            prefixItems: [
                              {
                                type: "object",
                                properties: {
                                  role: {
                                    type: "string",
                                    const: "system",
                                  },
                                  content: {
                                    type: "string",
                                  },
                                },
                                required: ["role", "content"],
                                additionalProperties: false,
                              },
                              {
                                type: "object",
                                properties: {
                                  role: {
                                    type: "string",
                                    const: "user",
                                  },
                                  content: {
                                    type: "string",
                                  },
                                },
                                required: ["role", "content"],
                                additionalProperties: false,
                              },
                            ],
                            items: false,
                            minItems: 2,
                            maxItems: 2,
                          },
                          text: {
                            type: "object",
                            properties: {
                              format: {
                                type: "object",
                                properties: {
                                  type: {
                                    type: "string",
                                    const: "json_schema",
                                  },
                                  name: {
                                    type: "string",
                                    minLength: 1,
                                  },
                                  strict: {
                                    type: "boolean",
                                    const: true,
                                  },
                                  schema: {
                                    type: "object",
                                    propertyNames: {
                                      type: "string",
                                    },
                                    additionalProperties: {
                                      $ref: "#/$defs/__schema0",
                                    },
                                  },
                                },
                                required: ["type", "name", "strict", "schema"],
                                additionalProperties: false,
                              },
                            },
                            required: ["format"],
                            additionalProperties: false,
                          },
                        },
                        required: ["model", "store", "max_output_tokens", "input", "text"],
                        additionalProperties: false,
                      },
                      requestDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      inputChars: {
                        type: "integer",
                        minimum: 0,
                        maximum: 240000,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: ["phase", "body", "requestDigest", "inputChars", "contractDigest"],
                    additionalProperties: false,
                  },
                  reviewTemplate: {
                    type: "object",
                    properties: {
                      schemaVersion: {
                        type: "number",
                        const: 1,
                      },
                      phase: {
                        type: "string",
                        const: "review",
                      },
                      complete: {
                        type: "boolean",
                        const: false,
                      },
                      model: {
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                      },
                      store: {
                        type: "boolean",
                        const: false,
                      },
                      max_output_tokens: {
                        type: "number",
                        const: 16000,
                      },
                      systemMessage: {
                        type: "object",
                        properties: {
                          role: {
                            type: "string",
                            const: "system",
                          },
                          content: {
                            type: "string",
                          },
                        },
                        required: ["role", "content"],
                        additionalProperties: false,
                      },
                      format: {
                        type: "object",
                        properties: {
                          type: {
                            type: "string",
                            const: "json_schema",
                          },
                          name: {
                            type: "string",
                            minLength: 1,
                          },
                          strict: {
                            type: "boolean",
                            const: true,
                          },
                          schema: {
                            type: "object",
                            propertyNames: {
                              type: "string",
                            },
                            additionalProperties: {
                              $ref: "#/$defs/__schema0",
                            },
                          },
                        },
                        required: ["type", "name", "strict", "schema"],
                        additionalProperties: false,
                      },
                      fixedUserContext: {
                        type: "object",
                        propertyNames: {
                          type: "string",
                        },
                        additionalProperties: {
                          $ref: "#/$defs/__schema1",
                        },
                      },
                      draftSlot: {
                        type: "object",
                        properties: {
                          jsonPath: {
                            type: "string",
                            const: "$.draft",
                          },
                          rule: {
                            type: "string",
                            const: "this-run-validated-generation-only",
                          },
                          requiresValidatedEventBinding: {
                            type: "boolean",
                            const: true,
                          },
                        },
                        required: ["jsonPath", "rule", "requiresValidatedEventBinding"],
                        additionalProperties: false,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      templateDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: [
                      "schemaVersion",
                      "phase",
                      "complete",
                      "model",
                      "store",
                      "max_output_tokens",
                      "systemMessage",
                      "format",
                      "fixedUserContext",
                      "draftSlot",
                      "contractDigest",
                      "templateDigest",
                    ],
                    additionalProperties: false,
                  },
                  evidenceDigest: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                },
                required: ["generation", "reviewTemplate", "evidenceDigest"],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
          evidence: {
            type: "object",
            properties: {
              price: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      provenance: {
                        type: "string",
                        enum: ["official-reviewed", "synthetic-test"],
                      },
                      provider: {
                        type: "string",
                        const: "OpenAI",
                      },
                      endpoint: {
                        type: "string",
                        const: "https://api.openai.com/v1",
                      },
                      model: {
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                      },
                      authority: {
                        type: "object",
                        properties: {
                          sourceUrl: {
                            type: "string",
                            format: "uri",
                          },
                          documentDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          retrievedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validFrom: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validUntil: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewerId: {
                            type: "string",
                            minLength: 1,
                            maxLength: 200,
                          },
                          excerpt: {
                            type: "string",
                            minLength: 1,
                            maxLength: 10000,
                          },
                          applicability: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                          validityPolicy: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                        },
                        required: [
                          "sourceUrl",
                          "documentDigest",
                          "retrievedAt",
                          "reviewedAt",
                          "validFrom",
                          "validUntil",
                          "reviewerId",
                          "excerpt",
                          "applicability",
                          "validityPolicy",
                        ],
                        additionalProperties: false,
                      },
                      currency: {
                        type: "string",
                        pattern: "^[A-Z]{3}$",
                      },
                      unitScale: {
                        type: "integer",
                        minimum: 0,
                        maximum: 12,
                      },
                      inputRate: {
                        type: "object",
                        properties: {
                          units: {
                            type: "string",
                            pattern: "^(0|[1-9]\\d{0,39})$",
                          },
                          perTokens: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                        },
                        required: ["units", "perTokens"],
                        additionalProperties: false,
                      },
                      outputRate: {
                        type: "object",
                        properties: {
                          units: {
                            type: "string",
                            pattern: "^(0|[1-9]\\d{0,39})$",
                          },
                          perTokens: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                        },
                        required: ["units", "perTokens"],
                        additionalProperties: false,
                      },
                      cachePolicy: {
                        type: "string",
                        const: "undiscounted",
                      },
                      outputCoverage: {
                        type: "string",
                        const: "all-output-including-reasoning",
                      },
                      additionalCharges: {
                        oneOf: [
                          {
                            type: "object",
                            properties: {
                              kind: {
                                type: "string",
                                const: "none-verified",
                              },
                            },
                            required: ["kind"],
                            additionalProperties: false,
                          },
                          {
                            type: "object",
                            properties: {
                              kind: {
                                type: "string",
                                const: "bounded-per-request",
                              },
                              units: {
                                type: "string",
                                pattern: "^(0|[1-9]\\d{0,39})$",
                              },
                            },
                            required: ["kind", "units"],
                            additionalProperties: false,
                          },
                        ],
                      },
                    },
                    required: [
                      "provenance",
                      "provider",
                      "endpoint",
                      "model",
                      "authority",
                      "currency",
                      "unitScale",
                      "inputRate",
                      "outputRate",
                      "cachePolicy",
                      "outputCoverage",
                      "additionalCharges",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              tokens: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      provenance: {
                        type: "string",
                        enum: ["model-tokenizer-reviewed", "synthetic-test"],
                      },
                      provider: {
                        type: "string",
                        const: "OpenAI",
                      },
                      endpoint: {
                        type: "string",
                        const: "https://api.openai.com/v1",
                      },
                      model: {
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                      },
                      authority: {
                        type: "object",
                        properties: {
                          sourceUrl: {
                            type: "string",
                            format: "uri",
                          },
                          documentDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          retrievedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validFrom: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validUntil: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewerId: {
                            type: "string",
                            minLength: 1,
                            maxLength: 200,
                          },
                          excerpt: {
                            type: "string",
                            minLength: 1,
                            maxLength: 10000,
                          },
                          applicability: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                          validityPolicy: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                        },
                        required: [
                          "sourceUrl",
                          "documentDigest",
                          "retrievedAt",
                          "reviewedAt",
                          "validFrom",
                          "validUntil",
                          "reviewerId",
                          "excerpt",
                          "applicability",
                          "validityPolicy",
                        ],
                        additionalProperties: false,
                      },
                      tokenizerId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                      tokenizerVersion: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      coverage: {
                        type: "object",
                        properties: {
                          system: {
                            type: "boolean",
                            const: true,
                          },
                          user: {
                            type: "boolean",
                            const: true,
                          },
                          structuredOutputSchema: {
                            type: "boolean",
                            const: true,
                          },
                          messageFraming: {
                            type: "boolean",
                            const: true,
                          },
                          providerOverhead: {
                            type: "boolean",
                            const: true,
                          },
                        },
                        required: [
                          "system",
                          "user",
                          "structuredOutputSchema",
                          "messageFraming",
                          "providerOverhead",
                        ],
                        additionalProperties: false,
                      },
                      assurance: {
                        type: "string",
                        const: "entire-request-upper-bound",
                      },
                      generation: {
                        type: "object",
                        properties: {
                          requestDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          inputUpperBound: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                        },
                        required: ["requestDigest", "inputUpperBound"],
                        additionalProperties: false,
                      },
                      review: {
                        type: "object",
                        properties: {
                          templateDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          inputUpperBound: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                          includesMaxGeneratedDraftTokens: {
                            type: "number",
                            const: 16000,
                          },
                          includesDraftSerialization: {
                            type: "boolean",
                            const: true,
                          },
                          derivation: {
                            type: "string",
                            const: "this-run-validated-generation-only",
                          },
                        },
                        required: [
                          "templateDigest",
                          "inputUpperBound",
                          "includesMaxGeneratedDraftTokens",
                          "includesDraftSerialization",
                          "derivation",
                        ],
                        additionalProperties: false,
                      },
                      maxInputTokens: {
                        type: "integer",
                        exclusiveMinimum: 0,
                        maximum: 9007199254740991,
                      },
                      maxOutputTokens: {
                        type: "integer",
                        exclusiveMinimum: 0,
                        maximum: 9007199254740991,
                      },
                      contextWindowTokens: {
                        type: "integer",
                        exclusiveMinimum: 0,
                        maximum: 9007199254740991,
                      },
                    },
                    required: [
                      "provenance",
                      "provider",
                      "endpoint",
                      "model",
                      "authority",
                      "tokenizerId",
                      "tokenizerVersion",
                      "contractDigest",
                      "coverage",
                      "assurance",
                      "generation",
                      "review",
                      "maxInputTokens",
                      "maxOutputTokens",
                      "contextWindowTokens",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              budget: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      provenance: {
                        type: "string",
                        enum: ["reviewed-budget", "synthetic-test"],
                      },
                      currency: {
                        type: "string",
                        pattern: "^[A-Z]{3}$",
                      },
                      unitScale: {
                        type: "integer",
                        minimum: 0,
                        maximum: 12,
                      },
                      capUnits: {
                        type: "string",
                        pattern: "^(0|[1-9]\\d{0,39})$",
                      },
                      unsettledUnits: {
                        type: "string",
                        pattern: "^(0|[1-9]\\d{0,39})$",
                      },
                      observedAt: {
                        type: "string",
                        format: "date-time",
                        pattern:
                          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                      },
                      validUntil: {
                        type: "string",
                        format: "date-time",
                        pattern:
                          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                      },
                      scope: {
                        type: "string",
                        const: "candidate-quality-executions",
                      },
                      ledgerDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: [
                      "provenance",
                      "currency",
                      "unitScale",
                      "capUnits",
                      "unsettledUnits",
                      "observedAt",
                      "validUntil",
                      "scope",
                      "ledgerDigest",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
            },
            required: ["price", "tokens", "budget"],
            additionalProperties: false,
          },
          costs: {
            anyOf: [
              {
                type: "object",
                properties: {
                  currency: {
                    type: "string",
                    pattern: "^[A-Z]{3}$",
                  },
                  unitScale: {
                    type: "integer",
                    minimum: 0,
                    maximum: 12,
                  },
                  generationUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,79})$",
                  },
                  reviewUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,79})$",
                  },
                  unsettledUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,39})$",
                  },
                  totalUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,79})$",
                  },
                  budgetUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,39})$",
                  },
                  rounding: {
                    type: "string",
                    const: "ceil-each-rate-per-request",
                  },
                  meaning: {
                    type: "string",
                    const: "unreserved-upper-bound-not-a-bill",
                  },
                },
                required: [
                  "currency",
                  "unitScale",
                  "generationUnits",
                  "reviewUnits",
                  "unsettledUnits",
                  "totalUnits",
                  "budgetUnits",
                  "rounding",
                  "meaning",
                ],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
          readiness: {
            type: "string",
            enum: ["blocked", "calculation-ready"],
          },
          blockers: {
            maxItems: 30,
            type: "array",
            items: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  enum: [
                    "MODEL_NOT_SELECTED",
                    "PRICE_NOT_CONFIGURED",
                    "PRICE_INVALID",
                    "PRICE_SCOPE_MISMATCH",
                    "PRICE_OUTDATED",
                    "TOKEN_BOUND_NOT_CONFIGURED",
                    "TOKEN_BOUND_INVALID",
                    "TOKEN_SCOPE_MISMATCH",
                    "TOKEN_EVIDENCE_OUTDATED",
                    "TOKEN_LIMIT_EXCEEDED",
                    "BUDGET_NOT_CONFIGURED",
                    "BUDGET_INVALID",
                    "BUDGET_SCOPE_MISMATCH",
                    "BUDGET_EXCEEDED",
                    "SYNTHETIC_EVIDENCE_FORBIDDEN",
                  ],
                },
                message: {
                  type: "string",
                  minLength: 1,
                  maxLength: 500,
                },
              },
              required: ["code", "message"],
              additionalProperties: false,
            },
          },
          executionBlocks: {
            type: "array",
            prefixItems: [
              {
                type: "string",
                const: "이번 준비 조회는 실행 승인을 기록하지 않습니다.",
              },
              {
                type: "string",
                const: "비용 예약과 실제 실행 경로가 연결되지 않았습니다.",
              },
            ],
            items: false,
            minItems: 2,
            maxItems: 2,
          },
          executionAllowed: {
            type: "boolean",
            const: false,
          },
          approvalRecorded: {
            type: "boolean",
            const: false,
          },
          reservationRecorded: {
            type: "boolean",
            const: false,
          },
          humanAnswerKey: {
            type: "null",
          },
          independentHoldoutConfirmed: {
            type: "boolean",
            const: false,
          },
          performanceEvaluation: {
            type: "string",
            const: "not-performed",
          },
          preparationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
        },
        required: [
          "schemaVersion",
          "kind",
          "environment",
          "preparedAt",
          "scope",
          "model",
          "provider",
          "destination",
          "purpose",
          "engine",
          "requestEvidence",
          "evidence",
          "costs",
          "readiness",
          "blockers",
          "executionBlocks",
          "executionAllowed",
          "approvalRecorded",
          "reservationRecorded",
          "humanAnswerKey",
          "independentHoldoutConfirmed",
          "performanceEvaluation",
          "preparationDigest",
        ],
        additionalProperties: false,
      },
      approval: {
        type: "object",
        properties: {
          provenance: {
            type: "string",
            const: "synthetic-test",
          },
          approvedPreparationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          acknowledgedSyntheticOnly: {
            type: "boolean",
            const: true,
          },
          approvedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
        },
        required: [
          "provenance",
          "approvedPreparationDigest",
          "acknowledgedSyntheticOnly",
          "approvedAt",
        ],
        additionalProperties: false,
      },
    },
    required: [
      "clientRequestId",
      "expectedBudgetRevision",
      "expectedBudgetDigest",
      "expectedActualRunCount",
      "preparation",
      "approval",
    ],
    additionalProperties: false,
    $defs: {
      __schema0: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema0",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema0",
            },
          },
        ],
      },
      __schema1: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema1",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema1",
            },
          },
        ],
      },
    },
  },
  actualLedgerBudgetPayloadSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "configure",
          },
          capUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
        },
        required: ["kind", "capUnits"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "reserve-run",
          },
          runId: {
            type: "string",
            format: "uuid",
            pattern:
              "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          },
          preparationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          generationUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
          reviewUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
        },
        required: ["kind", "runId", "preparationDigest", "generationUnits", "reviewUnits"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "recognize-usage",
          },
          runId: {
            type: "string",
            format: "uuid",
            pattern:
              "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          },
          phase: {
            type: "string",
            enum: ["generation", "review"],
          },
          reservationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          requestDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          responseArtifactSha256: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          recognizedUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
          consumedReservedUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
          unusedReleasedUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
          boundExcessUnits: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
          tokenBoundBreached: {
            type: "boolean",
          },
        },
        required: [
          "kind",
          "runId",
          "phase",
          "reservationDigest",
          "requestDigest",
          "responseArtifactSha256",
          "recognizedUnits",
          "consumedReservedUnits",
          "unusedReleasedUnits",
          "boundExcessUnits",
          "tokenBoundBreached",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "release-unused",
          },
          runId: {
            type: "string",
            format: "uuid",
            pattern:
              "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          },
          phase: {
            type: "string",
            enum: ["generation", "review"],
          },
          reservationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          units: {
            type: "string",
            pattern: "^(0|[1-9]\\d{0,79})$",
          },
          reason: {
            type: "string",
            const: "not-dispatched",
          },
        },
        required: ["kind", "runId", "phase", "reservationDigest", "units", "reason"],
        additionalProperties: false,
      },
    ],
  },
  actualLedgerBudgetEventSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      scopeId: {
        type: "string",
        const: "candidate-quality-executions",
      },
      revision: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
      },
      previousDigest: {
        anyOf: [
          {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          {
            type: "null",
          },
        ],
      },
      eventId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      recordedAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
      },
      provenance: {
        type: "string",
        const: "synthetic-test",
      },
      currency: {
        type: "string",
        pattern: "^[A-Z]{3}$",
      },
      unitScale: {
        type: "integer",
        minimum: 0,
        maximum: 12,
      },
      payload: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "configure",
              },
              capUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
            },
            required: ["kind", "capUnits"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "reserve-run",
              },
              runId: {
                type: "string",
                format: "uuid",
                pattern:
                  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              },
              preparationDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              generationUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
              reviewUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
            },
            required: ["kind", "runId", "preparationDigest", "generationUnits", "reviewUnits"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "recognize-usage",
              },
              runId: {
                type: "string",
                format: "uuid",
                pattern:
                  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              },
              phase: {
                type: "string",
                enum: ["generation", "review"],
              },
              reservationDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              requestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              responseArtifactSha256: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              recognizedUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
              consumedReservedUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
              unusedReleasedUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
              boundExcessUnits: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
              tokenBoundBreached: {
                type: "boolean",
              },
            },
            required: [
              "kind",
              "runId",
              "phase",
              "reservationDigest",
              "requestDigest",
              "responseArtifactSha256",
              "recognizedUnits",
              "consumedReservedUnits",
              "unusedReleasedUnits",
              "boundExcessUnits",
              "tokenBoundBreached",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "release-unused",
              },
              runId: {
                type: "string",
                format: "uuid",
                pattern:
                  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              },
              phase: {
                type: "string",
                enum: ["generation", "review"],
              },
              reservationDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              units: {
                type: "string",
                pattern: "^(0|[1-9]\\d{0,79})$",
              },
              reason: {
                type: "string",
                const: "not-dispatched",
              },
            },
            required: ["kind", "runId", "phase", "reservationDigest", "units", "reason"],
            additionalProperties: false,
          },
        ],
      },
      eventDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
    required: [
      "scopeId",
      "revision",
      "previousDigest",
      "eventId",
      "recordedAt",
      "provenance",
      "currency",
      "unitScale",
      "payload",
      "eventDigest",
    ],
    additionalProperties: false,
  },
  actualLedgerRunSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      schemaVersion: {
        type: "number",
        const: 1,
      },
      archiveFormatVersion: {
        type: "number",
        const: 1,
      },
      id: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      clientRequestId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      inputDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      recordedAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
      },
      executionKind: {
        type: "string",
        const: "actual-ledger-simulation",
      },
      environment: {
        type: "string",
        const: "synthetic-test",
      },
      observedTransport: {
        type: "string",
        const: "synthetic-adapter",
      },
      actualAiCalls: {
        type: "number",
        const: 0,
      },
      preparation: {
        type: "object",
        properties: {
          schemaVersion: {
            type: "number",
            const: 1,
          },
          kind: {
            type: "string",
            const: "actual-ai-preparation-inspection",
          },
          environment: {
            type: "string",
            enum: ["production", "synthetic-test"],
          },
          preparedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
          scope: {
            type: "object",
            properties: {
              setId: {
                type: "string",
                const: "ai-validation-candidates",
              },
              version: {
                type: "integer",
                minimum: 1,
                maximum: 20,
              },
              versionDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              registrySourceDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              manifestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              candidateId: {
                type: "string",
                maxLength: 120,
                pattern: "^validation-candidate-[a-z0-9-]+$",
              },
              label: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              sourceDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              candidateDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              modelInputDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "setId",
              "version",
              "versionDigest",
              "registrySourceDigest",
              "manifestDigest",
              "candidateId",
              "label",
              "sourceDigest",
              "candidateDigest",
              "modelInputDigest",
            ],
            additionalProperties: false,
          },
          model: {
            anyOf: [
              {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
              },
              {
                type: "null",
              },
            ],
          },
          provider: {
            type: "string",
            const: "OpenAI",
          },
          destination: {
            type: "string",
            const: "https://api.openai.com/v1",
          },
          purpose: {
            type: "string",
            const: "synthetic-candidate-generation-and-review",
          },
          engine: {
            type: "object",
            properties: {
              schemaVersion: {
                type: "number",
                const: 1,
              },
              engineVersion: {
                type: "string",
                const: "plan-observation-v1",
              },
              provider: {
                type: "string",
                const: "OpenAI",
              },
              endpoint: {
                type: "string",
                const: "https://api.openai.com/v1",
              },
              maxCalls: {
                type: "number",
                const: 2,
              },
              maxInputChars: {
                type: "number",
                const: 240000,
              },
              maxOutputTokens: {
                type: "number",
                const: 16000,
              },
              timeoutMs: {
                type: "number",
                const: 120000,
              },
              maxRetries: {
                type: "number",
                const: 0,
              },
              store: {
                type: "boolean",
                const: false,
              },
              repair: {
                type: "boolean",
                const: false,
              },
              phases: {
                minItems: 2,
                maxItems: 2,
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    phase: {
                      type: "string",
                      enum: ["generation", "review"],
                    },
                    name: {
                      type: "string",
                      minLength: 1,
                    },
                    systemDigest: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                    instructionDigest: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                    schemaDigest: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                  },
                  required: ["phase", "name", "systemDigest", "instructionDigest", "schemaDigest"],
                  additionalProperties: false,
                },
              },
              contractDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "schemaVersion",
              "engineVersion",
              "provider",
              "endpoint",
              "maxCalls",
              "maxInputChars",
              "maxOutputTokens",
              "timeoutMs",
              "maxRetries",
              "store",
              "repair",
              "phases",
              "contractDigest",
            ],
            additionalProperties: false,
          },
          requestEvidence: {
            anyOf: [
              {
                type: "object",
                properties: {
                  generation: {
                    type: "object",
                    properties: {
                      phase: {
                        type: "string",
                        const: "generation",
                      },
                      body: {
                        type: "object",
                        properties: {
                          model: {
                            type: "string",
                            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                          },
                          store: {
                            type: "boolean",
                            const: false,
                          },
                          max_output_tokens: {
                            type: "number",
                            const: 16000,
                          },
                          input: {
                            type: "array",
                            prefixItems: [
                              {
                                type: "object",
                                properties: {
                                  role: {
                                    type: "string",
                                    const: "system",
                                  },
                                  content: {
                                    type: "string",
                                  },
                                },
                                required: ["role", "content"],
                                additionalProperties: false,
                              },
                              {
                                type: "object",
                                properties: {
                                  role: {
                                    type: "string",
                                    const: "user",
                                  },
                                  content: {
                                    type: "string",
                                  },
                                },
                                required: ["role", "content"],
                                additionalProperties: false,
                              },
                            ],
                            items: false,
                            minItems: 2,
                            maxItems: 2,
                          },
                          text: {
                            type: "object",
                            properties: {
                              format: {
                                type: "object",
                                properties: {
                                  type: {
                                    type: "string",
                                    const: "json_schema",
                                  },
                                  name: {
                                    type: "string",
                                    minLength: 1,
                                  },
                                  strict: {
                                    type: "boolean",
                                    const: true,
                                  },
                                  schema: {
                                    type: "object",
                                    propertyNames: {
                                      type: "string",
                                    },
                                    additionalProperties: {
                                      $ref: "#/$defs/__schema0",
                                    },
                                  },
                                },
                                required: ["type", "name", "strict", "schema"],
                                additionalProperties: false,
                              },
                            },
                            required: ["format"],
                            additionalProperties: false,
                          },
                        },
                        required: ["model", "store", "max_output_tokens", "input", "text"],
                        additionalProperties: false,
                      },
                      requestDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      inputChars: {
                        type: "integer",
                        minimum: 0,
                        maximum: 240000,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: ["phase", "body", "requestDigest", "inputChars", "contractDigest"],
                    additionalProperties: false,
                  },
                  reviewTemplate: {
                    type: "object",
                    properties: {
                      schemaVersion: {
                        type: "number",
                        const: 1,
                      },
                      phase: {
                        type: "string",
                        const: "review",
                      },
                      complete: {
                        type: "boolean",
                        const: false,
                      },
                      model: {
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                      },
                      store: {
                        type: "boolean",
                        const: false,
                      },
                      max_output_tokens: {
                        type: "number",
                        const: 16000,
                      },
                      systemMessage: {
                        type: "object",
                        properties: {
                          role: {
                            type: "string",
                            const: "system",
                          },
                          content: {
                            type: "string",
                          },
                        },
                        required: ["role", "content"],
                        additionalProperties: false,
                      },
                      format: {
                        type: "object",
                        properties: {
                          type: {
                            type: "string",
                            const: "json_schema",
                          },
                          name: {
                            type: "string",
                            minLength: 1,
                          },
                          strict: {
                            type: "boolean",
                            const: true,
                          },
                          schema: {
                            type: "object",
                            propertyNames: {
                              type: "string",
                            },
                            additionalProperties: {
                              $ref: "#/$defs/__schema0",
                            },
                          },
                        },
                        required: ["type", "name", "strict", "schema"],
                        additionalProperties: false,
                      },
                      fixedUserContext: {
                        type: "object",
                        propertyNames: {
                          type: "string",
                        },
                        additionalProperties: {
                          $ref: "#/$defs/__schema1",
                        },
                      },
                      draftSlot: {
                        type: "object",
                        properties: {
                          jsonPath: {
                            type: "string",
                            const: "$.draft",
                          },
                          rule: {
                            type: "string",
                            const: "this-run-validated-generation-only",
                          },
                          requiresValidatedEventBinding: {
                            type: "boolean",
                            const: true,
                          },
                        },
                        required: ["jsonPath", "rule", "requiresValidatedEventBinding"],
                        additionalProperties: false,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      templateDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: [
                      "schemaVersion",
                      "phase",
                      "complete",
                      "model",
                      "store",
                      "max_output_tokens",
                      "systemMessage",
                      "format",
                      "fixedUserContext",
                      "draftSlot",
                      "contractDigest",
                      "templateDigest",
                    ],
                    additionalProperties: false,
                  },
                  evidenceDigest: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                },
                required: ["generation", "reviewTemplate", "evidenceDigest"],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
          evidence: {
            type: "object",
            properties: {
              price: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      provenance: {
                        type: "string",
                        enum: ["official-reviewed", "synthetic-test"],
                      },
                      provider: {
                        type: "string",
                        const: "OpenAI",
                      },
                      endpoint: {
                        type: "string",
                        const: "https://api.openai.com/v1",
                      },
                      model: {
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                      },
                      authority: {
                        type: "object",
                        properties: {
                          sourceUrl: {
                            type: "string",
                            format: "uri",
                          },
                          documentDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          retrievedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validFrom: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validUntil: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewerId: {
                            type: "string",
                            minLength: 1,
                            maxLength: 200,
                          },
                          excerpt: {
                            type: "string",
                            minLength: 1,
                            maxLength: 10000,
                          },
                          applicability: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                          validityPolicy: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                        },
                        required: [
                          "sourceUrl",
                          "documentDigest",
                          "retrievedAt",
                          "reviewedAt",
                          "validFrom",
                          "validUntil",
                          "reviewerId",
                          "excerpt",
                          "applicability",
                          "validityPolicy",
                        ],
                        additionalProperties: false,
                      },
                      currency: {
                        type: "string",
                        pattern: "^[A-Z]{3}$",
                      },
                      unitScale: {
                        type: "integer",
                        minimum: 0,
                        maximum: 12,
                      },
                      inputRate: {
                        type: "object",
                        properties: {
                          units: {
                            type: "string",
                            pattern: "^(0|[1-9]\\d{0,39})$",
                          },
                          perTokens: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                        },
                        required: ["units", "perTokens"],
                        additionalProperties: false,
                      },
                      outputRate: {
                        type: "object",
                        properties: {
                          units: {
                            type: "string",
                            pattern: "^(0|[1-9]\\d{0,39})$",
                          },
                          perTokens: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                        },
                        required: ["units", "perTokens"],
                        additionalProperties: false,
                      },
                      cachePolicy: {
                        type: "string",
                        const: "undiscounted",
                      },
                      outputCoverage: {
                        type: "string",
                        const: "all-output-including-reasoning",
                      },
                      additionalCharges: {
                        oneOf: [
                          {
                            type: "object",
                            properties: {
                              kind: {
                                type: "string",
                                const: "none-verified",
                              },
                            },
                            required: ["kind"],
                            additionalProperties: false,
                          },
                          {
                            type: "object",
                            properties: {
                              kind: {
                                type: "string",
                                const: "bounded-per-request",
                              },
                              units: {
                                type: "string",
                                pattern: "^(0|[1-9]\\d{0,39})$",
                              },
                            },
                            required: ["kind", "units"],
                            additionalProperties: false,
                          },
                        ],
                      },
                    },
                    required: [
                      "provenance",
                      "provider",
                      "endpoint",
                      "model",
                      "authority",
                      "currency",
                      "unitScale",
                      "inputRate",
                      "outputRate",
                      "cachePolicy",
                      "outputCoverage",
                      "additionalCharges",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              tokens: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      provenance: {
                        type: "string",
                        enum: ["model-tokenizer-reviewed", "synthetic-test"],
                      },
                      provider: {
                        type: "string",
                        const: "OpenAI",
                      },
                      endpoint: {
                        type: "string",
                        const: "https://api.openai.com/v1",
                      },
                      model: {
                        type: "string",
                        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
                      },
                      authority: {
                        type: "object",
                        properties: {
                          sourceUrl: {
                            type: "string",
                            format: "uri",
                          },
                          documentDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          retrievedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewedAt: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validFrom: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          validUntil: {
                            type: "string",
                            format: "date-time",
                            pattern:
                              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                          },
                          reviewerId: {
                            type: "string",
                            minLength: 1,
                            maxLength: 200,
                          },
                          excerpt: {
                            type: "string",
                            minLength: 1,
                            maxLength: 10000,
                          },
                          applicability: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                          validityPolicy: {
                            type: "string",
                            minLength: 1,
                            maxLength: 2000,
                          },
                        },
                        required: [
                          "sourceUrl",
                          "documentDigest",
                          "retrievedAt",
                          "reviewedAt",
                          "validFrom",
                          "validUntil",
                          "reviewerId",
                          "excerpt",
                          "applicability",
                          "validityPolicy",
                        ],
                        additionalProperties: false,
                      },
                      tokenizerId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                      tokenizerVersion: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      coverage: {
                        type: "object",
                        properties: {
                          system: {
                            type: "boolean",
                            const: true,
                          },
                          user: {
                            type: "boolean",
                            const: true,
                          },
                          structuredOutputSchema: {
                            type: "boolean",
                            const: true,
                          },
                          messageFraming: {
                            type: "boolean",
                            const: true,
                          },
                          providerOverhead: {
                            type: "boolean",
                            const: true,
                          },
                        },
                        required: [
                          "system",
                          "user",
                          "structuredOutputSchema",
                          "messageFraming",
                          "providerOverhead",
                        ],
                        additionalProperties: false,
                      },
                      assurance: {
                        type: "string",
                        const: "entire-request-upper-bound",
                      },
                      generation: {
                        type: "object",
                        properties: {
                          requestDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          inputUpperBound: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                        },
                        required: ["requestDigest", "inputUpperBound"],
                        additionalProperties: false,
                      },
                      review: {
                        type: "object",
                        properties: {
                          templateDigest: {
                            type: "string",
                            pattern: "^[a-f0-9]{64}$",
                          },
                          inputUpperBound: {
                            type: "integer",
                            exclusiveMinimum: 0,
                            maximum: 9007199254740991,
                          },
                          includesMaxGeneratedDraftTokens: {
                            type: "number",
                            const: 16000,
                          },
                          includesDraftSerialization: {
                            type: "boolean",
                            const: true,
                          },
                          derivation: {
                            type: "string",
                            const: "this-run-validated-generation-only",
                          },
                        },
                        required: [
                          "templateDigest",
                          "inputUpperBound",
                          "includesMaxGeneratedDraftTokens",
                          "includesDraftSerialization",
                          "derivation",
                        ],
                        additionalProperties: false,
                      },
                      maxInputTokens: {
                        type: "integer",
                        exclusiveMinimum: 0,
                        maximum: 9007199254740991,
                      },
                      maxOutputTokens: {
                        type: "integer",
                        exclusiveMinimum: 0,
                        maximum: 9007199254740991,
                      },
                      contextWindowTokens: {
                        type: "integer",
                        exclusiveMinimum: 0,
                        maximum: 9007199254740991,
                      },
                    },
                    required: [
                      "provenance",
                      "provider",
                      "endpoint",
                      "model",
                      "authority",
                      "tokenizerId",
                      "tokenizerVersion",
                      "contractDigest",
                      "coverage",
                      "assurance",
                      "generation",
                      "review",
                      "maxInputTokens",
                      "maxOutputTokens",
                      "contextWindowTokens",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              budget: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      provenance: {
                        type: "string",
                        enum: ["reviewed-budget", "synthetic-test"],
                      },
                      currency: {
                        type: "string",
                        pattern: "^[A-Z]{3}$",
                      },
                      unitScale: {
                        type: "integer",
                        minimum: 0,
                        maximum: 12,
                      },
                      capUnits: {
                        type: "string",
                        pattern: "^(0|[1-9]\\d{0,39})$",
                      },
                      unsettledUnits: {
                        type: "string",
                        pattern: "^(0|[1-9]\\d{0,39})$",
                      },
                      observedAt: {
                        type: "string",
                        format: "date-time",
                        pattern:
                          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                      },
                      validUntil: {
                        type: "string",
                        format: "date-time",
                        pattern:
                          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
                      },
                      scope: {
                        type: "string",
                        const: "candidate-quality-executions",
                      },
                      ledgerDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: [
                      "provenance",
                      "currency",
                      "unitScale",
                      "capUnits",
                      "unsettledUnits",
                      "observedAt",
                      "validUntil",
                      "scope",
                      "ledgerDigest",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
            },
            required: ["price", "tokens", "budget"],
            additionalProperties: false,
          },
          costs: {
            anyOf: [
              {
                type: "object",
                properties: {
                  currency: {
                    type: "string",
                    pattern: "^[A-Z]{3}$",
                  },
                  unitScale: {
                    type: "integer",
                    minimum: 0,
                    maximum: 12,
                  },
                  generationUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,79})$",
                  },
                  reviewUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,79})$",
                  },
                  unsettledUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,39})$",
                  },
                  totalUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,79})$",
                  },
                  budgetUnits: {
                    type: "string",
                    pattern: "^(0|[1-9]\\d{0,39})$",
                  },
                  rounding: {
                    type: "string",
                    const: "ceil-each-rate-per-request",
                  },
                  meaning: {
                    type: "string",
                    const: "unreserved-upper-bound-not-a-bill",
                  },
                },
                required: [
                  "currency",
                  "unitScale",
                  "generationUnits",
                  "reviewUnits",
                  "unsettledUnits",
                  "totalUnits",
                  "budgetUnits",
                  "rounding",
                  "meaning",
                ],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
          readiness: {
            type: "string",
            enum: ["blocked", "calculation-ready"],
          },
          blockers: {
            maxItems: 30,
            type: "array",
            items: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  enum: [
                    "MODEL_NOT_SELECTED",
                    "PRICE_NOT_CONFIGURED",
                    "PRICE_INVALID",
                    "PRICE_SCOPE_MISMATCH",
                    "PRICE_OUTDATED",
                    "TOKEN_BOUND_NOT_CONFIGURED",
                    "TOKEN_BOUND_INVALID",
                    "TOKEN_SCOPE_MISMATCH",
                    "TOKEN_EVIDENCE_OUTDATED",
                    "TOKEN_LIMIT_EXCEEDED",
                    "BUDGET_NOT_CONFIGURED",
                    "BUDGET_INVALID",
                    "BUDGET_SCOPE_MISMATCH",
                    "BUDGET_EXCEEDED",
                    "SYNTHETIC_EVIDENCE_FORBIDDEN",
                  ],
                },
                message: {
                  type: "string",
                  minLength: 1,
                  maxLength: 500,
                },
              },
              required: ["code", "message"],
              additionalProperties: false,
            },
          },
          executionBlocks: {
            type: "array",
            prefixItems: [
              {
                type: "string",
                const: "이번 준비 조회는 실행 승인을 기록하지 않습니다.",
              },
              {
                type: "string",
                const: "비용 예약과 실제 실행 경로가 연결되지 않았습니다.",
              },
            ],
            items: false,
            minItems: 2,
            maxItems: 2,
          },
          executionAllowed: {
            type: "boolean",
            const: false,
          },
          approvalRecorded: {
            type: "boolean",
            const: false,
          },
          reservationRecorded: {
            type: "boolean",
            const: false,
          },
          humanAnswerKey: {
            type: "null",
          },
          independentHoldoutConfirmed: {
            type: "boolean",
            const: false,
          },
          performanceEvaluation: {
            type: "string",
            const: "not-performed",
          },
          preparationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
        },
        required: [
          "schemaVersion",
          "kind",
          "environment",
          "preparedAt",
          "scope",
          "model",
          "provider",
          "destination",
          "purpose",
          "engine",
          "requestEvidence",
          "evidence",
          "costs",
          "readiness",
          "blockers",
          "executionBlocks",
          "executionAllowed",
          "approvalRecorded",
          "reservationRecorded",
          "humanAnswerKey",
          "independentHoldoutConfirmed",
          "performanceEvaluation",
          "preparationDigest",
        ],
        additionalProperties: false,
      },
      approval: {
        type: "object",
        properties: {
          provenance: {
            type: "string",
            const: "synthetic-test",
          },
          approvedPreparationDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          acknowledgedSyntheticOnly: {
            type: "boolean",
            const: true,
          },
          approvedAt: {
            type: "string",
            format: "date-time",
            pattern:
              "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
          },
        },
        required: [
          "provenance",
          "approvedPreparationDigest",
          "acknowledgedSyntheticOnly",
          "approvedAt",
        ],
        additionalProperties: false,
      },
      expectedBudgetRevision: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
      },
      expectedBudgetDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      expectedActualRunCount: {
        type: "integer",
        minimum: 0,
        maximum: 19,
      },
      reservedBudgetRevision: {
        type: "integer",
        minimum: 2,
        maximum: 1000,
      },
      reservationDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      storageReservationBytes: {
        type: "number",
        const: 33554432,
      },
      reservedSlots: {
        type: "object",
        properties: {
          events: {
            type: "number",
            const: 32,
          },
          budgetEvents: {
            type: "number",
            const: 16,
          },
          receipts: {
            type: "number",
            const: 64,
          },
        },
        required: ["events", "budgetEvents", "receipts"],
        additionalProperties: false,
      },
      runDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
    required: [
      "schemaVersion",
      "archiveFormatVersion",
      "id",
      "clientRequestId",
      "inputDigest",
      "recordedAt",
      "executionKind",
      "environment",
      "observedTransport",
      "actualAiCalls",
      "preparation",
      "approval",
      "expectedBudgetRevision",
      "expectedBudgetDigest",
      "expectedActualRunCount",
      "reservedBudgetRevision",
      "reservationDigest",
      "storageReservationBytes",
      "reservedSlots",
      "runDigest",
    ],
    additionalProperties: false,
    $defs: {
      __schema0: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema0",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema0",
            },
          },
        ],
      },
      __schema1: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema1",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema1",
            },
          },
        ],
      },
    },
  },
  actualLedgerRunPayloadSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "request-prepared",
          },
          phase: {
            type: "string",
            enum: ["generation", "review"],
          },
          requestDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          artifactSha256: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          inputTokenUpperBound: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9007199254740991,
          },
          derivedFrom: {
            anyOf: [
              {
                type: "object",
                properties: {
                  generationEventDigest: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                  artifactSha256: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                },
                required: ["generationEventDigest", "artifactSha256"],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
          budgetRevision: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
          },
          budgetDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
        },
        required: [
          "kind",
          "phase",
          "requestDigest",
          "artifactSha256",
          "inputTokenUpperBound",
          "derivedFrom",
          "budgetRevision",
          "budgetDigest",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "dispatch-intent",
          },
          phase: {
            type: "string",
            enum: ["generation", "review"],
          },
          requestDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          preparedEventDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          artifactSha256: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          budgetRevision: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
          },
          budgetDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
        },
        required: [
          "kind",
          "phase",
          "requestDigest",
          "preparedEventDigest",
          "artifactSha256",
          "budgetRevision",
          "budgetDigest",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "response-received",
          },
          phase: {
            type: "string",
            enum: ["generation", "review"],
          },
          requestDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          dispatchEventDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          artifactSha256: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          metadata: {
            type: "object",
            properties: {
              request: {
                type: "object",
                properties: {
                  phase: {
                    type: "string",
                    enum: ["generation", "review"],
                  },
                  sequence: {
                    anyOf: [
                      {
                        type: "number",
                        const: 1,
                      },
                      {
                        type: "number",
                        const: 2,
                      },
                    ],
                  },
                  mode: {
                    type: "string",
                    enum: ["mock", "actual-ai"],
                  },
                  provider: {
                    type: "string",
                    enum: ["mock", "OpenAI"],
                  },
                  configuredModel: {
                    type: "string",
                    minLength: 1,
                    maxLength: 200,
                  },
                  contractDigest: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                  requestDigest: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                  inputChars: {
                    type: "integer",
                    minimum: 0,
                    maximum: 240000,
                  },
                  maxOutputTokens: {
                    type: "number",
                    const: 16000,
                  },
                },
                required: [
                  "phase",
                  "sequence",
                  "mode",
                  "provider",
                  "configuredModel",
                  "contractDigest",
                  "requestDigest",
                  "inputChars",
                  "maxOutputTokens",
                ],
                additionalProperties: false,
              },
              responseId: {
                anyOf: [
                  {
                    type: "string",
                    maxLength: 500,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              requestId: {
                anyOf: [
                  {
                    type: "string",
                    maxLength: 500,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              responseModel: {
                anyOf: [
                  {
                    type: "string",
                    maxLength: 200,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              status: {
                anyOf: [
                  {
                    type: "string",
                    maxLength: 100,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              usage: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      inputTokens: {
                        type: "integer",
                        minimum: 0,
                        maximum: 9007199254740991,
                      },
                      outputTokens: {
                        type: "integer",
                        minimum: 0,
                        maximum: 9007199254740991,
                      },
                      totalTokens: {
                        type: "integer",
                        minimum: 0,
                        maximum: 9007199254740991,
                      },
                      cachedInputTokens: {
                        anyOf: [
                          {
                            type: "integer",
                            minimum: 0,
                            maximum: 9007199254740991,
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                      reasoningOutputTokens: {
                        anyOf: [
                          {
                            type: "integer",
                            minimum: 0,
                            maximum: 9007199254740991,
                          },
                          {
                            type: "null",
                          },
                        ],
                      },
                    },
                    required: [
                      "inputTokens",
                      "outputTokens",
                      "totalTokens",
                      "cachedInputTokens",
                      "reasoningOutputTokens",
                    ],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
            },
            required: ["request", "responseId", "requestId", "responseModel", "status", "usage"],
            additionalProperties: false,
          },
          usageBudgetEventDigest: {
            anyOf: [
              {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: [
          "kind",
          "phase",
          "requestDigest",
          "dispatchEventDigest",
          "artifactSha256",
          "metadata",
          "usageBudgetEventDigest",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "domain-validated",
          },
          phase: {
            type: "string",
            enum: ["generation", "review"],
          },
          requestDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          responseEventDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          artifactSha256: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          outputDigest: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
        },
        required: [
          "kind",
          "phase",
          "requestDigest",
          "responseEventDigest",
          "artifactSha256",
          "outputDigest",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "execution-stopped",
          },
          outcome: {
            type: "string",
            enum: [
              "completed",
              "before-dispatch",
              "result-unobserved",
              "needs-cost-review",
              "output-invalid",
              "bound-breached",
            ],
          },
          failureCode: {
            anyOf: [
              {
                type: "string",
                enum: [
                  "INTERRUPTED",
                  "STORAGE_FAILED",
                  "OUTPUT_INVALID",
                  "COST_UNSETTLED",
                  "BOUND_BREACHED",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          finalArtifactSha256: {
            anyOf: [
              {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              {
                type: "null",
              },
            ],
          },
          releasedBudgetEventDigests: {
            maxItems: 2,
            type: "array",
            items: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
            },
          },
        },
        required: [
          "kind",
          "outcome",
          "failureCode",
          "finalArtifactSha256",
          "releasedBudgetEventDigests",
        ],
        additionalProperties: false,
      },
    ],
  },
  actualLedgerRunEventSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      runId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      revision: {
        type: "integer",
        minimum: 1,
        maximum: 32,
      },
      previousEventDigest: {
        anyOf: [
          {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
          },
          {
            type: "null",
          },
        ],
      },
      recordedAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
      },
      payload: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "request-prepared",
              },
              phase: {
                type: "string",
                enum: ["generation", "review"],
              },
              requestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              artifactSha256: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              inputTokenUpperBound: {
                type: "integer",
                exclusiveMinimum: 0,
                maximum: 9007199254740991,
              },
              derivedFrom: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      generationEventDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      artifactSha256: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                    },
                    required: ["generationEventDigest", "artifactSha256"],
                    additionalProperties: false,
                  },
                  {
                    type: "null",
                  },
                ],
              },
              budgetRevision: {
                type: "integer",
                minimum: 1,
                maximum: 1000,
              },
              budgetDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "kind",
              "phase",
              "requestDigest",
              "artifactSha256",
              "inputTokenUpperBound",
              "derivedFrom",
              "budgetRevision",
              "budgetDigest",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "dispatch-intent",
              },
              phase: {
                type: "string",
                enum: ["generation", "review"],
              },
              requestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              preparedEventDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              artifactSha256: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              budgetRevision: {
                type: "integer",
                minimum: 1,
                maximum: 1000,
              },
              budgetDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "kind",
              "phase",
              "requestDigest",
              "preparedEventDigest",
              "artifactSha256",
              "budgetRevision",
              "budgetDigest",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "response-received",
              },
              phase: {
                type: "string",
                enum: ["generation", "review"],
              },
              requestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              dispatchEventDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              artifactSha256: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              metadata: {
                type: "object",
                properties: {
                  request: {
                    type: "object",
                    properties: {
                      phase: {
                        type: "string",
                        enum: ["generation", "review"],
                      },
                      sequence: {
                        anyOf: [
                          {
                            type: "number",
                            const: 1,
                          },
                          {
                            type: "number",
                            const: 2,
                          },
                        ],
                      },
                      mode: {
                        type: "string",
                        enum: ["mock", "actual-ai"],
                      },
                      provider: {
                        type: "string",
                        enum: ["mock", "OpenAI"],
                      },
                      configuredModel: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                      },
                      contractDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      requestDigest: {
                        type: "string",
                        pattern: "^[a-f0-9]{64}$",
                      },
                      inputChars: {
                        type: "integer",
                        minimum: 0,
                        maximum: 240000,
                      },
                      maxOutputTokens: {
                        type: "number",
                        const: 16000,
                      },
                    },
                    required: [
                      "phase",
                      "sequence",
                      "mode",
                      "provider",
                      "configuredModel",
                      "contractDigest",
                      "requestDigest",
                      "inputChars",
                      "maxOutputTokens",
                    ],
                    additionalProperties: false,
                  },
                  responseId: {
                    anyOf: [
                      {
                        type: "string",
                        maxLength: 500,
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  requestId: {
                    anyOf: [
                      {
                        type: "string",
                        maxLength: 500,
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  responseModel: {
                    anyOf: [
                      {
                        type: "string",
                        maxLength: 200,
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  status: {
                    anyOf: [
                      {
                        type: "string",
                        maxLength: 100,
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  usage: {
                    anyOf: [
                      {
                        type: "object",
                        properties: {
                          inputTokens: {
                            type: "integer",
                            minimum: 0,
                            maximum: 9007199254740991,
                          },
                          outputTokens: {
                            type: "integer",
                            minimum: 0,
                            maximum: 9007199254740991,
                          },
                          totalTokens: {
                            type: "integer",
                            minimum: 0,
                            maximum: 9007199254740991,
                          },
                          cachedInputTokens: {
                            anyOf: [
                              {
                                type: "integer",
                                minimum: 0,
                                maximum: 9007199254740991,
                              },
                              {
                                type: "null",
                              },
                            ],
                          },
                          reasoningOutputTokens: {
                            anyOf: [
                              {
                                type: "integer",
                                minimum: 0,
                                maximum: 9007199254740991,
                              },
                              {
                                type: "null",
                              },
                            ],
                          },
                        },
                        required: [
                          "inputTokens",
                          "outputTokens",
                          "totalTokens",
                          "cachedInputTokens",
                          "reasoningOutputTokens",
                        ],
                        additionalProperties: false,
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                },
                required: [
                  "request",
                  "responseId",
                  "requestId",
                  "responseModel",
                  "status",
                  "usage",
                ],
                additionalProperties: false,
              },
              usageBudgetEventDigest: {
                anyOf: [
                  {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                  {
                    type: "null",
                  },
                ],
              },
            },
            required: [
              "kind",
              "phase",
              "requestDigest",
              "dispatchEventDigest",
              "artifactSha256",
              "metadata",
              "usageBudgetEventDigest",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "domain-validated",
              },
              phase: {
                type: "string",
                enum: ["generation", "review"],
              },
              requestDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              responseEventDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              artifactSha256: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
              outputDigest: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
              },
            },
            required: [
              "kind",
              "phase",
              "requestDigest",
              "responseEventDigest",
              "artifactSha256",
              "outputDigest",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                const: "execution-stopped",
              },
              outcome: {
                type: "string",
                enum: [
                  "completed",
                  "before-dispatch",
                  "result-unobserved",
                  "needs-cost-review",
                  "output-invalid",
                  "bound-breached",
                ],
              },
              failureCode: {
                anyOf: [
                  {
                    type: "string",
                    enum: [
                      "INTERRUPTED",
                      "STORAGE_FAILED",
                      "OUTPUT_INVALID",
                      "COST_UNSETTLED",
                      "BOUND_BREACHED",
                    ],
                  },
                  {
                    type: "null",
                  },
                ],
              },
              finalArtifactSha256: {
                anyOf: [
                  {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                  {
                    type: "null",
                  },
                ],
              },
              releasedBudgetEventDigests: {
                maxItems: 2,
                type: "array",
                items: {
                  type: "string",
                  pattern: "^[a-f0-9]{64}$",
                },
              },
            },
            required: [
              "kind",
              "outcome",
              "failureCode",
              "finalArtifactSha256",
              "releasedBudgetEventDigests",
            ],
            additionalProperties: false,
          },
        ],
      },
      eventDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      budgetRevision: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
      },
    },
    required: [
      "runId",
      "revision",
      "budgetRevision",
      "previousEventDigest",
      "recordedAt",
      "payload",
      "eventDigest",
    ],
    additionalProperties: false,
  },
  actualLedgerReceiptSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [
          "actual-budget-configure",
          "actual-start",
          "actual-prepare",
          "actual-dispatch",
          "actual-response",
          "actual-validate",
          "actual-stop",
        ],
      },
      clientRequestId: {
        type: "string",
        format: "uuid",
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      },
      inputDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      runId: {
        anyOf: [
          {
            type: "string",
            format: "uuid",
            pattern:
              "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          },
          {
            type: "null",
          },
        ],
      },
      runRevision: {
        anyOf: [
          {
            type: "integer",
            minimum: 0,
            maximum: 32,
          },
          {
            type: "null",
          },
        ],
      },
      budgetRevision: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
      },
      operationDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      recordedAt: {
        type: "string",
        format: "date-time",
        pattern:
          "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
      },
    },
    required: [
      "kind",
      "clientRequestId",
      "inputDigest",
      "runId",
      "runRevision",
      "budgetRevision",
      "operationDigest",
      "recordedAt",
    ],
    additionalProperties: false,
  },
  actualLedgerUsageSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      inputTokens: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      outputTokens: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      totalTokens: {
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
      cachedInputTokens: {
        anyOf: [
          {
            type: "integer",
            minimum: 0,
            maximum: 9007199254740991,
          },
          {
            type: "null",
          },
        ],
      },
      reasoningOutputTokens: {
        anyOf: [
          {
            type: "integer",
            minimum: 0,
            maximum: 9007199254740991,
          },
          {
            type: "null",
          },
        ],
      },
    },
    required: [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cachedInputTokens",
      "reasoningOutputTokens",
    ],
    additionalProperties: false,
  },
  actualLedgerResponseArtifactSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      captureKind: {
        type: "string",
        const: "sdk-response-json",
      },
      response: {
        type: "object",
        properties: {
          id: {
            $ref: "#/$defs/__schema0",
          },
          _request_id: {
            $ref: "#/$defs/__schema1",
          },
          model: {
            $ref: "#/$defs/__schema2",
          },
          status: {
            $ref: "#/$defs/__schema3",
          },
          usage: {
            $ref: "#/$defs/__schema4",
          },
          output: {
            type: "array",
            items: {
              $ref: "#/$defs/__schema5",
            },
          },
        },
        required: ["output"],
        additionalProperties: false,
      },
    },
    required: ["captureKind", "response"],
    additionalProperties: false,
    $defs: {
      __schema0: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema0",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema0",
            },
          },
        ],
      },
      __schema1: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema1",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema1",
            },
          },
        ],
      },
      __schema2: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema2",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema2",
            },
          },
        ],
      },
      __schema3: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema3",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema3",
            },
          },
        ],
      },
      __schema4: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema4",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema4",
            },
          },
        ],
      },
      __schema5: {
        anyOf: [
          {
            type: "string",
          },
          {
            type: "number",
          },
          {
            type: "boolean",
          },
          {
            type: "null",
          },
          {
            type: "array",
            items: {
              $ref: "#/$defs/__schema5",
            },
          },
          {
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              $ref: "#/$defs/__schema5",
            },
          },
        ],
      },
    },
  },
  actualLedgerValidatedArtifactSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "plan",
          },
          content: {
            type: "object",
            properties: {
              title: {
                type: "string",
                maxLength: 300,
              },
              summary: {
                type: "string",
                maxLength: 6000,
              },
              sections: {
                maxItems: 20,
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: {
                      type: "string",
                    },
                    title: {
                      type: "string",
                      maxLength: 200,
                    },
                    content: {
                      type: "string",
                      maxLength: 18000,
                    },
                    evidence: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sourceId: {
                            type: "string",
                          },
                          quote: {
                            type: "string",
                            maxLength: 1500,
                          },
                          locator: {
                            type: "string",
                            maxLength: 150,
                          },
                        },
                        required: ["sourceId", "quote", "locator"],
                        additionalProperties: false,
                      },
                    },
                    needsConfirmation: {
                      type: "boolean",
                    },
                  },
                  required: ["key", "title", "content", "evidence", "needsConfirmation"],
                  additionalProperties: false,
                },
              },
              actionItems: {
                maxItems: 40,
                type: "array",
                items: {
                  type: "string",
                  maxLength: 3000,
                },
              },
              interviewQuestions: {
                maxItems: 30,
                type: "array",
                items: {
                  type: "string",
                  maxLength: 3000,
                },
              },
            },
            required: ["title", "summary", "sections", "actionItems", "interviewQuestions"],
            additionalProperties: false,
          },
        },
        required: ["kind", "content"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: {
            type: "string",
            const: "review",
          },
          findings: {
            maxItems: 12,
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                severity: {
                  type: "string",
                  enum: ["error", "warning", "info"],
                },
                category: {
                  type: "string",
                },
                message: {
                  type: "string",
                  maxLength: 3000,
                },
                action: {
                  type: "string",
                  maxLength: 3000,
                },
                sectionKey: {
                  type: ["string", "null"],
                },
                sourceIds: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              },
              required: [
                "id",
                "severity",
                "category",
                "message",
                "action",
                "sectionKey",
                "sourceIds",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["kind", "findings"],
        additionalProperties: false,
      },
    ],
  },
  actualLedgerFinalArtifactSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      content: {
        type: "object",
        properties: {
          title: {
            type: "string",
            maxLength: 300,
          },
          summary: {
            type: "string",
            maxLength: 6000,
          },
          sections: {
            maxItems: 20,
            type: "array",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                },
                title: {
                  type: "string",
                  maxLength: 200,
                },
                content: {
                  type: "string",
                  maxLength: 18000,
                },
                evidence: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      sourceId: {
                        type: "string",
                      },
                      quote: {
                        type: "string",
                        maxLength: 1500,
                      },
                      locator: {
                        type: "string",
                        maxLength: 150,
                      },
                    },
                    required: ["sourceId", "quote", "locator"],
                    additionalProperties: false,
                  },
                },
                needsConfirmation: {
                  type: "boolean",
                },
              },
              required: ["key", "title", "content", "evidence", "needsConfirmation"],
              additionalProperties: false,
            },
          },
          actionItems: {
            maxItems: 40,
            type: "array",
            items: {
              type: "string",
              maxLength: 3000,
            },
          },
          interviewQuestions: {
            maxItems: 30,
            type: "array",
            items: {
              type: "string",
              maxLength: 3000,
            },
          },
        },
        required: ["title", "summary", "sections", "actionItems", "interviewQuestions"],
        additionalProperties: false,
      },
      review: {
        maxItems: 250,
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
            severity: {
              type: "string",
              enum: ["error", "warning", "info"],
            },
            category: {
              type: "string",
            },
            message: {
              type: "string",
              maxLength: 3000,
            },
            action: {
              type: "string",
              maxLength: 3000,
            },
            sectionKey: {
              type: ["string", "null"],
            },
            sourceIds: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
          required: ["id", "severity", "category", "message", "action", "sectionKey", "sourceIds"],
          additionalProperties: false,
        },
      },
      semanticReview: {
        maxItems: 12,
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
            },
            severity: {
              type: "string",
              enum: ["error", "warning", "info"],
            },
            category: {
              type: "string",
            },
            message: {
              type: "string",
              maxLength: 3000,
            },
            action: {
              type: "string",
              maxLength: 3000,
            },
            sectionKey: {
              type: ["string", "null"],
            },
            sourceIds: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
          required: ["id", "severity", "category", "message", "action", "sectionKey", "sourceIds"],
          additionalProperties: false,
        },
      },
      contractDigest: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
    },
    required: ["content", "review", "semanticReview", "contractDigest"],
    additionalProperties: false,
  },
};
export const actualArchiveSchemas = Object.fromEntries(
  Object.entries(actualArchiveJsonSchemas).map(([key, value]) => [key, z.fromJSONSchema(value)]),
);

const MiB = 1024 * 1024,
  scope = "candidate-quality-executions",
  phases = ["generation", "review"];
const notice =
  "합성 가격·토큰·전송 어댑터의 비용 원장 시험 기록입니다. 실제 AI 호출·운영 승인·청구·사람 평가를 증명하지 않습니다.";
const fail = (message = "Actual archival ledger mismatch") => {
  throw new Error(message);
};
const canonical = (value, wire = false) =>
  Array.isArray(value)
    ? value.map((item) => canonical(item, wire))
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (wire ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item, wire)]),
        )
      : value;
export const actualCanonicalDigest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const wireDigest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value, true)))
    .digest("hex");
export const actualRawDigest = (value) => createHash("sha256").update(value).digest("hex");
const omit = (value, key) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};
const same = (a, b) => actualCanonicalDigest(a) === actualCanonicalDigest(b);
const bytes = (value) =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const parse = (name, value) => actualArchiveSchemas[name].parse(value);
const sum = (list) => list.reduce((value, item) => value + BigInt(item), BigInt(0));
const nonnegative = (value) => (value > BigInt(0) ? value : BigInt(0));
const rate = (tokens, price) => {
  const n = BigInt(price.perTokens);
  return (BigInt(tokens) * BigInt(price.units) + n - BigInt(1)) / n;
};

export function validateActualArtifact(value) {
  const artifact = parse("actualLedgerArtifactSchema", value);
  const cap = artifact.key.endsWith("-response") ? 8 * MiB : 2 * MiB;
  if (
    artifact.sizeBytes !== bytes(artifact.body) ||
    artifact.sizeBytes > cap ||
    artifact.sha256 !== actualRawDigest(artifact.body)
  )
    fail("Actual artifact bytes mismatch");
  const body = JSON.parse(artifact.body);
  if (artifact.key.endsWith("-response")) parse("actualLedgerResponseArtifactSchema", body);
  else if (artifact.key.endsWith("-validated")) parse("actualLedgerValidatedArtifactSchema", body);
  else if (artifact.key === "final-result") parse("actualLedgerFinalArtifactSchema", body);
  else {
    const allowed = ["model", "store", "max_output_tokens", "input", "text"];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join() !== allowed.sort().join()
    )
      fail();
  }
  return artifact;
}
export function validateActualBudgetLedger(values) {
  if (values.length > 1000) fail();
  const events = values.map((value) => parse("actualLedgerBudgetEventSchema", value));
  let cap = BigInt(0),
    recognized = BigInt(0),
    currency = null,
    unitScale = null,
    head = null,
    breached = false;
  const reservations = [],
    ids = new Set(),
    reservedRuns = new Set();
  for (const [index, event] of events.entries()) {
    if (
      event.revision !== index + 1 ||
      event.previousDigest !== head ||
      event.eventDigest !== actualCanonicalDigest(omit(event, "eventDigest")) ||
      ids.has(event.eventId) ||
      bytes(event) > 32768
    )
      fail();
    ids.add(event.eventId);
    head = event.eventDigest;
    const p = event.payload;
    if (index === 0) {
      if (p.kind !== "configure") fail();
      cap = BigInt(p.capUnits);
      currency = event.currency;
      unitScale = event.unitScale;
      continue;
    }
    if (event.currency !== currency || event.unitScale !== unitScale || p.kind === "configure")
      fail();
    if (p.kind === "reserve-run") {
      if (reservedRuns.has(p.runId) || breached) fail();
      const amount = BigInt(p.generationUnits) + BigInt(p.reviewUnits);
      if (recognized + sum(reservations.map((item) => item.heldUnits)) + amount > cap)
        fail("Actual budget exceeded");
      reservedRuns.add(p.runId);
      for (const phase of phases)
        reservations.push({
          runId: p.runId,
          phase,
          reservationDigest: event.eventDigest,
          reservedUnits: p[`${phase}Units`],
          heldUnits: p[`${phase}Units`],
          recognizedUnits: "0",
          releasedUnits: "0",
          boundExcessUnits: "0",
          settled: false,
        });
    } else {
      const reservation = reservations.find(
        (item) =>
          item.runId === p.runId &&
          item.phase === p.phase &&
          item.reservationDigest === p.reservationDigest,
      );
      if (!reservation || reservation.settled) fail("Actual reservation already consumed");
      const held = BigInt(reservation.heldUnits);
      if (p.kind === "recognize-usage") {
        const cost = BigInt(p.recognizedUnits),
          consumed = cost < held ? cost : held,
          released = nonnegative(held - cost),
          excess = nonnegative(cost - held);
        if (
          BigInt(p.consumedReservedUnits) !== consumed ||
          BigInt(p.unusedReleasedUnits) !== released ||
          BigInt(p.boundExcessUnits) !== excess
        )
          fail("Actual usage arithmetic mismatch");
        recognized += cost;
        reservation.recognizedUnits = cost.toString();
        reservation.releasedUnits = released.toString();
        reservation.boundExcessUnits = excess.toString();
        breached ||= excess > BigInt(0) || p.tokenBoundBreached;
      } else {
        if (BigInt(p.units) !== held) fail("Actual release exceeds held reservation");
        reservation.releasedUnits = p.units;
      }
      reservation.heldUnits = "0";
      reservation.settled = true;
    }
  }
  const held = sum(reservations.map((item) => item.heldUnits)),
    exposure = recognized + held;
  return {
    scopeId: scope,
    revision: events.length,
    headDigest: head,
    currency,
    unitScale,
    capUnits: cap.toString(),
    recognizedUsageUnits: recognized.toString(),
    heldUnits: held.toString(),
    exposureUnits: exposure.toString(),
    availableUnits: nonnegative(cap - exposure).toString(),
    deficitUnits: nonnegative(exposure - cap).toString(),
    boundBreached: breached,
    reservations,
  };
}

function responseMetadata(artifact) {
  const raw = parse("actualLedgerResponseArtifactSchema", JSON.parse(artifact.body)).response;
  const str = (value, max) =>
    typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  const u = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  const parsed = actualArchiveSchemas.actualLedgerUsageSchema.safeParse({
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: u.total_tokens,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? null,
    reasoningOutputTokens: u.output_tokens_details?.reasoning_tokens ?? null,
  });
  let usage = parsed.success ? parsed.data : null;
  if (
    usage &&
    (usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
      (usage.cachedInputTokens !== null && usage.cachedInputTokens > usage.inputTokens) ||
      (usage.reasoningOutputTokens !== null && usage.reasoningOutputTokens > usage.outputTokens))
  )
    usage = null;
  return {
    raw,
    responseId: str(raw.id, 500),
    requestId: str(raw._request_id, 500),
    responseModel: str(raw.model, 200),
    status: str(raw.status, 100),
    usage,
  };
}
export function calculateActualUsage({ run, phase, metadata, artifact }) {
  const observed = responseMetadata(validateActualArtifact(artifact));
  if (!same(omit(observed, "raw"), omit(metadata, "request")))
    fail("Actual response metadata does not match captured JSON");
  const usage = observed.usage,
    prep = run.preparation;
  if (!usage || observed.responseModel !== prep.model) return null;
  const price = prep.evidence.price,
    reserved = BigInt(prep.costs[`${phase}Units`]);
  const cost =
    rate(usage.inputTokens, price.inputRate) +
    rate(usage.outputTokens, price.outputRate) +
    (price.additionalCharges.kind === "bounded-per-request"
      ? BigInt(price.additionalCharges.units)
      : BigInt(0));
  return {
    kind: "recognize-usage",
    runId: run.id,
    phase,
    reservationDigest: run.reservationDigest,
    requestDigest: metadata.request.requestDigest,
    responseArtifactSha256: artifact.sha256,
    recognizedUnits: cost.toString(),
    consumedReservedUnits: (cost < reserved ? cost : reserved).toString(),
    unusedReleasedUnits: nonnegative(reserved - cost).toString(),
    boundExcessUnits: nonnegative(cost - reserved).toString(),
    tokenBoundBreached:
      usage.inputTokens > prep.evidence.tokens[phase].inputUpperBound ||
      usage.outputTokens > prep.engine.maxOutputTokens,
  };
}

function validatePreparation(prep, registry) {
  if (
    prep.preparationDigest !== actualCanonicalDigest(omit(prep, "preparationDigest")) ||
    prep.environment !== "synthetic-test" ||
    prep.readiness !== "calculation-ready" ||
    prep.blockers.length ||
    !prep.model ||
    !prep.requestEvidence ||
    !prep.costs ||
    Object.values(prep.evidence).some((item) => !item || item.provenance !== "synthetic-test") ||
    prep.executionAllowed ||
    prep.approvalRecorded ||
    prep.reservationRecorded
  )
    fail("Actual archived preparation mismatch");
  const e = prep.requestEvidence,
    g = e.generation,
    t = e.reviewTemplate;
  if (
    prep.engine.phases[0].phase !== "generation" ||
    prep.engine.phases[0].name !== "business_plan" ||
    prep.engine.phases[1].phase !== "review" ||
    prep.engine.phases[1].name !== "business_plan_review"
  )
    fail();
  if (
    e.evidenceDigest !== actualCanonicalDigest(omit(e, "evidenceDigest")) ||
    g.requestDigest !== wireDigest(g.body) ||
    t.templateDigest !== wireDigest(omit(t, "templateDigest")) ||
    prep.engine.contractDigest !== wireDigest(omit(prep.engine, "contractDigest")) ||
    g.contractDigest !== prep.engine.contractDigest ||
    t.contractDigest !== prep.engine.contractDigest ||
    g.body.model !== prep.model ||
    t.model !== prep.model
  )
    fail();
  for (const [index, system, format] of [
    [0, g.body.input[0].content, g.body.text.format],
    [1, t.systemMessage.content, t.format],
  ]) {
    const split = system.lastIndexOf("\n\n"),
      contract = prep.engine.phases[index];
    if (
      split < 0 ||
      wireDigest(system.slice(0, split)) !== contract.systemDigest ||
      wireDigest(system.slice(split + 2)) !== contract.instructionDigest ||
      wireDigest(format) !== contract.schemaDigest
    )
      fail("Actual archived prompt contract mismatch");
  }
  const manifest = registry.manifest.find((item) => item.candidateId === prep.scope.candidateId),
    entry = registry.entries.find((item) => item.candidateId === prep.scope.candidateId);
  if (
    !manifest ||
    !entry ||
    registry.version !== prep.scope.version ||
    registry.versionDigest !== prep.scope.versionDigest ||
    registry.sourceDigest !== prep.scope.registrySourceDigest ||
    registry.manifestDigest !== prep.scope.manifestDigest ||
    ["candidateDigest", "sourceDigest", "modelInputDigest"].some(
      (key) => manifest[key] !== prep.scope[key],
    )
  )
    fail("Actual candidate binding mismatch");
  if (
    registry.versionDigest !== actualCanonicalDigest(omit(registry, "versionDigest")) ||
    registry.sourceDigest !==
      actualCanonicalDigest({
        schemaVersion: 1,
        setId: registry.setId,
        entries: registry.entries,
      }) ||
    registry.manifestDigest !== actualCanonicalDigest(registry.manifest) ||
    manifest.modelInputDigest !== actualCanonicalDigest(entry.input) ||
    manifest.sourceDigest !==
      actualCanonicalDigest({ profile: entry.input.profile, sources: entry.input.sources }) ||
    manifest.candidateDigest !== actualCanonicalDigest(entry.input.candidate)
  )
    fail("Actual registry integrity mismatch");
  const generation = JSON.parse(g.body.input[1].content),
    fixed = t.fixedUserContext,
    profile = { ...entry.input.profile };
  delete profile.businessNumber;
  if (
    Object.keys(fixed).sort().join() !==
    ["profile", "preparationContext", "unextractedSourceCount", "sources", "selectedCandidate"]
      .sort()
      .join()
  )
    fail("Actual reviewer-only metadata in model input");
  const sources = entry.input.sources.filter((item) => item.extraction !== "pending");
  if (
    !same(generation.profile, profile) ||
    !same(fixed.profile, profile) ||
    !same(fixed.selectedCandidate, entry.input.candidate) ||
    generation.sources.length !== sources.length ||
    fixed.sources.length !== sources.length ||
    generation.unextractedSourceCount !== entry.input.sources.length - sources.length ||
    fixed.unextractedSourceCount !== generation.unextractedSourceCount
  )
    fail();
  for (const context of [generation, fixed])
    for (const [index, source] of sources.entries())
      if (
        !same(omit(context.sources[index], "kind"), {
          sourceId: source.id,
          name: source.name,
          text: source.text,
          warnings: source.warnings,
        })
      )
        fail();
  if (
    !same(
      omit(generation.selectedCandidate, "classification"),
      omit(entry.input.candidate, "classification"),
    ) ||
    !same(omit(generation, "sectionDefinitions"), {
      ...fixed,
      selectedCandidate: generation.selectedCandidate,
    })
  )
    fail("Actual fixed context differs");
  const price = prep.evidence.price,
    tokens = prep.evidence.tokens,
    budget = prep.evidence.budget;
  if (
    price.model !== prep.model ||
    tokens.model !== prep.model ||
    price.currency !== budget.currency ||
    price.unitScale !== budget.unitScale ||
    tokens.contractDigest !== prep.engine.contractDigest ||
    tokens.generation.requestDigest !== g.requestDigest ||
    tokens.review.templateDigest !== t.templateDigest
  )
    fail();
  const phaseCost = (phase) =>
    rate(tokens[phase].inputUpperBound, price.inputRate) +
    rate(prep.engine.maxOutputTokens, price.outputRate) +
    (price.additionalCharges.kind === "bounded-per-request"
      ? BigInt(price.additionalCharges.units)
      : BigInt(0));
  const when = Date.parse(prep.preparedAt);
  for (const authority of [price.authority, tokens.authority])
    if (
      Date.parse(authority.retrievedAt) > Date.parse(authority.reviewedAt) ||
      Date.parse(authority.reviewedAt) > when ||
      Date.parse(authority.validFrom) > when ||
      Date.parse(authority.validUntil) <= when
    )
      fail("Actual evidence was invalid at preparation time");
  if (
    Date.parse(budget.observedAt) > when ||
    Date.parse(budget.validUntil) <= when ||
    tokens.maxOutputTokens < prep.engine.maxOutputTokens ||
    phases.some(
      (phase) =>
        tokens[phase].inputUpperBound > tokens.maxInputTokens ||
        BigInt(tokens[phase].inputUpperBound) + BigInt(prep.engine.maxOutputTokens) >
          BigInt(tokens.contextWindowTokens),
    )
  )
    fail();
  if (
    prep.costs.currency !== price.currency ||
    prep.costs.unitScale !== price.unitScale ||
    prep.costs.generationUnits !== phaseCost("generation").toString() ||
    prep.costs.reviewUnits !== phaseCost("review").toString() ||
    prep.costs.unsettledUnits !== budget.unsettledUnits ||
    prep.costs.budgetUnits !== budget.capUnits ||
    prep.costs.totalUnits !==
      (phaseCost("generation") + phaseCost("review") + BigInt(budget.unsettledUnits)).toString() ||
    BigInt(prep.costs.totalUnits) > BigInt(budget.capUnits)
  )
    fail();
}
function outputJson(artifact) {
  const { raw } = responseMetadata(artifact);
  if (raw.status !== "completed") fail("Actual incomplete response cannot validate");
  const texts = [];
  for (const message of raw.output)
    if (message?.type === "message" && Array.isArray(message.content))
      for (const part of message.content) {
        if (part?.type === "refusal") fail();
        if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
      }
  if (texts.length !== 1) fail();
  return JSON.parse(texts[0]);
}
export function deriveActualReviewRequest(run, validatedOutput) {
  const t = run.preparation.requestEvidence.reviewTemplate;
  if (validatedOutput.kind !== "plan") fail();
  return {
    model: t.model,
    store: false,
    max_output_tokens: t.max_output_tokens,
    input: [
      t.systemMessage,
      {
        role: "user",
        content: JSON.stringify({ ...t.fixedUserContext, draft: validatedOutput.content }),
      },
    ],
    text: { format: t.format },
  };
}
function validateDomain(phase, output, response, run, registry, generation) {
  const parsed = parse("actualLedgerValidatedArtifactSchema", output),
    raw = outputJson(response);
  const entry = registry.entries.find(
    (item) => item.candidateId === run.preparation.scope.candidateId,
  );
  if (phase === "generation") {
    if (parsed.kind !== "plan") fail();
    const plan = parsed.content,
      definitions = JSON.parse(
        run.preparation.requestEvidence.generation.body.input[1].content,
      ).sectionDefinitions;
    if (
      plan.sections.length !== definitions.length ||
      raw.sections?.length !== plan.sections.length ||
      !same(omit(plan, "sections"), omit(raw, "sections"))
    )
      fail();
    for (const [index, section] of plan.sections.entries()) {
      const original = raw.sections[index];
      if (
        section.key !== definitions[index].key ||
        section.title !== definitions[index].title ||
        !same(
          omit(omit(section, "title"), "needsConfirmation"),
          omit(omit(original, "title"), "needsConfirmation"),
        ) ||
        (original.needsConfirmation && !section.needsConfirmation)
      )
        fail();
      for (const ref of section.evidence) {
        const text =
          ref.sourceId === "profile"
            ? Object.values(entry.input.profile).filter((item) => typeof item === "string")
            : entry.input.sources
                .filter((item) => item.id === ref.sourceId && item.extraction !== "pending")
                .map((item) => item.text);
        if (
          !ref.quote.trim() ||
          !ref.locator.trim() ||
          !text.some((item) => item.includes(ref.quote))
        )
          fail("Actual invalid evidence quotation");
      }
    }
  } else {
    if (parsed.kind !== "review" || !same(raw, { findings: parsed.findings }) || !generation)
      fail();
    const ids = new Set([
        "profile",
        ...entry.input.sources
          .filter((item) => item.extraction !== "pending")
          .map((item) => item.id),
      ]),
      keys = new Set(generation.content.sections.map((item) => item.key));
    if (
      parsed.findings.some(
        (item) =>
          item.sourceIds.some((id) => !ids.has(id)) ||
          (item.sectionKey !== null && !keys.has(item.sectionKey)),
      )
    )
      fail();
  }
  return parsed;
}

export function validateActualRunLedger({
  run: runValue,
  events: values,
  artifacts: artifactValues,
  budgetEvents: budgetValues,
  receipts: receiptValues = [],
  registry,
}) {
  const run = parse("actualLedgerRunSchema", runValue),
    events = values.map((value) => parse("actualLedgerRunEventSchema", value)),
    artifacts = artifactValues
      .map(validateActualArtifact)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    receipts = receiptValues.map((value) => parse("actualLedgerReceiptSchema", value));
  if (
    run.runDigest !== actualCanonicalDigest(omit(run, "runDigest")) ||
    bytes(run) > 2 * MiB ||
    events.length > 32
  )
    fail();
  validatePreparation(run.preparation, registry);
  const startInput = {
    kind: "actual-start",
    clientRequestId: run.clientRequestId,
    approvedPreparationDigest: run.preparation.preparationDigest,
    approval: run.approval,
    expectedBudgetRevision: run.expectedBudgetRevision,
    expectedBudgetDigest: run.expectedBudgetDigest,
    expectedActualRunCount: run.expectedActualRunCount,
  };
  if (
    run.inputDigest !== actualCanonicalDigest(startInput) ||
    run.approval.approvedPreparationDigest !== run.preparation.preparationDigest
  )
    fail();
  const budgetEvents = budgetValues.map((value) => parse("actualLedgerBudgetEventSchema", value));
  validateActualBudgetLedger(budgetEvents);
  const reserve = budgetEvents.find((item) => item.eventDigest === run.reservationDigest),
    prior = validateActualBudgetLedger(budgetEvents.slice(0, run.expectedBudgetRevision));
  if (
    !reserve ||
    reserve.revision !== run.reservedBudgetRevision ||
    reserve.revision !== run.expectedBudgetRevision + 1 ||
    prior.headDigest !== run.expectedBudgetDigest ||
    !same(reserve.payload, {
      kind: "reserve-run",
      runId: run.id,
      preparationDigest: run.preparation.preparationDigest,
      generationUnits: run.preparation.costs.generationUnits,
      reviewUnits: run.preparation.costs.reviewUnits,
    }) ||
    run.preparation.evidence.budget.ledgerDigest !== prior.headDigest ||
    run.preparation.evidence.budget.capUnits !==
      (BigInt(prior.capUnits) - BigInt(prior.recognizedUsageUnits)).toString() ||
    run.preparation.evidence.budget.unsettledUnits !== prior.heldUnits
  )
    fail("Actual start reservation mismatch");
  if (
    new Set(artifacts.map((item) => item.key)).size !== artifacts.length ||
    artifacts.some((item) => item.runId !== run.id)
  )
    fail();
  const byKey = new Map(artifacts.map((item) => [item.key, item])),
    used = new Set(["generation-request"]);
  const original = byKey.get("generation-request");
  if (
    !original ||
    original.body !== JSON.stringify(run.preparation.requestEvidence.generation.body)
  )
    fail("Actual original request changed");
  let state = "reserved",
    head = null,
    maxBudgetRevision = run.reservedBudgetRevision,
    stopped = false,
    lastPhase = null;
  const prepared = {},
    dispatched = {},
    responded = {},
    validated = {},
    outputs = {},
    linkedBudget = new Set([reserve.eventDigest]);
  const artifact = (phase, suffix, sha) => {
    const key = suffix === "final-result" ? suffix : `${phase}-${suffix}`,
      value = byKey.get(key);
    if (!value || value.sha256 !== sha) fail("Actual artifact reference missing");
    used.add(key);
    return value;
  };
  const budgetHead = (revision, digest) => {
    const selected = validateActualBudgetLedger(budgetEvents.slice(0, revision));
    if (selected.revision !== revision || selected.headDigest !== digest) fail();
    maxBudgetRevision = Math.max(maxBudgetRevision, revision);
    return selected;
  };
  for (const [index, event] of events.entries()) {
    if (
      event.runId !== run.id ||
      event.revision !== index + 1 ||
      event.previousEventDigest !== head ||
      event.eventDigest !== actualCanonicalDigest(omit(event, "eventDigest")) ||
      bytes(event) > 32768
    )
      fail();
    head = event.eventDigest;
    const p = event.payload,
      phase = p.phase;
    if (event.budgetRevision < maxBudgetRevision || event.budgetRevision > budgetEvents.length)
      fail("Actual event budget head invalid");
    const envelopeBudget = validateActualBudgetLedger(budgetEvents.slice(0, event.budgetRevision));
    if (envelopeBudget.revision !== event.budgetRevision) fail();
    maxBudgetRevision = event.budgetRevision;
    if (
      (p.kind === "request-prepared" || p.kind === "dispatch-intent") &&
      p.budgetRevision !== event.budgetRevision
    )
      fail("Actual payload budget head differs from event");
    const referenceDigests = [
      p.usageBudgetEventDigest,
      ...(p.releasedBudgetEventDigests ?? []),
    ].filter(Boolean);
    if (
      referenceDigests.some(
        (h) =>
          (budgetEvents.find((item) => item.eventDigest === h)?.revision ?? Infinity) >
          event.budgetRevision,
      )
    )
      fail("Actual event precedes budget effect");
    if (
      referenceDigests.length &&
      Math.max(
        ...referenceDigests.map(
          (h) => budgetEvents.find((item) => item.eventDigest === h).revision,
        ),
      ) !== event.budgetRevision
    )
      fail("Actual transaction budget head mismatch");
    lastPhase = phase ?? lastPhase;
    if (p.kind === "request-prepared") {
      if (
        stopped ||
        prepared[phase] ||
        (phase === "generation"
          ? state !== "reserved"
          : !validated.generation || state !== "domain-validated")
      )
        fail();
      const b = budgetHead(p.budgetRevision, p.budgetDigest);
      if (b.boundBreached || BigInt(b.deficitUnits) > BigInt(0)) fail();
      if (
        phase === "review" &&
        (!responded.generation.payload.usageBudgetEventDigest ||
          !b.reservations.find((item) => item.runId === run.id && item.phase === "generation")
            ?.settled)
      )
        fail();
      const a = artifact(phase, "request", p.artifactSha256),
        body = JSON.parse(a.body),
        expected =
          phase === "generation"
            ? run.preparation.requestEvidence.generation.body
            : deriveActualReviewRequest(run, outputs.generation);
      if (
        a.body !== JSON.stringify(expected) ||
        p.requestDigest !== wireDigest(body) ||
        p.inputTokenUpperBound > run.preparation.evidence.tokens[phase].inputUpperBound
      )
        fail("Actual prepared request exceeds fixed derivation");
      if (
        phase === "generation"
          ? p.derivedFrom !== null
          : !same(p.derivedFrom, {
              generationEventDigest: validated.generation.eventDigest,
              artifactSha256: byKey.get("generation-validated").sha256,
            })
      )
        fail();
      prepared[phase] = event;
      state = "request-prepared";
    } else if (p.kind === "dispatch-intent") {
      if (
        stopped ||
        state !== "request-prepared" ||
        !prepared[phase] ||
        dispatched[phase] ||
        p.preparedEventDigest !== prepared[phase].eventDigest ||
        p.requestDigest !== prepared[phase].payload.requestDigest ||
        p.artifactSha256 !== prepared[phase].payload.artifactSha256
      )
        fail();
      const b = budgetHead(p.budgetRevision, p.budgetDigest);
      if (
        b.boundBreached ||
        BigInt(b.deficitUnits) > BigInt(0) ||
        b.reservations.find((item) => item.runId === run.id && item.phase === phase)?.settled
      )
        fail();
      dispatched[phase] = event;
      state = "dispatch-intent";
    } else if (p.kind === "response-received") {
      if (
        !dispatched[phase] ||
        responded[phase] ||
        p.dispatchEventDigest !== dispatched[phase].eventDigest ||
        p.requestDigest !== dispatched[phase].payload.requestDigest ||
        !["dispatch-intent", "result-unobserved"].includes(state)
      )
        fail();
      const a = artifact(phase, "response", p.artifactSha256),
        request = p.metadata.request;
      if (
        request.mode !== "mock" ||
        request.provider !== "mock" ||
        request.phase !== phase ||
        request.sequence !== (phase === "generation" ? 1 : 2) ||
        request.configuredModel !== run.preparation.model ||
        request.requestDigest !== p.requestDigest ||
        request.contractDigest !== run.preparation.engine.contractDigest ||
        request.maxOutputTokens !== run.preparation.engine.maxOutputTokens ||
        request.inputChars !==
          JSON.parse(byKey.get(`${phase}-request`).body).input.reduce(
            (n, item) => n + item.content.length,
            0,
          )
      )
        fail("Actual simulation provenance or request mismatch");
      const recognition = calculateActualUsage({ run, phase, metadata: p.metadata, artifact: a });
      if (recognition) {
        const b = budgetEvents.find((item) => item.eventDigest === p.usageBudgetEventDigest);
        if (!b || !same(b.payload, recognition) || b.revision <= run.reservedBudgetRevision)
          fail("Actual usage event missing");
        linkedBudget.add(b.eventDigest);
        maxBudgetRevision = Math.max(maxBudgetRevision, b.revision);
      } else if (p.usageBudgetEventDigest !== null) fail();
      responded[phase] = event;
      state = "response-received";
    } else if (p.kind === "domain-validated") {
      if (
        state !== "response-received" ||
        !responded[phase] ||
        validated[phase] ||
        p.responseEventDigest !== responded[phase].eventDigest ||
        p.requestDigest !== responded[phase].payload.requestDigest
      )
        fail();
      const a = artifact(phase, "validated", p.artifactSha256),
        output = JSON.parse(a.body);
      if (p.outputDigest !== wireDigest(output)) fail();
      outputs[phase] = validateDomain(
        phase,
        output,
        byKey.get(`${phase}-response`),
        run,
        registry,
        outputs.generation,
      );
      validated[phase] = event;
      state = "domain-validated";
    } else {
      if (stopped && state !== "response-received" && state !== "domain-validated") fail();
      for (const h of p.releasedBudgetEventDigests) {
        const b = budgetEvents.find((item) => item.eventDigest === h);
        if (
          !b ||
          b.payload.kind !== "release-unused" ||
          b.payload.runId !== run.id ||
          dispatched[b.payload.phase] ||
          linkedBudget.has(h)
        )
          fail("Actual dispatched reservation cannot release");
        linkedBudget.add(h);
        maxBudgetRevision = Math.max(maxBudgetRevision, b.revision);
      }
      if (p.outcome === "completed") {
        if (
          !validated.review ||
          !validated.generation ||
          !p.finalArtifactSha256 ||
          p.failureCode !== null
        )
          fail();
        const final = JSON.parse(artifact(null, "final-result", p.finalArtifactSha256).body),
          initial = outputs.generation.content;
        if (
          final.contractDigest !== run.preparation.engine.contractDigest ||
          !same(final.semanticReview, outputs.review.findings) ||
          final.content.title !== initial.title ||
          final.content.summary !== initial.summary ||
          final.content.sections.length !== initial.sections.length ||
          final.content.sections.some(
            (section, index) =>
              !same(
                omit(section, "needsConfirmation"),
                omit(initial.sections[index], "needsConfirmation"),
              ) ||
              (initial.sections[index].needsConfirmation && !section.needsConfirmation),
          ) ||
          !final.semanticReview.every((finding) => final.review.some((item) => same(item, finding)))
        )
          fail();
        state = "completed";
      } else {
        if (p.failureCode === null || p.finalArtifactSha256 !== null) fail();
        if (p.outcome === "before-dispatch" && Object.keys(dispatched).length) fail();
        if (
          p.outcome === "result-unobserved" &&
          !phases.some((item) => dispatched[item] && !responded[item])
        )
          fail();
        if (
          p.outcome === "needs-cost-review" &&
          !phases.some((item) => responded[item] && !responded[item].payload.usageBudgetEventDigest)
        )
          fail();
        if (
          p.outcome === "bound-breached" &&
          !validateActualBudgetLedger(budgetEvents.slice(0, maxBudgetRevision)).boundBreached
        )
          fail();
        state = {
          "before-dispatch": "stopped-before-dispatch",
          "result-unobserved": "result-unobserved",
          "needs-cost-review": "stopped-needs-cost-review",
          "output-invalid": "stopped-output-invalid",
          "bound-breached": "stopped-bound-breached",
        }[p.outcome];
      }
      stopped = true;
    }
  }
  if (artifacts.some((item) => !used.has(item.key))) fail("Actual orphan artifact");
  const relevantBudget = budgetEvents.filter((item) => item.payload.runId === run.id);
  if (
    relevantBudget.some((item) => !linkedBudget.has(item.eventDigest)) ||
    relevantBudget.length > 16 ||
    receipts.length > 64 ||
    receipts.some((item) => item.runId !== run.id || item.runRevision > events.length)
  )
    fail("Actual unlinked budget or receipt");
  const budget = validateActualBudgetLedger(budgetEvents.slice(0, maxBudgetRevision)),
    reservations = budget.reservations.filter((item) => item.runId === run.id);
  const costState =
    reservations.some((item) => BigInt(item.boundExcessUnits) > BigInt(0)) ||
    relevantBudget.some((item) => item.payload.tokenBoundBreached)
      ? "bound-breached"
      : reservations.every((item) => item.settled)
        ? "settled"
        : "held";
  const terminal =
    stopped &&
    ![
      "result-unobserved",
      "stopped-needs-cost-review",
      "response-received",
      "domain-validated",
    ].includes(state) &&
    costState !== "held";
  const usedBytes =
    bytes(run) +
    events.reduce((n, item) => n + bytes(item), 0) +
    artifacts.reduce((n, item) => n + item.sizeBytes, 0) +
    relevantBudget.reduce((n, item) => n + bytes(item), 0) +
    receipts.reduce((n, item) => n + bytes(item), 0);
  if (usedBytes > 32 * MiB) fail("Actual reserved storage exceeded");
  const result = {
    schemaVersion: 1,
    archiveFormatVersion: 1,
    run,
    revision: events.length,
    events,
    artifacts: artifacts.map((item) => omit(item, "body")),
    budgetEvents: budgetEvents.slice(0, maxBudgetRevision),
    state,
    costState,
    sameCandidateBlocked: !terminal,
    canResume: false,
    actualAiCalls: 0,
    storage: {
      usedBytes,
      heldBytes: terminal ? 0 : 32 * MiB - usedBytes,
      remainingEventSlots: terminal ? 0 : 32 - events.length,
      remainingBudgetEventSlots: terminal ? 0 : 16 - relevantBudget.length,
      remainingReceiptSlots: terminal ? 0 : 64 - receipts.length,
    },
    notice,
  };
  return { ...result, snapshotDigest: actualCanonicalDigest(result) };
}

export function inspectActualLedger({
  runs,
  events,
  artifacts,
  budgetEvents,
  receipts,
  registries,
  otherNonces = [],
}) {
  if (
    runs.length > 20 ||
    events.length > runs.length * 32 ||
    receipts.length > 1000 ||
    artifacts.length > runs.length * 7
  )
    fail();
  const nonces = new Set(otherNonces),
    ids = new Set(),
    snapshots = [];
  const parsedReceipts = receipts.map((item) => parse("actualLedgerReceiptSchema", item));
  for (const receipt of parsedReceipts) {
    if (nonces.has(receipt.clientRequestId) || bytes(receipt) > 4096)
      fail("Actual nonce collision");
    nonces.add(receipt.clientRequestId);
  }
  const sorted = runs
    .map((item) => parse("actualLedgerRunSchema", item))
    .sort((a, b) => a.expectedActualRunCount - b.expectedActualRunCount);
  for (const [index, run] of sorted.entries()) {
    if (
      ids.has(run.id) ||
      run.expectedActualRunCount !== index ||
      (index > 0 && run.reservedBudgetRevision <= sorted[index - 1].reservedBudgetRevision)
    )
      fail();
    ids.add(run.id);
    const registry = registries.find(
      (item) =>
        item.version === run.preparation.scope.version &&
        item.versionDigest === run.preparation.scope.versionDigest,
    );
    if (!registry) fail();
    const earlier = snapshots.filter(
      (item) => item.run.preparation.scope.candidateId === run.preparation.scope.candidateId,
    );
    // At the new reservation head, the earlier run must already have an explicit settled stop.
    for (const prior of earlier) {
      const priorReceipts = parsedReceipts.filter((item) => item.runId === prior.run.id);
      if (
        prior.sameCandidateBlocked ||
        priorReceipts.some((item) => item.budgetRevision >= run.reservedBudgetRevision)
      )
        fail("Actual unresolved candidate restarted");
    }
    const ownReceipts = parsedReceipts.filter((item) => item.runId === run.id);
    const start = ownReceipts.find((item) => item.kind === "actual-start");
    if (
      !start ||
      start.clientRequestId !== run.clientRequestId ||
      start.inputDigest !== run.inputDigest ||
      start.runRevision !== 0 ||
      start.budgetRevision !== run.reservedBudgetRevision ||
      start.recordedAt !== run.recordedAt ||
      start.operationDigest !== run.runDigest
    )
      fail("Actual start receipt missing");
    const snapshot = validateActualRunLedger({
      run,
      events: events.filter((item) => item.runId === run.id),
      artifacts: artifacts.filter((item) => item.runId === run.id),
      budgetEvents,
      receipts: ownReceipts,
      registry,
    });
    const kinds = {
      "request-prepared": "actual-prepare",
      "dispatch-intent": "actual-dispatch",
      "response-received": "actual-response",
      "domain-validated": "actual-validate",
      "execution-stopped": "actual-stop",
    };
    let receiptHead = run.reservedBudgetRevision;
    for (const event of snapshot.events) {
      const related = ownReceipts.filter((item) => item.runRevision === event.revision);
      if (
        related.length !== 1 ||
        related[0].operationDigest !== event.eventDigest ||
        related[0].kind !== kinds[event.payload.kind] ||
        related[0].recordedAt !== event.recordedAt ||
        related[0].budgetRevision !== event.budgetRevision ||
        related[0].budgetRevision < run.reservedBudgetRevision ||
        related[0].budgetRevision > budgetEvents.length
      )
        fail("Actual event receipt missing");
      const receipt = related[0],
        p = event.payload;
      const references = [p.usageBudgetEventDigest, ...(p.releasedBudgetEventDigests ?? [])].filter(
        Boolean,
      );
      const minimumHead = Math.max(
        receiptHead,
        p.budgetRevision ?? 0,
        ...references.map(
          (hash) => budgetEvents.find((item) => item.eventDigest === hash)?.revision ?? Infinity,
        ),
      );
      if (receipt.budgetRevision < minimumHead) fail("Actual receipt budget order mismatch");
      receiptHead = receipt.budgetRevision;
      let artifact;
      if (
        p.kind === "response-received" ||
        p.kind === "domain-validated" ||
        (p.kind === "request-prepared" && p.phase === "review")
      )
        artifact = artifacts.find(
          (item) => item.runId === run.id && item.sha256 === p.artifactSha256,
        );
      else if (p.kind === "execution-stopped" && p.outcome === "completed")
        artifact = artifacts.find((item) => item.runId === run.id && item.key === "final-result");
      if (
        receipt.inputDigest !==
        actualLedgerOperationDigest({
          kind: receipt.kind,
          clientRequestId: receipt.clientRequestId,
          runId: run.id,
          expectedRevision: event.revision - 1,
          payload: p,
          artifact,
        })
      )
        fail("Actual event request digest mismatch");
    }
    if (ownReceipts.length !== snapshot.events.length + 1) fail();
    snapshots.push(snapshot);
  }
  if (
    events.some((item) => !ids.has(item.runId)) ||
    artifacts.some((item) => !ids.has(item.runId)) ||
    budgetEvents.some((item) => item.payload.runId && !ids.has(item.payload.runId)) ||
    parsedReceipts.some((item) => item.runId !== null && !ids.has(item.runId))
  )
    fail();
  const policies = parsedReceipts.filter((item) => item.runId === null);
  if (
    budgetEvents.length
      ? policies.length !== 1 ||
        policies[0].kind !== "actual-budget-configure" ||
        policies[0].budgetRevision !== 1 ||
        policies[0].operationDigest !== budgetEvents[0].eventDigest
      : policies.length !== 0
  )
    fail("Actual budget policy receipt missing");
  if (policies.length) {
    const p = policies[0],
      event = budgetEvents[0];
    if (
      p.runRevision !== null ||
      p.clientRequestId !== event.eventId ||
      p.recordedAt !== event.recordedAt ||
      p.inputDigest !== actualLedgerPolicyRequestDigest(event, p.clientRequestId)
    )
      fail("Actual policy request digest mismatch");
  }
  const budget = validateActualBudgetLedger(budgetEvents),
    reservedBytes = snapshots.reduce((n, item) => n + item.storage.heldBytes, 0),
    reservedBudgetEventSlots = snapshots.reduce(
      (n, item) => n + item.storage.remainingBudgetEventSlots,
      0,
    ),
    reservedReceiptSlots = snapshots.reduce((n, item) => n + item.storage.remainingReceiptSlots, 0);
  if (
    budgetEvents.length + reservedBudgetEventSlots > 1000 ||
    receipts.length + reservedReceiptSlots > 1000
  )
    fail("Actual record slots exhausted");
  const usedBytes =
    runs.reduce((n, item) => n + bytes(item), 0) +
    events.reduce((n, item) => n + bytes(item), 0) +
    budgetEvents.reduce((n, item) => n + bytes(item), 0) +
    receipts.reduce((n, item) => n + bytes(item), 0) +
    artifacts.reduce((n, item) => n + item.sizeBytes, 0);
  if (usedBytes + reservedBytes > 256 * MiB) fail("Actual storage budget exceeded");
  return {
    budget,
    snapshots,
    reservedBytes,
    reservedBudgetEventSlots,
    reservedReceiptSlots,
    usedBytes,
  };
}

export function actualLedgerOperationDigest({
  kind,
  clientRequestId,
  runId,
  expectedRevision,
  payload,
  artifact,
}) {
  let clientPayload = payload;
  if (payload.kind === "response-received") clientPayload = omit(payload, "usageBudgetEventDigest");
  if (payload.kind === "execution-stopped")
    clientPayload = omit(payload, "releasedBudgetEventDigests");
  return actualCanonicalDigest({
    kind,
    clientRequestId,
    runId,
    expectedRevision,
    payload: clientPayload,
    artifact: artifact ? omit(artifact, "body") : null,
  });
}
export function actualLedgerPolicyRequestDigest(event, clientRequestId) {
  return actualCanonicalDigest({
    kind: "actual-budget-configure",
    clientRequestId,
    expectedRevision: event.revision - 1,
    policy: {
      provenance: event.provenance,
      currency: event.currency,
      unitScale: event.unitScale,
      capUnits: event.payload.capUnits,
    },
  });
}
