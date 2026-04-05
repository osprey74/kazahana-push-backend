import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

const DATABASE_PATH = process.env.DATABASE_PATH || "./kazahana-push.db";

const db = new Database(DATABASE_PATH);
db.exec(MIGRATIONS);

export { db };
