import { startApi } from './api';

const server = startApi();

const shutdown = () => {
  server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
