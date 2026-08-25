#!/usr/bin/env node
/**
 * CLI entry point for the `mds` command.
 *
 * Thin wrapper around {@link module:cli} so the executable stays trivially
 * testable; all argument handling lives in the cli module.
 *
 * @module bin.mds
 */
import { main } from '../src/cli.js';

main(process.argv.slice(2));
