import { providerTransmissionApprovalBindingJsonSchema } from "./local-data-quality-provider-transmission-binding-schema.mjs";

// Separate archived shape. Clone only frozen v1 fields; never import current prompt/configuration.
const schema = structuredClone(providerTransmissionApprovalBindingJsonSchema);
function child(parent, key) {
  const value = parent.properties[key];
  if (value.$ref)
    parent.properties[key] = structuredClone(schema.$defs[value.$ref.slice("#/$defs/".length)]);
  return parent.properties[key];
}
schema.properties.recordVersion = { type: "number", const: 2 };
const review = child(schema, "approvedReview");
review.properties.schemaVersion = { type: "number", const: 2 };
child(review, "run").properties.archiveFormatVersion = { type: "number", enum: [4, 5] };
child(child(child(review, "request"), "contract"), "baseContract").properties.engineVersion = {
  type: "string",
  const: "plan-observation-v2",
};
const manifest = child(review, "manifest");
manifest.properties.schemaVersion = { type: "number", const: 2 };
const contract = child(manifest, "executionContract");
contract.properties.version = { type: "number", const: 2 };
contract.properties.engineVersion = { type: "string", const: "plan-observation-v2" };
contract.properties.nativeRunFormat = { type: "number", const: 3 };
contract.required.push("engineVersion", "nativeRunFormat");
review.properties.tokenAssessment = {
  type: "object",
  properties: {
    basis: { type: "string", const: "financial-reservation-only" },
    actualTokenCountMeasured: { type: "boolean", const: false },
    contextFitVerified: { type: "boolean", const: false },
  },
  required: ["basis", "actualTokenCountMeasured", "contextFitVerified"],
  additionalProperties: false,
};
review.required.push("tokenAssessment");
export const versionedProviderTransmissionApprovalBindingJsonSchema = schema;
