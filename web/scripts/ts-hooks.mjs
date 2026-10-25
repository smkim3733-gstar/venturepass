// Lets a Node script import the app's TypeScript files (src/**) with Node's built-in type
// stripping: "@/x" and extensionless relative imports inside src resolve to .ts/.tsx files.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const inside = (file) => {
  const relative = path.relative(source, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export async function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith("@/")) target = path.join(source, specifier.slice(2));
  else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !path.extname(specifier) &&
    context.parentURL?.startsWith("file:")
  ) {
    const parent = fileURLToPath(context.parentURL);
    if (inside(parent)) target = path.resolve(path.dirname(parent), specifier);
  }
  if (target && inside(target))
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")])
      if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
  return next(specifier, context);
}
