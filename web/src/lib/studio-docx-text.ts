type TextNode = { type: string; value?: string; children?: TextNode[] };

function plainText(node: TextNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "tab") return "\t";
  if (node.type === "break") return "\n";
  return (node.children ?? []).map(plainText).join("") + (node.type === "paragraph" ? "\n\n" : "");
}

/** Preserve explicit Word breaks so adjacent amounts, units and sentences cannot merge. */
export async function extractDocxText(buffer: Buffer) {
  const mammoth = await import("mammoth");
  let value = "";
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      transformDocument(document: TextNode) {
        value = plainText(document);
        // Only read the parsed text tree; do not render HTML or resolve image content.
        return { ...document, children: [] };
      },
    },
  );
  return { value, messages: result.messages };
}
