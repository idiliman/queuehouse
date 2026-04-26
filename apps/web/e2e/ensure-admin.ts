/**
 * Ensures an admin user exists for operator E2E. Run with Bun from repo root.
 * Env: DATABASE_URL (required), E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD
 */
import { prisma } from "@queuehouse/db";

const email = (process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@queuehouse.test").trim().toLowerCase();
const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-test-password-min-8-chars";

const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });

await prisma.user.upsert({
  where: { email },
  create: { email, passwordHash, role: "ADMIN" },
  update: { passwordHash, role: "ADMIN", disabledAt: null },
});

await prisma.$disconnect();
