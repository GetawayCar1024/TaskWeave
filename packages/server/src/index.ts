import { parseArgs } from 'node:util';
import { startServer } from './server.js';

/**
 * Command line, for development and the test scripts: start the server and print the
 * address. PolyForge itself is the desktop app (packages/desktop).
 */
const { values: args } = parseArgs({
  options: {
    dev: { type: 'boolean', default: false },
    port: { type: 'string' },
    home: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
  },
});

async function main() {
  const server = await startServer({ home: args.home, port: args.port ? Number(args.port) : undefined, dev: args.dev });
  console.log(`[polyforge] open ${server.url}`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
