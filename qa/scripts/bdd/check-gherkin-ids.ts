#!/usr/bin/env node
/**
 * Validates the Gherkin feature files in `qa/features/`.
 *
 * Enforces the test-ID convention:
 * - every Scenario and Scenario Outline carries exactly one ID tag of
 *   the form `@TC-<GROUP>-<case>`, where GROUP is a semantic, uppercase
 *   name for the test area (e.g. `@TC-STARTUP-1`, `@TC-INVOKE-4`);
 * - all IDs in one feature file share the same GROUP;
 * - IDs are unique across the whole suite.
 *
 * Exits with a non-zero status on any violation. Run as
 * `pnpm lint:gherkin` (part of `pnpm lint`).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType, type Scenario } from '@cucumber/messages';

const FEATURES_DIR = fileURLToPath(new URL('../../features/', import.meta.url));

const ID_TAG_PATTERN = /^@TC-([A-Z]+)-(\d+)$/;
const seenIds = new Map<string, string>();
let scenarioCount = 0;
const errors: string[] = [];

/**
 * Extracts the semantic GROUP part of an ID tag
 * (e.g. `@TC-STARTUP-1` -> `STARTUP`).
 *
 * @param idTag - The full ID tag, including the leading `@`.
 * @returns The GROUP part, or an empty string when the tag is malformed.
 */
function groupOf(idTag: string): string {
  return idTag.match(ID_TAG_PATTERN)?.[1] ?? '';
}

/**
 * Validates one scenario's tags: exactly one ID, matching the file
 * group, and not already seen. Records violations in `errors`.
 *
 * @param filePath - Absolute path to the feature file.
 * @param scenario - The parsed scenario.
 * @param fileGroup - The group already established for the file.
 * @returns The group in effect after this scenario.
 */
function checkScenarioTags(filePath: string, scenario: Scenario, fileGroup: string): string {
  const tags = (scenario.tags ?? []).map((tag) => tag.name);
  const idTags = tags.filter((tag) => ID_TAG_PATTERN.test(tag));

  if (idTags.length !== 1) {
    errors.push(
      `${filePath}:${scenario.location.line}: ${scenario.name} — expected ` +
        `exactly one @TC-<GROUP>-<case> tag, found ${idTags.length}`,
    );
    return fileGroup;
  }

  const id = idTags[0];
  const group = groupOf(id);
  if (fileGroup !== '' && group !== fileGroup) {
    errors.push(
      `${filePath}:${scenario.location.line}: ${scenario.name} — ID ${id} ` +
        `uses group "${group}" but the file group is "${fileGroup}"`,
    );
  }

  if (seenIds.has(id)) {
    errors.push(
      `${filePath}:${scenario.location.line}: ${scenario.name} — duplicate ID ` +
        `${id} (also on ${seenIds.get(id)})`,
    );
  } else {
    seenIds.set(id, `${filePath}:${scenario.location.line}`);
  }
  return fileGroup === '' ? group : fileGroup;
}

/**
 * Checks a single feature file: exactly one ID per scenario, one group
 * per file, and suite-wide uniqueness.
 *
 * @param filePath - Absolute path to the feature file.
 */
async function checkFile(filePath: string): Promise<void> {
  const source = await readFile(filePath, 'utf8');
  const messages = generateMessages(
    source,
    filePath,
    SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
    {
      includeGherkinDocument: true,
      includePickles: false,
      newId: IdGenerator.uuid(),
    },
  );

  const document = messages.find((message) => message.gherkinDocument)?.gherkinDocument;
  const feature = document?.feature;
  if (!feature) {
    errors.push(`${filePath}: could not parse a feature document`);
    return;
  }

  let fileGroup = '';
  for (const child of feature.children ?? []) {
    const scenario = child.scenario;
    if (!scenario) {
      continue;
    }
    scenarioCount += 1;
    fileGroup = checkScenarioTags(filePath, scenario, fileGroup);
  }
}

const files = (await readdir(FEATURES_DIR)).filter((file) => file.endsWith('.feature'));
for (const file of files) {
  await checkFile(join(FEATURES_DIR, file));
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`gherkin-ids: ${error}`);
  }
  console.error(`gherkin-ids: ${errors.length} error(s) in ${files.length} file(s)`);
  process.exit(1);
}

console.log(
  `gherkin-ids: OK — ${scenarioCount} scenarios in ${files.length} file(s), ` +
    `${seenIds.size} unique IDs`,
);
