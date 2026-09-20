import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const baseUrl = (process.env.SCREENING_BASE_URL || 'http://127.0.0.1:3002/api').replace(/\/$/, '');
const sourceDir = path.resolve(
  process.env.JOB_SAMPLE_DIR || path.join(process.cwd(), '..', '..', 'data', 'AI岗位描述样本'),
);

const files = (await readdir(sourceDir))
  .filter((name) => name.endsWith('.txt'))
  .sort();

if (!files.length) {
  throw new Error(`No .txt job samples found in ${sourceDir}`);
}

for (const fileName of files) {
  const sourceText = await readFile(path.join(sourceDir, fileName), 'utf8');
  const response = await fetch(`${baseUrl}/jobs/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceFileName: fileName, sourceText }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${fileName}: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  console.log(`${body.id}\t${body.title}\t${body.criteriaStatus}`);
}
