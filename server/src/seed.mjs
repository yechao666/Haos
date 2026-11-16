import { openDb, seedForce } from './db.mjs';

const db = openDb();
const seeded = seedForce(db);
console.log(seeded ? 'Seeded demo data. admin@haos.local / haos-demo' : 'Seed failed.');
db.close();
