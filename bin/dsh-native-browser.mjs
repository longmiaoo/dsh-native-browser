#!/usr/bin/env node
import { main } from '../dist/packages/broker/src/cli.js';
try { await main(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
