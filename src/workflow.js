// Classifies one executed scenario. An HTTP error is never an application defect on its own: the
// preconditions have to be evidenced as valid first, otherwise the result is attributed to whichever
// precondition failed. This is the gate that stops TestLoop from reporting fake FAILs.
export function classifyExecution({ expectedStatuses, actualStatus, fixtureVerified, authVerified, environmentHealthy }) {
  if (!environmentHealthy) return 'ENVIRONMENT_ERROR';
  if (!authVerified && [401, 403].includes(actualStatus)) return 'AUTH_ERROR';
  if (!fixtureVerified && actualStatus >= 400) return 'FIXTURE_ERROR';
  if (expectedStatuses.includes(actualStatus)) return 'PASS';
  if (actualStatus >= 500) return 'APPLICATION_BUG';
  return 'INCONCLUSIVE';
}
