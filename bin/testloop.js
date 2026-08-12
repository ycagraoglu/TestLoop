#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ArtifactStore } from '../src/artifact-store.js';
import { discoverDotnetProjects, ensureDirectoryExists } from '../src/discovery.js';
import { executeHttp } from '../src/http.js';
import { listOperations, loadOpenApi } from '../src/openapi.js';
import { runVerification } from '../src/orchestrator.js';
import { buildProject, startApi } from '../src/process-manager.js';
import { resumeVerification } from '../src/resume.js';
import { analyzeAspNetSource } from '../src/source-analyzer.js';
import { buildTestPlan } from '../src/test-planner.js';
import { createWorkflowState, transitionWorkflow } from '../src/workflow.js';

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'discover': {
      const root = args[0] ?? process.cwd();
      await ensureDirectoryExists(root);
      print(await discoverDotnetProjects(root));
      break;
    }
    case 'analyze': {
      const root = args[0] ?? process.cwd();
      await ensureDirectoryExists(root);
      print(await analyzeAspNetSource(root));
      break;
    }
    case 'openapi': {
      const source = required(args[0], 'OpenAPI URL');
      const document = await loadOpenApi(source);
      print({ source, operations: listOperations(document) });
      break;
    }
    case 'plan': {
      const openApiSource = required(args[0], 'OpenAPI URL');
      const root = args[1] ?? process.cwd();
      const document = await loadOpenApi(openApiSource);
      const sourceManifest = await analyzeAspNetSource(root);
      print(buildTestPlan({ operations: listOperations(document), sourceManifest, mode: args[2] ?? 'standard' }));
      break;
    }
    case 'request': {
      const method = required(args[0], 'HTTP method').toUpperCase();
      const url = required(args[1], 'URL');
      const body = args[2] ? JSON.parse(args[2]) : undefined;
      print(await executeHttp({ method, url, body }));
      break;
    }
    case 'build': {
      print(await buildProject(required(args[0], 'Project path')));
      break;
    }
    case 'serve': {
      const projectPath = required(args[0], 'Project path');
      const url = args[1] ?? 'http://127.0.0.1:5099';
      const api = await startApi({ projectPath, url, environment: args[2] ?? 'Development' });
      print({ status: 'READY', pid: api.pid, url: api.url, environment: api.environment });
      const shutdown = async () => { await api.stop(); process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
      break;
    }
    case 'run': {
      const configPath = required(args[0], 'Config path');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      print(await runVerification(config, { store: new ArtifactStore(config.root ?? process.cwd(), config.runId) }));
      break;
    }
    case 'resume': {
      const runId = required(args[0], 'Run ID');
      const scenarioId = required(args[1], 'Scenario ID');
      const decision = required(args[2], 'Decision (approve|decline)').toLowerCase();
      const root = args[3] ?? process.cwd();
      print(await resumeVerification({ root, runId, scenarioId, decision }));
      break;
    }
    case 'workflow': {
      const runId = required(args[0], 'Run ID');
      const target = required(args[1], 'Target');
      let workflow = createWorkflowState({ runId, target });
      for (const outcome of args.slice(2)) workflow = transitionWorkflow(workflow, outcome);
      print(workflow);
      break;
    }
    case 'help':
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'ERROR', message: error.message, details: error.result ?? undefined }, null, 2));
  process.exitCode = 1;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function printHelp() {
  console.log(`TestLoop\n\nCommands:\n  testloop discover [root]\n  testloop analyze [root]\n  testloop openapi <url>\n  testloop plan <openapi-url> [root] [mode]\n  testloop request <method> <url> [json-body]\n  testloop build <project-path>\n  testloop serve <project-path> [url] [environment]\n  testloop run <testloop.config.json>\n  testloop resume <run-id> <scenario-id> <approve|decline> [root]\n  testloop workflow <run-id> <target> [outcomes...]\n`);
}
