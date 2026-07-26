import { drizzle } from "drizzle-orm/netlify-db";
// No `.js` extension: this file is now imported by the Next.js bundler, which resolves
// TypeScript sources directly and cannot follow the ESM-style extension.
import * as schema from "./schema";

export const db = drizzle({ schema });
