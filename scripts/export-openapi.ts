// Writes docs/api/openapi.json from the source of truth in src/http/openapi.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { openApiDocument } from '../src/http/openapi.ts';
mkdirSync('docs/api', { recursive: true });
writeFileSync('docs/api/openapi.json', JSON.stringify(openApiDocument('https://license-server.repasscloud.com'), null, 2) + '\n');
console.log('wrote docs/api/openapi.json');
