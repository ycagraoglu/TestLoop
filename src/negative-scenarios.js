// Deep mode's extra coverage: the checks that prove an endpoint refuses what it should refuse.
//
// Only what the analyzer already established is used, so every generated scenario asserts something
// the code actually claims about itself. A guard is only proven to exist by watching it reject
// something, which is why these are worth generating at all: a missing [Authorize] or a validator
// that was never wired up passes every happy-path test ever written.
//
// Each expectation accepts the family of statuses that mean the same thing, because a scenario that
// fails over 422-instead-of-400 teaches nobody anything.

const REJECTED_BY_VALIDATION = [400, 422];
const REJECTED_AS_UNAUTHENTICATED = [401, 403];
const ABSENT = [404];

export function buildNegativeScenarios({ operation, scenario, baseScenarioId }) {
  return [
    ...anonymousAccess({ operation, scenario, baseScenarioId }),
    ...validationBoundaries({ scenario, baseScenarioId }),
    ...missingResource({ operation, scenario, baseScenarioId })
  ];
}

// A protected endpoint that answers an unauthenticated caller has lost its guard entirely, which no
// happy-path scenario can reveal because they all arrive holding a token.
function anonymousAccess({ operation, scenario, baseScenarioId }) {
  if (!operation.source?.authorize?.required) return [];
  return [{
    id: `${baseScenarioId}-rejects-anonymous`,
    method: scenario.method,
    path: scenario.path,
    anonymous: true,
    expectedStatuses: REJECTED_AS_UNAUTHENTICATED,
    ...(scenario.requestModel ? { requestModel: scenario.requestModel, fixtureSources: scenario.fixtureSources } : {})
  }];
}

// One rule broken at a time, everything else left valid, so a rejection can only be attributed to
// the rule under test.
function validationBoundaries({ scenario, baseScenarioId }) {
  const properties = new Map((scenario.requestModel?.properties ?? []).map(property => [property.name, property]));
  const dependencies = new Set((scenario.requestModel?.dependencies ?? []).map(dependency => dependency.property));

  return (scenario.validator?.rules ?? []).flatMap(rule => {
    // A foreign key's value comes from a verified fixture; overriding it would test the fixture gate
    // rather than the validator.
    if (dependencies.has(rule.property)) return [];
    const property = properties.get(rule.property);
    if (!property) return [];

    return (rule.constraints ?? []).flatMap(constraint => {
      const violation = violate(constraint, property);
      if (violation === undefined) return [];
      return [{
        id: `${baseScenarioId}-rejects-${kebab(rule.property)}-${constraint.type}`,
        method: scenario.method,
        path: scenario.path,
        expectedStatuses: REJECTED_BY_VALIDATION,
        requestModel: scenario.requestModel,
        ...(scenario.fixtureSources ? { fixtureSources: scenario.fixtureSources } : {}),
        body: { ...(scenario.body ?? {}), [rule.property]: violation }
      }];
    });
  });
}

function violate(constraint, property) {
  const type = String(property.type ?? '').replace(/\?$/, '').toLowerCase();
  if (constraint.type === 'not-empty' && type === 'string') return '';
  if (constraint.type === 'max-length' && Number.isInteger(constraint.value)) return 'x'.repeat(constraint.value + 1);
  if (constraint.type === 'min-length' && Number.isInteger(constraint.value) && constraint.value > 1) return 'x'.repeat(constraint.value - 1);
  if (constraint.type === 'greater-than' && typeof constraint.value === 'number') return constraint.value;
  return undefined;
}

// Asking for something that cannot exist proves the endpoint answers "not found" rather than
// leaking, throwing, or returning someone else's record.
function missingResource({ operation, scenario, baseScenarioId }) {
  if (operation.method !== 'GET' || !/\{[^}]+\}$/.test(operation.route)) return [];
  const parameter = (operation.source?.parameters ?? []).at(-1);
  const absentId = absentIdentifier(parameter?.type);
  if (!absentId) return [];

  return [{
    id: `${baseScenarioId}-missing-is-not-found`,
    method: scenario.method,
    path: operation.route.replace(/\{[^}]+\}$/, absentId),
    expectedStatuses: ABSENT,
    ...(operation.source?.authorize?.required ? {} : {})
  }];
}

function absentIdentifier(type) {
  const normalized = String(type ?? '').replace(/\?$/, '').toLowerCase();
  if (normalized === 'guid') return '00000000-0000-0000-0000-000000000000';
  if (['int', 'int32', 'int64', 'long'].includes(normalized)) return '2147483647';
  return null;
}

function kebab(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
