import http from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('../test/fixtures/form.html', import.meta.url));
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); });
server.listen(18765, '127.0.0.1', () => console.log('Fixture: http://127.0.0.1:18765'));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
