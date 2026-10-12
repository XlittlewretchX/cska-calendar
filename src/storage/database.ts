import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  databaseSchema,
  emptyDatabase,
  type Database,
} from '../models/match.js';
export async function readDatabase(root: string): Promise<Database> {
  try {
    return databaseSchema.parse(
      JSON.parse(await readFile(resolve(root, 'data/matches.json'), 'utf8')),
    );
  } catch (error) {
    if (isMissing(error)) return emptyDatabase();
    throw error;
  }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function writeOutputs(
  root: string,
  outputs: Record<string, string>,
): Promise<void> {
  const staged: { path: string; temp: string; previous: string | undefined }[] =
    [];
  const written: typeof staged = [];
  try {
    for (const [relative, content] of Object.entries(outputs)) {
      const path = resolve(root, relative);
      await mkdir(dirname(path), { recursive: true });
      let previous: string | undefined;
      try {
        previous = await readFile(path, 'utf8');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (previous === content) continue;
      const temp = `${path}.${process.pid}.tmp`;
      staged.push({ path, temp, previous });
      await writeFile(temp, content, 'utf8');
    }
    for (const item of staged) {
      await rename(item.temp, item.path);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (item.previous === undefined) await rm(item.path, { force: true });
      else await writeFile(item.path, item.previous, 'utf8');
    }
    throw error;
  } finally {
    await Promise.all(staged.map((item) => rm(item.temp, { force: true })));
  }
}
