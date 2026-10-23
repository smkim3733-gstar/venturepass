import { createServer } from 'node:http';
import { render } from './build.mjs';

const port = process.argv[2] === undefined ? 0 : Number(process.argv[2]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0..65535');
const html = await render();
const server = createServer((request, response) => {
  if (request.url !== '/' || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : html);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Synthetic demo: http://127.0.0.1:${server.address().port}/`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
