// Frozen reservation binding/coverage v1. Never regenerate to reinterpret archived records.
// Semantic refinements are enforced by the native archive validator; shape parity is tested.
export const providerReservationBindingJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    recordVersion: {
      type: "number",
      const: 1,
    },
    kind: {
      type: "string",
      const: "provider-reservation-policy-binding",
    },
    clientRequestId: {
      $ref: "#/$defs/__schema0",
    },
    command: {
      type: "object",
      properties: {
        version: {
          $ref: "#/$defs/__schema1",
        },
        versionDigest: {
          $ref: "#/$defs/__schema2",
        },
        candidateId: {
          $ref: "#/$defs/__schema3",
        },
        commandVersion: {
          $ref: "#/$defs/__schema4",
        },
        kind: {
          $ref: "#/$defs/__schema5",
        },
        clientRequestId: {
          $ref: "#/$defs/__schema6",
        },
        approvedReviewDigest: {
          $ref: "#/$defs/__schema7",
        },
        expectedLedgerDigest: {
          $ref: "#/$defs/__schema7",
        },
        expectedPolicyHead: {
          $ref: "#/$defs/__schema8",
        },
        expectedPolicyReference: {
          $ref: "#/$defs/__schema11",
        },
        expectedBudgetHead: {
          $ref: "#/$defs/__schema12",
        },
        expectedGlobalRunCount: {
          $ref: "#/$defs/__schema13",
        },
        expectedProductionRunCount: {
          $ref: "#/$defs/__schema14",
        },
        approval: {
          $ref: "#/$defs/__schema15",
        },
      },
      required: [
        "version",
        "versionDigest",
        "candidateId",
        "commandVersion",
        "kind",
        "clientRequestId",
        "approvedReviewDigest",
        "expectedLedgerDigest",
        "expectedPolicyHead",
        "expectedPolicyReference",
        "expectedBudgetHead",
        "expectedGlobalRunCount",
        "expectedProductionRunCount",
        "approval",
      ],
      additionalProperties: false,
    },
    commandDigest: {
      $ref: "#/$defs/__schema16",
    },
    approvedReview: {
      type: "object",
      properties: {
        schemaVersion: {
          $ref: "#/$defs/__schema17",
        },
        kind: {
          $ref: "#/$defs/__schema18",
        },
        policyReview: {
          $ref: "#/$defs/__schema19",
        },
        ledgerDigest: {
          $ref: "#/$defs/__schema36",
        },
        policyHead: {
          $ref: "#/$defs/__schema8",
        },
        policy: {
          $ref: "#/$defs/__schema37",
        },
        runs: {
          $ref: "#/$defs/__schema38",
        },
        assessment: {
          $ref: "#/$defs/__schema40",
        },
        nextStep: {
          $ref: "#/$defs/__schema42",
        },
        actions: {
          $ref: "#/$defs/__schema43",
        },
        notice: {
          $ref: "#/$defs/__schema44",
        },
        reviewDigest: {
          $ref: "#/$defs/__schema36",
        },
      },
      required: [
        "schemaVersion",
        "kind",
        "policyReview",
        "ledgerDigest",
        "policyHead",
        "policy",
        "runs",
        "assessment",
        "nextStep",
        "actions",
        "notice",
        "reviewDigest",
      ],
      additionalProperties: false,
    },
    runId: {
      $ref: "#/$defs/__schema0",
    },
    runDigest: {
      $ref: "#/$defs/__schema16",
    },
    startInputDigest: {
      $ref: "#/$defs/__schema16",
    },
    recordedAt: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    dispatchAllowed: {
      type: "boolean",
      const: false,
    },
    recordDigest: {
      $ref: "#/$defs/__schema16",
    },
  },
  required: [
    "recordVersion",
    "kind",
    "clientRequestId",
    "command",
    "commandDigest",
    "approvedReview",
    "runId",
    "runDigest",
    "startInputDigest",
    "recordedAt",
    "dispatchAllowed",
    "recordDigest",
  ],
  additionalProperties: false,
  $defs: {
    __schema0: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    __schema1: {
      type: "integer",
      minimum: 1,
      maximum: 20,
    },
    __schema2: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema3: {
      type: "string",
      maxLength: 120,
      pattern: "^validation-candidate-[a-z0-9-]+$",
    },
    __schema4: {
      type: "number",
      const: 1,
    },
    __schema5: {
      type: "string",
      const: "reserve-provider-candidate",
    },
    __schema6: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    __schema7: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
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
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        },
        {
          type: "null",
        },
      ],
    },
    __schema11: {
      type: "object",
      properties: {
        revision: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        recordDigest: {
          $ref: "#/$defs/__schema7",
        },
        clientRequestId: {
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
      },
      required: ["revision", "recordDigest", "clientRequestId", "recordedAt"],
      additionalProperties: false,
    },
    __schema12: {
      type: "object",
      properties: {
        revision: {
          type: "integer",
          minimum: 1,
          maximum: 999,
        },
        headDigest: {
          $ref: "#/$defs/__schema7",
        },
      },
      required: ["revision", "headDigest"],
      additionalProperties: false,
    },
    __schema13: {
      type: "integer",
      minimum: 0,
      maximum: 19,
    },
    __schema14: {
      type: "integer",
      minimum: 0,
      maximum: 19,
    },
    __schema15: {
      type: "object",
      properties: {
        noticeVersion: {
          type: "number",
          const: 1,
        },
        acknowledgedCandidate: {
          type: "boolean",
          const: true,
        },
        acknowledgedCurrentBudget: {
          type: "boolean",
          const: true,
        },
        acknowledgedReservationOnly: {
          type: "boolean",
          const: true,
        },
        acknowledgedFinancialBasisNotTokenFit: {
          type: "boolean",
          const: true,
        },
        acknowledgedRetention: {
          type: "boolean",
          const: true,
        },
        acknowledgedNoAutomaticRetry: {
          type: "boolean",
          const: true,
        },
        transmission: {
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
        "acknowledgedCandidate",
        "acknowledgedCurrentBudget",
        "acknowledgedReservationOnly",
        "acknowledgedFinancialBasisNotTokenFit",
        "acknowledgedRetention",
        "acknowledgedNoAutomaticRetry",
        "transmission",
        "approvedAt",
      ],
      additionalProperties: false,
    },
    __schema16: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema17: {
      type: "number",
      const: 1,
    },
    __schema18: {
      type: "string",
      const: "provider-reservation-review",
    },
    __schema19: {
      type: "object",
      properties: {
        schemaVersion: {
          $ref: "#/$defs/__schema20",
        },
        kind: {
          $ref: "#/$defs/__schema21",
        },
        environment: {
          $ref: "#/$defs/__schema22",
        },
        inputProvenance: {
          $ref: "#/$defs/__schema23",
        },
        scope: {
          $ref: "#/$defs/__schema24",
        },
        inspectedAt: {
          $ref: "#/$defs/__schema25",
        },
        expiresAt: {
          $ref: "#/$defs/__schema25",
        },
        bindings: {
          $ref: "#/$defs/__schema26",
        },
        budget: {
          $ref: "#/$defs/__schema28",
        },
        proposedBudget: {
          $ref: "#/$defs/__schema30",
        },
        reservation: {
          $ref: "#/$defs/__schema31",
        },
        assessment: {
          $ref: "#/$defs/__schema32",
        },
        accountAccess: {
          $ref: "#/$defs/__schema33",
        },
        actions: {
          $ref: "#/$defs/__schema34",
        },
        notice: {
          $ref: "#/$defs/__schema35",
        },
        reviewDigest: {
          $ref: "#/$defs/__schema27",
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
    __schema20: {
      type: "number",
      const: 1,
    },
    __schema21: {
      type: "string",
      const: "provider-policy-review",
    },
    __schema22: {
      type: "string",
      const: "production",
    },
    __schema23: {
      type: "string",
      const: "registered-synthetic-candidate",
    },
    __schema24: {
      type: "object",
      properties: {
        version: {
          $ref: "#/$defs/__schema1",
        },
        versionDigest: {
          $ref: "#/$defs/__schema2",
        },
        candidateId: {
          $ref: "#/$defs/__schema3",
        },
        setId: {
          type: "string",
          const: "ai-validation-candidates",
        },
        registrySourceDigest: {
          $ref: "#/$defs/__schema2",
        },
        manifestDigest: {
          $ref: "#/$defs/__schema2",
        },
        label: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        sourceDigest: {
          $ref: "#/$defs/__schema2",
        },
        candidateDigest: {
          $ref: "#/$defs/__schema2",
        },
        modelInputDigest: {
          $ref: "#/$defs/__schema2",
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
    __schema25: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    __schema26: {
      type: "object",
      properties: {
        configurationDigest: {
          $ref: "#/$defs/__schema27",
        },
        requestReviewDigest: {
          $ref: "#/$defs/__schema27",
        },
        financialBasisDigest: {
          $ref: "#/$defs/__schema27",
        },
        retentionDigest: {
          $ref: "#/$defs/__schema27",
        },
        usagePolicyDigest: {
          $ref: "#/$defs/__schema27",
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
    __schema27: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema28: {
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
              $ref: "#/$defs/__schema27",
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
          $ref: "#/$defs/__schema29",
        },
        heldUnits: {
          $ref: "#/$defs/__schema29",
        },
        recognizedUnits: {
          $ref: "#/$defs/__schema29",
        },
        availableUnits: {
          $ref: "#/$defs/__schema29",
        },
        deficitUnits: {
          $ref: "#/$defs/__schema29",
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
    __schema29: {
      type: "string",
      pattern: "^(0|[1-9]\\d{0,79})$",
    },
    __schema30: {
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
          type: "string",
          pattern: "^(0|[1-9]\\d{0,79})$",
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
    __schema31: {
      type: "object",
      properties: {
        generationUnits: {
          $ref: "#/$defs/__schema29",
        },
        reviewUnits: {
          $ref: "#/$defs/__schema29",
        },
        totalUnits: {
          $ref: "#/$defs/__schema29",
        },
      },
      required: ["generationUnits", "reviewUnits", "totalUnits"],
      additionalProperties: false,
    },
    __schema32: {
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
              $ref: "#/$defs/__schema29",
            },
            {
              type: "null",
            },
          ],
        },
        availableAfterReservationUnits: {
          anyOf: [
            {
              $ref: "#/$defs/__schema29",
            },
            {
              type: "null",
            },
          ],
        },
        shortfallUnits: {
          anyOf: [
            {
              $ref: "#/$defs/__schema29",
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
    __schema33: {
      type: "string",
      const: "not-checked",
    },
    __schema34: {
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
    __schema35: {
      type: "string",
      const:
        "운영 정책과 누적 예산의 검토 자료입니다. 정책 채택·예산 설정·비용 예약·AI 전송은 실행되지 않습니다.",
    },
    __schema36: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema37: {
      oneOf: [
        {
          type: "object",
          properties: {
            state: {
              type: "string",
              const: "not-adopted",
            },
            reference: {
              type: "null",
            },
          },
          required: ["state", "reference"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            state: {
              type: "string",
              enum: ["matched", "changed"],
            },
            reference: {
              type: "object",
              properties: {
                revision: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                },
                recordDigest: {
                  $ref: "#/$defs/__schema36",
                },
                clientRequestId: {
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
              },
              required: ["revision", "recordDigest", "clientRequestId", "recordedAt"],
              additionalProperties: false,
            },
          },
          required: ["state", "reference"],
          additionalProperties: false,
        },
      ],
    },
    __schema38: {
      type: "object",
      properties: {
        globalCount: {
          type: "integer",
          minimum: 0,
          maximum: 20,
        },
        productionCount: {
          type: "integer",
          minimum: 0,
          maximum: 20,
        },
        unsettledCandidateRunIds: {
          maxItems: 20,
          type: "array",
          items: {
            $ref: "#/$defs/__schema39",
          },
        },
      },
      required: ["globalCount", "productionCount", "unsettledCandidateRunIds"],
      additionalProperties: false,
    },
    __schema39: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    __schema40: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["conditions-met", "blocked"],
        },
        blockers: {
          maxItems: 8,
          type: "array",
          items: {
            $ref: "#/$defs/__schema41",
          },
        },
      },
      required: ["state", "blockers"],
      additionalProperties: false,
    },
    __schema41: {
      type: "string",
      enum: [
        "policy-not-adopted",
        "policy-changed",
        "budget-not-configured",
        "budget-insufficient",
        "budget-incompatible",
        "budget-bound-breached",
        "candidate-unsettled",
        "run-limit",
      ],
    },
    __schema42: {
      type: "string",
      const: "separate-reservation-command-required",
    },
    __schema43: {
      type: "object",
      properties: {
        reservationAllowed: {
          type: "boolean",
          const: false,
        },
        dispatchAllowed: {
          type: "boolean",
          const: false,
        },
        budgetWriteAllowed: {
          type: "boolean",
          const: false,
        },
      },
      required: ["reservationAllowed", "dispatchAllowed", "budgetWriteAllowed"],
      additionalProperties: false,
    },
    __schema44: {
      type: "string",
      const:
        "채택 정책과 현재 누적 예산을 대조한 예약 검토입니다. 별도의 예약 명령과 전송 승인이 필요하며 비용 예약·AI 전송은 실행되지 않습니다.",
    },
  },
};
export const providerReservationCoverageJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    coverageVersion: {
      type: "number",
      const: 1,
    },
    kind: {
      type: "string",
      const: "provider-reservation-binding-coverage",
    },
    cutoverGlobalRunCount: {
      type: "integer",
      minimum: 0,
      maximum: 20,
    },
    cutoverRunPrefixDigest: {
      $ref: "#/$defs/__schema0",
    },
    legacyProductionRuns: {
      maxItems: 20,
      type: "array",
      items: {
        $ref: "#/$defs/__schema1",
      },
    },
    coverageDigest: {
      $ref: "#/$defs/__schema0",
    },
  },
  required: [
    "coverageVersion",
    "kind",
    "cutoverGlobalRunCount",
    "cutoverRunPrefixDigest",
    "legacyProductionRuns",
    "coverageDigest",
  ],
  additionalProperties: false,
  $defs: {
    __schema0: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema1: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        },
        runDigest: {
          $ref: "#/$defs/__schema0",
        },
      },
      required: ["runId", "runDigest"],
      additionalProperties: false,
    },
  },
};
