import { readFile } from 'node:fs/promises';

// AGENTS.md carries the non-negotiable rules so that agents which read only a root context file get
// them, which means the same list now lives in two places. Every other copy of a rule in this project
// has drifted at least once, so this refuses to let these two disagree rather than trusting anyone to
// remember. The wording is the contract; a rule that differs by a word is a rule that means something
// else to whichever agent read the other file.
const SOURCE = 'skills/testloop/SKILL.md';
const COPY = 'AGENTS.md';
const HEADING = '## Non-negotiable rules';

const [source, copy] = await Promise.all([rules(SOURCE), rules(COPY)]);

if (source.length === 0) {
  throw new Error(`No numbered rules were found under "${HEADING}" in ${SOURCE}.`);
}

const differences = [];
for (let index = 0; index < Math.max(source.length, copy.length); index += 1) {
  if (source[index] === copy[index]) continue;
  differences.push(`  rule ${index + 1}\n    ${SOURCE}: ${source[index] ?? '(missing)'}\n    ${COPY}: ${copy[index] ?? '(missing)'}`);
}

if (differences.length > 0) {
  console.error(`The non-negotiable rules differ between ${SOURCE} and ${COPY}:\n${differences.join('\n')}`);
  process.exit(1);
}

console.log(`Agent instruction copies agree: ${source.length} non-negotiable rules in ${SOURCE} and ${COPY}.`);

async function rules(file) {
  const content = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  const start = content.indexOf(HEADING);
  if (start === -1) throw new Error(`${file} is missing the "${HEADING}" section.`);

  const rest = content.slice(start + HEADING.length);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);

  return section
    .split('\n')
    .map(line => line.match(/^\d+\.\s+(?<rule>.+)$/)?.groups.rule.trim())
    .filter(Boolean);
}
