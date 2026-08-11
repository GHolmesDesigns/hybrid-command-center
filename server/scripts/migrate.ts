import { config } from '../config.ts';
import { createDb } from '../db.ts';

const db = createDb(config.databasePath, (statements) => {
  if (statements.length === 0) {
    console.log('No additive schema changes were needed.');
    return;
  }
  console.log(`Applied ${statements.length} additive schema change(s):`);
  for (const statement of statements) console.log(`  ${statement}`);
});
db.close();
console.log(`Database schema is up to date at ${config.databasePath}.`);
