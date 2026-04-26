import { prisma } from "./index";

export type BootstrapOptions = {
  email: string;
  password: string;
};

function parseArgs(argv: string[]): { email?: string; password?: string } {
  let email: string | undefined;
  let password: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email" && argv[i + 1]) {
      email = argv[++i];
    } else if (a === "--password" && argv[i + 1]) {
      password = argv[++i];
    }
  }
  return { email, password };
}

/**
 * Creates the first admin user when no users exist. Exits the process on misuse.
 */
export async function bootstrapFirstAdmin(options: BootstrapOptions): Promise<void> {
  const count = await prisma.user.count();
  if (count > 0) {
    throw new Error(
      "Bootstrap refused: users already exist. This command only runs when the database has zero users.",
    );
  }

  const email = options.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Invalid email for bootstrap admin.");
  }
  if (options.password.length < 8) {
    throw new Error("Bootstrap password must be at least 8 characters.");
  }

  const passwordHash = await Bun.password.hash(options.password, {
    algorithm: "bcrypt",
    cost: 10,
  });

  await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: "ADMIN",
    },
  });
}

async function main() {
  const fromEnv = {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim(),
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "",
  };
  const fromArgs = parseArgs(process.argv.slice(2));
  const email = fromArgs.email ?? fromEnv.email;
  const password = fromArgs.password ?? fromEnv.password;

  if (!email || !password) {
    console.error(
      "Usage: bun run src/bootstrap.ts --email admin@example.com --password '<secret>'\n" +
        "Or set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD.",
    );
    process.exit(1);
  }

  try {
    await bootstrapFirstAdmin({ email, password });
    console.log(`Bootstrap complete: created admin ${email.trim().toLowerCase()}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  await main();
}
