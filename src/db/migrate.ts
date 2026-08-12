/**
 * Runner de migração simples: aplica os arquivos .sql de src/db/migrations/, em
 * ordem, uma vez cada. As migrations são SQL puro (não geradas pelo drizzle-kit)
 * porque as EXCLUDE constraints — a trava real contra overbooking — não têm
 * representação no DSL do Drizzle. Ver 0000_init.sql pro porquê.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function main() {
  const sql = postgres(config.DATABASE_URL, { max: 1 });

  await sql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const already = await sql`select 1 from _migrations where name = ${file}`;
    if (already.length > 0) {
      console.log(`↷ ${file} (já aplicada)`);
      continue;
    }

    const content = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`→ aplicando ${file}...`);
    await sql.unsafe(content);
    await sql`insert into _migrations (name) values (${file})`;
    console.log(`✓ ${file}`);
  }

  await sql.end();
  console.log('Migrações em dia.');
}

main().catch((err) => {
  console.error('Falha ao migrar:', err);
  process.exit(1);
});
