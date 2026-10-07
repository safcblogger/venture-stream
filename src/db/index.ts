import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const g = globalThis as unknown as { __vsSql?: ReturnType<typeof postgres>; __vsDb?: Db };

export function getDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!g.__vsDb) {
    g.__vsSql = postgres(url, { max: 10, onnotice: () => {} });
    g.__vsDb = drizzle(g.__vsSql, { schema });
  }
  return g.__vsDb;
}

export const db = new Proxy({} as Db, {
  get: (_t, prop) => (getDb() as never)[prop as never],
});

export { schema };
