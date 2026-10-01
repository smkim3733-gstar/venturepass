import { providerPolicyArchiveJsonSchema } from "./local-data-quality-provider-policy-schema.mjs";

// A distinct archive format; never mutate/regenerate the historical v1 schema.
// Current prompts/configuration/time are deliberately absent from this module.
const schema = structuredClone(providerPolicyArchiveJsonSchema);
schema.properties.recordVersion = { type: "number", const: 2 };
schema.properties.reviewedProposal.properties.viewVersion = { type: "number", const: 4 };
const proposalRef = schema.properties.reviewedProposal.properties.proposal.$ref;
const proposal = schema.$defs[proposalRef.slice("#/$defs/".length)];
proposal.properties.requestReview.properties.contract.properties.baseContract.properties.engineVersion =
  {
    type: "string",
    enum: ["plan-observation-v1", "plan-observation-v2"],
  };
export const versionedProviderPolicyArchiveJsonSchema = schema;
