import path from "path";
import dotenv from "dotenv";

// Load env from root (monorepo structure)
const rootEnvPath = path.resolve(process.cwd(), "../../.env");
dotenv.config({ path: rootEnvPath });
console.log("Loaded env from:", rootEnvPath);
console.log("DATABASE_URL present:", !!process.env.DATABASE_URL);
console.log("GOOGLE_CLIENT_ID present:", !!process.env.GOOGLE_CLIENT_ID);
console.log("GOOGLE_CLIENT_SECRET present:", !!process.env.GOOGLE_CLIENT_SECRET);
console.log("GOOGLE_REFRESH_TOKEN present:", !!process.env.GOOGLE_REFRESH_TOKEN);
console.log("GOOGLE_DRIVE_FOLDER_STUDENT_DOCS present:", !!process.env.GOOGLE_DRIVE_FOLDER_STUDENT_DOCS);
console.log("GOOGLE_DRIVE_FOLDER_ABSTRACTS present:", !!process.env.GOOGLE_DRIVE_FOLDER_ABSTRACTS);

