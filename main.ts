// Driver for the markdown-render-speed-02 entry. The harness runs
// `node /bot/main.ts` on Node 22: read every case from
// /input/cases.json, render each one alone with parse() from parse.js,
// and write /output/html.json as a JSON array of the HTML strings, one
// per case and in the cases' order. Outside a container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for
// /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
