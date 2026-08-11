import { resetE2eDatabase } from './database.ts';

const databasePath = resetE2eDatabase();
console.log(`Reset E2E database at ${databasePath}`);
await import('../server/index.ts');
