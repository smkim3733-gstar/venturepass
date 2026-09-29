// Frozen transmission approval binding/coverage v1. Never regenerate to reinterpret archives.
// Semantic refinements live in the native reader; shape parity is tested.
export const providerTransmissionApprovalBindingJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    recordVersion: {
      type: "number",
      const: 1,
    },
    kind: {
      type: "string",
      const: "provider-transmission-approval-binding",
    },
    clientRequestId: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    command: {
      type: "object",
      properties: {
        runId: {
          $ref: "#/$defs/__schema0",
        },
        runDigest: {
          $ref: "#/$defs/__schema1",
        },
        commandVersion: {
          $ref: "#/$defs/__schema2",
        },
        kind: {
          $ref: "#/$defs/__schema3",
        },
        clientRequestId: {
          $ref: "#/$defs/__schema4",
        },
        approvedReviewDigest: {
          $ref: "#/$defs/__schema5",
        },
        expectedArchiveDigest: {
          $ref: "#/$defs/__schema5",
        },
        expectedCoverageDigest: {
          $ref: "#/$defs/__schema5",
        },
        expectedReservationBindingDigest: {
          $ref: "#/$defs/__schema5",
        },
        expectedManifestDigest: {
          $ref: "#/$defs/__schema5",
        },
        expectedRun: {
          $ref: "#/$defs/__schema6",
        },
        expectedPolicyHead: {
          $ref: "#/$defs/__schema7",
        },
        expectedPolicyReference: {
          $ref: "#/$defs/__schema10",
        },
        expectedBudgetHead: {
          $ref: "#/$defs/__schema11",
        },
        approval: {
          $ref: "#/$defs/__schema12",
        },
      },
      required: [
        "runId",
        "runDigest",
        "commandVersion",
        "kind",
        "clientRequestId",
        "approvedReviewDigest",
        "expectedArchiveDigest",
        "expectedCoverageDigest",
        "expectedReservationBindingDigest",
        "expectedManifestDigest",
        "expectedRun",
        "expectedPolicyHead",
        "expectedPolicyReference",
        "expectedBudgetHead",
        "approval",
      ],
      additionalProperties: false,
    },
    commandDigest: {
      $ref: "#/$defs/__schema13",
    },
    approvedReview: {
      type: "object",
      properties: {
        schemaVersion: {
          $ref: "#/$defs/__schema14",
        },
        kind: {
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
          $ref: "#/$defs/__schema22",
        },
        expiresAt: {
          $ref: "#/$defs/__schema22",
        },
        archiveDigest: {
          $ref: "#/$defs/__schema1",
        },
        coverageDigest: {
          $ref: "#/$defs/__schema1",
        },
        configurationDigest: {
          $ref: "#/$defs/__schema1",
        },
        run: {
          $ref: "#/$defs/__schema23",
        },
        reservation: {
          $ref: "#/$defs/__schema24",
        },
        policy: {
          $ref: "#/$defs/__schema26",
        },
        budget: {
          $ref: "#/$defs/__schema28",
        },
        request: {
          $ref: "#/$defs/__schema30",
        },
        financialBasis: {
          $ref: "#/$defs/__schema58",
        },
        retention: {
          $ref: "#/$defs/__schema74",
        },
        manifest: {
          $ref: "#/$defs/__schema76",
        },
        facts: {
          $ref: "#/$defs/__schema79",
        },
        assessment: {
          $ref: "#/$defs/__schema80",
        },
        accountAccess: {
          $ref: "#/$defs/__schema82",
        },
        actions: {
          $ref: "#/$defs/__schema83",
        },
        nextStep: {
          $ref: "#/$defs/__schema84",
        },
        notice: {
          $ref: "#/$defs/__schema85",
        },
        reviewDigest: {
          $ref: "#/$defs/__schema1",
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
        "archiveDigest",
        "coverageDigest",
        "configurationDigest",
        "run",
        "reservation",
        "policy",
        "budget",
        "request",
        "financialBasis",
        "retention",
        "manifest",
        "facts",
        "assessment",
        "accountAccess",
        "actions",
        "nextStep",
        "notice",
        "reviewDigest",
      ],
      additionalProperties: false,
    },
    runId: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    runDigest: {
      $ref: "#/$defs/__schema13",
    },
    executionInputDigest: {
      $ref: "#/$defs/__schema13",
    },
    approvalEventDigest: {
      $ref: "#/$defs/__schema13",
    },
    approvalRevision: {
      type: "number",
      const: 1,
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
      $ref: "#/$defs/__schema13",
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
    "executionInputDigest",
    "approvalEventDigest",
    "approvalRevision",
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
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema2: {
      type: "number",
      const: 1,
    },
    __schema3: {
      type: "string",
      const: "approve-provider-transmission",
    },
    __schema4: {
      type: "string",
      format: "uuid",
      pattern:
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    },
    __schema5: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema6: {
      type: "object",
      properties: {
        revision: {
          type: "number",
          const: 0,
        },
        snapshotDigest: {
          $ref: "#/$defs/__schema5",
        },
      },
      required: ["revision", "snapshotDigest"],
      additionalProperties: false,
    },
    __schema7: {
      type: "object",
      properties: {
        revision: {
          $ref: "#/$defs/__schema8",
        },
        headDigest: {
          $ref: "#/$defs/__schema9",
        },
      },
      required: ["revision", "headDigest"],
      additionalProperties: false,
    },
    __schema8: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    __schema9: {
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
    __schema10: {
      type: "object",
      properties: {
        revision: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        recordDigest: {
          $ref: "#/$defs/__schema5",
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
    __schema11: {
      type: "object",
      properties: {
        revision: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
        },
        headDigest: {
          $ref: "#/$defs/__schema5",
        },
      },
      required: ["revision", "headDigest"],
      additionalProperties: false,
    },
    __schema12: {
      type: "object",
      properties: {
        noticeVersion: {
          type: "number",
          const: 1,
        },
        acknowledgedExternalTransmission: {
          type: "boolean",
          const: true,
        },
        acknowledgedGenerationAndDerivedReview: {
          type: "boolean",
          const: true,
        },
        acknowledgedRetentionNoticeDigest: {
          $ref: "#/$defs/__schema5",
        },
        acknowledgedFinancialReservationNotTokenFit: {
          type: "boolean",
          const: true,
        },
        acknowledgedUnknownCostHoldAndNoRetry: {
          type: "boolean",
          const: true,
        },
        acknowledgedCurrentPolicyAndBudget: {
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
        "noticeVersion",
        "acknowledgedExternalTransmission",
        "acknowledgedGenerationAndDerivedReview",
        "acknowledgedRetentionNoticeDigest",
        "acknowledgedFinancialReservationNotTokenFit",
        "acknowledgedUnknownCostHoldAndNoRetry",
        "acknowledgedCurrentPolicyAndBudget",
        "approvedAt",
      ],
      additionalProperties: false,
    },
    __schema13: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema14: {
      type: "number",
      const: 1,
    },
    __schema15: {
      type: "string",
      const: "provider-transmission-review",
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
          $ref: "#/$defs/__schema19",
        },
        versionDigest: {
          $ref: "#/$defs/__schema20",
        },
        candidateId: {
          $ref: "#/$defs/__schema21",
        },
        setId: {
          type: "string",
          const: "ai-validation-candidates",
        },
        registrySourceDigest: {
          $ref: "#/$defs/__schema20",
        },
        manifestDigest: {
          $ref: "#/$defs/__schema20",
        },
        label: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
        sourceDigest: {
          $ref: "#/$defs/__schema20",
        },
        candidateDigest: {
          $ref: "#/$defs/__schema20",
        },
        modelInputDigest: {
          $ref: "#/$defs/__schema20",
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
      type: "integer",
      minimum: 1,
      maximum: 20,
    },
    __schema20: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema21: {
      type: "string",
      maxLength: 120,
      pattern: "^validation-candidate-[a-z0-9-]+$",
    },
    __schema22: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    __schema23: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        },
        runDigest: {
          $ref: "#/$defs/__schema1",
        },
        preparationDigest: {
          $ref: "#/$defs/__schema1",
        },
        recordedAt: {
          $ref: "#/$defs/__schema22",
        },
        preparedAt: {
          $ref: "#/$defs/__schema22",
        },
        preparationExpiresAt: {
          $ref: "#/$defs/__schema22",
        },
        revision: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
        },
        archiveFormatVersion: {
          anyOf: [
            {
              type: "number",
              const: 2,
            },
            {
              type: "number",
              const: 3,
            },
          ],
        },
        state: {
          type: "string",
          enum: [
            "reserved",
            "cancelled-before-dispatch",
            "approved",
            "prepared",
            "dispatching",
            "response-recorded",
            "validated",
            "completed",
            "before-dispatch",
            "result-unobserved",
            "needs-cost-review",
            "output-invalid",
            "bound-breached",
          ],
        },
        snapshotDigest: {
          $ref: "#/$defs/__schema1",
        },
      },
      required: [
        "id",
        "runDigest",
        "preparationDigest",
        "recordedAt",
        "preparedAt",
        "preparationExpiresAt",
        "revision",
        "archiveFormatVersion",
        "state",
        "snapshotDigest",
      ],
      additionalProperties: false,
    },
    __schema24: {
      type: "object",
      properties: {
        bindingDigest: {
          $ref: "#/$defs/__schema1",
        },
        clientRequestId: {
          type: "string",
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        },
        approvedReviewDigest: {
          $ref: "#/$defs/__schema1",
        },
        reservationDigest: {
          $ref: "#/$defs/__schema1",
        },
        generationUnits: {
          $ref: "#/$defs/__schema25",
        },
        reviewUnits: {
          $ref: "#/$defs/__schema25",
        },
        totalUnits: {
          $ref: "#/$defs/__schema25",
        },
        heldUnits: {
          $ref: "#/$defs/__schema25",
        },
        generationHeldUnits: {
          $ref: "#/$defs/__schema25",
        },
        reviewHeldUnits: {
          $ref: "#/$defs/__schema25",
        },
        generationSettled: {
          type: "boolean",
        },
        reviewSettled: {
          type: "boolean",
        },
      },
      required: [
        "bindingDigest",
        "clientRequestId",
        "approvedReviewDigest",
        "reservationDigest",
        "generationUnits",
        "reviewUnits",
        "totalUnits",
        "heldUnits",
        "generationHeldUnits",
        "reviewHeldUnits",
        "generationSettled",
        "reviewSettled",
      ],
      additionalProperties: false,
    },
    __schema25: {
      type: "string",
      pattern: "^(0|[1-9]\\d{0,79})$",
    },
    __schema26: {
      type: "object",
      properties: {
        head: {
          $ref: "#/$defs/__schema7",
        },
        reservedReference: {
          $ref: "#/$defs/__schema27",
        },
        currentReference: {
          anyOf: [
            {
              $ref: "#/$defs/__schema27",
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: ["head", "reservedReference", "currentReference"],
      additionalProperties: false,
    },
    __schema27: {
      type: "object",
      properties: {
        revision: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        recordDigest: {
          $ref: "#/$defs/__schema1",
        },
        clientRequestId: {
          type: "string",
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        },
        recordedAt: {
          $ref: "#/$defs/__schema22",
        },
      },
      required: ["revision", "recordDigest", "clientRequestId", "recordedAt"],
      additionalProperties: false,
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
              type: "string",
              pattern: "^[a-f0-9]{64}$",
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
        scope: {
          type: "object",
          properties: {
            version: {
              $ref: "#/$defs/__schema19",
            },
            versionDigest: {
              $ref: "#/$defs/__schema20",
            },
            candidateId: {
              $ref: "#/$defs/__schema21",
            },
            sourceDigest: {
              $ref: "#/$defs/__schema20",
            },
            candidateDigest: {
              $ref: "#/$defs/__schema20",
            },
            modelInputDigest: {
              $ref: "#/$defs/__schema20",
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
                  $ref: "#/$defs/__schema32",
                },
                engineVersion: {
                  $ref: "#/$defs/__schema33",
                },
                provider: {
                  $ref: "#/$defs/__schema34",
                },
                endpoint: {
                  $ref: "#/$defs/__schema35",
                },
                maxCalls: {
                  $ref: "#/$defs/__schema36",
                },
                maxInputChars: {
                  $ref: "#/$defs/__schema37",
                },
                maxOutputTokens: {
                  $ref: "#/$defs/__schema38",
                },
                timeoutMs: {
                  $ref: "#/$defs/__schema39",
                },
                maxRetries: {
                  $ref: "#/$defs/__schema40",
                },
                store: {
                  $ref: "#/$defs/__schema41",
                },
                repair: {
                  $ref: "#/$defs/__schema42",
                },
                phases: {
                  $ref: "#/$defs/__schema43",
                },
                contractDigest: {
                  $ref: "#/$defs/__schema45",
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
              $ref: "#/$defs/__schema46",
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
              $ref: "#/$defs/__schema20",
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
                  $ref: "#/$defs/__schema51",
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
                      $ref: "#/$defs/__schema52",
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
                      $ref: "#/$defs/__schema53",
                    },
                  },
                  required: ["format"],
                  additionalProperties: false,
                },
                service_tier: {
                  $ref: "#/$defs/__schema47",
                },
                truncation: {
                  $ref: "#/$defs/__schema48",
                },
                background: {
                  $ref: "#/$defs/__schema49",
                },
                stream: {
                  $ref: "#/$defs/__schema50",
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
              $ref: "#/$defs/__schema20",
            },
            sha256: {
              $ref: "#/$defs/__schema20",
            },
            inputChars: {
              maximum: 240000,
              $ref: "#/$defs/__schema55",
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
              $ref: "#/$defs/__schema51",
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
              $ref: "#/$defs/__schema52",
            },
            format: {
              $ref: "#/$defs/__schema53",
            },
            fixedUserContext: {
              type: "object",
              propertyNames: {
                type: "string",
              },
              additionalProperties: {
                $ref: "#/$defs/__schema56",
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
              $ref: "#/$defs/__schema57",
            },
            templateDigest: {
              $ref: "#/$defs/__schema57",
            },
            schemaVersion: {
              type: "number",
              const: 2,
            },
            requestOptions: {
              $ref: "#/$defs/__schema46",
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
    __schema31: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    },
    __schema32: {
      type: "number",
      const: 1,
    },
    __schema33: {
      type: "string",
      const: "plan-observation-v1",
    },
    __schema34: {
      type: "string",
      const: "OpenAI",
    },
    __schema35: {
      type: "string",
      const: "https://api.openai.com/v1",
    },
    __schema36: {
      type: "number",
      const: 2,
    },
    __schema37: {
      type: "number",
      const: 240000,
    },
    __schema38: {
      type: "number",
      const: 16000,
    },
    __schema39: {
      type: "number",
      const: 120000,
    },
    __schema40: {
      type: "number",
      const: 0,
    },
    __schema41: {
      type: "boolean",
      const: false,
    },
    __schema42: {
      type: "boolean",
      const: false,
    },
    __schema43: {
      minItems: 2,
      maxItems: 2,
      type: "array",
      items: {
        $ref: "#/$defs/__schema44",
      },
    },
    __schema44: {
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
          $ref: "#/$defs/__schema45",
        },
        instructionDigest: {
          $ref: "#/$defs/__schema45",
        },
        schemaDigest: {
          $ref: "#/$defs/__schema45",
        },
      },
      required: ["phase", "name", "systemDigest", "instructionDigest", "schemaDigest"],
      additionalProperties: false,
    },
    __schema45: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema46: {
      type: "object",
      properties: {
        service_tier: {
          $ref: "#/$defs/__schema47",
        },
        truncation: {
          $ref: "#/$defs/__schema48",
        },
        background: {
          $ref: "#/$defs/__schema49",
        },
        stream: {
          $ref: "#/$defs/__schema50",
        },
      },
      required: ["service_tier", "truncation", "background", "stream"],
      additionalProperties: false,
    },
    __schema47: {
      type: "string",
      const: "default",
    },
    __schema48: {
      type: "string",
      const: "disabled",
    },
    __schema49: {
      type: "boolean",
      const: false,
    },
    __schema50: {
      type: "boolean",
      const: false,
    },
    __schema51: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    },
    __schema52: {
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
    __schema53: {
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
            $ref: "#/$defs/__schema54",
          },
        },
      },
      required: ["type", "name", "strict", "schema"],
      additionalProperties: false,
    },
    __schema54: {
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
            $ref: "#/$defs/__schema54",
          },
        },
        {
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {
            $ref: "#/$defs/__schema54",
          },
        },
      ],
    },
    __schema55: {
      type: "integer",
      minimum: 0,
      maximum: 9007199254740991,
    },
    __schema56: {
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
            $ref: "#/$defs/__schema56",
          },
        },
        {
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {
            $ref: "#/$defs/__schema56",
          },
        },
      ],
    },
    __schema57: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    },
    __schema58: {
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
          $ref: "#/$defs/__schema59",
        },
        conditions: {
          $ref: "#/$defs/__schema60",
        },
        evidence: {
          type: "object",
          properties: {
            context: {
              type: "object",
              properties: {
                provenance: {
                  $ref: "#/$defs/__schema61",
                },
                model: {
                  $ref: "#/$defs/__schema62",
                },
                conditions: {
                  $ref: "#/$defs/__schema60",
                },
                authority: {
                  $ref: "#/$defs/__schema63",
                },
                contextWindowTokens: {
                  $ref: "#/$defs/__schema64",
                },
                contextCoverage: {
                  type: "string",
                  const: "input-plus-output-including-reasoning",
                },
                maxOutputTokens: {
                  $ref: "#/$defs/__schema64",
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
                  $ref: "#/$defs/__schema61",
                },
                model: {
                  $ref: "#/$defs/__schema62",
                },
                conditions: {
                  $ref: "#/$defs/__schema60",
                },
                authority: {
                  $ref: "#/$defs/__schema63",
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
                  $ref: "#/$defs/__schema65",
                },
                longContext: {
                  anyOf: [
                    {
                      $ref: "#/$defs/__schema65",
                    },
                    {
                      $ref: "#/$defs/__schema68",
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
                  $ref: "#/$defs/__schema69",
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
                  $ref: "#/$defs/__schema69",
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
              $ref: "#/$defs/__schema71",
            },
            review: {
              $ref: "#/$defs/__schema71",
            },
            totalUnits: {
              $ref: "#/$defs/__schema70",
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
            $ref: "#/$defs/__schema72",
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
            $ref: "#/$defs/__schema73",
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
    __schema59: {
      type: "string",
      format: "date-time",
      pattern:
        "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$",
    },
    __schema60: {
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
    __schema61: {
      type: "string",
      enum: ["official-reviewed", "synthetic-test"],
    },
    __schema62: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    },
    __schema63: {
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
    __schema64: {
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 1000000000,
    },
    __schema65: {
      type: "object",
      properties: {
        uncachedInput: {
          $ref: "#/$defs/__schema66",
        },
        cacheReadInput: {
          $ref: "#/$defs/__schema67",
        },
        cacheWriteInput: {
          $ref: "#/$defs/__schema67",
        },
        outputIncludingReasoning: {
          $ref: "#/$defs/__schema66",
        },
      },
      required: ["uncachedInput", "cacheReadInput", "cacheWriteInput", "outputIncludingReasoning"],
      additionalProperties: false,
    },
    __schema66: {
      type: "object",
      properties: {
        units: {
          type: "string",
          pattern: "^(0|[1-9]\\d{0,39})$",
        },
        perTokens: {
          $ref: "#/$defs/__schema64",
        },
      },
      required: ["units", "perTokens"],
      additionalProperties: false,
    },
    __schema67: {
      anyOf: [
        {
          $ref: "#/$defs/__schema66",
        },
        {
          $ref: "#/$defs/__schema68",
        },
      ],
    },
    __schema68: {
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
    __schema69: {
      type: "object",
      properties: {
        units: {
          $ref: "#/$defs/__schema70",
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
    __schema70: {
      type: "string",
      pattern: "^(0|[1-9]\\d{0,79})$",
    },
    __schema71: {
      type: "object",
      properties: {
        inputTokensReserved: {
          $ref: "#/$defs/__schema55",
        },
        outputTokensReserved: {
          $ref: "#/$defs/__schema55",
        },
        inputUnits: {
          $ref: "#/$defs/__schema70",
        },
        outputUnits: {
          $ref: "#/$defs/__schema70",
        },
        totalUnits: {
          $ref: "#/$defs/__schema70",
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
    __schema72: {
      not: {},
    },
    __schema73: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
    },
    __schema74: {
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
          $ref: "#/$defs/__schema75",
        },
        documentDigest: {
          $ref: "#/$defs/__schema20",
        },
        reviewedAt: {
          $ref: "#/$defs/__schema59",
        },
        validUntil: {
          $ref: "#/$defs/__schema59",
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
    __schema75: {
      type: "string",
      format: "uri",
    },
    __schema76: {
      type: "object",
      properties: {
        schemaVersion: {
          type: "number",
          const: 1,
        },
        runDigest: {
          $ref: "#/$defs/__schema1",
        },
        preparationDigest: {
          $ref: "#/$defs/__schema1",
        },
        executionContract: {
          type: "object",
          properties: {
            version: {
              type: "number",
              const: 1,
            },
            mode: {
              type: "string",
              const: "provider",
            },
            requestContractDigest: {
              $ref: "#/$defs/__schema1",
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
                  $ref: "#/$defs/__schema20",
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
                          $ref: "#/$defs/__schema77",
                        },
                        cacheWrite: {
                          $ref: "#/$defs/__schema77",
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
                          $ref: "#/$defs/__schema55",
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
                      $ref: "#/$defs/__schema75",
                    },
                    documentDigest: {
                      $ref: "#/$defs/__schema20",
                    },
                    reviewedAt: {
                      $ref: "#/$defs/__schema59",
                    },
                    validUntil: {
                      $ref: "#/$defs/__schema59",
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
            usagePolicyDigest: {
              $ref: "#/$defs/__schema1",
            },
            responseSchemaVersion: {
              type: "number",
              const: 1,
            },
            domainValidationVersion: {
              type: "number",
              const: 1,
            },
            limits: {
              type: "object",
              properties: {
                requestBytes: {
                  type: "number",
                  const: 2097152,
                },
                responseBytes: {
                  type: "number",
                  const: 4194304,
                },
                validatedBytes: {
                  type: "number",
                  const: 2097152,
                },
                finalBytes: {
                  type: "number",
                  const: 4194304,
                },
                totalArtifactBytes: {
                  type: "number",
                  const: 20971520,
                },
              },
              required: [
                "requestBytes",
                "responseBytes",
                "validatedBytes",
                "finalBytes",
                "totalArtifactBytes",
              ],
              additionalProperties: false,
            },
            maxCalls: {
              type: "number",
              const: 2,
            },
            maxRetries: {
              type: "number",
              const: 0,
            },
            contractDigest: {
              $ref: "#/$defs/__schema1",
            },
          },
          required: [
            "version",
            "mode",
            "requestContractDigest",
            "usagePolicy",
            "usagePolicyDigest",
            "responseSchemaVersion",
            "domainValidationVersion",
            "limits",
            "maxCalls",
            "maxRetries",
            "contractDigest",
          ],
          additionalProperties: false,
        },
        manifestDigest: {
          $ref: "#/$defs/__schema1",
        },
      },
      required: [
        "schemaVersion",
        "runDigest",
        "preparationDigest",
        "executionContract",
        "manifestDigest",
      ],
      additionalProperties: false,
    },
    __schema77: {
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
                $ref: "#/$defs/__schema78",
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
    __schema78: {
      type: "string",
      pattern: "^[A-Za-z_][A-Za-z0-9_]{0,79}$",
    },
    __schema79: {
      type: "object",
      properties: {
        policyUnchanged: {
          type: "boolean",
        },
        runUntouched: {
          type: "boolean",
        },
        reservationIntact: {
          type: "boolean",
        },
        budgetCompatible: {
          type: "boolean",
        },
        budgetWithinBound: {
          type: "boolean",
        },
      },
      required: [
        "policyUnchanged",
        "runUntouched",
        "reservationIntact",
        "budgetCompatible",
        "budgetWithinBound",
      ],
      additionalProperties: false,
    },
    __schema80: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["conditions-met", "blocked"],
        },
        blockers: {
          maxItems: 5,
          type: "array",
          items: {
            $ref: "#/$defs/__schema81",
          },
        },
      },
      required: ["state", "blockers"],
      additionalProperties: false,
    },
    __schema81: {
      type: "string",
      enum: [
        "policy-superseded",
        "run-not-reserved",
        "reservation-not-intact",
        "budget-incompatible",
        "budget-bound-breached",
      ],
    },
    __schema82: {
      type: "string",
      const: "not-checked",
    },
    __schema83: {
      type: "object",
      properties: {
        approvalWriteAllowed: {
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
      required: ["approvalWriteAllowed", "dispatchAllowed", "budgetWriteAllowed"],
      additionalProperties: false,
    },
    __schema84: {
      type: "string",
      const: "separate-transmission-approval-required",
    },
    __schema85: {
      type: "string",
      const:
        "이미 예약된 후보 한 건의 전송 범위를 검토합니다. 생성과 생성 결과로 구성할 검토 요청에는 별도 명시적 승인이 필요하며 이 조회로 승인·전송·비용 쓰기를 실행하지 않습니다.",
    },
  },
};
export const providerTransmissionApprovalCoverageJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    coverageVersion: {
      type: "number",
      const: 1,
    },
    kind: {
      type: "string",
      const: "provider-transmission-approval-coverage",
    },
    cutoverGlobalRunCount: {
      type: "integer",
      minimum: 0,
      maximum: 20,
    },
    cutoverRunPrefixDigest: {
      $ref: "#/$defs/__schema0",
    },
    cutoverProviderEvents: {
      maxItems: 20,
      type: "array",
      items: {
        $ref: "#/$defs/__schema1",
      },
    },
    legacyProductionApprovals: {
      maxItems: 20,
      type: "array",
      items: {
        $ref: "#/$defs/__schema2",
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
    "cutoverProviderEvents",
    "legacyProductionApprovals",
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
        eventCount: {
          type: "integer",
          minimum: 0,
          maximum: 32,
        },
        eventPrefixDigest: {
          $ref: "#/$defs/__schema0",
        },
      },
      required: ["runId", "runDigest", "eventCount", "eventPrefixDigest"],
      additionalProperties: false,
    },
    __schema2: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        },
        approvalEventDigest: {
          $ref: "#/$defs/__schema0",
        },
        clientRequestId: {
          type: "string",
          format: "uuid",
          pattern:
            "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        },
        executionInputDigest: {
          $ref: "#/$defs/__schema0",
        },
      },
      required: ["runId", "approvalEventDigest", "clientRequestId", "executionInputDigest"],
      additionalProperties: false,
    },
  },
};
