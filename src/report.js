// The human-readable close of a run. summary.json is for machines; this is what someone reads before
// deciding whether to trust the verdict.
//
// Its most important sections are the ones that qualify a pass. A green run is only as broad as what
// it actually exercised, so the report states plainly what went unverified, what the run left behind,
// and which decisions are still waiting on a person. A report that only listed successes would make
// the tool more dangerous the more it was trusted.

const PASSING = new Set(['PASS']);

export function buildReport({ config, runId, status, results = [], blockers = [], created = [], cleanup = null }) {
  const sections = [
    heading({ config, runId, status, results }),
    scenarioTable(results),
    changes(results),
    remainingRisks({ config, results, created, cleanup }),
    notVerified({ config, results, blockers }),
    evidence({ config, runId })
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

function heading({ config, runId, status, results }) {
  const passed = results.filter(result => PASSING.has(result.status)).length;
  const counts = tally(results.filter(result => !PASSING.has(result.status)).map(result => result.status));
  const detail = counts.length > 0 ? `${passed} passed, ${counts.join(', ')}` : `all ${passed} passed`;

  return [
    `# TestLoop run \`${runId}\``,
    '',
    `**${status}** — ${results.length} ${results.length === 1 ? 'scenario' : 'scenarios'}: ${detail}.`,
    '',
    `- Target: \`${config.baseUrl}\``,
    `- Mode: \`${config.mode ?? 'standard'}\``,
    `- Completed: ${new Date().toISOString()}`
  ].join('\n');
}

function scenarioTable(results) {
  if (results.length === 0) return null;
  const rows = results.map(result => {
    const httpStatus = result.response?.status ? `\`${result.response.status}\`` : '—';
    const note = result.classification && result.classification !== result.status ? ` (${result.classification})` : '';
    return `| \`${result.id}\` | ${httpStatus} | **${result.status}**${note} |`;
  });
  return ['## Scenarios', '', '| Scenario | HTTP | Result |', '| --- | --- | --- |', ...rows].join('\n');
}

function changes(results) {
  const repaired = results.filter(result => result.fix);
  if (repaired.length === 0) return null;

  const entries = repaired.map(result => {
    const lines = [`### \`${result.id}\``, ''];
    if (result.diagnosis?.summary) lines.push(`- **Diagnosis**: ${result.diagnosis.summary}`);
    lines.push(`- **Fix**: ${result.fix.status}${result.fix.summary ? ` — ${result.fix.summary}` : ''}`);
    for (const file of result.fix.changedFiles ?? []) lines.push(`  - \`${file}\``);
    if (result.review) lines.push(`- **Review**: ${result.review.status}${result.review.summary ? ` — ${result.review.summary}` : ''}`);
    if (result.response?.status) lines.push(`- **Retest**: HTTP \`${result.response.status}\``);
    if (result.regression) {
      lines.push(result.regression.broken.length === 0
        ? `- **Regression sweep**: ${result.regression.checked.length} previously passing ${result.regression.checked.length === 1 ? 'scenario' : 'scenarios'} re-run, all still passing`
        : `- **Regression sweep**: broke ${result.regression.broken.map(item => `\`${item.id}\``).join(', ')}`);
    }
    return lines.join('\n');
  });

  return ['## Changes', '', 'Source was modified only where a human approved it.', '', ...entries].join('\n');
}

function remainingRisks({ config, results, created, cleanup }) {
  const risks = [];

  for (const result of results) {
    if (result.status === 'AWAITING_APPROVAL') {
      risks.push(`\`${result.id}\` is waiting on a decision: \`testloop resume <run-id> ${result.id} approve|decline\`.`);
    }
    if (result.status === 'FAIL' || result.status === 'ESCALATED') {
      risks.push(`\`${result.id}\` — ${result.reason ?? result.classification ?? 'failed'}`);
    }
    for (const violation of result.violations ?? []) {
      risks.push(`\`${result.id}\` breaks its published contract: ${violation}`);
    }
  }

  if (cleanup?.failed?.length > 0) {
    risks.push(`${cleanup.failed.length} created ${cleanup.failed.length === 1 ? 'record' : 'records'} could not be removed; they are listed in \`cleanup.json\`.`);
  } else if (created.length > 0 && config.cleanup !== true) {
    const one = created.length === 1;
    risks.push(`${created.length} ${one ? 'record' : 'records'} created by this run ${one ? 'is' : 'are'} still in the environment, because \`cleanup\` is not enabled. ${one ? 'It is' : 'They are'} listed in \`created.json\`.`);
  }

  return section('Remaining risks', risks, 'None recorded.');
}

// The limits of the verdict. Anything here is something the run did not establish, whether because a
// scenario could not proceed or because the configuration never asked the question.
function notVerified({ config, results, blockers }) {
  const gaps = results
    .filter(result => ['BLOCKED', 'SKIPPED'].includes(result.status))
    .map(result => `\`${result.id}\` — ${result.reason ?? result.classification ?? result.status}`);

  // A run stopped before any scenario ran — a failed login, say — reports only a blocker, and that is
  // the case where saying "nothing was verified" matters most.
  const reported = new Set(results.map(result => result.id));
  for (const blocker of blockers) {
    if (!reported.has(String(blocker).split(':')[0])) gaps.push(blocker);
  }

  if (!config.openApiUrl) {
    gaps.push('Response shapes were not checked against a contract: no `openApiUrl` was configured.');
  }
  if ((config.mode ?? 'standard') !== 'deep') {
    gaps.push('Refusals were not exercised: authorization, validation and not-found checks are generated by `scaffold ... deep`.');
  }
  if (config.regressionCheck === false) {
    gaps.push('Regression sweeping was disabled, so a repair was not checked for collateral damage.');
  }

  return section('Not verified', gaps, 'Everything configured was executed.');
}

function evidence({ config, runId }) {
  return [
    '## Evidence',
    '',
    `Every request, response, fixture proof, role decision and diff for this run is under \`${config.root ?? '.'}/.testloop/runs/${runId}/\`.`
  ].join('\n');
}

function section(title, items, empty) {
  const body = items.length > 0 ? items.map(item => `- ${item}`) : [empty];
  return [`## ${title}`, '', ...body].join('\n');
}

function tally(statuses) {
  const counts = new Map();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count} ${status.toLowerCase()}`);
}
