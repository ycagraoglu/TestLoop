#!/usr/bin/env node
import { discoverDotnetProjects, ensureDirectoryExists } from '../src/discovery.js';
import { executeHttp } from '../src/http.js';
import { listOperations, loadOpenApi } from '../src/openapi.js';
import { analyzeAspNetSource } from '../src/source-analyzer.js';
import { createWorkflowState, transitionWorkflow } from '../src/workflow.js';

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'discover': {
      const root = args[0] ?? process.cwd();
      await ensureDirectoryExists(root);
      console.log(JSON.stringify(await discoverDotnetProjects(root), null, 2));
      break;
    }
    case 'analyze': {
      const root = args[0] ?? process.cwd();
      await ensureDirectoryExists(root);
      console.log(JSON.stringify(await analyzeAspNetSource(root), null, 2));
      break;
    }
    case 'openapi': {
      const source = required(args[0], 'OpenAPI URL');
      const document = await loadOpenApi(source);
      console.log(JSON.stringify({ source, operations: listOperations(document) }, null, 2));
      break;
    }
    case 'request': {
      const method = required(args[0], 'HTTP method').toUpperCase();
      const url = required(args[1], 'URL');
      const body = args[2] ? JSON.parse(args[2]) : undefined;
      console.log(JSON.stringify(await executeHttp({ method, url, body }), null, 2));
      break;
    }
    case 'workflow': {
      const runId = required(args[0], 'Run ID');
      const target = required(args[1], 'Target');
      const outcomes = args.slice(2);
      let workflow = createWorkflowState({ runId, target });
      for (const outcome of outcomes) workflow = transitionWorkflow(workflow, outcome);
      console.log(JSON.stringify(workflow, null, 2));
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
  console.error(JSON.stringify({ status: 'ERROR', message: error.message }, null, 2));
  process.exitCode = 1;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function printHelp() {
  console.log(`TestLoop deterministic runner\n\nCommands:\n  testloop discover [root]\n  testloop analyze [root]\n  testloop openapi <url>\n  testloop request <method> <url> [json-body]\n  testloop workflow <run-id> <target> [outcomes...]\n`);
}
