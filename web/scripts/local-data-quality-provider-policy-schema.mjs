// Frozen policy adoption record v1 shape. Refinements are enforced by the archive validator.
// Parity checked against the TypeScript record contract; do not regenerate to reinterpret stored records.
export const providerPolicyArchiveJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    recordVersion: {
      type: "number",
      const: 1,
    },
    kind: {
      type: "string",
      const: "provider-policy-adoption",
    },
    scopeId: {
      type: "string",
      const: "candidate-quality-provider-policy-live",
    },
    revision: {
      type: "integer",
      minimum: 1,
      maximum: 100,
    },
    previousDigest: {
      anyOf: [
        {
          $ref: "#/$defs/__schema0",
        },
        {
          type: "null",
        },
      ],
    },
    clientRequestId: {
      $ref: "#/$defs/__schema1",
    },
    requestDigest: {
      $ref: "#/$defs/__schema0",
    },
    recordedAt: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    command: {
      type: "object",
      properties: {
        version: {
          $ref: "#/$defs/__schema2",
        },
        versionDigest: {
          $ref: "#/$defs/__schema3",
        },
        candidateId: {
          $ref: "#/$defs/__schema4",
        },
        commandVersion: {
          $ref: "#/$defs/__schema5",
        },
        kind: {
          $ref: "#/$defs/__schema6",
        },
        clientRequestId: {
          $ref: "#/$defs/__schema7",
        },
        expectedPolicyHead: {
          $ref: "#/$defs/__schema8",
        },
        approvedReviewDigest: {
          $ref: "#/$defs/__schema11",
        },
        budgetAction: {
          $ref: "#/$defs/__schema12",
        },
        initialBudgetRequestId: {
          $ref: "#/$defs/__schema13",
        },
        approval: {
          $ref: "#/$defs/__schema14",
        },
      },
      required: [
        "version",
        "versionDigest",
        "candidateId",
        "commandVersion",
        "kind",
        "clientRequestId",
        "expectedPolicyHead",
        "approvedReviewDigest",
        "budgetAction",
        "initialBudgetRequestId",
        "approval",
      ],
      additionalProperties: false,
    },
    reviewedProposal: {
      type: "object",
      properties: {
        providerContractVersion: {
          $ref: "#/$defs/__schema15",
        },
        environment: {
          $ref: "#/$defs/__schema16",
        },
        inputProvenance: {
          $ref: "#/$defs/__schema17",
        },
        scope: {
          $ref: "#/$defs/__schema18",
        },
        inspectedAt: {
          $ref: "#/$defs/__schema19",
        },
        budget: {
          $ref: "#/$defs/__schema20",
        },
        preparation: {
          $ref: "#/$defs/__schema21",
        },
        transmissionManifest: {
          $ref: "#/$defs/__schema22",
        },
        accountAccess: {
          $ref: "#/$defs/__schema23",
        },
        actualExecutionEnabled: {
          $ref: "#/$defs/__schema24",
        },
        maxCalls: {
          $ref: "#/$defs/__schema25",
        },
        maxRetries: {
          $ref: "#/$defs/__schema26",
        },
        automaticRepair: {
          $ref: "#/$defs/__schema27",
        },
        notice: {
          $ref: "#/$defs/__schema28",
        },
        viewDigest: {
          $ref: "#/$defs/__schema3",
        },
        viewVersion: {
          $ref: "#/$defs/__schema29",
        },
        state: {
          $ref: "#/$defs/__schema30",
        },
        model: {
          $ref: "#/$defs/__schema31",
        },
        financialBasis: {
          $ref: "#/$defs/__schema32",
        },
        retention: {
          $ref: "#/$defs/__schema49",
        },
        proposal: {
          $ref: "#/$defs/__schema51",
        },
        blockers: {
          $ref: "#/$defs/__schema81",
        },
      },
      required: [
        "providerContractVersion",
        "environment",
        "inputProvenance",
        "scope",
        "inspectedAt",
        "budget",
        "preparation",
        "transmissionManifest",
        "accountAccess",
        "actualExecutionEnabled",
        "maxCalls",
        "maxRetries",
        "automaticRepair",
        "notice",
        "viewDigest",
        "viewVersion",
        "state",
        "model",
        "financialBasis",
        "retention",
        "proposal",
        "blockers",
      ],
      additionalProperties: false,
    },
    approvedReview: {
      type: "object",
      properties: {
        schemaVersion: {
          $ref: "#/$defs/__schema83",
        },
        kind: {
          $ref: "#/$defs/__schema84",
        },
        environment: {
          $ref: "#/$defs/__schema85",
        },
        inputProvenance: {
          $ref: "#/$defs/__schema86",
        },
        scope: {
          $ref: "#/$defs/__schema18",
        },
        inspectedAt: {
          $ref: "#/$defs/__schema87",
        },
        expiresAt: {
          $ref: "#/$defs/__schema87",
        },
        bindings: {
          $ref: "#/$defs/__schema88",
        },
        budget: {
          $ref: "#/$defs/__schema90",
        },
        proposedBudget: {
          $ref: "#/$defs/__schema77",
        },
        reservation: {
          $ref: "#/$defs/__schema92",
        },
        assessment: {
          $ref: "#/$defs/__schema93",
        },
        accountAccess: {
          $ref: "#/$defs/__schema94",
        },
        actions: {
          $ref: "#/$defs/__schema95",
        },
        notice: {
          $ref: "#/$defs/__schema96",
        },
        reviewDigest: {
          $ref: "#/$defs/__schema89",
        },
      },
      required: [
        "schemaVersion",
        "kind",
        "environment",
        "inputProvenance",
        "scope",
        "inspectedAt",
        "expiresAt",
        "bindings",
        "budget",
        "proposedBudget",
        "reservation",
        "assessment",
        "accountAccess",
        "actions",
        "notice",
        "reviewDigest",
      ],
      additionalProperties: false,
    },
    budgetTransition: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["initialize-proposed-budget", "keep-existing-budget"],
        },
        before: {
          $ref: "#/$defs/__schema97",
        },
        after: {
          $ref: "#/$defs/__schema97",
        },
        initializationRequestId: {
          anyOf: [
            {
              $ref: "#/$defs/__schema1",
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: ["kind", "before", "after", "initializationRequestId"],
      additionalProperties: false,
    },
    reservationAllowed: {
      type: "boolean",
      const: false,
    },
    dispatchAllowed: {
      type: "boolean",
      const: false,
    },
    recordDigest: {
      $ref: "#/$defs/__schema0",
    },
  },
  required: [
    "recordVersion",
    "kind",
    "scopeId",
    "revision",
    "previousDigest",
    "clientRequestId",
    "requestDigest",
    "recordedAt",
    "command",
    "reviewedProposal",
    "approvedReview",
    "budgetTransition",
    "reservationAllowed",
    "dispatchAllowed",
    "recordDigest",
  ],
  additionalProperties: false,
  $defs: {
    __schema0: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema1: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    __schema2: {
      type: "integer",
      minimum: 1,
      maximum: 20,
    },
    __schema3: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema4: {
      type: "string",
      maxLength: 120,
      pattern: "^validation-candidate-[a-z0-9-]+$",
    },
    __schema5: {
      type: "number",
      const: 1,
    },
    __schema6: {
      type: "string",
      const: "adopt-provider-policy",
    },
    __schema7: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    __schema8: {
      type: "object",
      properties: {
        revision: {
          $ref: "#/$defs/__schema9",
        },
        headDigest: {
          $ref: "#/$defs/__schema10",
        },
      },
      required: ["revision", "headDigest"],
      additionalProperties: false,
    },
    __schema9: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    __schema10: {
      anyOf: [
        {
          $ref: "#/$defs/__schema11",
        },
        {
          type: "null",
        },
      ],
    },
    __schema11: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema12: {
      type: "string",
      enum: ["initialize-proposed-budget", "keep-existing-budget"],
    },
    __schema13: {
      anyOf: [
        {
          $ref: "#/$defs/__schema7",
        },
        {
          type: "null",
        },
      ],
    },
    __schema14: {
      type: "object",
      properties: {
        noticeVersion: {
          type: "number",
          const: 1,
        },
        acknowledgedPolicy: {
          type: "boolean",
          const: true,
        },
        acknowledgedBudgetAction: {
          type: "boolean",
          const: true,
        },
        reservationAndTransmission: {
          type: "string",
          const: "separate-approval-required",
        },
        approvedAt: {
          type: "string",
          format: "date-time",
          pattern:
            "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
        },
      },
      required: [
        "noticeVersion",
        "acknowledgedPolicy",
        "acknowledgedBudgetAction",
        "reservationAndTransmission",
        "approvedAt",
      ],
      additionalProperties: false,
    },
    __schema15: {
      type: "number",
      const: 2,
    },
    __schema16: {
      type: "string",
      const: "production",
    },
    __schema17: {
      type: "string",
      const: "registered-synthetic-candidate",
    },
    __schema18: {
      type: "object",
      properties: {
        version: {
          $ref: "#/$defs/__schema2",
        },
        versionDigest: {
          $ref: "#/$defs/__schema3",
        },
        candidateId: {
          $ref: "#/$defs/__schema4",
        },
        setId: {
          type: "string",
          const: "ai-validation-candidates",
        },
        registrySourceDigest: {
          $ref: "#/$defs/__schema3",
        },
        manifestDigest: {
          $ref: "#/$defs/__schema3",
        },
        label: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        sourceDigest: {
          $ref: "#/$defs/__schema3",
        },
        candidateDigest: {
          $ref: "#/$defs/__schema3",
        },
        modelInputDigest: {
          $ref: "#/$defs/__schema3",
        },
      },
      required: [
        "version",
        "versionDigest",
        "candidateId",
        "setId",
        "registrySourceDigest",
        "manifestDigest",
        "label",
        "sourceDigest",
        "candidateDigest",
        "modelInputDigest",
      ],
      additionalProperties: false,
    },
    __schema19: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    __schema20: {
      type: "null",
    },
    __schema21: {
      type: "null",
    },
    __schema22: {
      type: "null",
    },
    __schema23: {
      type: "string",
      const: "not-checked",
    },
    __schema24: {
      type: "boolean",
      const: false,
    },
    __schema25: {
      type: "number",
      const: 2,
    },
    __schema26: {
      type: "number",
      const: 0,
    },
    __schema27: {
      type: "boolean",
      const: false,
    },
    __schema28: {
      type: "string",
      const:
        "등록한 합성 후보의 운영 준비 조회본입니다. 실제 AI 호출·승인·비용 예약은 이루어지지 않습니다.",
    },
    __schema29: {
      type: "number",
      const: 2,
    },
    __schema30: {
      type: "string",
      const: "proposal-only",
    },
    __schema31: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    },
    __schema32: {
      type: "object",
      properties: {
        schemaVersion: {
          type: "number",
          const: 2,
        },
        kind: {
          type: "string",
          const: "provider-context-financial-reservation-basis",
        },
        status: {
          type: "string",
          const: "calculated-for-stated-conditions",
        },
        evidenceMode: {
          type: "string",
          const: "official-reviewed",
        },
        model: {
          $ref: "#/$defs/__schema31",
        },
        calculatedAt: {
          $ref: "#/$defs/__schema33",
        },
        conditions: {
          $ref: "#/$defs/__schema34",
        },
        evidence: {
          type: "object",
          properties: {
            context: {
              type: "object",
              properties: {
                provenance: {
                  $ref: "#/$defs/__schema35",
                },
                model: {
                  $ref: "#/$defs/__schema36",
                },
                conditions: {
                  $ref: "#/$defs/__schema34",
                },
                authority: {
                  $ref: "#/$defs/__schema37",
                },
                contextWindowTokens: {
                  $ref: "#/$defs/__schema38",
                },
                contextCoverage: {
                  type: "string",
                  const: "input-plus-output-including-reasoning",
                },
                maxOutputTokens: {
                  $ref: "#/$defs/__schema38",
                },
              },
              required: [
                "provenance",
                "model",
                "conditions",
                "authority",
                "contextWindowTokens",
                "contextCoverage",
                "maxOutputTokens",
              ],
              additionalProperties: false,
            },
            pricing: {
              type: "object",
              properties: {
                provenance: {
                  $ref: "#/$defs/__schema35",
                },
                model: {
                  $ref: "#/$defs/__schema36",
                },
                conditions: {
                  $ref: "#/$defs/__schema34",
                },
                authority: {
                  $ref: "#/$defs/__schema37",
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
                rateMeaning: {
                  type: "string",
                  const: "all-in-replacement-rates-not-additive-surcharges",
                },
                shortContext: {
                  $ref: "#/$defs/__schema39",
                },
                longContext: {
                  anyOf: [
                    {
                      $ref: "#/$defs/__schema39",
                    },
                    {
                      $ref: "#/$defs/__schema42",
                    },
                  ],
                },
                additionalCharges: {
                  type: "object",
                  properties: {
                    applicability: {
                      type: "string",
                      const: "none-under-stated-conditions",
                    },
                    explanation: {
                      type: "string",
                      minLength: 1,
                      maxLength: 2000,
                    },
                  },
                  required: ["applicability", "explanation"],
                  additionalProperties: false,
                },
              },
              required: [
                "provenance",
                "model",
                "conditions",
                "authority",
                "currency",
                "unitScale",
                "rateMeaning",
                "shortContext",
                "longContext",
                "additionalCharges",
              ],
              additionalProperties: false,
            },
          },
          required: ["context", "pricing"],
          additionalProperties: false,
        },
        basis: {
          type: "string",
          const: "full-context-input-plus-separate-output-reservation",
        },
        maxCalls: {
          type: "number",
          const: 2,
        },
        retries: {
          type: "number",
          const: 0,
        },
        costs: {
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
            maximumInputRate: {
              type: "object",
              properties: {
                rate: {
                  $ref: "#/$defs/__schema43",
                },
                selectedFrom: {
                  type: "string",
                  minLength: 1,
                },
              },
              required: ["rate", "selectedFrom"],
              additionalProperties: false,
            },
            maximumOutputRate: {
              type: "object",
              properties: {
                rate: {
                  $ref: "#/$defs/__schema43",
                },
                selectedFrom: {
                  type: "string",
                  minLength: 1,
                },
              },
              required: ["rate", "selectedFrom"],
              additionalProperties: false,
            },
            generation: {
              $ref: "#/$defs/__schema45",
            },
            review: {
              $ref: "#/$defs/__schema45",
            },
            totalUnits: {
              $ref: "#/$defs/__schema44",
            },
            rounding: {
              type: "string",
              const: "ceil-each-rate-per-request",
            },
          },
          required: [
            "currency",
            "unitScale",
            "maximumInputRate",
            "maximumOutputRate",
            "generation",
            "review",
            "totalUnits",
            "rounding",
          ],
          additionalProperties: false,
        },
        blockers: {
          minItems: 0,
          maxItems: 0,
          type: "array",
          items: {
            $ref: "#/$defs/__schema47",
          },
        },
        authority: {
          type: "object",
          properties: {
            sourceAuthenticityIndependentlyVerified: {
              type: "boolean",
              const: false,
            },
            providerFailureChargeBoundVerified: {
              type: "boolean",
              const: false,
            },
            actualTokenCountMeasured: {
              type: "boolean",
              const: false,
            },
            contextFitVerified: {
              type: "boolean",
              const: false,
            },
            accountAccessVerified: {
              type: "boolean",
              const: false,
            },
            userApprovalRecorded: {
              type: "boolean",
              const: false,
            },
            operatingBudgetConfigured: {
              type: "boolean",
              const: false,
            },
            executionReady: {
              type: "boolean",
              const: false,
            },
            dispatchAllowed: {
              type: "boolean",
              const: false,
            },
            compatibleWithLegacyPreparation: {
              type: "boolean",
              const: false,
            },
          },
          required: [
            "sourceAuthenticityIndependentlyVerified",
            "providerFailureChargeBoundVerified",
            "actualTokenCountMeasured",
            "contextFitVerified",
            "accountAccessVerified",
            "userApprovalRecorded",
            "operatingBudgetConfigured",
            "executionReady",
            "dispatchAllowed",
            "compatibleWithLegacyPreparation",
          ],
          additionalProperties: false,
        },
        unobservedCostPolicy: {
          type: "string",
          const: "retain-reservation-no-automatic-retry",
        },
        limitations: {
          minItems: 1,
          maxItems: 20,
          type: "array",
          items: {
            $ref: "#/$defs/__schema48",
          },
        },
      },
      required: [
        "schemaVersion",
        "kind",
        "status",
        "evidenceMode",
        "model",
        "calculatedAt",
        "conditions",
        "evidence",
        "basis",
        "maxCalls",
        "retries",
        "costs",
        "blockers",
        "authority",
        "unobservedCostPolicy",
        "limitations",
      ],
      additionalProperties: false,
    },
    __schema33: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    __schema34: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          const: "OpenAI",
        },
        endpoint: {
          type: "string",
          const: "https://api.openai.com/v1",
        },
        api: {
          type: "string",
          const: "responses",
        },
        modality: {
          type: "string",
          const: "text-only",
        },
        tools: {
          type: "string",
          const: "none",
        },
        tokenCountingEndpoint: {
          type: "string",
          const: "none",
        },
        serviceTier: {
          type: "string",
          const: "default",
        },
        processing: {
          type: "string",
          const: "standard",
        },
        destination: {
          type: "string",
          const: "global",
        },
        store: {
          type: "boolean",
          const: false,
        },
        truncation: {
          type: "string",
          const: "disabled",
        },
        previousResponse: {
          type: "string",
          const: "none",
        },
        conversation: {
          type: "string",
          const: "none",
        },
        compaction: {
          type: "string",
          const: "none",
        },
        background: {
          type: "boolean",
          const: false,
        },
        stream: {
          type: "boolean",
          const: false,
        },
        maxCalls: {
          type: "number",
          const: 2,
        },
        retries: {
          type: "number",
          const: 0,
        },
      },
      required: [
        "provider",
        "endpoint",
        "api",
        "modality",
        "tools",
        "tokenCountingEndpoint",
        "serviceTier",
        "processing",
        "destination",
        "store",
        "truncation",
        "previousResponse",
        "conversation",
        "compaction",
        "background",
        "stream",
        "maxCalls",
        "retries",
      ],
      additionalProperties: false,
    },
    __schema35: {
      type: "string",
      enum: ["official-reviewed", "synthetic-test"],
    },
    __schema36: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    },
    __schema37: {
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
        validUntil: {
          type: "string",
          format: "date-time",
          pattern:
            "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
        },
        freshnessPolicy: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
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
      },
      required: [
        "sourceUrl",
        "documentDigest",
        "retrievedAt",
        "reviewedAt",
        "validUntil",
        "freshnessPolicy",
        "reviewerId",
        "excerpt",
      ],
      additionalProperties: false,
    },
    __schema38: {
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 1000000000,
    },
    __schema39: {
      type: "object",
      properties: {
        uncachedInput: {
          $ref: "#/$defs/__schema40",
        },
        cacheReadInput: {
          $ref: "#/$defs/__schema41",
        },
        cacheWriteInput: {
          $ref: "#/$defs/__schema41",
        },
        outputIncludingReasoning: {
          $ref: "#/$defs/__schema40",
        },
      },
      required: ["uncachedInput", "cacheReadInput", "cacheWriteInput", "outputIncludingReasoning"],
      additionalProperties: false,
    },
    __schema40: {
      type: "object",
      properties: {
        units: {
          type: "string",
          pattern: "^(0|[1-9]\\d{0,39})$",
        },
        perTokens: {
          $ref: "#/$defs/__schema38",
        },
      },
      required: ["units", "perTokens"],
      additionalProperties: false,
    },
    __schema41: {
      anyOf: [
        {
          $ref: "#/$defs/__schema40",
        },
        {
          $ref: "#/$defs/__schema42",
        },
      ],
    },
    __schema42: {
      type: "object",
      properties: {
        applicability: {
          type: "string",
          const: "not-applicable",
        },
        explanation: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
        },
      },
      required: ["applicability", "explanation"],
      additionalProperties: false,
    },
    __schema43: {
      type: "object",
      properties: {
        units: {
          $ref: "#/$defs/__schema44",
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
    __schema44: {
      type: "string",
      pattern: "^(0|[1-9]\\d{0,79})$",
    },
    __schema45: {
      type: "object",
      properties: {
        inputTokensReserved: {
          $ref: "#/$defs/__schema46",
        },
        outputTokensReserved: {
          $ref: "#/$defs/__schema46",
        },
        inputUnits: {
          $ref: "#/$defs/__schema44",
        },
        outputUnits: {
          $ref: "#/$defs/__schema44",
        },
        totalUnits: {
          $ref: "#/$defs/__schema44",
        },
      },
      required: [
        "inputTokensReserved",
        "outputTokensReserved",
        "inputUnits",
        "outputUnits",
        "totalUnits",
      ],
      additionalProperties: false,
    },
    __schema46: {
      type: "integer",
      minimum: 0,
      maximum: 9007199254740991,
    },
    __schema47: {
      not: {},
    },
    __schema48: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
    },
    __schema49: {
      type: "object",
      properties: {
        policyVersion: {
          type: "string",
          minLength: 1,
          maxLength: 100,
        },
        notice: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
        },
        sourceUrl: {
          $ref: "#/$defs/__schema50",
        },
        documentDigest: {
          $ref: "#/$defs/__schema3",
        },
        reviewedAt: {
          $ref: "#/$defs/__schema33",
        },
        validUntil: {
          $ref: "#/$defs/__schema33",
        },
      },
      required: [
        "policyVersion",
        "notice",
        "sourceUrl",
        "documentDigest",
        "reviewedAt",
        "validUntil",
      ],
      additionalProperties: false,
    },
    __schema50: {
      type: "string",
      format: "uri",
    },
    __schema51: {
      type: "object",
      properties: {
        configurationDigest: {
          $ref: "#/$defs/__schema3",
        },
        adoption: {
          type: "string",
          const: "not-adopted",
        },
        requestReview: {
          type: "object",
          properties: {
            scope: {
              type: "object",
              properties: {
                version: {
                  $ref: "#/$defs/__schema2",
                },
                versionDigest: {
                  $ref: "#/$defs/__schema3",
                },
                candidateId: {
                  $ref: "#/$defs/__schema4",
                },
                sourceDigest: {
                  $ref: "#/$defs/__schema3",
                },
                candidateDigest: {
                  $ref: "#/$defs/__schema3",
                },
                modelInputDigest: {
                  $ref: "#/$defs/__schema3",
                },
              },
              required: [
                "version",
                "versionDigest",
                "candidateId",
                "sourceDigest",
                "candidateDigest",
                "modelInputDigest",
              ],
              additionalProperties: false,
            },
            model: {
              $ref: "#/$defs/__schema31",
            },
            contract: {
              type: "object",
              properties: {
                schemaVersion: {
                  type: "number",
                  const: 2,
                },
                engineVersion: {
                  type: "string",
                  const: "plan-provider-reservation-v2",
                },
                baseContract: {
                  type: "object",
                  properties: {
                    schemaVersion: {
                      $ref: "#/$defs/__schema52",
                    },
                    engineVersion: {
                      $ref: "#/$defs/__schema53",
                    },
                    provider: {
                      $ref: "#/$defs/__schema54",
                    },
                    endpoint: {
                      $ref: "#/$defs/__schema55",
                    },
                    maxCalls: {
                      $ref: "#/$defs/__schema56",
                    },
                    maxInputChars: {
                      $ref: "#/$defs/__schema57",
                    },
                    maxOutputTokens: {
                      $ref: "#/$defs/__schema58",
                    },
                    timeoutMs: {
                      $ref: "#/$defs/__schema59",
                    },
                    maxRetries: {
                      $ref: "#/$defs/__schema60",
                    },
                    store: {
                      $ref: "#/$defs/__schema61",
                    },
                    repair: {
                      $ref: "#/$defs/__schema62",
                    },
                    phases: {
                      $ref: "#/$defs/__schema63",
                    },
                    contractDigest: {
                      $ref: "#/$defs/__schema65",
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
                requestOptions: {
                  $ref: "#/$defs/__schema66",
                },
                omittedFields: {
                  type: "array",
                  prefixItems: [
                    {
                      type: "string",
                      const: "previous_response_id",
                    },
                    {
                      type: "string",
                      const: "conversation",
                    },
                    {
                      type: "string",
                      const: "tools",
                    },
                    {
                      type: "string",
                      const: "context_management",
                    },
                  ],
                  items: false,
                  minItems: 4,
                  maxItems: 4,
                },
                maxCalls: {
                  type: "number",
                  const: 2,
                },
                maxRetries: {
                  type: "number",
                  const: 0,
                },
                maxOutputTokens: {
                  type: "number",
                  const: 16000,
                },
                contractDigest: {
                  $ref: "#/$defs/__schema3",
                },
              },
              required: [
                "schemaVersion",
                "engineVersion",
                "baseContract",
                "requestOptions",
                "omittedFields",
                "maxCalls",
                "maxRetries",
                "maxOutputTokens",
                "contractDigest",
              ],
              additionalProperties: false,
            },
            generation: {
              type: "object",
              properties: {
                body: {
                  type: "object",
                  properties: {
                    model: {
                      $ref: "#/$defs/__schema71",
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
                          $ref: "#/$defs/__schema72",
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
                          $ref: "#/$defs/__schema73",
                        },
                      },
                      required: ["format"],
                      additionalProperties: false,
                    },
                    service_tier: {
                      $ref: "#/$defs/__schema67",
                    },
                    truncation: {
                      $ref: "#/$defs/__schema68",
                    },
                    background: {
                      $ref: "#/$defs/__schema69",
                    },
                    stream: {
                      $ref: "#/$defs/__schema70",
                    },
                  },
                  required: [
                    "model",
                    "store",
                    "max_output_tokens",
                    "input",
                    "text",
                    "service_tier",
                    "truncation",
                    "background",
                    "stream",
                  ],
                  additionalProperties: false,
                },
                requestDigest: {
                  $ref: "#/$defs/__schema3",
                },
                sha256: {
                  $ref: "#/$defs/__schema3",
                },
                inputChars: {
                  maximum: 240000,
                  $ref: "#/$defs/__schema46",
                },
              },
              required: ["body", "requestDigest", "sha256", "inputChars"],
              additionalProperties: false,
            },
            reviewTemplate: {
              type: "object",
              properties: {
                phase: {
                  type: "string",
                  const: "review",
                },
                complete: {
                  type: "boolean",
                  const: false,
                },
                model: {
                  $ref: "#/$defs/__schema71",
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
                  $ref: "#/$defs/__schema72",
                },
                format: {
                  $ref: "#/$defs/__schema73",
                },
                fixedUserContext: {
                  type: "object",
                  propertyNames: {
                    type: "string",
                  },
                  additionalProperties: {
                    $ref: "#/$defs/__schema75",
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
                  $ref: "#/$defs/__schema76",
                },
                templateDigest: {
                  $ref: "#/$defs/__schema76",
                },
                schemaVersion: {
                  type: "number",
                  const: 2,
                },
                requestOptions: {
                  $ref: "#/$defs/__schema66",
                },
              },
              required: [
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
                "schemaVersion",
                "requestOptions",
              ],
              additionalProperties: false,
            },
          },
          required: ["scope", "model", "contract", "generation", "reviewTemplate"],
          additionalProperties: false,
        },
        proposedBudget: {
          $ref: "#/$defs/__schema77",
        },
        sources: {
          minItems: 1,
          maxItems: 12,
          type: "array",
          items: {
            $ref: "#/$defs/__schema78",
          },
        },
        usagePolicy: {
          type: "object",
          properties: {
            schemaVersion: {
              type: "number",
              const: 1,
            },
            kind: {
              type: "string",
              const: "provider-usage-rate-policy",
            },
            provenance: {
              type: "string",
              const: "official-reviewed",
            },
            financialBasisDigest: {
              $ref: "#/$defs/__schema3",
            },
            configuredModel: {
              $ref: "#/$defs/__schema31",
            },
            responseModels: {
              minItems: 1,
              maxItems: 10,
              type: "array",
              items: {
                $ref: "#/$defs/__schema31",
              },
            },
            requestedTier: {
              type: "string",
              const: "default",
            },
            responseTier: {
              type: "string",
              const: "default",
            },
            inputPartition: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      const: "equal-rates",
                    },
                    basis: {
                      type: "string",
                      minLength: 1,
                      maxLength: 2000,
                    },
                  },
                  required: ["kind", "basis"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      const: "disjoint-cache",
                    },
                    aggregate: {
                      type: "string",
                      const: "input-includes-cache-read-and-write",
                    },
                    cacheRead: {
                      $ref: "#/$defs/__schema79",
                    },
                    cacheWrite: {
                      $ref: "#/$defs/__schema79",
                    },
                    basis: {
                      type: "string",
                      minLength: 1,
                      maxLength: 2000,
                    },
                  },
                  required: ["kind", "aggregate", "cacheRead", "cacheWrite", "basis"],
                  additionalProperties: false,
                },
              ],
            },
            bandSelection: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      const: "short-only",
                    },
                    basis: {
                      type: "string",
                      minLength: 1,
                      maxLength: 2000,
                    },
                  },
                  required: ["kind", "basis"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      const: "input-threshold",
                    },
                    threshold: {
                      maximum: 1000000000,
                      $ref: "#/$defs/__schema46",
                    },
                    basis: {
                      type: "string",
                      minLength: 1,
                      maxLength: 2000,
                    },
                  },
                  required: ["kind", "threshold", "basis"],
                  additionalProperties: false,
                },
              ],
            },
            authority: {
              type: "object",
              properties: {
                sourceUrl: {
                  $ref: "#/$defs/__schema50",
                },
                documentDigest: {
                  $ref: "#/$defs/__schema3",
                },
                reviewedAt: {
                  $ref: "#/$defs/__schema33",
                },
                validUntil: {
                  $ref: "#/$defs/__schema33",
                },
                excerpt: {
                  type: "string",
                  minLength: 1,
                  maxLength: 2000,
                },
              },
              required: ["sourceUrl", "documentDigest", "reviewedAt", "validUntil", "excerpt"],
              additionalProperties: false,
            },
          },
          required: [
            "schemaVersion",
            "kind",
            "provenance",
            "financialBasisDigest",
            "configuredModel",
            "responseModels",
            "requestedTier",
            "responseTier",
            "inputPartition",
            "bandSelection",
            "authority",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "configurationDigest",
        "adoption",
        "requestReview",
        "proposedBudget",
        "sources",
        "usagePolicy",
      ],
      additionalProperties: false,
    },
    __schema52: {
      type: "number",
      const: 1,
    },
    __schema53: {
      type: "string",
      const: "plan-observation-v1",
    },
    __schema54: {
      type: "string",
      const: "OpenAI",
    },
    __schema55: {
      type: "string",
      const: "https://api.openai.com/v1",
    },
    __schema56: {
      type: "number",
      const: 2,
    },
    __schema57: {
      type: "number",
      const: 240000,
    },
    __schema58: {
      type: "number",
      const: 16000,
    },
    __schema59: {
      type: "number",
      const: 120000,
    },
    __schema60: {
      type: "number",
      const: 0,
    },
    __schema61: {
      type: "boolean",
      const: false,
    },
    __schema62: {
      type: "boolean",
      const: false,
    },
    __schema63: {
      minItems: 2,
      maxItems: 2,
      type: "array",
      items: {
        $ref: "#/$defs/__schema64",
      },
    },
    __schema64: {
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
          $ref: "#/$defs/__schema65",
        },
        instructionDigest: {
          $ref: "#/$defs/__schema65",
        },
        schemaDigest: {
          $ref: "#/$defs/__schema65",
        },
      },
      required: ["phase", "name", "systemDigest", "instructionDigest", "schemaDigest"],
      additionalProperties: false,
    },
    __schema65: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema66: {
      type: "object",
      properties: {
        service_tier: {
          $ref: "#/$defs/__schema67",
        },
        truncation: {
          $ref: "#/$defs/__schema68",
        },
        background: {
          $ref: "#/$defs/__schema69",
        },
        stream: {
          $ref: "#/$defs/__schema70",
        },
      },
      required: ["service_tier", "truncation", "background", "stream"],
      additionalProperties: false,
    },
    __schema67: {
      type: "string",
      const: "default",
    },
    __schema68: {
      type: "string",
      const: "disabled",
    },
    __schema69: {
      type: "boolean",
      const: false,
    },
    __schema70: {
      type: "boolean",
      const: false,
    },
    __schema71: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    },
    __schema72: {
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
    __schema73: {
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
            $ref: "#/$defs/__schema74",
          },
        },
      },
      required: ["type", "name", "strict", "schema"],
      additionalProperties: false,
    },
    __schema74: {
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
            $ref: "#/$defs/__schema74",
          },
        },
        {
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {
            $ref: "#/$defs/__schema74",
          },
        },
      ],
    },
    __schema75: {
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
            $ref: "#/$defs/__schema75",
          },
        },
        {
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {
            $ref: "#/$defs/__schema75",
          },
        },
      ],
    },
    __schema76: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema77: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          const: "cumulative-budget-proposal",
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
          $ref: "#/$defs/__schema44",
        },
        status: {
          type: "string",
          const: "not-approved",
        },
        basis: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
        },
      },
      required: ["kind", "currency", "unitScale", "capUnits", "status", "basis"],
      additionalProperties: false,
    },
    __schema78: {
      type: "object",
      properties: {
        id: {
          type: "string",
          pattern: "^[a-z0-9-]{1,100}$",
        },
        url: {
          $ref: "#/$defs/__schema50",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 300,
        },
        retrievedAt: {
          $ref: "#/$defs/__schema33",
        },
        reviewedAt: {
          $ref: "#/$defs/__schema33",
        },
        validUntil: {
          $ref: "#/$defs/__schema33",
        },
        excerpt: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
        },
        excerptSha256: {
          $ref: "#/$defs/__schema3",
        },
        bodySha256: {
          anyOf: [
            {
              $ref: "#/$defs/__schema3",
            },
            {
              type: "null",
            },
          ],
        },
        digestKind: {
          type: "string",
          enum: ["body", "curated-record"],
        },
        recordDigest: {
          $ref: "#/$defs/__schema3",
        },
      },
      required: [
        "id",
        "url",
        "title",
        "retrievedAt",
        "reviewedAt",
        "validUntil",
        "excerpt",
        "excerptSha256",
        "bodySha256",
        "digestKind",
        "recordDigest",
      ],
      additionalProperties: false,
    },
    __schema79: {
      oneOf: [
        {
          type: "object",
          properties: {
            kind: {
              type: "string",
              const: "field",
            },
            path: {
              minItems: 1,
              maxItems: 5,
              type: "array",
              items: {
                $ref: "#/$defs/__schema80",
              },
            },
          },
          required: ["kind", "path"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: {
              type: "string",
              const: "not-applicable",
            },
            basis: {
              type: "string",
              minLength: 1,
              maxLength: 2000,
            },
          },
          required: ["kind", "basis"],
          additionalProperties: false,
        },
      ],
    },
    __schema80: {
      type: "string",
      pattern: "^[A-Za-z_][A-Za-z0-9_]{0,79}$",
    },
    __schema81: {
      minItems: 4,
      maxItems: 4,
      type: "array",
      items: {
        $ref: "#/$defs/__schema82",
      },
    },
    __schema82: {
      type: "object",
      properties: {
        code: {
          type: "string",
          enum: [
            "CONFIGURATION_NOT_ADOPTED",
            "BUDGET_NOT_CONFIGURED",
            "ACCOUNT_ACCESS_NOT_CHECKED",
            "PRODUCTION_EXECUTION_DISABLED",
          ],
        },
        message: {
          type: "string",
        },
      },
      required: ["code", "message"],
      additionalProperties: false,
    },
    __schema83: {
      type: "number",
      const: 1,
    },
    __schema84: {
      type: "string",
      const: "provider-policy-review",
    },
    __schema85: {
      type: "string",
      const: "production",
    },
    __schema86: {
      type: "string",
      const: "registered-synthetic-candidate",
    },
    __schema87: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    __schema88: {
      type: "object",
      properties: {
        configurationDigest: {
          $ref: "#/$defs/__schema89",
        },
        requestReviewDigest: {
          $ref: "#/$defs/__schema89",
        },
        financialBasisDigest: {
          $ref: "#/$defs/__schema89",
        },
        retentionDigest: {
          $ref: "#/$defs/__schema89",
        },
        usagePolicyDigest: {
          $ref: "#/$defs/__schema89",
        },
        model: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
        },
      },
      required: [
        "configurationDigest",
        "requestReviewDigest",
        "financialBasisDigest",
        "retentionDigest",
        "usagePolicyDigest",
        "model",
      ],
      additionalProperties: false,
    },
    __schema89: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema90: {
      type: "object",
      properties: {
        scopeId: {
          type: "string",
          const: "candidate-quality-provider-v2-live",
        },
        revision: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
        },
        headDigest: {
          anyOf: [
            {
              $ref: "#/$defs/__schema89",
            },
            {
              type: "null",
            },
          ],
        },
        currency: {
          anyOf: [
            {
              type: "string",
              pattern: "^[A-Z]{3}$",
            },
            {
              type: "null",
            },
          ],
        },
        unitScale: {
          anyOf: [
            {
              type: "integer",
              minimum: 0,
              maximum: 12,
            },
            {
              type: "null",
            },
          ],
        },
        capUnits: {
          $ref: "#/$defs/__schema91",
        },
        heldUnits: {
          $ref: "#/$defs/__schema91",
        },
        recognizedUnits: {
          $ref: "#/$defs/__schema91",
        },
        availableUnits: {
          $ref: "#/$defs/__schema91",
        },
        deficitUnits: {
          $ref: "#/$defs/__schema91",
        },
        boundBreached: {
          type: "boolean",
        },
      },
      required: [
        "scopeId",
        "revision",
        "headDigest",
        "currency",
        "unitScale",
        "capUnits",
        "heldUnits",
        "recognizedUnits",
        "availableUnits",
        "deficitUnits",
        "boundBreached",
      ],
      additionalProperties: false,
    },
    __schema91: {
      type: "string",
      pattern: "^(0|[1-9]\\d{0,79})$",
    },
    __schema92: {
      type: "object",
      properties: {
        generationUnits: {
          $ref: "#/$defs/__schema91",
        },
        reviewUnits: {
          $ref: "#/$defs/__schema91",
        },
        totalUnits: {
          $ref: "#/$defs/__schema91",
        },
      },
      required: ["generationUnits", "reviewUnits", "totalUnits"],
      additionalProperties: false,
    },
    __schema93: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: [
            "budget-not-configured",
            "budget-configured",
            "budget-insufficient",
            "budget-incompatible",
            "budget-bound-breached",
          ],
        },
        basis: {
          type: "string",
          enum: ["existing-budget", "unapproved-proposal", "incompatible"],
        },
        availableBeforeReservationUnits: {
          anyOf: [
            {
              $ref: "#/$defs/__schema91",
            },
            {
              type: "null",
            },
          ],
        },
        availableAfterReservationUnits: {
          anyOf: [
            {
              $ref: "#/$defs/__schema91",
            },
            {
              type: "null",
            },
          ],
        },
        shortfallUnits: {
          anyOf: [
            {
              $ref: "#/$defs/__schema91",
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: [
        "state",
        "basis",
        "availableBeforeReservationUnits",
        "availableAfterReservationUnits",
        "shortfallUnits",
      ],
      additionalProperties: false,
    },
    __schema94: {
      type: "string",
      const: "not-checked",
    },
    __schema95: {
      type: "object",
      properties: {
        policyAdoptionAllowed: {
          type: "boolean",
          const: false,
        },
        budgetWriteAllowed: {
          type: "boolean",
          const: false,
        },
        reservationAllowed: {
          type: "boolean",
          const: false,
        },
        dispatchAllowed: {
          type: "boolean",
          const: false,
        },
      },
      required: [
        "policyAdoptionAllowed",
        "budgetWriteAllowed",
        "reservationAllowed",
        "dispatchAllowed",
      ],
      additionalProperties: false,
    },
    __schema96: {
      type: "string",
      const:
        "운영 정책과 누적 예산의 검토 자료입니다. 정책 채택·예산 설정·비용 예약·AI 전송은 실행되지 않습니다.",
    },
    __schema97: {
      type: "object",
      properties: {
        revision: {
          $ref: "#/$defs/__schema98",
        },
        headDigest: {
          $ref: "#/$defs/__schema99",
        },
      },
      required: ["revision", "headDigest"],
      additionalProperties: false,
    },
    __schema98: {
      type: "integer",
      minimum: 0,
      maximum: 1000,
    },
    __schema99: {
      anyOf: [
        {
          $ref: "#/$defs/__schema89",
        },
        {
          type: "null",
        },
      ],
    },
  },
};
