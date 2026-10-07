import postgres from "postgres";
import { runMigrations } from "../../src/db/migrate";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://venture:venture_dev_password@localhost:5433/venture_stream_test";
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`Refusing to run tests against non-test database "${dbName}"`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  const exists = await sql`select 1 from pg_database where datname = ${dbName}`;
  if (exists.length === 0) await sql.unsafe(`create database "${dbName}"`);
  await sql.end();
  // Fresh schema every run.
  const t = postgres(url, { max: 1, onnotice: () => {} });
  await t.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await t.end();
  await runMigrations(url);
}
