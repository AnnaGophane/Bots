import http from 'http';
import { logger } from './logger.js';

export function setupHealthCheck() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('OK');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    logger.info(`Health check server listening on port ${port}`);
  });

  return server;
}
