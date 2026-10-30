import { BrowserError } from '../../contracts/src/index.js';

const endpoints = ['foreground', 'setup.status', 'setup.install', 'setup.open'] as const;
type Handler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;

/** Modern DSH owns authentication and owner-principal checks for exact /api routes.
 * Do not claim the shared RPC interceptor: it belongs to DSH's API Gateway.
 * Older DSH releases retain their authenticated independent RPC channel.
 */
export function registerHostRoutes(connection: any, handler: Handler): () => void {
  if (typeof connection?.fetch?.register !== 'function') {
    if (typeof connection?.rpc?.handle !== 'function') {
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'DSH authenticated Connection service is required');
    }
    return connection.rpc.handle('/dsh-native-browser', handler, { authority: 'trusted-host' });
  }
  const disposers: (() => void)[] = [];
  try {
    for (const endpoint of endpoints) {
      const method = `dsh-native-browser/${endpoint}`;
      disposers.push(connection.fetch.register({
        path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
        fetch: async (request: Request) => {
          if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
            return new Response('Expected application/json', { status: 415 });
          }
          const text = await request.text();
          if (text.length > 16_384) return new Response('Request too large', { status: 413 });
          let body;
          try { body = JSON.parse(text); } catch { return new Response('Invalid JSON', { status: 400 }); }
          if (!body || body.type !== 'client-request' || typeof body.rpcId !== 'string'
            || body.rpcId.length < 1 || body.rpcId.length > 256 || body.method !== method) {
            return new Response('Invalid RPC envelope', { status: 400 });
          }
          request.signal.throwIfAborted();
          const result = await handler(endpoint, body.payload, request.signal);
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result });
        },
      }));
    }
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
}
