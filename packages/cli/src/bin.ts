#!/usr/bin/env node
import { run } from './cli.js';

const result = run(process.argv.slice(2));
if (result.stdout !== '') process.stdout.write(result.stdout);
if (result.stderr !== '') process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
