import { createProjectGraphAsync } from '@nx/devkit';

const allowedDependencies = new Map([
  ['arena-client', new Set(['arena-engine', 'arena-protocol'])],
  ['arena-engine', new Set()],
  ['arena-protocol', new Set()],
  ['server', new Set(['arena-engine', 'arena-protocol'])],
  ['web', new Set(['arena-client'])],
  ['web-e2e', new Set(['server', 'web'])],
]);

const graph = await createProjectGraphAsync({ exitOnError: true });
const projectNames = Object.keys(graph.nodes).filter((name) => name !== 'workspace');
const errors = [];

for (const projectName of projectNames) {
  const allowed = allowedDependencies.get(projectName);
  if (allowed === undefined) {
    errors.push(`Project "${projectName}" has no declared boundary rule.`);
    continue;
  }

  for (const dependency of graph.dependencies[projectName] ?? []) {
    if (graph.nodes[dependency.target] === undefined) continue;
    if (!allowed.has(dependency.target)) {
      errors.push(
        `Project "${projectName}" must not depend on "${dependency.target}" (${dependency.type}).`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(
    ['Project boundary violations:', ...errors.map((error) => `- ${error}`)].join('\n'),
  );
  process.exitCode = 1;
} else {
  console.log('Project boundaries verified.');
}
