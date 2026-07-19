import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EgressSentinel {
  endpoint: string;
  requestCount(): number;
  stop(): Promise<void>;
}

export async function startEgressSentinel(): Promise<EgressSentinel> {
  let requests = 0;
  const server: Server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  let stopped = false;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
