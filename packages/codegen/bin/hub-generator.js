#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);

const cpSep = process.platform === 'win32' ? ';' : ':';
const classpath = resolve(__dirname, 'openapi-generator-cli.jar') + cpSep + resolve(__dirname, 'hub-module-codegen.jar');
console.log(classpath);

// Add skipFormModel global property for generation of models defined in form data.
let JAVA_OPTS = process.env['JAVA_OPTS'] || '-DskipFormModel=false';
if (!JAVA_OPTS.includes('skipFormModel')) {
  JAVA_OPTS = JAVA_OPTS.concat(' -DskipFormModel=false');
}

let command = `java ${JAVA_OPTS} -cp "${classpath}" org.openapitools.codegen.OpenAPIGenerator`;

if (args) {
  command += ` ${args.join(' ')}`;
}

const cmd = spawn(command, { stdio: 'inherit', shell: true });
cmd.on('exit', process.exit);
