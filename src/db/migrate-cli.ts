import { runMigrations } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
runMigrations(url).then(() => console.log("Migrations applied"));
