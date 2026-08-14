// Classifies one executed scenario. An HTTP error is never an application defect on its own: the
// preconditions have to be evidenced as valid first, otherwise the result is attributed to whichever
// precondition failed. This is the gate that stops TestLoop from reporting fake FAILs.
export function classifyExecution({ expectedStatuses, actualStatus, fixtureVerified, environmentHealthy }) {
  if (!environmentHealthy) return 'ENVIRONMENT_ERROR';
  // The expected status wins over everything below: a negative scenario that deliberately asserts
  // 401 or 403 (deep mode's role and tenant checks) is a pass, not an authentication problem.
  if (expectedStatuses.includes(actualStatus)) return 'PASS';
  // A scenario that expects only rejections is contradicted outright when the call succeeds: the
  // guard it exists to prove did not fire. No unmet precondition can produce that, so this is one of
  // the few results attributable to the application without a role's judgement.
  if (expectedStatuses.length > 0 && expectedStatuses.every(status => status >= 400) && actualStatus < 400) {
    return 'REJECTION_NOT_ENFORCED';
  }
  if ([401, 403].includes(actualStatus)) return 'AUTH_ERROR';
  if (!fixtureVerified && actualStatus >= 400) return 'FIXTURE_ERROR';
  if (actualStatus >= 500) return 'APPLICATION_BUG';
  return 'INCONCLUSIVE';
}
