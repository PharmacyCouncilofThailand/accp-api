
import * as dotenv from 'dotenv';
dotenv.config();

import { db } from "../database/index.js";
import { backofficeUsers } from "../database/schema.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function verifyPassword() {
  const email = "admin@accp.org";
  const password = "admin123";

  console.log(`Checking user: ${email}`);

  const users = await db
    .select()
    .from(backofficeUsers)
    .where(eq(backofficeUsers.email, email))
    .limit(1);

  if (users.length === 0) {
    console.log("User not found!");
    process.exit(1);
  }

  const user = users[0];
  console.log(`User found. Hash: ${user.passwordHash}`);

  const isValid = await bcrypt.compare(password, user.passwordHash);
  console.log(`Password '${password}' is valid: ${isValid}`);

  if (!isValid) {
    console.log("Generating new hash for 'admin123'...");
    const newHash = await bcrypt.hash(password, 10);
    console.log(`New Hash: ${newHash}`);
    
    // Uncomment to update
    // await db.update(backofficeUsers).set({ passwordHash: newHash }).where(eq(backofficeUsers.id, user.id));
    // console.log("Password updated.");
  }

  process.exit(0);
}

verifyPassword().catch(console.error);
