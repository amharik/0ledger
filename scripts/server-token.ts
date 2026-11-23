import { createTenantToken } from '../server.tenancy.ts';

interface CliOptions {
  tenantId: string;
  workspaceIds: string[];
  subject?: string;
  ttlSeconds: number;
}

function usage(): never {
  console.error(`Usage: bun run server:token -- --tenant <id> --workspace <id> [options]

Required:
  --tenant, -t <id>         Tenant id (letters, numbers, dots, underscores, hyphens)
  --workspace, -w <id>      Workspace id; repeat or comma-separate multiple values

Options:
  --subject, -s <name>      Optional subject recorded in the token
  --ttl <seconds>           Token lifetime, 60-86400 seconds (default: 3600)
  --help, -h                Show this help

The signing secret is read from SERVER_AUTH_SECRET. The token is printed to stdout.`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const workspaceIds: string[] = [];
  let tenantId = '';
  let subject: string | undefined;
  let ttlSeconds = 3600;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) usage();
      i += 1;
      return value;
    };

    switch (arg) {
      case '--tenant':
      case '-t':
        tenantId = next();
        break;
      case '--workspace':
      case '-w':
        workspaceIds.push(
          ...next()
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        );
        break;
      case '--subject':
      case '-s':
        subject = next();
        break;
      case '--ttl':
        ttlSeconds = Number(next());
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        if (arg?.startsWith('--')) usage();
    }
  }

  if (!tenantId) usage();
  if (workspaceIds.length === 0) usage();
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
    throw new Error('Token lifetime must be an integer between 60 and 86400 seconds.');
  }

  const options: CliOptions = { tenantId, workspaceIds, ttlSeconds };
  if (subject) options.subject = subject;
  return options;
}

try {
  const secret = process.env.SERVER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error('SERVER_AUTH_SECRET is required to sign a token.');
  }
  const options = parseArgs(process.argv.slice(2));
  const token = createTenantToken(options, secret);
  process.stdout.write(`${token}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
