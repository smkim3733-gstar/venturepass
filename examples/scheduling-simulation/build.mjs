import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function render() {
  const root = new URL('./', import.meta.url);
  const [template, engine, rawFixture] = await Promise.all([
    readFile(new URL('template.html', root), 'utf8'),
    readFile(new URL('engine.cjs', root), 'utf8'),
    readFile(new URL('fixture.json', root), 'utf8'),
  ]);
  const fixture = JSON.stringify(JSON.parse(rawFixture)).replace(/</g, '\\u003c');
  return template.replace('{{ENGINE}}', () => engine).replace('{{FIXTURE}}', () => fixture);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const output = new URL('./dist/index.html', import.meta.url);
  await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
  await writeFile(output, await render(), 'utf8');
  console.log(fileURLToPath(output));
}
